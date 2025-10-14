import { initRouter } from './router.js';

export let soundOn = localStorage.getItem('sound') !== 'off'; // Global state
const clickSound = new Audio('audio/click.mp3');
clickSound.volume = 0.3;

export function initNavbar() {
  const themeBtn = document.getElementById('theme-toggle');
  const soundBtn = document.getElementById('sound-toggle');
  const navbar = document.querySelector('.navbar');
  const navRight = document.getElementById('nav-right');
  const overflowToggle = document.getElementById('nav-overflow-toggle');

  if (!themeBtn || !soundBtn) return;

  setupOverflow(navbar, navRight, overflowToggle);

  // === Theme Toggle ===
  if (!themeBtn.dataset.bound) {
    themeBtn.addEventListener('click', () => {
      document.body.classList.add('transition-gradient');

      setTimeout(() => {
        document.documentElement.classList.toggle('dark');
        document.body.classList.remove('transition-gradient');

        const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        localStorage.setItem('theme', theme);
        location.reload();

        // 🔁 Force reapply gradient on all gradient-based sections
        document.querySelectorAll('[data-gradient]').forEach(el => {
          const gradientName = el.getAttribute('data-gradient');
          el.style.backgroundImage = ''; // Reset
          requestAnimationFrame(() => {
            const newGradient = getComputedStyle(document.documentElement)
              .getPropertyValue(`--gradient-${gradientName}`)?.trim();
            el.style.backgroundImage = newGradient || '';
          });
        });
      }, 300);
    });
    themeBtn.dataset.bound = 'true';
  }

  // === Sound Toggle ===
  if (!soundBtn.dataset.bound) {
    soundBtn.addEventListener('click', () => {
      soundOn = !soundOn;
      localStorage.setItem('sound', soundOn ? 'on' : 'off');
      soundBtn.classList.toggle('active', !soundOn);

      if (soundOn) {
        clickSound.currentTime = 0;
        clickSound.play().catch(() => {});
      } else {
        soundBtn.classList.add('animate-click');
        setTimeout(() => soundBtn.classList.remove('animate-click'), 300);
      }

      bindButtonEffects(); // Re-bind with updated state
    });

    soundBtn.dataset.bound = 'true';
  }

  // Initialize state
  soundBtn.classList.toggle('active', !soundOn);
  bindButtonEffects(); // Initial bind
}

export function bindButtonEffects() {
  const soundBtn = document.getElementById('sound-toggle');

  document.querySelectorAll('button').forEach(btn => {
    if (!btn.dataset.animated && btn !== soundBtn) {
      btn.addEventListener('mousedown', () => {
        if (soundOn) {
          clickSound.currentTime = 0;
          clickSound.play().catch(() => {});
        }
      });
      btn.dataset.animated = 'true';
    }
  });
}

function setupOverflow(navbar, navRight, overflowToggle) {
  if (!navbar || !navRight || !overflowToggle) return;

  const evaluateOverflow = () => {
    const collapsed = navbar.scrollWidth > navbar.clientWidth + 1;
    navbar.classList.toggle('nav-collapsed', collapsed);
    if (!collapsed) {
      navRight.classList.remove('open');
    }
  };

  if (!overflowToggle.dataset.bound) {
    overflowToggle.addEventListener('click', event => {
      if (!navbar.classList.contains('nav-collapsed')) return;
      event.stopPropagation();
      navRight.classList.toggle('open');
    });
    overflowToggle.dataset.bound = 'true';
  }

  if (!navRight.dataset.closeBound) {
    document.addEventListener('click', event => {
      if (!navRight.classList.contains('open')) return;
      if (!navRight.contains(event.target)) {
        navRight.classList.remove('open');
      }
    });
    navRight.dataset.closeBound = 'true';
  }

  if (!navbar.dataset.resizeBound) {
    if (typeof ResizeObserver !== 'undefined') {
      const overflowObserver = new ResizeObserver(evaluateOverflow);
      overflowObserver.observe(navbar);
      navbar._overflowObserver = overflowObserver;
    }
    window.addEventListener('resize', evaluateOverflow);
    navbar.dataset.resizeBound = 'true';
  }

  evaluateOverflow();
}
