import { createHmac, timingSafeEqual } from 'node:crypto';
import db, { audit } from '../db.js';
import config from '../config.js';

/**
 * Who has asked to hear from the site, and how a message gets to them.
 *
 * Two rules shape everything here. Nothing is ever sent to somebody who did not
 * ask -- both opt-ins default to off and a confirmed address is required, so a
 * mistyped address can never be signed up by a stranger. And every message
 * carries a way out that works from an old email, years later, without signing
 * in: an unsubscribe that needs an account is not an unsubscribe.
 */

export const KINDS = ['newsletter', 'release'];
const COLUMN = { newsletter: 'newsletter_opt_in', release: 'release_opt_in' };

// --- who wants what --------------------------------------------------------

export function preferencesFor(userId) {
  const row = db
    .prepare('SELECT newsletter_opt_in, release_opt_in FROM users WHERE id = ?')
    .get(userId);
  return {
    newsletter: Boolean(row?.newsletter_opt_in),
    release: Boolean(row?.release_opt_in),
  };
}

export function setPreference(userId, kind, on, actorId = null) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown notification kind: ${kind}`);
  db.prepare(`UPDATE users SET ${COLUMN[kind]} = ? WHERE id = ?`).run(on ? 1 : 0, userId);
  audit(actorId ?? userId, on ? 'notify.opted_in' : 'notify.opted_out', 'user', userId, { kind });
  return preferencesFor(userId);
}

/**
 * Everybody who should get this kind of message.
 *
 * A confirmed address is required, not merely an address: an unconfirmed one
 * may well belong to somebody else who never asked for any of this, and sending
 * to it is how a site earns a spam complaint it deserves.
 */
export function subscribersFor(kind, lang = null) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown notification kind: ${kind}`);

  // An empty mail_langs is "no preference", so those readers match every
  // language. The commas around both sides are what stop 'es' matching inside
  // a longer code; it is a LIKE rather than a join table because the list is
  // five entries long and will never be queried on its own.
  const byLanguage = lang
    ? `AND (mail_langs = '' OR ',' || mail_langs || ',' LIKE '%,' || @lang || ',%')`
    : '';

  return db
    .prepare(
      `SELECT id, email, display_name AS displayName
         FROM users
        WHERE ${COLUMN[kind]} = 1
          AND email IS NOT NULL
          AND email_verified_at IS NOT NULL
          AND deleted_at IS NULL
          AND status != 'banned'
          ${byLanguage}
        ORDER BY id`
    )
    .all(lang ? { lang } : {});
}

// --- which languages ------------------------------------------------------

/**
 * The languages a reader wants to hear about, or an empty array meaning "any".
 *
 * This governs release announcements as well as the newsletter, and that is the
 * point: a chapter shipping in five languages used to mail every subscriber
 * five times, because the announcement loop ran per language over a recipient
 * list that had no language in it.
 */
export function mailLanguages(userId) {
  const row = db.prepare('SELECT mail_langs FROM users WHERE id = ?').get(userId);
  return String(row?.mail_langs || '')
    .split(',')
    .filter(Boolean);
}

export function setMailLanguages(userId, langs, actorId = null) {
  const clean = [...new Set((langs || []).filter((code) => config.languages.includes(code)))];
  // Every language is the same as no preference, and storing it as no
  // preference means a reader who later gets a sixth language still gets it.
  const value = clean.length === config.languages.length ? '' : clean.sort().join(',');
  db.prepare('UPDATE users SET mail_langs = ? WHERE id = ?').run(value, userId);
  audit(actorId ?? userId, 'notify.languages', 'user', userId, { langs: value || 'all' });
  return mailLanguages(userId);
}

// --- leaving ---------------------------------------------------------------

/**
 * A signed unsubscribe token.
 *
 * Deliberately stateless and without an expiry. A stored token would have to
 * live forever to be any use -- people unsubscribe from mail they find two
 * years later -- and an expiring one turns into a dead link that leaves the
 * reader with no way out but a spam complaint. The signature makes it
 * unforgeable without keeping anything.
 */
const sign = (payload) =>
  createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

export function unsubscribeToken(userId, kind) {
  const payload = `${userId}.${kind}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function readUnsubscribeToken(token) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString();
  } catch {
    return null;
  }

  const expected = sign(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const [userId, kind] = payload.split('.');
  if (!KINDS.includes(kind)) return null;
  return { userId: Number(userId), kind };
}

export const unsubscribeUrl = (userId, kind) =>
  `${config.publicOrigin}/api/notify/unsubscribe?token=${encodeURIComponent(
    unsubscribeToken(userId, kind)
  )}`;

// --- the queue -------------------------------------------------------------

const enqueueOne = db.prepare(
  `INSERT INTO mail_queue (user_id, address, subject, html, text, kind, dedupe_key)
   VALUES (@userId, @address, @subject, @html, @text, @kind, @dedupeKey)
   ON CONFLICT(dedupe_key) DO NOTHING`
);

/**
 * Adds messages to the queue.
 *
 * `dedupeKey` is what makes announcing a chapter safe to attempt twice: the
 * second attempt collides and writes nothing, so a restart mid-announcement
 * cannot mail the same chapter to the same reader again.
 */
export const enqueue = db.transaction((messages) => {
  let added = 0;
  for (const message of messages) {
    const result = enqueueOne.run({ dedupeKey: null, ...message });
    added += result.changes;
  }
  return added;
});

export const queueDepth = () =>
  db.prepare(`SELECT COUNT(*) AS n FROM mail_queue WHERE status = 'queued'`).get().n;

export const sentToday = () =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM mail_queue
        WHERE status = 'sent' AND sent_at >= datetime('now', '-1 day')`
    )
    .get().n;

export const nextBatch = (limit) =>
  db.prepare(`SELECT * FROM mail_queue WHERE status = 'queued' ORDER BY id LIMIT ?`).all(limit);

export const markSent = db.prepare(
  `UPDATE mail_queue SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
);

/**
 * A failure is retried a few times and then given up on.
 *
 * Retrying forever would wedge the queue behind one bad address: every later
 * message waits on a send that is never going to succeed.
 */
export const markAttempt = db.transaction((id, error, maxAttempts) => {
  const row = db.prepare('SELECT attempts FROM mail_queue WHERE id = ?').get(id);
  const attempts = (row?.attempts || 0) + 1;
  db.prepare(`UPDATE mail_queue SET attempts = ?, error = ?, status = ? WHERE id = ?`).run(
    attempts,
    String(error).slice(0, 300),
    attempts >= maxAttempts ? 'failed' : 'queued',
    id
  );
  return attempts;
});

export const queueSummary = () => ({
  queued: queueDepth(),
  sentToday: sentToday(),
  failed: db.prepare(`SELECT COUNT(*) AS n FROM mail_queue WHERE status = 'failed'`).get().n,
  subscribers: {
    newsletter: subscribersFor('newsletter').length,
    release: subscribersFor('release').length,
  },
});
