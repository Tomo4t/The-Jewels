import db, { audit } from '../db.js';

/**
 * Credentials the site earns at runtime, kept out of the settings table.
 *
 * A refresh token is not a setting: it is never shown, never edited by hand,
 * and must not be handed to the admin panel along with everything else. Keeping
 * it in its own table makes "do not serialise this to a client" a property of
 * where it lives rather than a rule somebody has to remember.
 */

export function getSecret(key) {
  const row = db.prepare('SELECT value FROM app_secrets WHERE key = ?').get(key);
  return row?.value || '';
}

export function setSecret(key, value, actorId = null) {
  if (!value) {
    db.prepare('DELETE FROM app_secrets WHERE key = ?').run(key);
    audit(actorId, 'secret.cleared', 'secret', key);
    return;
  }
  db.prepare(
    `INSERT INTO app_secrets (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
  // The value never reaches the audit log -- only the fact that it changed.
  audit(actorId, 'secret.set', 'secret', key);
}

export const hasSecret = (key) => Boolean(getSecret(key));
