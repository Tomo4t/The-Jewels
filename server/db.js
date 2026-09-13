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
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('users', 'email', 'TEXT');
addColumn('users', 'email_verified_at', 'TEXT');
addColumn('users', 'google_sub', 'TEXT');

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google
  ON users(google_sub) WHERE google_sub IS NOT NULL;

-- Verification links. Only the SHA-256 of the token is stored, so a leaked
-- database cannot be replayed as a set of live verification links.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

-- Short-lived CSRF state for the OAuth round trip.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT    PRIMARY KEY,
  redirect_to TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL
);
`);

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
