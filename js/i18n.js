let currentLang = 'en';
let translations = {};

export function setTranslations(lang, newTranslations = {}) {
  currentLang = lang;
  translations = newTranslations || {};
}

export function getTranslation(key, fallback = '') {
  if (!key) return fallback;
  const value = translations[key];
  if (value == null || value === '') {
    return fallback;
  }
  return value;
}

export function getCurrentLanguage() {
  return currentLang;
}
