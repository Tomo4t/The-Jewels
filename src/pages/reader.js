import { escapeHTML, announce, prefersReducedMotion } from '../lib/dom.js';
import { t, currentLanguage } from '../lib/i18n.js';
import { read, write, writeJSON, KEYS } from '../lib/store.js';
import { play } from '../lib/sound.js';
import { syncHash, buildHash } from '../router.js';
import api from '../lib/api.js';
import { mountComments } from '../components/comments.js';

/**
 * The chapter reader.
 *
 * Three presentations over the same page list:
 *   flip   — a book with turning sheets (sheet k carries pages 2k and 2k+1)
 *   scroll — a continuous webcomic column
 *   card   — one page at a time, sliding sideways
 *
 * Images are lazy: only pages near the current position are given a `src`, so
 * opening a 40-page chapter no longer pulls 40 images down at once.
 */

const MODES = ['flip', 'scroll', 'card'];
const PRELOAD_RADIUS = 2;

let state = null;

export function title(params) {
  return state?.chapter?.title || `${t('chapters.chapter', { n: params.chapter || 1 })}`;
}

export async function render(params) {
  const lang = params.lang && params.lang.length === 2 ? params.lang : currentLanguage();
  const number = Number(params.chapter) || 1;

  let chapter;
  try {
    chapter = await api.chapter(lang, number);
  } catch {
    return `
      <div class="reader-missing">
        <h2>${escapeHTML(t('reader.notFound'))}</h2>
        <a class="button" href="${buildHash('chapters')}">${escapeHTML(t('reader.backToChapters'))}</a>
      </div>
    `;
  }

  const total = chapter.pages.length;
  const startPage = Math.max(0, Math.min(Number(params.page) || 0, Math.max(0, total - 1)));
  const savedMode = read(KEYS.readerMode, 'flip');
  const mode = MODES.includes(savedMode) ? savedMode : 'flip';

  state = { lang, number, chapter, total, page: startPage, mode, cleanups: [] };

  const modeButton = (id, value, label, icon) => `
    <button type="button" id="mode-${id}" class="mode-btn ${mode === value ? 'active' : ''}"
            data-mode="${value}" data-sound="ui"
            title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}"
            aria-pressed="${mode === value}">
      <img src="/images/${icon}" alt="" aria-hidden="true">
    </button>`;

  return `
    <div class="reader-wrapper" data-mode="${mode}">
      <div class="reader-toolbar">
        <a class="reader-back" href="${buildHash('chapters')}" data-sound="ui"
           title="${escapeHTML(t('reader.backToChapters'))}"
           aria-label="${escapeHTML(t('reader.backToChapters'))}">
          <img src="/images/arrow.svg" alt="" aria-hidden="true" class="arrow-icon arrow-icon--back">
        </a>

        <h1 class="reader-title">${escapeHTML(chapter.title)}</h1>

        <div class="reader-toggle" role="group" aria-label="${escapeHTML(t('reader.comicMode'))}">
          ${modeButton('comic', 'flip', t('reader.comicMode'), 'open-page.svg')}
          ${modeButton('scroll', 'scroll', t('reader.scrollMode'), 'scroll.svg')}
          ${modeButton('card', 'card', t('reader.cardMode'), 'card.svg')}
        </div>
      </div>

      <div class="book" id="book" data-mode="${mode}"></div>

      <p class="page-indicator" id="page-indicator" aria-live="polite">
        ${escapeHTML(t('reader.pageOf', { current: startPage + 1, total }))}
      </p>
      <p class="reader-hint">${escapeHTML(t('reader.fullscreenHint'))}</p>
    </div>

    <section class="comments-section" id="comments-section" aria-labelledby="comments-heading">
      <h2 id="comments-heading">${escapeHTML(t('comments.title'))}</h2>
      <div id="comments-root"><div class="skeleton skeleton--block"></div></div>
    </section>
  `;
}

export async function mount(params, outlet) {
  if (!state || !document.getElementById('book')) return () => {};

  renderMode(state.mode);
  bindToolbar();
  const unbindInput = bindInput();

  const unmountComments = await mountComments(document.getElementById('comments-root'), {
    lang: state.lang,
    chapter: state.number,
  });

  void params;
  void outlet;

  return () => {
    unbindInput();
    unmountComments?.();
    runCleanups();
    state = null;
  };
}

// --- shared helpers -------------------------------------------------------

function runCleanups() {
  for (const fn of state?.cleanups || []) {
    try {
      fn();
    } catch {
      /* a listener that is already gone is fine */
    }
  }
  if (state) state.cleanups = [];
}

