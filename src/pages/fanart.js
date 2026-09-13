import { escapeHTML } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { buildHash } from '../router.js';

/**
 * Placeholder for the reader-art gallery.
 *
 * It says plainly that there is nothing here yet rather than showing an empty
 * grid, which would read as something being broken.
 */

export function title() {
  return t('fanart.title');
}

export function render() {
  return `
    <div class="coming-soon">
      <img src="/images/fanart.svg" alt="" aria-hidden="true" class="coming-soon-mark">
      <p class="coming-soon-flag">${escapeHTML(t('fanart.comingSoon'))}</p>
      <h1>${escapeHTML(t('fanart.title'))}</h1>
      <p class="coming-soon-blurb">${escapeHTML(t('fanart.blurb'))}</p>
      <a class="button button--primary" href="${buildHash('chapters')}">
        ${escapeHTML(t('nav.chapters'))}
      </a>
    </div>
  `;
}
