/**
 * Per-route background wash.
 *
 * A coloured gradient sits between the background photograph and the particle
 * canvas and changes with the route, which is what stops every page reading as
 * the same flat grey. The markup (`#gradient-overlay`) and the layer styling
 * both survived the rebuild; only the code that filled them was lost, so this
 * restores that behaviour against the existing tokens.
 *
 * Layers cross-fade rather than swap: a new layer is added on top at zero
 * opacity, faded in, and the ones underneath are dropped once it has landed.
 */

const FADE_MS = 1000;
const NAMED_ROUTES = ['home', 'contact', 'chapters', 'reader'];

const tokenFor = (route) =>
  NAMED_ROUTES.includes(route) ? `--gradient-${route}` : '--gradient-default';

/** Tokens live on :root and are redefined by `html.dark`. */
const readToken = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let applied = null;

export function applyRouteGradient(route) {
  const overlay = document.getElementById('gradient-overlay');
  if (!overlay) return;

  const value = readToken(tokenFor(route));
  if (!value || value === applied) return;
  applied = value;

  const layer = document.createElement('div');
  layer.className = 'gradient-layer';
  layer.style.backgroundImage = value;

  const previous = [...overlay.querySelectorAll('.gradient-layer')];
  overlay.append(layer);

  // Two frames: one for the layer to be laid out at opacity 0, one for the
  // class change to register as a transition rather than an initial value.
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('active')));

  if (previous.length) {
    setTimeout(() => previous.forEach((node) => node.remove()), FADE_MS);
  }
}

/** Each theme defines its own gradients, so a theme swap has to re-read them. */
export function refreshRouteGradient(route) {
  applied = null;
  applyRouteGradient(route);
}