function setPage(page, { announcePage = false } = {}) {
  if (!state) return;
  state.page = Math.max(0, Math.min(page, state.total - 1));

  const indicator = document.getElementById('page-indicator');
  const label = t('reader.pageOf', { current: state.page + 1, total: state.total });
  if (indicator) indicator.textContent = label;
  if (announcePage) announce(label);

  writeJSON(KEYS.progress(state.lang), { chapter: state.number, page: state.page });
  syncHash('reader', { lang: state.lang, chapter: state.number, page: state.page });
  updateLazyImages();
}

/** Gives a `src` only to images near the current page, and drops far ones. */
function updateLazyImages() {
  const book = document.getElementById('book');
  if (!book || state.mode === 'scroll') return;

  book.querySelectorAll('img[data-src]').forEach((img) => {
    const index = Number(img.closest('[data-index]')?.dataset.index ?? -1);
    if (Math.abs(index - state.page) <= PRELOAD_RADIUS) {
      if (!img.src) img.src = img.dataset.src;
    }
  });
}

function pageElement(index, className, extraStyle = '') {
  const src = state.chapter.pages[index];
  return `
    <div class="${className}" data-index="${index}" style="${extraStyle}">
      <img data-src="${escapeHTML(src)}" alt="${escapeHTML(
        t('reader.pageOf', { current: index + 1, total: state.total })
      )}" class="page-iner" decoding="async" draggable="false">
    </div>`;
}

// --- mode rendering -------------------------------------------------------

function renderMode(mode) {
  const book = document.getElementById('book');
  const wrapper = document.querySelector('.reader-wrapper');
  if (!book) return;

  runCleanups();
  state.mode = mode;
  write(KEYS.readerMode, mode);
  book.dataset.mode = mode;
  wrapper?.setAttribute('data-mode', mode);

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  book.replaceChildren();
  document.querySelector('.navbtns')?.remove();

  if (mode === 'flip') renderFlip(book);
  else if (mode === 'scroll') renderScroll(book);
  else renderCard(book);

  updateLazyImages();
}

function navButtons(onPrev, onNext) {
  const wrapper = document.querySelector('.reader-wrapper');
  if (!wrapper) return;

  const nav = document.createElement('div');
  nav.className = 'navbtns';
  nav.innerHTML = `
    <button type="button" id="prev-btn" class="navbtnL" data-sound="flip"
            title="${escapeHTML(t('reader.previousPage'))}"
            aria-label="${escapeHTML(t('reader.previousPage'))}">
      <img src="/images/button-book.svg" alt="" aria-hidden="true">
    </button>
    <button type="button" id="next-btn" class="navbtnR" data-sound="flip"
            title="${escapeHTML(t('reader.nextPage'))}"
            aria-label="${escapeHTML(t('reader.nextPage'))}">
      <img src="/images/button-book.svg" alt="" aria-hidden="true">
    </button>`;

  nav.querySelector('#prev-btn').addEventListener('click', onPrev);
  nav.querySelector('#next-btn').addEventListener('click', onNext);
  wrapper.append(nav);

  state.actions = { prev: onPrev, next: onNext };
  state.cleanups.push(() => nav.remove());
}

/** Book mode. Sheet k carries page 2k on the front and 2k+1 on the back. */
function renderFlip(book) {
  const { total } = state;
  const sheets = Math.ceil(total / 2);

  const inner = document.createElement('div');
  inner.className = 'book-inner';
  inner.id = 'book-inner';

  let frontZ = total;
  let backZ = 1;
  let html = '';
  for (let i = 0; i < total; i += 1) {
    const isFront = i % 2 === 0;
    const z = isFront ? frontZ-- : backZ++;
    html += pageElement(i, isFront ? 'front' : 'back', `z-index:${z};`);
  }
  inner.innerHTML = html;
  book.append(inner);

  // `flipped` counts sheets turned so far; page p sits at ceil(p / 2).
  let flipped = Math.ceil(state.page / 2);

  const apply = ({ silent = false, keepPage = false } = {}) => {
    flipped = Math.max(0, Math.min(flipped, sheets));

    inner.querySelectorAll('.front, .back').forEach((node) => {
      node.classList.toggle('fliped', Number(node.dataset.index) < flipped * 2);
    });

    inner.classList.toggle('shifted', flipped > 0 && flipped < sheets);
    inner.classList.toggle('center', flipped >= sheets && flipped > 0);

    // A spread shows two pages: `right` and the one before it. Turning a sheet
    // should land on the right-hand page, but arriving from another mode should
    // not -- reporting `right` unconditionally is what made switching modes on
    // an odd page silently skip forward by one.
    const right = Math.min(flipped * 2, total - 1);
    const onThisSpread = state.page === right || state.page === right - 1;
    const target = keepPage && onThisSpread ? state.page : right;

    setPage(target, { announcePage: !silent });
  };

  const next = () => {
    if (flipped >= sheets) return;
    flipped += 1;
    play('flip');
    apply();
  };

  const prev = () => {
    if (flipped <= 0) return;
    flipped -= 1;
    play('flip');
    apply();
  };

  navButtons(prev, next);
  apply({ silent: true, keepPage: true });
}

