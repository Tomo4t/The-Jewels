import { $, $$, escapeHTML } from '../lib/dom.js';
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
import { readJSON, KEYS } from '../lib/store.js';

/**
 * The navbar is built once and then only updated — the old version re-bound
 * every listener on each page change by cloning nodes, which quietly leaked
 * handlers and lost focus state.
 */

let initialised = false;

/**
 * The drawer.
 *
 * Eight icons and a title do not fit on a phone: the bar was down to 20px icons
 * at 360px wide, and an icon that small with no label is a guess -- a palette
 * and a globe mean nothing until you have tapped them once. So on a phone the
 * bar keeps the two things people came to do, chapters and their account, and
 * everything else moves behind the burger where there is room to write down
 * what it is.
 *
 * Only on a phone. At desktop widths there is space for the whole bar, and
 * putting it behind a tap there would be hiding things for no reason.
 *
 * The rows are two kinds and are not pretending to be one. Above the rule are
 * places you go, each with a chevron. Below it are settings, which show what
 * they are currently set to and change in place -- a chevron there would
 * promise a page that does not exist.
 */
const DRAWER_LINKS = [
  { href: '#home', icon: 'home.svg', key: 'nav.home' },
  { href: '#chapters', icon: 'chapters.svg', key: 'nav.chapters' },
  { href: '#fanart', icon: 'fanart.svg', key: 'nav.fanart' },
  { href: '#contact', icon: 'contact.svg', key: 'nav.contact' },
];

const drawerOpen = () => document.documentElement.classList.contains('drawer-open');

function setDrawer(open) {
  const drawer = $('#nav-drawer');
  const burger = $('#nav-burger');
  if (!drawer) return;

  document.documentElement.classList.toggle('drawer-open', open);
  burger?.setAttribute('aria-expanded', String(open));

  // inert rather than hidden: display: none cannot be transitioned, and a
  // drawer that is off-screen but still tabbable is a set of controls nobody
  // can see taking keyboard focus.
  if (open) drawer.removeAttribute('inert');
  else drawer.setAttribute('inert', '');

  if (open) drawer.querySelector('#drawer-close')?.focus();
  else burger?.focus();
}

const row = ({ tag = 'a', href, id, icon, label, extra = '' }) => `
  <${tag} class="drawer-row"${id ? ` id="${id}"` : ''}${
    tag === 'a' ? ` href="${href}"` : ' type="button"'
  }>
    <span class="drawer-icon" aria-hidden="true"><img src="/images/${icon}" alt=""></span>
    <span class="drawer-label">${label}</span>
    ${extra}
  </${tag}>`;

const CHEVRON = '<span class="drawer-chevron" aria-hidden="true"></span>';
const value = (id) => `<span class="drawer-value" id="${id}"></span>`;

function buildDrawer() {
  const drawer = $('#nav-drawer');
  if (!drawer) return;

  drawer.innerHTML = `
    <div class="drawer-head">
      <button type="button" class="drawer-close" id="drawer-close"
              title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(
                t('common.close')
              )}">
        <span aria-hidden="true"></span>
      </button>
    </div>

    <div class="drawer-rule" aria-hidden="true"></div>

    <div class="drawer-group">
      <a class="drawer-row drawer-row--feature" id="drawer-continue" hidden>
        <span class="drawer-icon" aria-hidden="true"><img src="/images/chapters.svg" alt=""></span>
        <span class="drawer-label">
          <span class="drawer-eyebrow" id="drawer-continue-label"></span>
          <span class="drawer-strong" id="drawer-continue-chapter"></span>
        </span>
        ${CHEVRON}
      </a>

      ${DRAWER_LINKS.map((link) =>
        row({
          href: link.href,
          icon: link.icon,
          label: `<span data-i18n="${link.key}">${escapeHTML(t(link.key))}</span>`,
          extra: CHEVRON,
        })
      ).join('')}

      ${row({
        href: '#signin',
        id: 'drawer-account',
        icon: 'account.svg',
        label: '<span id="drawer-account-label"></span>',
        extra: CHEVRON,
      })}
    </div>

    <div class="drawer-rule" aria-hidden="true"></div>

    <div class="drawer-group drawer-group--settings">
      <button type="button" class="drawer-row" id="drawer-language"
              aria-expanded="false" aria-controls="drawer-languages">
        <span class="drawer-icon" aria-hidden="true"><img src="/images/language.svg" alt=""></span>
        <span class="drawer-label" data-i18n="nav.language">${escapeHTML(t('nav.language'))}</span>
        ${value('drawer-language-value')}
        ${CHEVRON}
      </button>
      <ul class="drawer-sub" id="drawer-languages" hidden>
        ${LANGUAGES.map(
          (code) =>
            `<li><button type="button" class="drawer-sub-option" data-lang="${code}">${escapeHTML(
              LANGUAGE_NAMES[code]
            )}</button></li>`
        ).join('')}
      </ul>

      ${row({
        tag: 'button',
        id: 'drawer-theme',
        icon: 'sun.svg',
        label: `<span data-i18n="nav.themeName">${escapeHTML(t('nav.themeName'))}</span>`,
        extra: value('drawer-theme-value'),
      })}

      ${row({
        tag: 'button',
        id: 'drawer-sound',
        icon: 'sound.svg',
        label: `<span data-i18n="nav.soundName">${escapeHTML(t('nav.soundName'))}</span>`,
        extra: value('drawer-sound-value'),
      })}
    </div>

    <div class="drawer-rule" aria-hidden="true"></div>
  `;

  drawer.setAttribute('inert', '');

  // Going somewhere closes it. Every link in here is a hash change, and a
  // drawer still sitting over the page you just asked for is a drawer you have
  // to dismiss before you can read anything.
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) setDrawer(false);
  });

  $('#drawer-close')?.addEventListener('click', () => setDrawer(false));

  const languageRow = $('#drawer-language');
  const languageList = $('#drawer-languages');
  languageRow?.addEventListener('click', () => {
    const open = languageList.hidden;
    languageList.hidden = !open;
    languageRow.setAttribute('aria-expanded', String(open));
  });

  languageList?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-lang]');
    if (!option) return;
    await loadLanguage(option.dataset.lang);
    setDrawer(false);
  });

  $('#drawer-theme')?.addEventListener('click', () => {
    toggleTheme();
    updateNavbar();
  });

  $('#drawer-sound')?.addEventListener('click', () => {
    const on = toggleSound();
    updateNavbar();
    if (on) play('click');
  });
}

