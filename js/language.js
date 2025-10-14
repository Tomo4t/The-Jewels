import { loadUpdates } from './updates.js';

export async function initLanguageSelector() {
  const dropdown = document.getElementById('language-wrapper');
  const toggle = document.getElementById('language-toggle');

  if (!dropdown || !toggle) return;

  // Rebind toggle
  const newToggle = toggle.cloneNode(true);
  toggle.parentNode.replaceChild(newToggle, toggle);

  const updatedToggle = document.getElementById('language-toggle');

  updatedToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.language-dropdown.show').forEach(openDropdown => {
      if (openDropdown !== dropdown) {
        openDropdown.classList.remove('show');
      }
    });
    dropdown.classList.toggle('show');
  });

  if (!document.body.dataset.languageDismissBound) {
    document.addEventListener('click', () => {
      document.querySelectorAll('.language-dropdown.show').forEach(openDropdown => {
        openDropdown.classList.remove('show');
      });
    });
    document.body.dataset.languageDismissBound = 'true';
  }

  // Bind links after cloning
  const langLinks = document.querySelectorAll('#language-menu a');
  langLinks.forEach(link => {
    const newLink = link.cloneNode(true);
    link.parentNode.replaceChild(newLink, link);
  });

  const updatedLinks = document.querySelectorAll('#language-menu a');

  updatedLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const lang = link.getAttribute('data-lang');

      // ✅ PLAY slide.mp3
      const soundOn = localStorage.getItem("sound") !== "off";
      if (soundOn) {
        const slideSound = new Audio("audio/slide.mp3");
        slideSound.volume = 0.3;
        slideSound.currentTime = 0;
        slideSound.play().catch(() => {});
      }

      applyLanguage(lang);
      dropdown.classList.remove('show');
      window.dispatchEvent(new Event('navbar:invalidate'));
    });
  });

  // Load default or saved language
  const saved = localStorage.getItem('language') || 'en';
  applyLanguage(saved);
}

async function applyLanguage(lang) {
  try {
    const res = await fetch(`lang/${lang}.json`);
    const translations = await res.json();

    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (translations[key]) {
        el.textContent = translations[key];
      }
    });

    document.documentElement.setAttribute('lang', lang);
    localStorage.setItem('language', lang);
    loadUpdates(null, lang);
  } catch (err) {
    console.error(`Could not load lang/${lang}.json`, err);
  }
  window.dispatchEvent(new Event('navbar:invalidate'));
  if (location.hash === '#chapters') {
  const content = document.getElementById('page-content');
  import('./pages/chapters.js').then(({ default: renderChapters }) => {
    renderChapters().then(html => {
      content.innerHTML = html;
    });
  });
}

}

