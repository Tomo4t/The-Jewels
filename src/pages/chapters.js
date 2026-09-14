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

/**
 * How long until a chapter is out, in the largest unit that still says
 * something useful. "in 3 days" beats "in 72 hours", and once it is inside the
 * last minute it counts seconds, because that is the bit worth watching.
 */
export function countdownParts(releaseAt, now = Date.now()) {
  const at = Date.parse(releaseAt);
  if (Number.isNaN(at)) return null;

  const ms = at - now;
  if (ms <= 0) return { due: true, text: '' };

  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  // Two units, never three: a countdown is read at a glance.
  if (days > 0) return { due: false, text: `${days}d ${hours}h`, tick: 60000 };
  if (hours > 0) return { due: false, text: `${hours}h ${minutes}m`, tick: 60000 };
  if (minutes > 0) return { due: false, text: `${minutes}m ${secs}s`, tick: 1000 };
  return { due: false, text: `${secs}s`, tick: 1000 };
}

const chapterCard = (chapter, lang) => {
  const label = `
    <span class="chapter-label">
      <span class="chapter-number">${escapeHTML(t('chapters.chapter', { n: chapter.number }))}</span>
      <span class="chapter-title">${escapeHTML(chapter.title)}</span>
      ${
        chapter.publishedAt && chapter.released !== false
          ? `<span class="chapter-date">${escapeHTML(formatDate(chapter.publishedAt))}</span>`
          : ''
      }
    </span>`;

  const cover = `
    <img src="${escapeHTML(chapter.cover)}" alt="" aria-hidden="true"
         loading="lazy" decoding="async" width="300" height="425">`;

  // Not out yet: the same shelf slot, but a panel rather than a link. There is
  // nothing behind it to open, and a link that refuses to open is worse than
  // no link.
  if (chapter.released === false) {
    const parts = countdownParts(chapter.releaseAt);
    return `
      <div class="chapter-box is-upcoming" data-countdown="${escapeHTML(chapter.releaseAt || '')}"
           aria-label="${escapeHTML(t('chapters.comingLabel', { title: chapter.title }))}">
        ${cover}
        <span class="chapter-veil" aria-hidden="true"></span>
        <span class="chapter-coming">
          <span class="chapter-coming-flag">${escapeHTML(t('chapters.comingSoon'))}</span>
          <span class="chapter-countdown" role="timer">${escapeHTML(parts?.text || '')}</span>
          ${
            chapter.releaseAt
              ? `<span class="chapter-when">${escapeHTML(formatDate(chapter.releaseAt))}</span>`
              : ''
          }
        </span>
        ${label}
      </div>`;
  }

  return `
    <a class="chapter-box${chapter.archived ? ' is-archived' : ''}" href="${buildHash('reader', {
      lang,
      chapter: chapter.number,
      page: 0,
    })}" aria-label="${escapeHTML(t('chapters.openChapter', { title: chapter.title }))}">
      ${cover}
      ${chapter.archived ? `<span class="chapter-archived-flag">${escapeHTML(t('chapters.archived'))}</span>` : ''}
      ${label}
    </a>`;
};

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
          ${row.map((chapter) => chapterCard(chapter, lang)).join('')}
        </div>
        <div class="shelf-line" aria-hidden="true"></div>`
    )
    .join('');

  return `
    <div class="chapters-page">
      <h1 class="visually-hidden">${escapeHTML(t('chapters.title'))}</h1>
      <div class="chapters-shelf-container" style="--shelf-cols: ${perRow}">${shelves}</div>
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
      startCountdowns();
    }, 200);
  };

  // --- the countdowns -------------------------------------------------------
  // One timer for the page, not one per card, and it ticks at the rate the
  // nearest release needs: once a minute while anything is days away, once a
  // second when something is within the hour.
  let tick = null;

  const startCountdowns = () => {
    window.clearTimeout(tick);
    const cards = [...document.querySelectorAll('[data-countdown]')];
    if (!cards.length) return;

    let soonest = 60000;
    let anyDue = false;

    for (const card of cards) {
      const parts = countdownParts(card.dataset.countdown);
      const out = card.querySelector('.chapter-countdown');
      if (!parts || parts.due) {
        anyDue = true;
        continue;
      }
      if (out) out.textContent = parts.text;
      soonest = Math.min(soonest, parts.tick);
    }

    // A chapter whose moment arrived during the countdown is now readable, and
    // the page is showing a panel that says otherwise. Re-render rather than
    // leave a stale "coming soon" on a chapter that is out.
    if (anyDue) {
      (async () => {
        const outlet = document.getElementById('page-content');
        if (outlet) outlet.innerHTML = await render();
        startCountdowns();
      })();
      return;
    }

    tick = window.setTimeout(startCountdowns, soonest);
  };

  startCountdowns();

  window.addEventListener('resize', onResize);
  return () => {
    window.clearTimeout(timer);
    window.clearTimeout(tick);
    window.removeEventListener('resize', onResize);
  };
}

export default { render, mount, title };