/** The parts of the drawer that depend on state. */
function updateDrawer() {
  // The drawer sits outside <header>, and updateNavbar only translates the
  // header -- so without this its labels would be written once in whatever
  // language was loaded first and never change again.
  const drawer = $('#nav-drawer');
  if (drawer) translateDOM(drawer);

  const account = $('#drawer-account');
  if (account) {
    account.hidden = !session.apiAvailable;
    const label = session.isSignedIn ? t('nav.profile') : t('auth.signIn');
    account.setAttribute('href', session.isSignedIn ? '#profile' : '#signin');
    const text = $('#drawer-account-label');
    if (text) text.textContent = label;
  }

  const dark = currentTheme() === 'dark';
  const themeValue = $('#drawer-theme-value');
  if (themeValue) themeValue.textContent = t(dark ? 'nav.dark' : 'nav.light');
  $('#drawer-theme')?.setAttribute('aria-pressed', String(dark));

  const on = soundEnabled();
  const soundValue = $('#drawer-sound-value');
  if (soundValue) soundValue.textContent = t(on ? 'nav.on' : 'nav.off');
  $('#drawer-sound')?.setAttribute('aria-pressed', String(on));

  const languageValue = $('#drawer-language-value');
  if (languageValue) languageValue.textContent = LANGUAGE_NAMES[currentLanguage()] || '';
  $$('.drawer-sub-option').forEach((option) => {
    option.setAttribute('aria-current', String(option.dataset.lang === currentLanguage()));
  });

  // Where they left off. The local copy only -- the account's copy needs a
  // request, and a menu row is not worth making somebody wait for one.
  const resume = $('#drawer-continue');
  if (!resume) return;
  const lang = currentLanguage();
  const progress = readJSON(KEYS.progress(lang), null);
  const chapter = Number(progress?.chapter);
  const page = Number(progress?.page) || 0;

  // Page 0 is the cover: nothing has been read yet, so there is nothing to
  // resume and the row would just be a second way to open chapter one.
  if (!chapter || page < 1) {
    resume.hidden = true;
    return;
  }

  resume.hidden = false;
  resume.setAttribute('href', `#reader?lang=${lang}&chapter=${chapter}&page=${page}`);
  const eyebrow = $('#drawer-continue-label');
  const name = $('#drawer-continue-chapter');
  if (eyebrow) eyebrow.textContent = t('home.continueReading');
  if (name) name.textContent = t('chapters.chapter', { n: chapter });
}

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
    if (event.key === 'Escape') {
      closeMenu();
      if (drawerOpen()) setDrawer(false);
    }
  });

  // --- the drawer ---
  buildDrawer();
  $('#nav-burger')?.addEventListener('click', () => setDrawer(!drawerOpen()));
  $('#nav-scrim')?.addEventListener('click', () => setDrawer(false));

  // A width change can take the drawer's reason for existing away while it is
  // still open -- rotating a phone, or dragging a window wider.
  window.matchMedia('(min-width: 601px)').addEventListener('change', (event) => {
    if (event.matches) setDrawer(false);
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

  updateDrawer();

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
