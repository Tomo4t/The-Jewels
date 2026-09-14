import db, { audit } from '../db.js';
import config from '../config.js';

/**
 * Settings an administrator can change at runtime.
 *
 * Each one falls back to its environment value until somebody overrides it, so
 * a fresh deployment behaves exactly as its configuration says and nothing
 * silently diverges from the .env a operator wrote.
 *
 * Values are stored as text and coerced on read, because SQLite has no boolean
 * and a setting that reads back as the string "false" would be truthy.
 */

export const DEFINITIONS = {
  moderationQueue: {
    type: 'boolean',
    fallback: () => config.moderationQueue,
    describe: 'Hold new comments for approval before they appear.',
  },
  requireVerifiedEmail: {
    type: 'boolean',
    fallback: () => config.requireVerifiedEmail,
    describe: 'Require a confirmed email address before somebody can comment.',
  },
  allowRegistration: {
    type: 'boolean',
    fallback: () => config.allowRegistration,
    describe: 'Allow new accounts to be created.',
  },
  bannedWords: {
    type: 'text',
    fallback: () => '',
    describe: 'Words and phrases to catch, one per line. Matching is case-insensitive.',
  },
  bannedWordsAction: {
    type: 'text',
    fallback: () => 'hold',
    describe: 'What to do with a comment containing one: hold it for approval, or reject it.',
  },
  commentCooldownMinutes: {
    type: 'number',
    fallback: () => 5,
    describe: 'How recently five posts from one reader counts as posting too fast.',
  },
  commentDuplicateHours: {
    type: 'number',
    fallback: () => 24,
    describe: 'How long the same comment posted twice by one reader counts as a duplicate.',
  },
};

const cache = new Map();

const coerce = (type, raw) => {
  if (type === 'boolean') return raw === 'true';
  if (type === 'number') return Number(raw);
  return raw;
};

export function getSetting(key) {
  const definition = DEFINITIONS[key];
  if (!definition) throw new Error(`Unknown setting: ${key}`);

  if (cache.has(key)) return cache.get(key);

  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = row ? coerce(definition.type, row.value) : definition.fallback();
  cache.set(key, value);
  return value;
}

export function setSetting(key, value, actorId) {
  const definition = DEFINITIONS[key];
  if (!definition) throw new Error(`Unknown setting: ${key}`);

  let stored;
  if (definition.type === 'boolean') stored = String(Boolean(value));
  else if (definition.type === 'number') {
    const n = Number(value);
    // A setting that reads back as NaN would silently disable the rule it
    // governs, so a nonsense value falls back rather than being stored.
    stored = String(Number.isFinite(n) && n >= 0 ? n : definition.fallback());
  } else stored = String(value);
  db.prepare(
    `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = datetime('now'),
                                    updated_by = excluded.updated_by`
  ).run(key, stored, actorId ?? null);

  cache.delete(key);
  audit(actorId, 'setting.changed', 'setting', key, { value: stored });
  return getSetting(key);
}

/** Every setting with its current value and where that value came from. */
export function allSettings() {
  const stored = new Map(
    db
      .prepare('SELECT key, value FROM settings')
      .all()
      .map((r) => [r.key, r.value])
  );
  return Object.fromEntries(
    Object.entries(DEFINITIONS).map(([key, definition]) => [
      key,
      {
        value: getSetting(key),
        type: definition.type,
        source: stored.has(key) ? 'admin' : 'environment',
        describe: definition.describe,
      },
    ])
  );
}

/** Test helper: drops the memoised values so a changed row is picked up. */
export const clearSettingsCache = () => cache.clear();
