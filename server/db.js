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

/** Remove expired sessions. Cheap enough to run on boot and on a timer. */
export function pruneSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
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

pruneSessions();
setInterval(pruneSessions, 60 * 60 * 1000).unref();

export default db;
