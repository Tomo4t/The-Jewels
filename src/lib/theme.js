import { read, write, KEYS } from './store.js';

/**
 * Theme state lives in exactly one place: a `dark` class on <html>.
 *
 * The previous version toggled `<body>` in one file and `<html>` in another,
 * then reloaded the whole page to paper over the disagreement.
 */

const root = document.documentElement;

export function currentTheme() {
  return root.classList.contains('dark') ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const dark = theme === 'dark';
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  write(KEYS.theme, dark ? 'dark' : 'light');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#14101c' : '#f4eee6');

  document.dispatchEvent(
    new CustomEvent('themechange', { detail: { theme: dark ? 'dark' : 'light' } })
  );
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Resolves the startup theme: explicit choice first, then system preference. */
export function initTheme() {
  const saved = read(KEYS.theme, null);
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}
