/**
 * localStorage with the sharp edges removed.
 *
 * Storage throws in private windows and when a browser blocks site data, and
 * every read can return junk left by an older version of the site. Nothing in
 * the app should have to care, so every access is guarded here.
 */

let available = null;

function canUseStorage() {
  if (available !== null) return available;
  try {
    const probe = '__jewels_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

const memory = new Map();

export function read(key, fallback = null) {
  try {
    if (!canUseStorage()) return memory.has(key) ? memory.get(key) : fallback;
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    if (!canUseStorage()) {
      memory.set(key, String(value));
      return;
    }
    window.localStorage.setItem(key, String(value));
  } catch {
    memory.set(key, String(value));
  }
}

export function remove(key) {
  try {
    memory.delete(key);
    if (canUseStorage()) window.localStorage.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}

export function readJSON(key, fallback = null) {
  const raw = read(key, null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    write(key, JSON.stringify(value));
  } catch {
    /* value was not serialisable; not worth breaking the page over */
  }
}

export const KEYS = {
  language: 'language',
  theme: 'theme',
  sound: 'sound',
  readerMode: 'readerMode',
  progress: (lang) => `lastRead-${lang}`,
};
