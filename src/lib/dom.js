/** Small DOM helpers. Nothing clever — just the things used on every page. */

/** Escapes text for safe interpolation into an HTML string. */
export function escapeHTML(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Turns user text into paragraphs without ever trusting it as markup. */
// Stops at whitespace, and at the < of an escaped tag so a link can never run
// on into neighbouring markup.
const URL_IN_TEXT = /\b(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
// Sentence punctuation clings to the end of a pasted URL far more often than it
// belongs to one, so it is handed back to the sentence.
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Turns URLs into links inside text that has ALREADY been escaped.
 *
 * The order is the whole safety argument: by the time this runs the text is
 * inert, so the only anchor in the output is one this function wrote. Doing it
 * before escaping would mean escaping our own markup afterwards.
 *
 * rel is "nofollow ugc noopener noreferrer" -- nofollow and ugc because a comment
 * box that passes the site's search ranking to anything a stranger pastes is a
 * spam magnet, and noopener because a target=_blank link without it lets the
 * page it opens reach back and navigate this one.
 */
function linkifyEscaped(escaped) {
  return escaped.replace(URL_IN_TEXT, (match) => {
    const trailing = (match.match(TRAILING) || [''])[0];
    const url = match.slice(0, match.length - trailing.length);
    if (!url) return match;

    const href = url.startsWith('www.') ? `https://${url}` : url;
    // A pasted URL can be hundreds of characters and would otherwise blow out
    // the column it sits in.
    const label = url.length > 60 ? `${url.slice(0, 57)}…` : url;
    return (
      `<a href="${href}" rel="nofollow ugc noopener noreferrer" target="_blank">${label}</a>` +
      trailing
    );
  });
}

export function textToHTML(value, { links = false } = {}) {
  const escaped = escapeHTML(value);
  return (links ? linkifyEscaped(escaped) : escaped)
    .split('\n')
    .map((line) => (line.trim() ? line : '&nbsp;'))
    .join('<br>');
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

/** True when the visitor asked their system to reduce animation. */
export const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Announces a message to screen readers without moving focus. */
export function announce(message) {
  let region = document.getElementById('sr-live');
  if (!region) {
    region = el('div', {
      id: 'sr-live',
      class: 'visually-hidden',
      role: 'status',
      'aria-live': 'polite',
    });
    document.body.append(region);
  }
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/** Traps Tab inside a container while a dialog is open. Returns a cleanup fn. */
export function trapFocus(container) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = $$(selector, container).filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  return () => container.removeEventListener('keydown', onKeydown);
}
