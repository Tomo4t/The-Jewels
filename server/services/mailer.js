import db from '../db.js';
import config, { mailEnabled } from '../config.js';
import { sendQueued } from './email.js';
import {
  KINDS,
  enqueue,
  markAttempt,
  markSent,
  nextBatch,
  queueSummary,
  sentToday,
  subscribersFor,
  unsubscribeUrl,
} from './notifications.js';
import { listChapters } from './content.js';
import { releaseEmail } from './templates.js';
import { pushToUser } from './push.js';

/**
 * Drains the mail queue, and notices when a chapter has gone live.
 *
 * Both run on a timer for the same reason the backup does: Railway restarts the
 * container on every deploy, so anything holding its state in memory loses its
 * place. Everything that matters is a row -- what has been sent, what has been
 * announced -- and the timer only ever asks "what still needs doing".
 */

const LANGUAGES = ['en', 'fr', 'es', 'ja', 'pl'];
const MAX_ATTEMPTS = 3;

let draining = false;
let timers = [];

// --- draining --------------------------------------------------------------

/**
 * Sends what the plan still allows today.
 *
 * The provider's free tier is a few hundred messages a day. Going over does not
 * fail politely -- it fails the send -- so the cap is respected here and the
 * rest simply waits for tomorrow's tick. A subscriber list larger than the cap
 * therefore goes out over several days rather than not at all.
 */
export async function drainQueue() {
  if (draining || !mailEnabled()) return { drained: 0 };
  draining = true;

  let sent = 0;
  let stopped = null;

  try {
    const remaining = Math.max(0, config.mail.dailyLimit - sentToday());
    if (remaining === 0) return { drained: 0, stopped: 'daily_limit' };

    const batch = nextBatch(Math.min(remaining, config.mail.batchSize));
    for (const message of batch) {
      // Derived rather than stored: it is a pure function of the reader and
      // the kind, and a column holding a signed URL would only go stale.
      const result = await sendQueued({
        ...message,
        unsubscribeUrl:
          message.user_id && KINDS.includes(message.kind)
            ? unsubscribeUrl(message.user_id, message.kind)
            : null,
      });
      if (result.sent) {
        markSent.run(message.id);
        sent += 1;
      } else {
        const attempts = markAttempt(message.id, result.reason || 'unknown', MAX_ATTEMPTS);
        // A rejected key or a blocked domain will reject every other message
        // in this batch too. Stopping leaves them queued for the next tick
        // rather than burning all three attempts on each in a few seconds.
        if (result.reason?.startsWith('http_4')) {
          stopped = result.reason;
          break;
        }
        void attempts;
      }
      // Gentle on the provider's rate limit; the queue is not in a hurry.
      await new Promise((resolve) => setTimeout(resolve, config.mail.sendSpacingMs));
    }
  } finally {
    draining = false;
  }

  if (sent) console.log(`[mail] sent ${sent}`);
  return { drained: sent, stopped };
}

// --- announcing ------------------------------------------------------------

const alreadyAnnounced = db.prepare('SELECT 1 FROM announcements WHERE lang = ? AND chapter = ?');
const recordAnnouncement = db.prepare(
  'INSERT OR IGNORE INTO announcements (lang, chapter, recipients) VALUES (?, ?, ?)'
);

/**
 * Finds chapters that are out but have never been announced, and queues the
 * notifications for them.
 *
 * The announcement row is written in the same breath as the queue rows, so a
 * crash between the two cannot announce a chapter twice -- and the per-message
 * dedupe key means even a torn write could not.
 */
export async function announceNewChapters({ silent = false } = {}) {
  const readers = subscribersFor('release');
  let announced = 0;

  for (const lang of LANGUAGES) {
    let chapters = [];
    try {
      chapters = await listChapters(lang);
    } catch {
      continue;
    }

    for (const chapter of chapters) {
      if (chapter.released === false || chapter.archived) continue;
      if (alreadyAnnounced.get(lang, chapter.number)) continue;

      // The first run on an existing site would otherwise announce the whole
      // back catalogue to everybody. Recording without sending marks history as
      // already seen; only chapters published from now on go out.
      const backfill = silent;

      const messages = backfill
        ? []
        : readers.map((reader) => {
            const mail = releaseEmail({
              displayName: reader.displayName,
              lang,
              chapter,
              unsubscribe: unsubscribeUrl(reader.id, 'release'),
            });
            return {
              userId: reader.id,
              address: reader.email,
              subject: mail.subject,
              html: mail.html,
              text: mail.text,
              kind: 'release',
              dedupeKey: `release:${lang}:${chapter.number}:${reader.id}`,
            };
          });

      const queued = messages.length ? enqueue(messages) : 0;
      recordAnnouncement.run(lang, chapter.number, queued);
      announced += 1;

      if (!backfill) {
        await pushToUsers(readers, lang, chapter);
        if (queued) console.log(`[notify] ${lang} chapter ${chapter.number}: queued ${queued}`);
      }
    }
  }
  return { announced };
}

async function pushToUsers(readers, lang, chapter) {
  for (const reader of readers) {
    await pushToUser(reader.id, {
      title: chapter.title,
      body: `Chapter ${chapter.number} is out now.`,
      url: `/#reader?lang=${lang}&chapter=${chapter.number}&page=0`,
    }).catch(() => {});
  }
}

// --- the timers ------------------------------------------------------------

export function startMailWorker() {
  // A site that already has chapters must not announce its back catalogue the
  // first time this code runs. One silent pass marks everything currently out
  // as seen; everything published afterwards is genuinely new.
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n > 0;
  announceNewChapters({ silent: !seeded }).catch((err) =>
    console.error('[notify] first pass failed', err)
  );

  const announceTimer = setInterval(() => {
    announceNewChapters().catch((err) => console.error('[notify] announce failed', err));
  }, config.mail.announceEveryMs);

  const drainTimer = setInterval(() => {
    drainQueue().catch((err) => console.error('[mail] drain failed', err));
  }, config.mail.drainEveryMs);

  timers = [announceTimer, drainTimer];
  for (const timer of timers) timer.unref?.();

  return () => timers.forEach(clearInterval);
}

export { queueSummary };
