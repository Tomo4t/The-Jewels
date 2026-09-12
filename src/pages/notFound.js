import { escapeHTML } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { buildHash } from '../router.js';

export const title = () => t('errors.notFound');

export function render() {
  return `
    <div class="not-found">
      <h1>${escapeHTML(t('errors.notFound'))}</h1>
      <p>${escapeHTML(t('errors.notFoundHint'))}</p>
      <a class="button button--primary" href="${buildHash('chapters')}">
        ${escapeHTML(t('nav.chapters'))}
      </a>
    </div>
  `;
}

export default { render, title };
