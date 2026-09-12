import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import db from '../db.js';
import config from '../config.js';

const BCRYPT_ROUNDS = 12;

export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
export const MIN_PASSWORD_LENGTH = 10;

const PUBLIC_FIELDS = 'id, username, display_name, role, status, created_at';

export const toPublicUser = (row) =>
  row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        createdAt: row.created_at,
      }
    : null;

export function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

export function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export async function createUser({ username, password, displayName, role = 'user' }) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const info = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES (?, ?, ?, ?)`
    )
    .run(username, (displayName || username).trim().slice(0, 40), hash, role);
  return findById(info.lastInsertRowid);
}

export async function verifyPassword(user, password) {
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
    .map((row) => ({ ...toPublicUser(row), commentCount: row.comment_count }));
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
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
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
