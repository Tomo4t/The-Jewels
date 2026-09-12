import './styles/index.css';

import { initTheme } from './lib/theme.js';
import { bindGlobalSounds } from './lib/sound.js';
import { initParticles } from './lib/particles.js';
import { loadLanguage, preferredLanguage, translateDOM } from './lib/i18n.js';
import { initNavbar } from './components/navbar.js';
import { initRouter, registerRoute } from './router.js';
import session from './lib/session.js';

registerRoute('home', () => import('./pages/home.js'));
registerRoute('chapters', () => import('./pages/chapters.js'));
registerRoute('reader', () => import('./pages/reader.js'));
registerRoute('contact', () => import('./pages/contact.js'));
registerRoute('signin', () => import('./pages/auth.js').then((m) => m.signIn));
registerRoute('signup', () => import('./pages/auth.js').then((m) => m.signUp));
registerRoute('notFound', () => import('./pages/notFound.js'));

async function bootstrap() {
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
