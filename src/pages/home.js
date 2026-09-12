import { escapeHTML, textToHTML } from '../lib/dom.js';
import { t, currentLanguage, formatDate } from '../lib/i18n.js';
import { readJSON, KEYS } from '../lib/store.js';
import { buildHash } from '../router.js';
import api from '../lib/api.js';

export function title() {
  return t('nav.home');
}

export function render() {
  return `
    <div class="home-layout">
      <section class="updates-box" id="updates" aria-labelledby="updates-heading">
        <h2 id="updates-heading" data-i18n="home.updates">${escapeHTML(t('home.updates'))}</h2>
        <div id="updates-text" class="updates-text">
          <div class="skeleton skeleton--text"></div>
          <div class="skeleton skeleton--text skeleton--short"></div>
        </div>
        <div class="updates-controls">
          <button type="button" id="update-prev" class="arrow-btn" data-sound="ui"
                  title="${escapeHTML(t('home.previousUpdate'))}"
                  aria-label="${escapeHTML(t('home.previousUpdate'))}">
            <img src="/images/arrow.svg" alt="" aria-hidden="true" class="arrow-icon arrow-icon--back">
          </button>
          <span id="update-counter" class="update-counter">—</span>
          <button type="button" id="update-next" class="arrow-btn" data-sound="ui"
                  title="${escapeHTML(t('home.nextUpdate'))}"
                  aria-label="${escapeHTML(t('home.nextUpdate'))}">
            <img src="/images/arrow.svg" alt="" aria-hidden="true" class="arrow-icon">
          </button>
        </div>
      </section>

      <div class="home-sections">
        <div class="home-pair">
          <section class="home-block continue-reading" id="continue" hidden></section>
          <section class="home-block latest-chapter" id="latest"></section>
        </div>
      </div>
    </div>
  `;
}

export async function mount() {
  const lang = currentLanguage();
  const abort = new AbortController();

  await Promise.all([mountUpdates(lang, abort.signal), mountChapterCards(lang)]);

  return () => abort.abort();
}

// --- updates --------------------------------------------------------------

async function mountUpdates(lang, signal) {
  const box = document.getElementById('updates-text');
  const counter = document.getElementById('update-counter');
  const prev = document.getElementById('update-prev');
  const next = document.getElementById('update-next');
  if (!box) return;

  let updates = [];
  try {
    ({ updates } = await api.updates(lang));
  } catch {
    updates = [];
  }
  if (signal.aborted) return;

  if (!updates.length) {
    box.innerHTML = `<p class="empty-note">${escapeHTML(t('home.noUpdates'))}</p>`;
    counter.textContent = '';
    prev.hidden = true;
    next.hidden = true;
    return;
  }

  let index = 0;

  const show = (nextIndex) => {
    index = Math.max(0, Math.min(nextIndex, updates.length - 1));
    const update = updates[index];

    box.classList.add('is-fading');
    window.setTimeout(() => {
      box.innerHTML = `
        ${update.date ? `<p class="update-date">${escapeHTML(formatDate(update.date))}</p>` : ''}
        <div class="update-message">${textToHTML(update.body)}</div>
      `;
      box.classList.remove('is-fading');
    }, 140);

    counter.textContent = `${index + 1} / ${updates.length}`;
    prev.disabled = index === 0;
    next.disabled = index === updates.length - 1;
  };

  prev.addEventListener('click', () => show(index - 1), { signal });
  next.addEventListener('click', () => show(index + 1), { signal });
  show(0);
}

// --- latest chapter and continue reading ----------------------------------

function coverCard({ href, image, label, title: caption, alt }) {
  return `
    <a class="cover-card" href="${href}">
      <img src="${escapeHTML(image)}" alt="${escapeHTML(alt)}" class="cover-img"
           loading="lazy" decoding="async">
      <span class="cover-title">
        <span class="cover-label">${escapeHTML(label)}</span>
        <span class="cover-name">${escapeHTML(caption)}</span>
      </span>
    </a>
  `;
}

async function mountChapterCards(lang) {
  const latestHost = document.getElementById('latest');
  const continueHost = document.getElementById('continue');

  let chapters = [];
  try {
    ({ chapters } = await api.chapters(lang));
  } catch {
    chapters = [];
  }

  // Latest chapter
  const latest = chapters[chapters.length - 1];
  if (latest && latestHost) {
    latestHost.innerHTML = coverCard({
      href: buildHash('reader', { lang, chapter: latest.number, page: 0 }),
      image: latest.cover,
      label: t('home.latestChapter'),
      title: latest.title,
      alt: latest.title,
    });
  } else if (latestHost) {
    latestHost.innerHTML = `<p class="empty-note">${escapeHTML(t('chapters.empty'))}</p>`;
  }

  // Continue reading, only if there is saved progress that still exists
  const progress = readJSON(KEYS.progress(lang), null);
  if (!progress || !continueHost) return;

  const chapter = chapters.find((c) => c.number === Number(progress.chapter));
  if (!chapter || !chapter.pages) return;

  const page = Math.max(0, Math.min(Number(progress.page) || 0, chapter.pages - 1));
  if (page === 0) return; // nothing meaningful to resume

  let detail;
  try {
    detail = await api.chapter(lang, chapter.number);
  } catch {
    return;
  }

  continueHost.hidden = false;
  continueHost.innerHTML = coverCard({
    href: buildHash('reader', { lang, chapter: chapter.number, page }),
    image: detail.pages[page] || chapter.cover,
    label: t('home.continueReading'),
    title: `${chapter.title} — ${t('home.page')} ${page + 1}`,
    alt: `${chapter.title}, ${t('home.page')} ${page + 1}`,
  });
}

export default { render, mount, title };
