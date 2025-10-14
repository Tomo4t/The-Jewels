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

  const navLeft = navbar.querySelector('.nav-left');
  const navTitle = navbar.querySelector('.nav-title');
  const navControls = document.getElementById('nav-controls');
  const inlineList = document.getElementById('nav-inline-list');
  const overflowList = document.getElementById('nav-overflow-list');

  if (!navControls || !inlineList || !overflowList) return;

  const controlItems = Array.from(inlineList.children);
  let isCollapsed = false;

  const syncAria = () => {
    const expanded = navRight.classList.contains('open');
    overflowToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    overflowToggle.setAttribute('aria-hidden', isCollapsed ? 'false' : 'true');
    overflowToggle.hidden = !isCollapsed;
    overflowList.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    inlineList.setAttribute('aria-hidden', isCollapsed ? 'true' : 'false');
  };

  const moveToOverflow = () => {
    controlItems.forEach(item => {
      if (!overflowList.contains(item)) {
        overflowList.appendChild(item);
      }
    });
    inlineList.setAttribute('aria-hidden', 'true');
    overflowList.setAttribute('aria-hidden', navRight.classList.contains('open') ? 'false' : 'true');
  };

  const restoreInline = () => {
    controlItems.forEach(item => {
      if (!inlineList.contains(item)) {
        inlineList.appendChild(item);
      }
    });
    inlineList.setAttribute('aria-hidden', 'false');
    overflowList.setAttribute('aria-hidden', 'true');
  };

  const evaluateOverflow = () => {
    if (!overflowToggle) return;

    const wasOpen = navRight.classList.contains('open');

    // Reset layout so measurements are accurate
    restoreInline();
    navbar.classList.remove('nav-collapsed');
    overflowToggle.setAttribute('aria-expanded', wasOpen ? 'true' : 'false');
    overflowToggle.setAttribute('aria-hidden', 'true');
    overflowToggle.hidden = true;
    overflowList.setAttribute('aria-hidden', 'true');

    const navRect = navbar.getBoundingClientRect();
    const styles = getComputedStyle(navbar);
    const paddingRight = parseFloat(styles.paddingRight || '0');

    const inlineRect = inlineList.getBoundingClientRect();
    const availableRight = navRect.right - paddingRight;
    const inlineOverflow = inlineList.scrollWidth - inlineList.clientWidth > 1;
    const collapsed = inlineOverflow || inlineRect.right - availableRight > 1;
    isCollapsed = collapsed;
    navbar.classList.toggle('nav-collapsed', collapsed);

    overflowToggle.tabIndex = collapsed ? 0 : -1;
    overflowToggle.setAttribute('aria-hidden', collapsed ? 'false' : 'true');
    overflowToggle.hidden = !collapsed;

    if (collapsed) {
      moveToOverflow();
      if (wasOpen) {
        navRight.classList.add('open');
      }
    } else {
      restoreInline();
      navRight.classList.remove('open');
    }

    syncAria();
  };

  if (!overflowToggle.dataset.bound) {
    overflowToggle.addEventListener('click', event => {
      if (!isCollapsed) return;
      event.stopPropagation();
      navRight.classList.toggle('open');
      syncAria();
    });
    overflowToggle.dataset.bound = 'true';
  }

  if (!navRight.dataset.closeBound) {
    document.addEventListener('click', event => {
      if (!navRight.classList.contains('open')) return;
      if (!navRight.contains(event.target)) {
        navRight.classList.remove('open');
        syncAria();
      }
    });
    navRight.dataset.closeBound = 'true';
  }

  if (!navbar.dataset.resizeBound) {
    if (typeof ResizeObserver !== 'undefined') {
      const overflowObserver = new ResizeObserver(evaluateOverflow);
      overflowObserver.observe(navbar);
      [navLeft, navTitle, inlineList].forEach(el => {
        if (el) overflowObserver.observe(el);
      });
      navbar._overflowObserver = overflowObserver;
    }
    window.addEventListener('resize', evaluateOverflow);
    window.addEventListener('load', evaluateOverflow, { once: true });
    navbar.dataset.resizeBound = 'true';
  }

  if (!navbar.dataset.invalidateBound) {
    window.addEventListener('navbar:invalidate', () => {
      requestAnimationFrame(evaluateOverflow);
    });
    navbar.dataset.invalidateBound = 'true';
  }

  evaluateOverflow();
}
