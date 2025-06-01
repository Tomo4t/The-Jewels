import { loadUpdates } from './updates.js';

export async function initLanguageSelector() {
  const dropdown = document.querySelector('.dropdown');
  const toggle = document.getElementById('language-toggle');

  // Rebind toggle
  const newToggle = toggle.cloneNode(true);
  toggle.parentNode.replaceChild(newToggle, toggle);

  const updatedToggle = document.getElementById('language-toggle');

  updatedToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('show');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('show');
  });

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
    loadUpdates(1, lang);
  } catch (err) {
    console.error(`Could not load lang/${lang}.json`, err);
  }
  if (location.hash === '#chapters') {
  const content = document.getElementById('page-content');
  import('./pages/chapters.js').then(({ default: renderChapters }) => {
    renderChapters().then(html => {
      content.innerHTML = html;
    });
  });
}

}

