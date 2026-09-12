/*
 * Runs before first paint so the page never flashes the wrong theme.
 * Deliberately a separate file rather than an inline <script>: the Content
 * Security Policy only allows scripts from this origin, with no 'unsafe-inline'.
 */
(function () {
  try {
    var saved = localStorage.getItem('theme');
    var dark =
      saved === 'dark' ||
      (saved !== 'light' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (dark) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    }
  } catch (_e) {
    /* storage blocked — the default light theme is fine */
  }
})();
