import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import db from '../db.js';
import config from '../config.js';

const BCRYPT_ROUNDS = 12;

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Sentinel stored in password_hash for accounts that have no password -- ones
 * created through Google. It is not a valid bcrypt hash, so bcrypt.compare can
 * never match it and password login for such an account always fails.
 */
export const UNUSABLE_PASSWORD = '!no-password';

const PUBLIC_FIELDS =
  'id, username, display_name, role, status, created_at, email, email_verified_at, google_sub';

export const toPublicUser = (row) =>
  row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
        emailVerified: Boolean(row.email_verified_at),
        // The comment stays; the person does not. The client says so in the
        // reader's own language rather than storing an English placeholder.
        deleted: Boolean(row.deleted_at),
      }
    : null;

/** Everything toPublicUser exposes, plus the fields only the owner may see. */
export const toPrivateUser = (row) =>
  row
    ? {
        ...toPublicUser(row),
        email: row.email || null,
        hasPassword: row.password_hash !== UNUSABLE_PASSWORD,
        linkedGoogle: Boolean(row.google_sub),
        // True for an account that has never been shown the names it is going
        // to appear under -- in practice a fresh Google sign-up, where the
        // server chose both from the Google profile without asking.
        profileSetupPending: !row.profile_setup_at,
        // The address a verification link is currently out for. Usually the
        // same as `email`; it differs -- with `email` null -- when somebody
        // signed up with an address another unconfirmed account is holding, and
        // without this the account simply reads as having no email at all while
        // a link for it sits in their inbox.
        pendingEmail: pendingEmailFor(row.id),
      }
    : null;

/**
 * The unexpired, unused verification address for this account, if any.
 *
 * Scoped to purpose 'verify' on purpose: this table also holds password-reset
 * tokens, and without that clause requesting a reset would make the profile
 * claim an email confirmation was pending.
 */
