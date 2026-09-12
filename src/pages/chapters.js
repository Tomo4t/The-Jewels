import { escapeHTML } from '../lib/dom.js';
import { t, currentLanguage, formatDate } from '../lib/i18n.js';
import { buildHash } from '../router.js';
import api from '../lib/api.js';

export function title() {
  return t('chapters.title');
}

/** Groups chapters into shelf rows so the bookshelf styling still works. */
function chaptersPerRow() {
  const width = window.innerWidth;
  if (width >= 1200) return 5;
  if (width >= 900) return 4;
  if (width >= 600) return 3;
  return 2;
}

export async function render() {
  const lang = currentLanguage();

  let chapters = [];
  try {
    ({ chapters } = await api.chapters(lang));
  } catch {
    chapters = [];
  }

  if (!chapters.length) {
    return `
      <div class="chapters-empty">
        <img src="/images/chapters.svg" alt="" aria-hidden="true" class="empty-illustration">
        <h2>${escapeHTML(t('chapters.empty'))}</h2>
        <p>${escapeHTML(t('chapters.emptyHint'))}</p>
      </div>
    `;
  }

  const perRow = chaptersPerRow();
  const rows = [];
  for (let i = 0; i < chapters.length; i += perRow) {
    rows.push(chapters.slice(i, i + perRow));
  }

  const shelves = rows
    .map(
      (row) => `
        <div class="shelf-row">
          ${row
            .map(
              (chapter) => `
                <a class="chapter-box" href="${buildHash('reader', {
                  lang,
                  chapter: chapter.number,
                  page: 0,
                })}" aria-label="${escapeHTML(t('chapters.openChapter', { title: chapter.title }))}">
                  <img src="${escapeHTML(chapter.cover)}" alt="" aria-hidden="true"
                       loading="lazy" decoding="async" width="300" height="425">
                  <span class="chapter-label">
                    <span class="chapter-number">${escapeHTML(
                      t('chapters.chapter', { n: chapter.number })
                    )}</span>
                    <span class="chapter-title">${escapeHTML(chapter.title)}</span>
                    ${
                      chapter.publishedAt
                        ? `<span class="chapter-date">${escapeHTML(formatDate(chapter.publishedAt))}</span>`
                        : ''
                    }
                  </span>
                </a>`
            )
            .join('')}
        </div>
        <div class="shelf-line" aria-hidden="true"></div>`
    )
    .join('');

  return `
    <div class="chapters-page">
      <h1 class="visually-hidden">${escapeHTML(t('chapters.title'))}</h1>
      <div class="chapters-shelf-container">${shelves}</div>
    </div>
  `;
}

export function mount() {
  // Re-lay the shelves when the column count would change, and only then.
  let lastPerRow = chaptersPerRow();
  let timer = null;

  const onResize = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const next = chaptersPerRow();
      if (next === lastPerRow) return;
      lastPerRow = next;
      const outlet = document.getElementById('page-content');
      if (outlet) outlet.innerHTML = await render();
    }, 200);
  };

  window.addEventListener('resize', onResize);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('resize', onResize);
  };
}

export default { render, mount, title };