/** Continuous scroll. Native lazy loading handles the image budget here. */
function renderScroll(book) {
  const inner = document.createElement('div');
  inner.className = 'Wepcomic-inner';
  inner.id = 'Wepcomic-inner';

  inner.innerHTML = state.chapter.pages
    .map(
      (src, index) => `
        <div class="page-scroll" data-index="${index}">
          <img src="${escapeHTML(src)}" alt="${escapeHTML(
            t('reader.pageOf', { current: index + 1, total: state.total })
          )}" class="page-iner" loading="lazy" decoding="async" draggable="false">
        </div>`
    )
    .join('');

  book.append(inner);

  const goTo = (index) => {
    const target = inner.querySelector(`[data-index="${index}"]`);
    if (!target) return;
    play('flip');
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
    setPage(index, { announcePage: true });
  };

  navButtons(
    () => goTo(state.page - 1),
    () => goTo(state.page + 1)
  );

  // Track which page is in view without hammering the main thread on scroll.
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setPage(Number(visible.target.dataset.index));
    },
    { root: inner, threshold: [0.25, 0.5, 0.75] }
  );

  inner.querySelectorAll('.page-scroll').forEach((node) => observer.observe(node));
  state.cleanups.push(() => observer.disconnect());

  window.setTimeout(() => {
    inner.querySelector(`[data-index="${state.page}"]`)?.scrollIntoView({ block: 'start' });
  }, 0);
}

/** One page at a time. */
function renderCard(book) {
  const inner = document.createElement('div');
  inner.className = 'card-inner';
  inner.id = 'card-inner';
  inner.innerHTML = state.chapter.pages.map((_, index) => pageElement(index, 'card-page')).join('');
  book.append(inner);

  const apply = ({ silent = false } = {}) => {
    inner.querySelectorAll('.card-page').forEach((node, index) => {
      node.classList.remove('show', 'hide-left', 'hide-right');
      if (index === state.page) node.classList.add('show');
      else node.classList.add(index < state.page ? 'hide-left' : 'hide-right');
    });
    setPage(state.page, { announcePage: !silent });
  };

  navButtons(
    () => {
      if (state.page <= 0) return;
      state.page -= 1;
      play('flip');
      apply();
    },
    () => {
      if (state.page >= state.total - 1) return;
      state.page += 1;
      play('flip');
      apply();
    }
  );

  apply({ silent: true });
}

// --- input ----------------------------------------------------------------

function bindToolbar() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === state.mode) return;
      renderMode(btn.dataset.mode);
    });
  });
}

function bindInput() {
  const book = document.getElementById('book');

  const onKeydown = (event) => {
    if (event.repeat || !state?.actions) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      state.actions.next();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      state.actions.prev();
    } else if (event.key === 'Home') {
      event.preventDefault();
      renderMode(state.mode);
    }
  };

  // --- swipe ---
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const onTouchStart = (event) => {
    if (event.touches.length !== 1) return;
    tracking = true;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  };

  const onTouchEnd = (event) => {
    if (!tracking || !state?.actions) return;
    tracking = false;

    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // Ignore mostly-vertical drags so scroll mode still scrolls.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) state.actions.next();
    else state.actions.prev();
  };

  // --- double-tap or double-click for fullscreen ---
  const onDoubleClick = (event) => {
    const img = event.target.closest('.page-iner');
    if (!img) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else img.requestFullscreen?.().catch(() => {});
  };

  document.addEventListener('keydown', onKeydown);
  book?.addEventListener('touchstart', onTouchStart, { passive: true });
  book?.addEventListener('touchend', onTouchEnd, { passive: true });
  book?.addEventListener('dblclick', onDoubleClick);

  return () => {
    document.removeEventListener('keydown', onKeydown);
    book?.removeEventListener('touchstart', onTouchStart);
    book?.removeEventListener('touchend', onTouchEnd);
    book?.removeEventListener('dblclick', onDoubleClick);
  };
}

export default { render, mount, title };
