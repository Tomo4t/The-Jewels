import './styles/index.css';

import { initTheme } from './lib/theme.js';
import { bindGlobalSounds } from './lib/sound.js';
import { initParticles } from './lib/particles.js';
import { loadLanguage, preferredLanguage, translateDOM } from './lib/i18n.js';
import { initNavbar } from './components/navbar.js';
import { initRouter, registerRoute, currentRouteName } from './router.js';
import { refreshRouteGradient } from './lib/gradient.js';
import session from './lib/session.js';

registerRoute('home', () => import('./pages/home.js'));
registerRoute('chapters', () => import('./pages/chapters.js'));
registerRoute('reader', () => import('./pages/reader.js'));
registerRoute('contact', () => import('./pages/contact.js'));
registerRoute('fanart', () => import('./pages/fanart.js'));
registerRoute('privacy', () => import('./pages/privacy.js'));
registerRoute('terms', () => import('./pages/terms.js'));
registerRoute('signin', () => import('./pages/auth.js').then((m) => m.signIn));
registerRoute('signup', () => import('./pages/auth.js').then((m) => m.signUp));
registerRoute('profile', () => import('./pages/profile.js'));
registerRoute('reset', () => import('./pages/reset.js'));
registerRoute('notFound', () => import('./pages/notFound.js'));

// Entry points that live outside the site — a privacy policy URL given to
// Google, a link pasted into a forum — arrive as a path rather than a hash.
// The server serves index.html for these, and the router takes it from here.
const PATH_ROUTES = { '/privacy': 'privacy', '/terms': 'terms' };

function adoptPathRoute() {
  if (window.location.hash) return;
  const route = PATH_ROUTES[window.location.pathname.replace(/\/+$/, '') || '/'];
  if (route) window.history.replaceState({}, '', `/#${route}`);
}

async function bootstrap() {
  adoptPathRoute();
  initTheme();
  await loadLanguage(preferredLanguage());
  translateDOM(document);

  bindGlobalSounds();
  initNavbar();
  initParticles({ count: 60, color: 'rgba(255,255,255,0.3)', minSize: 1, maxSize: 3, speed: 0.6 });

  // The session check is not on the critical path — the comic reads fine
  // without it, so the router starts immediately and the navbar catches up.
  session.refresh();

  initRouter(document.getElementById('page-content'));

  document.addEventListener('languagechange', () => translateDOM(document));
  document.body.classList.add('is-ready');
}

bootstrap().catch((err) => {
  console.error('[boot] failed to start', err);
  const outlet = document.getElementById('page-content');
  if (outlet) {
    outlet.innerHTML =
      '<div class="page-error"><p>Something went wrong loading the site.</p></div>';
  }
});

// The gradient tokens are redefined per theme, so the wash has to be rebuilt
// whenever the theme changes rather than staying on the old palette.
document.addEventListener('themechange', () => {
  refreshRouteGradient(currentRouteName());
});
