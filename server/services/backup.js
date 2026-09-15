import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import db from '../db.js';
import config from '../config.js';
import { writeArchive, walk } from './archive.js';
import * as drive from './drive.js';
import { pushSummary } from './push.js';

/**
 * A weekly copy of everything that cannot be rebuilt from the repository: the
 * database, and every chapter image that has ever been uploaded.
 *
 * The scheduling deliberately asks "when did a backup last succeed" rather than
 * counting down a timer. Railway restarts the container on every deploy, and a
 * weekly setInterval loses its place each time -- on a week with three deploys
 * it would never fire at all. Comparing against the last recorded success
 * survives restarts and catches a week that was missed while the service was
 * down.
 */

const DAY = 86_400_000;

let running = false;
let timer = null;

// --- history ---------------------------------------------------------------

const insert = db.prepare(
  `INSERT INTO backups (started_at, status) VALUES (datetime('now'), 'running') RETURNING id`
);
const finish = db.prepare(
  `UPDATE backups SET finished_at = datetime('now'), status = ?, bytes = ?, file_name = ?,
                      remote_id = ?, error = ? WHERE id = ?`
);

export function recentBackups(limit = 20) {
  return db
    .prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status, bytes,
              file_name AS fileName, remote_id AS remoteId, error
         FROM backups ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

export const lastSuccess = () =>
  db
    .prepare(`SELECT finished_at AS at FROM backups WHERE status = 'ok' ORDER BY id DESC LIMIT 1`)
    .get() || null;

/** A run left as 'running' means the process died mid-backup. Say so plainly. */
function reapAbandoned() {
  db.prepare(
    `UPDATE backups SET status = 'failed', finished_at = datetime('now'),
            error = 'The server restarted while this backup was running.'
      WHERE status = 'running'`
  ).run();
}

// --- the backup itself -----------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

/**
 * Takes the snapshot and sends it.
 *
 * The database is copied with SQLite's own online backup rather than by reading
 * the file: in WAL mode the file on disk is not a complete database on its own,
 * and copying it under a live writer is how you get an archive that restores to
 * a corrupt database. `.backup()` produces a consistent snapshot of a database
 * that is still being written to.
 */
export async function runBackup({ reason = 'scheduled' } = {}) {
  if (running) return { skipped: 'A backup is already running.' };
  if (!drive.driveConfigured()) return { skipped: 'Google Drive is not set up.' };
  if (!drive.driveConnected()) return { skipped: 'Google Drive is not connected.' };

  running = true;
  const { id } = insert.get();
  const work = await mkdtemp(join(tmpdir(), 'jewels-backup-'));
  const name = `the-jewels-${stamp()}.tar.gz`;

  try {
    const snapshot = join(work, 'jewels.db');
    await db.backup(snapshot);

    const pages = await walk(config.contentDir);
    const entries = [
      { path: snapshot, name: 'jewels-backup/jewels.db' },
      ...pages.map((rel) => ({
        path: join(config.contentDir, rel),
        name: `jewels-backup/content/${rel}`,
      })),
    ];

    const archive = join(work, name);
    const bytes = await writeArchive(archive, entries);
    const uploaded = await drive.upload(archive, name);

    finish.run('ok', bytes, name, uploaded.id || null, null, id);
    await prune();
    return { ok: true, name, bytes, files: entries.length, reason };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    finish.run('failed', null, name, null, message, id);
    // A refresh token that Google has revoked will fail identically every week
    // forever. Dropping it turns a silent repeat failure into a visible
    // "not connected" in the admin panel, which is the state that actually
    // prompts somebody to fix it.
    if (/invalid_grant|unauthorized_client|Token has been expired or revoked/i.test(message)) {
      drive.disconnect();
    }
    return { ok: false, error: message };
  } finally {
    running = false;
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Keeps the newest few and lets the rest go, so Drive does not fill up. */
async function prune() {
  const keep = Math.max(1, config.backupKeep);
  const files = await drive.list();
  for (const file of files.slice(keep)) {
    await drive.remove(file.id).catch(() => {});
  }
}

// --- scheduling ------------------------------------------------------------

export function backupDue(now = Date.now()) {
  const last = lastSuccess();
  if (!last?.at) return true;
  // SQLite writes UTC with no zone marker, so it has to be said explicitly --
  // otherwise this is read as local time and the comparison is off by hours.
  const at = Date.parse(`${last.at.replace(' ', 'T')}Z`);
  if (Number.isNaN(at)) return true;
  return now - at >= config.backupIntervalDays * DAY;
}

/**
 * Checks hourly. Not because a backup is needed hourly, but because the check
 * is nearly free and it means a service that was asleep at the appointed hour
 * still catches up within the hour it comes back.
 */
export function startBackupSchedule() {
  if (!drive.driveConfigured()) return () => {};
  reapAbandoned();

  const tick = () => {
    if (!drive.driveConnected() || !backupDue()) return;
    runBackup({ reason: 'scheduled' })
      .then((result) => {
        if (result.ok) console.log(`[backup] uploaded ${result.name} (${result.bytes} bytes)`);
        else if (result.error) console.error(`[backup] failed: ${result.error}`);
      })
      .catch((err) => console.error('[backup] unexpected failure', err));
  };

  // Not on the instant of boot: a redeploy loop would otherwise start a backup
  // on every container that comes up.
  const first = setTimeout(tick, 60_000);
  timer = setInterval(tick, 3_600_000);
  timer.unref?.();
  first.unref?.();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export const backupState = async () => {
  const configured = drive.driveConfigured();
  const connected = configured && drive.driveConnected();
  let account = null;
  if (connected) account = await drive.account().catch(() => null);
  return {
    configured,
    connected,
    account,
    running,
    intervalDays: config.backupIntervalDays,
    keep: config.backupKeep,
    lastSuccess: lastSuccess()?.at || null,
    due: connected ? backupDue() : false,
    history: recentBackups(),
    push: pushSummary(),
  };
};
