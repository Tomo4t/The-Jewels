import { t } from './lib/i18n.js';
import { applyRouteGradient } from './lib/gradient.js';

/**
 * Hash router.
 *
 * Hash routing is deliberate: it keeps every deep link working even when the
 * site is served by a plain static host with no rewrite rules.
 *
 * Routes render into #page-content. Each page module exports `render` (which
 * returns HTML or a Node) and may export `mount` (run after insertion) and
 * `unmount` (cleanup — listeners, timers, observers).
 */

const routes = new Map();
let outlet = null;
let currentRoute = null;
let currentCleanup = null;
let renderToken = 0;

export function registerRoute(name, loader) {
  routes.set(name, loader);
}

export function parseHash(hash = window.location.hash) {
  const trimmed = String(hash || '').replace(/^#/, '');
  if (!trimmed) return { name: 'home', params: {} };

  const [name, query = ''] = trimmed.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { name: name || 'home', params };
}

export function buildHash(name, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null && value !== ''
    )
  ).toString();
  return `#${name}${query ? `?${query}` : ''}`;
}

export function navigate(name, params = {}, { replace = false } = {}) {
  const hash = buildHash(name, params);
  if (window.location.hash === hash) {
    render();
    return;
  }
  if (replace) window.history.replaceState({}, '', hash);
  else window.history.pushState({}, '', hash);
  render();
}

/** Replaces the URL without re-rendering — used to keep reader state in sync. */
export function syncHash(name, params = {}) {
  const hash = buildHash(name, params);
  if (window.location.hash !== hash) window.history.replaceState({}, '', hash);
}

export const currentRouteName = () => currentRoute;

async function render() {
  const token = ++renderToken;
  const { name, params } = parseHash();

  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (err) {
      console.error('[router] cleanup failed', err);
    }
    currentCleanup = null;
  }

  const resolved = routes.has(name) ? name : 'notFound';
  const loader = routes.get(resolved);
  outlet.setAttribute('aria-busy', 'true');

  let page;
  try {
    page = await loader();
  } catch (err) {
    console.error(`[router] could not load "${resolved}"`, err);
    outlet.innerHTML = `<div class="page-error"><p>${t('common.error')}</p></div>`;
    outlet.removeAttribute('aria-busy');
    return;
  }

  // A newer navigation started while this one was loading.
  if (token !== renderToken) return;

  try {
    const result = await page.render(params);
    if (token !== renderToken) return;

    outlet.replaceChildren();
    if (result instanceof Node) outlet.append(result);
    else outlet.innerHTML = String(result ?? '');

    currentRoute = resolved;
    // Named distinctly from the [data-route] trigger attribute: a `data-route`
    // on <body> would make every click on the page match the delegated
    // handler below and have its default action cancelled.
    document.body.dataset.activeRoute = resolved;
    applyRouteGradient(resolved);

    if (typeof page.mount === 'function') {
      currentCleanup = (await page.mount(params, outlet)) || null;
    }
    if (typeof page.title === 'function') {
      document.title = `${page.title(params)} · The Jewels`;
    } else {
      document.title = 'The Jewels';
    }
  } catch (err) {
    console.error(`[router] "${resolved}" failed to render`, err);
    outlet.innerHTML = `<div class="page-error"><p>${t('common.error')}</p></div>`;
  } finally {
    if (token === renderToken) outlet.removeAttribute('aria-busy');
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
}

export function initRouter(target) {
  outlet = target;

  // Any in-app link of the form href="#route?..." routes through here.
  window.addEventListener('hashchange', render);
  window.addEventListener('popstate', render);

  // Buttons and links may carry data-route instead of an href. Only real
  // controls qualify, so a stray attribute on a container can never swallow
  // clicks meant for the page.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('a[data-route], button[data-route]');
    if (!trigger || !trigger.dataset.route) return;

    event.preventDefault();
    let params = {};
    if (trigger.dataset.routeParams) {
      try {
        params = JSON.parse(trigger.dataset.routeParams);
      } catch {
        params = {};
      }
    }
    navigate(trigger.dataset.route, params);
  });

  document.addEventListener('languagechange', render);

  render();
}

export { render as renderCurrentRoute };
