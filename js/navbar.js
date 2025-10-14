
import { initRouter } from './router.js';
export let soundOn = localStorage.getItem("sound") !== "off"; // Global state
const clickSound = new Audio("audio/click.mp3");
clickSound.volume = 0.3;

export function initNavbar() {
  const themeBtn = document.getElementById("theme-toggle");
  const soundBtn = document.getElementById("sound-toggle");
  const navRight = document.querySelector(".nav-right");
  const navRightActions = document.getElementById("nav-right-actions");
  const navMenuBtn = document.getElementById("nav-right-menu");
  const navDropdown = document.querySelector(".nav-right .dropdown");
  let closeNavMenu = null;

  if (!themeBtn || !soundBtn) return;

  if (navRight && navRightActions && navMenuBtn && !navMenuBtn.dataset.bound) {
    const closeMenu = () => {
      navRight.classList.remove("open");
      navMenuBtn.setAttribute("aria-expanded", "false");
      navDropdown?.classList.remove("show");
    };
    closeNavMenu = closeMenu;

    navMenuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = !navRight.classList.contains("open");
      navRight.classList.toggle("open", willOpen);
      navMenuBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
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

    window.addEventListener("resize", () => {
      if (window.innerWidth > 720 && navRight.classList.contains("open")) {
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
