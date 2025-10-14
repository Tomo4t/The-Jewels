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

function parseHash(hashValue) {
  const trimmed = (hashValue || '').replace(/^#/, '');
  if (!trimmed) return { page: 'home', queryString: '' };

  const [page, ...rest] = trimmed.split('?');
  return {
    page: page || 'home',
    queryString: rest.join('?')
  };
}

let currentPage = parseHash(location.hash).page;
let currentChaptersPerRow = getChaptersPerRow();

export function initRouter() {
  const content = document.getElementById('page-content');
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
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

  async function loadPage({ page, queryString }) {
    const targetPage = page || 'home';
    currentPage = targetPage;

    if (targetPage === 'chapters') currentChaptersPerRow = getChaptersPerRow();

    const route = routes[targetPage];
    if (!route) {
      content.innerHTML = '<p>Page not found.</p>';
      return;
    }

    let rendered;
    let readerParams;

    if (targetPage === 'reader') {
      const params = new URLSearchParams(queryString || '');
      readerParams = {
        lang: params.get('lang') || undefined,
        chapter: params.get('chapter') || undefined,
        page: params.get('page') || undefined
      };
      rendered = await renderReaderPage(readerParams);
    } else {
      rendered = await route.render();
    }

    content.innerHTML = rendered;
    window.scrollTo(0, 0);
    loadStyle(route.style);

    if (targetPage === 'home') {
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
      }[targetPage] || getCSSVar('--gradient-default')
    );

    if (targetPage === 'reader') {
      window.renderComicPages();

      const modeBindings = [
        { selector: '#mode-comic', mode: 'flip' },
        { selector: '#mode-scroll', mode: 'scroll' },
        { selector: '#mode-card', mode: 'card' }
      ];

      modeBindings.forEach(({ selector, mode }) => {
        const button = document.querySelector(selector);
        if (button) {
          button.addEventListener('click', (event) => {
            if (!event.currentTarget.classList.contains('active')) {
              window.renderComicPages(mode);
            }
          });
        }
      });

      if (readerParams) {
        const params = new URLSearchParams();
        if (readerParams.lang) params.set('lang', readerParams.lang);
        if (readerParams.chapter) params.set('chapter', readerParams.chapter);
        if (readerParams.page) params.set('page', readerParams.page);
        const suffix = params.toString();
        if (suffix) {
          history.replaceState({}, '', `#reader?${suffix}`);
        }
      }
    }
  }


  function buildHash(page, queryString) {
    const suffix = queryString ? `?${queryString}` : '';
    return `#${page}${suffix}`;
  }

  window.addEventListener('click', (e) => {
    const target = e.target.closest('[data-page]');
    if (target) {
      e.preventDefault();
      const page = target.dataset.page;

      let queryString = '';
      if (page === 'reader') {
        const params = new URLSearchParams();
        if (target.dataset.lang) params.set('lang', target.dataset.lang);
        if (target.dataset.chapter) params.set('chapter', target.dataset.chapter);
        if (target.dataset.page) params.set('page', target.dataset.page);
        queryString = params.toString();
      }

      loadPage({ page, queryString });
      const newHash = buildHash(page, queryString);
      history.pushState({}, '', newHash);
    }
  });

  window.addEventListener('hashchange', () => {
    loadPage(parseHash(location.hash));
  });

  window.addEventListener('popstate', () => {
    loadPage(parseHash(location.hash));
  });

  window.addEventListener('resize', () => {
    const newPerRow = getChaptersPerRow();
    if (currentPage === 'chapters' && newPerRow !== currentChaptersPerRow) {
      currentChaptersPerRow = newPerRow;
      loadPage({ page: 'chapters', queryString: '' });
    }
  });

  const initial = parseHash(location.hash);

  loadPage(initial);

  initParticles({
    count: 60,
    color: 'rgba(255,255,255,0.3)',
    minSize: 1,
    maxSize: 3,
    speed: 0.6
  });
}
