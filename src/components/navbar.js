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

function collapseNeeded(navbar, left, title, actions) {
  if (!navbar || !left || !title || !actions) return window.innerWidth <= 640;
  if (window.innerWidth <= 640) return true;

  const styles = getComputedStyle(navbar);
  const padding = parseFloat(styles.paddingLeft || 0) + parseFloat(styles.paddingRight || 0);
  const available = navbar.clientWidth - padding;
  const needed =
    left.getBoundingClientRect().width +
    title.getBoundingClientRect().width +
    actions.getBoundingClientRect().width +
    24;

  return needed > available;
}

export function initNavbar() {
  if (initialised) {
    updateNavbar();
    return;
  }
  initialised = true;

  const navbar = $('.navbar');
  const navLeft = $('.nav-left');
  const navTitle = $('.nav-title');
  const navRight = $('.nav-right');
  const actions = $('#nav-right-actions');
  const menuButton = $('#nav-right-menu');
  const languageDropdown = $('#language-dropdown');
  const languageToggle = $('#language-toggle');
  const languageMenu = $('#language-menu');
  const themeButton = $('#theme-toggle');
  const soundButton = $('#sound-toggle');

  // --- responsive collapse ---
  let raf = null;
  const applyLayout = () => {
    if (!navbar || !menuButton) return;
    navbar.classList.remove('is-collapsed');
    const collapsed = collapseNeeded(navbar, navLeft, navTitle, actions);
    navbar.classList.toggle('is-collapsed', collapsed);
    menuButton.hidden = !collapsed;
    if (!collapsed) closeMenu();
  };
  const queueLayout = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(applyLayout);
  };

  const closeMenu = () => {
    navRight?.classList.remove('open');
    actions?.classList.remove('is-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    languageDropdown?.classList.remove('show');
    languageToggle?.setAttribute('aria-expanded', 'false');
  };

  menuButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = !navRight.classList.contains('open');
    navRight.classList.toggle('open', willOpen);
    actions?.classList.toggle('is-open', willOpen);
    menuButton.setAttribute('aria-expanded', String(willOpen));
    if (!willOpen) languageDropdown?.classList.remove('show');
  });

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
  });

  // --- sign in / out ---
  $('#account-action')?.addEventListener('click', async (event) => {
    if (!session.isSignedIn) return; // the anchor navigates to #signin on its own
    event.preventDefault();
    await session.signOut();
    closeMenu();
  });

  document.addEventListener('click', (event) => {
    if (!navbar?.contains(event.target)) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', queueLayout);
  document.addEventListener('languagechange', () => {
    updateNavbar();
    queueLayout();
  });
  session.subscribe(updateNavbar);

  updateNavbar();
  queueLayout();
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
  const accountLink = $('#account-link');
  const adminLink = $('#admin-link');

  if (accountLink) {
    accountLink.hidden = !session.apiAvailable || !session.isSignedIn;
    accountLink.textContent = t('nav.account');
  }

  if (account) {
    if (!session.apiAvailable) {
      account.hidden = true;
    } else if (session.isSignedIn) {
      account.hidden = false;
      account.textContent = t('auth.signOut');
      account.removeAttribute('href');
      account.setAttribute('role', 'button');
      account.tabIndex = 0;
    } else {
      account.hidden = false;
      account.textContent = t('auth.signIn');
      account.setAttribute('href', '#signin');
      account.removeAttribute('role');
    }
  }

  if (adminLink) adminLink.hidden = !session.isAdmin;
}
