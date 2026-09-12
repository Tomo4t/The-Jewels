import { read, write, KEYS } from './store.js';

/**
 * Translations are loaded on demand, one language at a time, so the initial
 * bundle carries only the language actually being read.
 */

const bundles = import.meta.glob('../i18n/*.json');

export const LANGUAGES = ['en', 'ja', 'pl', 'es', 'fr'];
export const LANGUAGE_NAMES = {
  en: 'English',
  ja: '日本語',
  pl: 'Polski',
  es: 'Español',
  fr: 'Français',
};

const cache = new Map();
let active = 'en';
let strings = {};

export const currentLanguage = () => active;

/** Picks a sensible starting language: saved choice, then browser, then English. */
export function preferredLanguage() {
  const saved = read(KEYS.language, null);
  if (saved && LANGUAGES.includes(saved)) return saved;

  for (const tag of navigator.languages || [navigator.language || 'en']) {
    const code = String(tag).toLowerCase().split('-')[0];
    if (LANGUAGES.includes(code)) return code;
  }
  return 'en';
}

export async function loadLanguage(lang) {
  const code = LANGUAGES.includes(lang) ? lang : 'en';

  if (!cache.has(code)) {
    const loader = bundles[`../i18n/${code}.json`];
    if (!loader) throw new Error(`No translations bundled for "${code}".`);
    const module = await loader();
    cache.set(code, module.default || module);
  }

  active = code;
  strings = cache.get(code);
  write(KEYS.language, code);

  const meta = strings.meta || {};
  document.documentElement.lang = code;
  document.documentElement.dir = meta.dir || 'ltr';

  document.dispatchEvent(new CustomEvent('languagechange', { detail: { lang: code } }));
  return strings;
}

/**
 * Looks up a dotted key, e.g. t('comments.empty').
 * Missing keys return the key itself so a gap is visible rather than blank.
 */
export function t(key, vars) {
  let value = key
    .split('.')
    .reduce((node, part) => (node == null ? undefined : node[part]), strings);

  if (typeof value !== 'string') return key;
  if (vars) {
    value = value.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    );
  }
  return value;
}

/** Rewrites every [data-i18n] node in a subtree. */
export function translateDOM(scope = document) {
  scope.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  scope.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    // Format: data-i18n-attr="title:nav.home aria-label:nav.home"
    for (const pair of node.dataset.i18nAttr.split(/\s+/)) {
      const [attr, key] = pair.split(':');
      if (attr && key) node.setAttribute(attr, t(key));
    }
  });
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return String(value);

  try {
    return new Intl.DateTimeFormat(strings.meta?.locale || active, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** "3 minutes ago" style stamps for comments. */
export function formatRelative(value) {
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  try {
    const rtf = new Intl.RelativeTimeFormat(strings.meta?.locale || active, { numeric: 'auto' });
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
    }
    return rtf.format(Math.round(seconds / 60) || 0, 'minute');
  } catch {
    return formatDate(date.toISOString());
  }
}
