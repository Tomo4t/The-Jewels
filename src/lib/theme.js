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

  // Colour transitions are enabled only while the theme is actually changing,
  // so they never slow down a normal page load or route change.
  // Held a little longer than the swap itself (--theme-swap is 420ms), because
  // taking the class off mid-transition is what made the last few frames snap.
  root.classList.add('theme-changing');
  clearTimeout(applyTheme.settle);
  applyTheme.settle = setTimeout(() => root.classList.remove('theme-changing'), 560);

  // The reflow is load-bearing, not superstition. A transition only starts if
  // the property already had a duration in the style BEFORE the value changed,
  // and adding the class and flipping the theme in the same task means it did
  // not. Standard properties got away with it; the custom properties the icon
  // filters are built from did not, so every icon jumped from near-black to
  // near-white in one frame while the surface behind it was still arriving.
  // Measured either way: without this the number is at its destination two
  // frames in, with it the same number reads 0.36 of the way across at 170ms.
  void root.offsetWidth;

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