export function pendingEmailFor(userId) {
  const row = db
    .prepare(
      `SELECT email FROM email_tokens
        WHERE user_id = ? AND purpose = 'verify'
          AND used_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId);
  return row?.email || null;
}

export function findByUsername(username) {
  // A deleted account is a headstone, not somebody who can sign in -- and its
  // scrubbed username must not block a real person from taking that name.
  return db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL')
    .get(username);
}

export function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export async function createUser({
  username,
  password,
  displayName,
  role = 'user',
  email = null,
  emailVerified = false,
  googleSub = null,
}) {
  const hash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : UNUSABLE_PASSWORD;
  const info = db
    .prepare(
      `INSERT INTO users
         (username, display_name, password_hash, role, email, email_verified_at, google_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      username,
      (displayName || username).trim().slice(0, 40),
      hash,
      role,
      normaliseEmail(email),
      emailVerified ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
      googleSub
    );
  return findById(info.lastInsertRowid);
}

export async function verifyPassword(user, password) {
  if (user && user.password_hash === UNUSABLE_PASSWORD) {
    // Google-only account. Still pay the hashing cost so the timing matches.
    await bcrypt.compare(password, '$2a$12$ptCJnQBEjJ8BqZPtCZQFzOJmYt9gk7k5dxnQ1gWLqZ7C8wYb0/Fua');
    return false;
  }
  if (!user) {
    // Compare against a dummy hash so a missing user costs the same as a wrong
    // password — otherwise response timing reveals which usernames exist.
    await bcrypt.compare(password, '$2a$12$ptCJnQBEjJ8BqZPtCZQFzOJmYt9gk7k5dxnQ1gWLqZ7C8wYb0/Fua');
    return false;
  }
  return bcrypt.compare(password, user.password_hash);
}

export async function setPassword(userId, password) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

export function listUsers({ limit = 100, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT ${PUBLIC_FIELDS},
              (SELECT COUNT(*) FROM comments c WHERE c.user_id = users.id AND c.status != 'deleted')
                AS comment_count
       FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset)
    .map((row) => ({
      ...toPublicUser(row),
      email: row.email || null,
      linkedGoogle: Boolean(row.google_sub),
      commentCount: row.comment_count,
    }));
}

/**
 * The display name is the one the reader picked for themselves and may change
 * whenever they like. The username is an identity other people link to, so it
 * is settable exactly once -- see setUsernameDuringSetup.
 */
export function setDisplayName(userId, displayName) {
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
  return findById(userId);
}

/**
 * Only while profile_setup_at is still NULL. A Google sign-up never chose its
 * username -- suggestUsername did -- so this is the one chance to correct it,
 * and it closes the moment setup is marked done.
 */
export function setUsernameDuringSetup(userId, username) {
  const row = findById(userId);
  if (!row || row.profile_setup_at) return null;
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
  return findById(userId);
}

export function markProfileSetupDone(userId) {
  db.prepare("UPDATE users SET profile_setup_at = datetime('now') WHERE id = ?").run(userId);
  return findById(userId);
}

// --- reading progress ------------------------------------------------------

export function readProgress(userId, lang = null) {
  if (lang) {
    return (
      db
        .prepare(
          'SELECT lang, chapter, page, updated_at FROM reading_progress WHERE user_id = ? AND lang = ?'
        )
        .get(userId, lang) || null
    );
  }
  return db
    .prepare('SELECT lang, chapter, page, updated_at FROM reading_progress WHERE user_id = ?')
    .all(userId);
}

export function writeProgress(userId, lang, chapter, page) {
  db.prepare(
    `INSERT INTO reading_progress (user_id, lang, chapter, page, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, lang) DO UPDATE
       SET chapter = excluded.chapter,
           page = excluded.page,
           updated_at = excluded.updated_at`
  ).run(userId, lang, chapter, page);
  return readProgress(userId, lang);
}

/**
 * Deleting an account, the two ways somebody might mean it.
 *
 * 'purge' removes the row, and the database takes the comments, sessions,
 * tokens and bookmarks with it.
 *
 * 'anonymise' keeps what they wrote and removes them from it. The row has to
 * stay -- comments reference it and a cascade would take whole reply threads
 * down with it -- so everything identifying is scrubbed out of it instead and
 * it is marked as gone. Nothing can sign in to it afterwards: no address to
 * reset from, no Google identity, and a password hash that matches nothing.
 */
export const deleteAccount = db.transaction((userId, mode) => {
  const row = findById(userId);
  if (!row) return false;

  if (mode === 'purge') {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return true;
  }

  db.prepare(
    `UPDATE users
        SET username = ?, display_name = ?, email = NULL, email_verified_at = NULL,
            google_sub = NULL, password_hash = ?, deleted_at = datetime('now')
      WHERE id = ?`
  ).run(`deleted-${userId}`, `deleted-${userId}`, UNUSABLE_PASSWORD, userId);

  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM reading_progress WHERE user_id = ?').run(userId);
  return true;
});

/** How many admins are left, so the last one cannot lock everybody out. */
export function countAdmins() {
  return db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL")
    .get().n;
}

export function setRole(userId, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  return findById(userId);
}

export function setStatus(userId, status) {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  if (status === 'banned') destroyAllSessionsForUser(userId);
  return findById(userId);
}

// --- sessions -------------------------------------------------------------
// The cookie carries a random token; only its SHA-256 lives in the database, so
// a leaked database cannot be replayed as a set of live sessions.

const hashToken = (token) =>
  createHash('sha256').update(`${token}${config.sessionSecret}`).digest('hex');

export function createSession(userId, userAgent) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES (?, ?, datetime('now', ?), ?)`
  ).run(
    hashToken(token),
    userId,
    `+${config.sessionTtlDays} days`,
    (userAgent || '').slice(0, 300)
  );
  return token;
}

export function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;

  const row = db
    .prepare(
      `SELECT s.token_hash, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')
         AND u.deleted_at IS NULL`
    )
    .get(hashToken(token));

  if (!row) return null;

  // Constant-time confirmation, belt-and-braces against any lookup oddity.
  const expected = Buffer.from(row.token_hash, 'utf8');
  const actual = Buffer.from(hashToken(token), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (row.status === 'banned') return null;

  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// --- email and identity ---------------------------------------------------

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Addresses are compared and stored lowercased; the local part is left alone. */
export const normaliseEmail = (email) => {
  const value = String(email || '')
    .trim()
    .toLowerCase();
  return value ? value.slice(0, 254) : null;
};

export function findByEmail(email) {
  const value = normaliseEmail(email);
  if (!value) return undefined;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(value);
}

/**
 * Whether an address is spoken for in a way that should block someone else
 * taking it. An address nobody ever confirmed does not block: the claim flow
 * hands it to whoever proves ownership.
 */
export function emailIsClaimable(email, forUserId = null) {
  const holder = findByEmail(email);
  if (!holder) return true;
  if (forUserId && holder.id === forUserId) return true;
  return !holder.email_verified_at;
}

export function findByGoogleSub(sub) {
  if (!sub) return undefined;
  return db.prepare('SELECT * FROM users WHERE google_sub = ?').get(String(sub));
}

/** Attaches an address as unverified, clearing any previous verification. */
export function setEmail(userId, email) {
  db.prepare('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?').run(
    normaliseEmail(email),
    userId
  );
  return findById(userId);
}

/** The account currently holding an address, if it has been confirmed. */
export function verifiedHolderOf(email) {
  const value = normaliseEmail(email);
  if (!value) return undefined;
  return db
    .prepare('SELECT * FROM users WHERE email = ? AND email_verified_at IS NOT NULL')
    .get(value);
}

export function markEmailVerified(userId) {
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(userId);
  return findById(userId);
}

export function linkGoogle(userId, sub) {
  db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(String(sub), userId);
  return findById(userId);
}

/**
 * Derives a free username from a display name or email local part. Google gives
 * us neither a username nor any guarantee one is available, so this strips the
 * value to the allowed alphabet and appends a counter until it lands.
 */
export function suggestUsername(seed) {
  const base =
    String(seed || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 20) || 'reader';

  const padded = base.length >= 3 ? base : `${base}-reader`.slice(0, 20);
  if (!findByUsername(padded)) return padded;

  for (let n = 2; n < 1000; n += 1) {
    const suffix = String(n);
    const candidate = `${padded.slice(0, 24 - suffix.length - 1)}-${suffix}`;
    if (!findByUsername(candidate)) return candidate;
  }
  return `reader-${randomBytes(4).toString('hex')}`;
}

// --- verification tokens --------------------------------------------------
// Same shape as sessions: the link carries a random token, the database holds
// only its hash, so the table is useless to anyone who steals it.

export function createEmailToken(userId, email, purpose = 'verify') {
  const token = randomBytes(32).toString('base64url');
  const hours = purpose === 'reset' ? config.mail.resetTtlHours : config.mail.verifyTtlHours;

  // One live link per account per purpose: issuing a new one retires the old,
  // so a forwarded or re-requested link cannot be used twice over.
  db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(
    `INSERT INTO email_tokens (token_hash, user_id, email, purpose, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`
  ).run(hashToken(token), userId, normaliseEmail(email), purpose, `+${hours} hours`);
  return token;
}

/**
 * Redeems a verification link. Returns the user on success, or null if the
 * token is unknown, expired, already used, or the address has changed since it
 * was issued -- all of which are the same answer to the caller.
 */
/** Looks a token up without spending it. */
export function peekEmailToken(token, purpose) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const row = db
    .prepare(
      `SELECT * FROM email_tokens
       WHERE token_hash = ? AND purpose = ? AND used_at IS NULL
         AND expires_at > datetime('now')`
    )
    .get(hashToken(token), purpose);
  return row || null;
}

const spendToken = (tokenHash) =>
  db
    .prepare("UPDATE email_tokens SET used_at = datetime('now') WHERE token_hash = ?")
    .run(tokenHash);

/**
 * Redeems a verification link.
 *
 * The link proves one thing: whoever opened it controls `row.email`, and it was
 * issued to `row.user_id`. That is enough to settle a contested address, so
 * this also handles claiming -- an address sitting on an account that never
 * confirmed it is taken away and given to the person who proved ownership.
 *
 * A pending claim is never written to the account before this point. The unique
 * index on users(email) would refuse it, and more importantly, typing somebody
 * else's address should not take it from them until ownership is shown.
 */
export const redeemEmailToken = db.transaction((token) => {
  const row = peekEmailToken(token, 'verify');
  if (!row) return null;

  const user = findById(row.user_id);
  if (!user) return null;

  // Somebody has since confirmed this address for themselves. Their claim is
  // as strong as this one and got there first, so this link no longer carries.
  const verifiedHolder = db
    .prepare(
      `SELECT id FROM users
       WHERE email = ? AND id != ? AND email_verified_at IS NOT NULL`
    )
    .get(row.email, row.user_id);
  if (verifiedHolder) return null;

  spendToken(row.token_hash);

  const displaced = db
    .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
    .all(row.email, row.user_id);

  for (const other of displaced) {
    db.prepare('UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?').run(
      other.id
    );
    db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(other.id);
  }

  db.prepare("UPDATE users SET email = ?, email_verified_at = datetime('now') WHERE id = ?").run(
    row.email,
    row.user_id
  );

  return { user: findById(row.user_id), displaced: displaced.map((o) => o.id) };
});

/**
 * The address a still-live verification link was issued for. Used when the
 * account itself carries no address because the request was a claim on one
 * somebody else is holding.
 */
export function latestPendingAddress(userId) {
  const row = db
    .prepare(
      `SELECT email FROM email_tokens
       WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL
         AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId);
  return row ? row.email : null;
}

/** Spends a reset link and returns the account it belongs to. */
export function redeemResetToken(token) {
  const row = peekEmailToken(token, 'reset');
  if (!row) return null;
  const user = findById(row.user_id);
  if (!user || user.email !== row.email) return null;
  spendToken(row.token_hash);
  return user;
}

// --- OAuth state ----------------------------------------------------------

export function createOAuthState(redirectTo) {
  const state = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO oauth_states (state, redirect_to, expires_at)
     VALUES (?, ?, datetime('now', '+15 minutes'))`
  ).run(state, redirectTo || null);
  return state;
}

/** Single-use: consuming a state deletes it, so a replayed callback fails. */
export function consumeOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const row = db
    .prepare("SELECT * FROM oauth_states WHERE state = ? AND expires_at > datetime('now')")
    .get(state);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  return row || null;
}
