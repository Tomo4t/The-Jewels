import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from './config.js';

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);

// Durability + concurrency defaults that suit a small single-server deployment.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'user'
                         CHECK (role IN ('user', 'moderator', 'admin')),
  status         TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'banned')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT
);

-- Outbound mail waits here rather than going out inside a request.
-- The provider's plan caps how many messages a day it will take, so a send to
-- every subscriber is drained over time by a worker; and because the queue is
-- on disk, a container that restarts halfway through resumes instead of either
-- stopping silently or starting the whole send again.
CREATE TABLE IF NOT EXISTS mail_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  address     TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  html        TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  dedupe_key  TEXT    UNIQUE,
  status      TEXT    NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_queue_pending ON mail_queue(status, id);

-- A chapter does not "become released"; releaseAt simply passes and every
-- later read reports it as out. There is no event to hang an announcement on,
-- so one is recorded here the first time a chapter is seen to be out, and the
-- primary key is what stops a rescheduled chapter mailing everybody twice.
CREATE TABLE IF NOT EXISTS announcements (
  lang         TEXT    NOT NULL,
  chapter      INTEGER NOT NULL,
  announced_at TEXT    NOT NULL DEFAULT (datetime('now')),
  recipients   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lang, chapter)
);

CREATE TABLE IF NOT EXISTS newsletters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject    TEXT    NOT NULL DEFAULT '',
  blocks     TEXT    NOT NULL DEFAULT '[]',
  status     TEXT    NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'sending', 'sent')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  failures   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS app_secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  bytes       INTEGER,
  file_name   TEXT,
  remote_id   TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status, id DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lang           TEXT    NOT NULL,
  chapter        INTEGER NOT NULL,
  parent_id      INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('visible', 'pending', 'rejected', 'deleted')),
  flag_reason    TEXT,
  flag_score     REAL    NOT NULL DEFAULT 0,
  flag_source    TEXT,
  edited         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  moderated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_chapter ON comments(lang, chapter, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_status  ON comments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_user    ON comments(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT    NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  detail       TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

db.exec(SCHEMA);

/**
 * Additive migrations.
 *
 * The schema above uses CREATE TABLE IF NOT EXISTS, which never touches a table
 * that already exists -- so columns added after a deployment has run have to be
 * applied separately. Each one is guarded by the live column list, making this
 * safe to run on every boot.
 */
function addColumn(table, column, definition) {
  const present = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (present) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

addColumn('users', 'email', 'TEXT');
addColumn('users', 'email_verified_at', 'TEXT');
addColumn('users', 'google_sub', 'TEXT');
// NULL until the owner has been shown, and had a chance to change, the name
// they will appear under. A Google sign-up never chose either name -- the
// server picked both from the Google profile -- so this marks the one moment
// the username is still theirs to set.
//
// Everyone already on the site registered by hand and typed their own
// username, so the backfill closes the window for them the one time the
// column appears. Only accounts created after this, by Google, start NULL.
// Set when somebody deletes their account but asks to keep what they wrote.
// The row has to survive -- comments reference it, and ON DELETE CASCADE would
// take every reply thread with it -- so it is scrubbed and marked instead.
addColumn('users', 'deleted_at', 'TEXT');

if (addColumn('users', 'profile_setup_at', 'TEXT')) {
  db.exec("UPDATE users SET profile_setup_at = COALESCE(created_at, datetime('now'))");
}

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google
  ON users(google_sub) WHERE google_sub IS NOT NULL;

-- Verification and password-reset links. Only the SHA-256 of the token is
-- stored, so a leaked database cannot be replayed as a set of live links.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

-- Settings an administrator can change while the site is running. Anything
-- absent here falls back to the environment, so a fresh deployment behaves
-- exactly as its configuration says until somebody changes something.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Where each reader is in each language. Kept on the account as well as in
-- the browser so "continue reading" survives a browser that clears its
-- storage, and follows the reader from a phone to a desktop.
CREATE TABLE IF NOT EXISTS reading_progress (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang       TEXT    NOT NULL,
  chapter    INTEGER NOT NULL,
  page       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lang)
);

-- Short-lived CSRF state for the OAuth round trip.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT    PRIMARY KEY,
  redirect_to TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL
);
`);

// The token table shipped carrying verification links only. Reset links share
// it, so rows need to say which they are; everything already stored is a
// verification link.
addColumn('email_tokens', 'purpose', "TEXT NOT NULL DEFAULT 'verify'");
// Opting in is a deliberate act, so both default to off: an account that never
// asked for mail must never receive any.
addColumn('users', 'newsletter_opt_in', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'release_opt_in', 'INTEGER NOT NULL DEFAULT 0');

/** Remove expired sessions. Cheap enough to run on boot and on a timer. */
export function pruneSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

/** Drop verification links and OAuth states that can no longer be redeemed. */
export function pruneEphemeral() {
  db.prepare("DELETE FROM email_tokens WHERE expires_at <= datetime('now')").run();
  db.prepare("DELETE FROM oauth_states WHERE expires_at <= datetime('now')").run();
}

/** Record a moderation or administrative action for later review. */
export function audit(actorId, action, targetType, targetId, detail) {
  db.prepare(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    actorId ?? null,
    action,
    targetType ?? null,
    targetId == null ? null : String(targetId),
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail)
  );
}

const prune = () => {
  pruneSessions();
  pruneEphemeral();
};

prune();
setInterval(prune, 60 * 60 * 1000).unref();

export default db;
