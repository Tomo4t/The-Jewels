
import { initRouter } from './router.js';
export let soundOn = localStorage.getItem("sound") !== "off"; // Global state
const clickSound = new Audio("audio/click.mp3");
clickSound.volume = 0.3;

export function initNavbar() {
  const themeBtn = document.getElementById("theme-toggle");
  const soundBtn = document.getElementById("sound-toggle");
  const navRight = document.querySelector(".nav-right");
  const navbar = document.querySelector(".navbar");
  const navLeft = document.querySelector(".nav-left");
  const navTitle = document.querySelector("header .nav-title");
  const navRightActions = document.getElementById("nav-right-actions");
  const navMenuBtn = document.getElementById("nav-right-menu");
  const navDropdown = document.querySelector(".nav-right .dropdown");
  let closeNavMenu = null;
  let resizeRaf = null;

  if (!themeBtn || !soundBtn) return;

  const syncMenuHiddenState = (isCollapsed, isOpen) => {
    if (!navRightActions) return;

    if (!isCollapsed) {
      navRightActions.hidden = false;
      navRightActions.removeAttribute("aria-hidden");
      return;
    }

    if (isOpen) {
      navRightActions.hidden = false;
      navRightActions.setAttribute("aria-hidden", "false");
    } else {
      navRightActions.hidden = true;
      navRightActions.setAttribute("aria-hidden", "true");
    }
  };

  const applyCollapsedState = (collapsed) => {
    if (!navbar) return;

    navbar.classList.toggle("is-collapsed", collapsed);

    if (navMenuBtn) {
      if (collapsed) {
        navMenuBtn.hidden = false;
        navMenuBtn.removeAttribute("aria-hidden");
      } else {
        navMenuBtn.hidden = true;
        navMenuBtn.setAttribute("aria-hidden", "true");
        navMenuBtn.setAttribute("aria-expanded", "false");
      }
    }

    if (collapsed) {
      navRightActions?.classList.remove("is-open");
      syncMenuHiddenState(true, false);
    } else {
      navRight?.classList.remove("open");
      navMenuBtn?.setAttribute("aria-expanded", "false");
      navRightActions?.classList.remove("is-open");
      syncMenuHiddenState(false, false);
    }
  };

  const shouldCollapseNavbar = () => {
    if (!navbar || !navLeft || !navTitle || !navRightActions) {
      return window.innerWidth <= 640;
    }

    const navbarStyles = getComputedStyle(navbar);
    const horizontalPadding =
      parseFloat(navbarStyles.paddingLeft || "0") +
      parseFloat(navbarStyles.paddingRight || "0");

    const availableWidth = navbar.clientWidth - horizontalPadding;
    const leftWidth = navLeft.getBoundingClientRect().width;
    const titleWidth = navTitle.getBoundingClientRect().width;
    const rightWidth = navRightActions.getBoundingClientRect().width;

    const buffer = 24; // account for flex gaps and rounding differences
    return window.innerWidth <= 640 || leftWidth + titleWidth + rightWidth + buffer > availableWidth;
  };

  const updateNavbarLayout = () => {
    if (!navbar || !navMenuBtn) return;

    const wasCollapsed = navbar.classList.contains("is-collapsed");

    if (wasCollapsed) {
      navbar.classList.remove("is-collapsed");
      navRight?.classList.remove("open");
      navMenuBtn.setAttribute("aria-expanded", "false");
    }

    const collapsed = shouldCollapseNavbar();
    applyCollapsedState(collapsed);
  };

  const queueLayoutUpdate = () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(updateNavbarLayout);
  };

  if (navbar && !navbar.dataset.layoutBound) {
    queueLayoutUpdate();
    window.addEventListener("resize", queueLayoutUpdate);
    navbar.dataset.layoutBound = "true";
  }

  if (navRight && navRightActions && navMenuBtn && !navMenuBtn.dataset.bound) {
    const closeMenu = () => {
      navRight.classList.remove("open");
      navMenuBtn.setAttribute("aria-expanded", "false");
      navDropdown?.classList.remove("show");
      navRightActions?.classList.remove("is-open");
      syncMenuHiddenState(true, false);
    };
    closeNavMenu = closeMenu;

    navMenuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const isCollapsed = navbar?.classList.contains("is-collapsed");
      if (!isCollapsed) {
        return;
      }
      const willOpen = !navRight.classList.contains("open");
      navRight.classList.toggle("open", willOpen);
      navRightActions?.classList.toggle("is-open", willOpen);
      navMenuBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      syncMenuHiddenState(true, willOpen);
      if (!willOpen) {
        navDropdown?.classList.remove("show");
      }
    });

    navRightActions.addEventListener("click", (event) => {
      if (navRight.classList.contains("open")) {
        event.stopPropagation();
      }
    });

    document.addEventListener("click", () => {
      if (navRight.classList.contains("open")) {
        closeMenu();
      }
    });

    navMenuBtn.dataset.bound = "true";
  }

  // === Theme Toggle ===
  if (!themeBtn.dataset.bound) {
    themeBtn.addEventListener("click", () => {
      closeNavMenu?.();
      document.body.classList.add("transition-gradient");

      setTimeout(() => {
        document.documentElement.classList.toggle("dark");
        document.body.classList.remove("transition-gradient");

        const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
        localStorage.setItem("theme", theme);
        location.reload();

        // 🔁 Force reapply gradient on all gradient-based sections
        document.querySelectorAll("[data-gradient]").forEach(el => {
          const gradientName = el.getAttribute("data-gradient");
          el.style.backgroundImage = ""; // Reset
          requestAnimationFrame(() => {
            const newGradient = getComputedStyle(document.documentElement)
              .getPropertyValue(`--gradient-${gradientName}`)?.trim();
            el.style.backgroundImage = newGradient || "";
          });
        });
      }, 300);

    });
    themeBtn.dataset.bound = "true";
  }

  // === Sound Toggle ===
  if (!soundBtn.dataset.bound) {
    soundBtn.addEventListener("click", () => {
      soundOn = !soundOn;
      localStorage.setItem("sound", soundOn ? "on" : "off");
      soundBtn.classList.toggle("active", !soundOn);

      if (soundOn) {
        clickSound.currentTime = 0;
        clickSound.play().catch(() => {});
      } else {
        soundBtn.classList.add("animate-click");
        setTimeout(() => soundBtn.classList.remove("animate-click"), 300);
      }

      bindButtonEffects(); // Re-bind with updated state
      closeNavMenu?.();
    });

    soundBtn.dataset.bound = "true";
  }

  // Initialize state
  soundBtn.classList.toggle("active", !soundOn);
  bindButtonEffects(); // Initial bind
  queueLayoutUpdate();
}

export function bindButtonEffects() {
  const soundBtn = document.getElementById("sound-toggle");

  document.querySelectorAll("button").forEach(btn => {
    if (!btn.dataset.animated && btn !== soundBtn) {
      btn.addEventListener("mousedown", () => {
        if (soundOn) {
          clickSound.currentTime = 0;
          clickSound.play().catch(() => {});
        }
      });
      btn.dataset.animated = "true";
    }
  });
}
