import { $, $$ } from '../lib/dom.js';
import {
  t,
  translateDOM,
  LANGUAGES,
  LANGUAGE_NAMES,
  currentLanguage,
  loadLanguage,
} from '../lib/i18n.js';
import { toggleTheme, currentTheme } from '../lib/theme.js';
import { soundEnabled, toggleSound, play } from '../lib/sound.js';
import session from '../lib/session.js';

/**
 * The navbar is built once and then only updated — the old version re-bound
 * every listener on each page change by cloning nodes, which quietly leaked
 * handlers and lost focus state.
 */

let initialised = false;

export function initNavbar() {
  if (initialised) {
    updateNavbar();
    return;
  }
  initialised = true;

  const navbar = $('.navbar');
  const languageDropdown = $('#language-dropdown');
  const languageToggle = $('#language-toggle');
  const languageMenu = $('#language-menu');
  const themeButton = $('#theme-toggle');
  const soundButton = $('#sound-toggle');

  // Every control is on the bar at every width now -- there is no burger and no
  // collapsed panel, so the only thing that still opens and closes is the
  // language list.
  const closeMenu = () => {
    languageDropdown?.classList.remove('show');
    languageToggle?.setAttribute('aria-expanded', 'false');
  };

  // --- language menu ---
  languageMenu.innerHTML = LANGUAGES.map(
    (code) =>
      `<li role="none"><button type="button" role="menuitem" class="language-option" data-lang="${code}" data-sound="slide">${LANGUAGE_NAMES[code]}</button></li>`
  ).join('');

  languageToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !languageDropdown.classList.contains('show');
    languageDropdown.classList.toggle('show', open);
    languageToggle.setAttribute('aria-expanded', String(open));
  });

  languageMenu.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-lang]');
    if (!option) return;
    event.stopPropagation();
    await loadLanguage(option.dataset.lang);
    closeMenu();
  });

  // --- theme and sound ---
  themeButton?.addEventListener('click', () => {
    toggleTheme();
    updateNavbar();
  });

  soundButton?.addEventListener('click', () => {
    const on = toggleSound();
    updateNavbar();
    if (on) play('click');

    // Restart the animation on every press. Removing the class and forcing a
    // reflow before re-adding it is what makes a repeated click replay it
    // instead of being ignored as a no-op class change.
    soundButton.classList.remove('is-animating', 'is-shaking');
    void soundButton.offsetWidth;
    soundButton.classList.add(on ? 'is-animating' : 'is-shaking');
  });

  soundButton?.addEventListener('animationend', () => {
    soundButton.classList.remove('is-animating', 'is-shaking');
  });

  // --- sign in / out ---
  // Signing out is a profile-page action now; the navbar icon is pure
  // navigation and needs no handler of its own.

  document.addEventListener('click', (event) => {
    if (!navbar?.contains(event.target)) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  document.addEventListener('languagechange', updateNavbar);
  session.subscribe(updateNavbar);

  updateNavbar();
}

/** Re-renders the parts of the navbar that depend on state. */
export function updateNavbar() {
  translateDOM(document.querySelector('header.navbar') || document);

  const dark = currentTheme() === 'dark';
  const themeButton = $('#theme-toggle');
  themeButton?.setAttribute('aria-pressed', String(dark));
  themeButton?.setAttribute('title', t('nav.theme'));

  const soundButton = $('#sound-toggle');
  const on = soundEnabled();
  soundButton?.classList.toggle('is-muted', !on);
  soundButton?.setAttribute('aria-pressed', String(on));
  soundButton?.setAttribute('title', t('nav.sound'));

  $('#language-toggle')?.setAttribute('title', t('nav.language'));
  $$('.language-option').forEach((option) => {
    option.setAttribute('aria-current', String(option.dataset.lang === currentLanguage()));
  });

  const account = $('#account-action');

  // One icon with two destinations: the profile when there is somebody to show
  // a profile for, the sign-in page otherwise. Signing out and the admin panel
  // both live on the profile page now, so the navbar stays four icons a side.
  if (account) {
    account.hidden = !session.apiAvailable;
    const label = session.isSignedIn ? t('nav.profile') : t('auth.signIn');
    account.setAttribute('href', session.isSignedIn ? '#profile' : '#signin');
    account.setAttribute('title', label);
    account.setAttribute('aria-label', label);
  }
}
