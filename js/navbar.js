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

  const getDocumentTheme = () =>
    document.documentElement.classList.contains("dark") ? "dark" : "light";

  const setThemeToggleState = (theme, previousTheme, animate = false) => {
    if (!themeBtn) return;

    themeBtn.setAttribute("data-theme", theme);
    themeBtn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");

    if (!animate || previousTheme === theme) {
      themeBtn.removeAttribute("data-animating");
      themeBtn.removeAttribute("data-prev-theme");
      return;
    }

    themeBtn.setAttribute("data-prev-theme", previousTheme);
    themeBtn.setAttribute("data-animating", "true");

    const handleAnimationEnd = (event) => {
      if (!event.target.classList.contains("theme-icon")) return;
      themeBtn.removeAttribute("data-animating");
      themeBtn.removeAttribute("data-prev-theme");
      themeBtn.removeEventListener("animationend", handleAnimationEnd, true);
    };

    themeBtn.addEventListener("animationend", handleAnimationEnd, true);
  };

  setThemeToggleState(getDocumentTheme());

  window.addEventListener("themechange", (event) => {
    const newTheme = event.detail?.theme || getDocumentTheme();
    const currentTheme = themeBtn.getAttribute("data-theme") || getDocumentTheme();

    if (newTheme === currentTheme) {
      if (!themeBtn.hasAttribute("data-animating")) {
        setThemeToggleState(newTheme);
      }
      return;
    }

    setThemeToggleState(newTheme, currentTheme, true);
  });

  const syncMenuHiddenState = (isCollapsed, isOpen) => {
    if (!navRightActions) return;

    const shouldHide = isCollapsed && !isOpen;

    if (shouldHide) {
      navRightActions.setAttribute("hidden", "");
      navRightActions.setAttribute("aria-hidden", "true");
      navRightActions.setAttribute("inert", "");
    } else {
      navRightActions.removeAttribute("hidden");
      navRightActions.removeAttribute("aria-hidden");
      navRightActions.removeAttribute("inert");
    }
  };

  const refreshGradients = () => {
    document.querySelectorAll("[data-gradient]").forEach((el) => {
      const gradientName = el.getAttribute("data-gradient");
      if (!gradientName) return;

      el.style.backgroundImage = "";

      requestAnimationFrame(() => {
        const newGradient = getComputedStyle(document.documentElement)
          .getPropertyValue(`--gradient-${gradientName}`)
          ?.trim();

        if (newGradient) {
          el.style.backgroundImage = newGradient;
        }
      });
    });
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
    } else {
      navRight?.classList.remove("open");
      navMenuBtn?.setAttribute("aria-expanded", "false");
      navRightActions?.classList.remove("is-open");
    }

    syncMenuHiddenState(collapsed, false);
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
      syncMenuHiddenState(navbar?.classList.contains("is-collapsed"), false);
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
      syncMenuHiddenState(isCollapsed, willOpen);
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
      document.body.classList.add("transition-gradient");

      const previousTheme = themeBtn.getAttribute("data-theme") || getDocumentTheme();
      const isDark = document.documentElement.classList.toggle("dark");
      const theme = isDark ? "dark" : "light";
      localStorage.setItem("theme", theme);

      setThemeToggleState(theme, previousTheme, true);

      requestAnimationFrame(() => {
        refreshGradients();
        window.dispatchEvent(
          new CustomEvent("themechange", { detail: { theme } })
        );
      });

      setTimeout(() => {
        document.body.classList.remove("transition-gradient");
      }, 350);
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
