import renderHome from './pages/home.js';
import renderContact from './pages/contact.js';
import renderChapters from './pages/chapters.js';
import renderReaderPage from './pages/reader.js';

import { loadUpdates } from './updates.js';
import { initNavbar } from './navbar.js';
import { initLanguageSelector } from './language.js';
import { initParticles } from './particles.js';

const routes = {
  home: { render: renderHome, style: 'css/home.css' },
  contact: { render: renderContact, style: 'css/contact.css' },
  chapters: { render: renderChapters, style: 'css/chapters.css' },
  reader: { render: renderReaderPage, style: 'css/reader.css' }
};

function updateGradient(gradientCSS) {
  const overlay = document.getElementById('gradient-overlay');
  if (!overlay) return;

  const newLayer = document.createElement('div');
  newLayer.className = 'gradient-layer';
  newLayer.style.backgroundImage = gradientCSS;
  overlay.appendChild(newLayer);
  requestAnimationFrame(() => newLayer.classList.add('active'));

  const layers = overlay.querySelectorAll('.gradient-layer');
  if (layers.length > 1) {
    setTimeout(() => layers[0].remove(), 1000);
  }
}

function getChaptersPerRow() {
  const width = window.innerWidth;
  if (width >= 1200) return 5;
  if (width >= 900) return 4;
  if (width >= 600) return 3;
  return 2;
}

let currentPage = location.hash.replace('#', '') || 'home';
let currentChaptersPerRow = getChaptersPerRow();

export function initRouter() {
  const content = document.getElementById('page-content');
  const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark') {
  document.body.classList.add('dark');
}


  function loadStyle(href) {
    const existing = document.querySelector('link[data-dynamic-style]');
    if (existing) existing.remove();

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-dynamic-style', '');
    document.head.appendChild(link);
  }

 async function loadPage(rawHash) {
  const [page, queryString] = rawHash.split('?');
  currentPage = page;

  if (page === 'chapters') currentChaptersPerRow = getChaptersPerRow();

  const route = routes[page];
  if (!route) {
    content.innerHTML = '<p>Page not found.</p>';
    return;
  }

  const rendered = await route.render();
  content.innerHTML = rendered;
  window.scrollTo(0, 0);
  loadStyle(route.style);

  if (page === 'home') {
    loadUpdates(1, localStorage.getItem('language') || 'en');
  }

  initNavbar();
  initLanguageSelector();

  setTimeout(() => {
    document.querySelectorAll('[style*="opacity: 0"]').forEach(el =>
      el.classList.add('fade-in')
    );
  }, 10);

  function getCSSVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

updateGradient(
  {
    home: getCSSVar('--gradient-home'),
    contact: getCSSVar('--gradient-contact'),
    chapters: getCSSVar('--gradient-chapters'),
  }[page] || getCSSVar('--gradient-default')
);
  if (page === 'reader') {
    const params = new URLSearchParams(queryString || '');
    const lang = params.get('lang') || 'en';
    const chapter = params.get('chapter') || '1';
    const pageNum = params.get('page') || '0';

    const html = await renderReaderPage({ lang, chapter, page: pageNum });
    document.querySelector('#app')?.replaceChildren();
    document.querySelector('#app')?.insertAdjacentHTML('beforeend', html);
    window.renderComicPages();

    document.getElementById('mode-comic')?.addEventListener('click', () => {
      if (!event.currentTarget.classList.contains('active')) window.renderComicPages('flip');
    });

    document.getElementById('mode-scroll')?.addEventListener('click', () => {
      if (!event.currentTarget.classList.contains('active')) window.renderComicPages('scroll');
    });
  }
}


 window.addEventListener('click', (e) => {
  const target = e.target.closest('[data-page]');
  if (target) {
    e.preventDefault();
    const page = target.dataset.page;

    // Store language and chapter to localStorage if going to reader
    if (page === 'reader') {
      const lang = target.dataset.lang;
      const chapter = target.dataset.chapter;

      if (lang) localStorage.setItem('language', lang);
      if (chapter) localStorage.setItem('chapter', chapter);
    }

    loadPage(page);
    history.pushState({}, '', `#${page}`);
  }
});

window.addEventListener('popstate', () => {
  const page = location.hash.slice(1) || 'home';
  loadPage(page);
});

  window.addEventListener('resize', () => {
    const newPerRow = getChaptersPerRow();
    if (currentPage === 'chapters' && newPerRow !== currentChaptersPerRow) {
      currentChaptersPerRow = newPerRow;
      loadPage('chapters');
    }
  });

  const initial = location.hash.slice(1) || 'home';

  loadPage(initial);

  initParticles({
    count: 60,
    color: 'rgba(255,255,255,0.3)',
    minSize: 1,
    maxSize: 3,
    speed: 0.6
  });
}
