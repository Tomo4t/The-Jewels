const LATEST_CHAPTER_LABELS = {
  en: 'Latest Chapter',
  ar: 'أحدث فصل',
  ja: '最新話'
};

const CONTINUE_READING_LABELS = {
  en: 'Continue Reading',
  ar: 'تابع القراءة',
  ja: '続きを読む'
};

const PAGE_LABELS = {
  en: 'Page',
  ar: 'الصفحة',
  ja: 'ページ'
};

export default function renderHome() {
  setTimeout(() => {
    const lang = localStorage.getItem('language') || 'en';
    refreshHomeDynamicSections(lang);
  }, 0);

  return `
  <div class="home-layout" style="opacity: 0;">
    <section id="updates" class="updates-box">
      <h3 data-i18n="updatesTitle">Updates</h3>
      <div id="updates-container">
        <div id="updates-text"></div>
      </div>
      <div class="updates-controls">
        <button id="update-prev" class="arrow-btn" title="Previous" data-sound="button-ui">
          <img src="images/arrow.svg" alt="Previous" style="transform: rotate(180deg); width: 1.2rem;">
        </button>
        <span id="update-counter">1 / 1</span>
        <button id="update-next" class="arrow-btn" title="Next" data-sound="button-ui">
          <img src="images/arrow.svg" alt="Next" style="width: 1.2rem;">
        </button>
      </div>
    </section>

    <div class="home-sections">
    <div class="home-pair">
      <section id="continue" class="continue-reading home-block">
        <div id="continue-preview"></div>
      </section>

      <section class="latest-chapter home-block" id="latest"></section>
    </div>
    </div>
  </div>
`;

}

export async function loadLatestChapter(lang) {
  try {
    const config = await fetch('config.json').then(r => r.json());
    const latest = config[lang];
    const latestContainer = document.getElementById('latest');
    if (!latestContainer) return;

    latestContainer.innerHTML = '';
    if (!latest) return;

    const meta = await fetch(`chapters/${lang}/chapter${latest}/meta.json`).then(r => r.json());

    const label = LATEST_CHAPTER_LABELS[lang] || LATEST_CHAPTER_LABELS.en;

    latestContainer.innerHTML = `
      <a href="#reader?lang=${lang}&chapter=${latest}&page=0" class="latest-cover-link">
        <img src="chapters/${lang}/chapter${latest}/page0.jpg" alt="${meta.title}" class="cover-img">
        <div class="cover-title"><span data-i18n="latestChapterLabel">${label}</span>: ${meta.title}</div>
      </a>
    `;
  } catch (e) {
    console.warn('Failed to load latest chapter', e);
  }
}

export async function loadContinuePreview(lang) {
  try {
    const previewContainer = document.getElementById('continue-preview');
    if (!previewContainer) return;

    previewContainer.innerHTML = '';
    const progress = JSON.parse(localStorage.getItem(`lastRead-${lang}`) || 'null');
    if (!progress) return;

    const meta = await fetch(`chapters/${lang}/chapter${progress.chapter}/meta.json`).then(r => r.json());

    // Clamp to valid page range just in case
    const page = Math.max(0, Math.min(progress.page, meta.pages - 1));

    const continueLabel = CONTINUE_READING_LABELS[lang] || CONTINUE_READING_LABELS.en;
    const pageLabel = PAGE_LABELS[lang] || PAGE_LABELS.en;

    previewContainer.innerHTML = `
      <a href="#reader?lang=${lang}&chapter=${progress.chapter}&page=${page}" class="latest-cover-link">
        <img src="chapters/${lang}/chapter${progress.chapter}/page${page}.jpg" alt="${pageLabel} ${page}" class="cover-img">
        <div class="cover-title">
          <span data-i18n="continueReadingLabel">${continueLabel}</span>: ${meta.title} — <span data-i18n="pageLabel">${pageLabel}</span> ${page}
        </div>
      </a>
    `;
  } catch (e) {
    console.warn('Failed to load continue reading preview', e);
  }
}

export function refreshHomeDynamicSections(lang) {
  loadLatestChapter(lang);
  loadContinuePreview(lang);
}

