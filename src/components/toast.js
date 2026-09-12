import { el } from '../lib/dom.js';

/** Short-lived status messages. Announced to screen readers via role=status. */
let host = null;

function container() {
  if (!host) {
    host = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

export function toast(message, { type = 'info', duration = 4000 } = {}) {
  const node = el('div', { class: `toast toast--${type}`, text: message });
  container().append(node);

  requestAnimationFrame(() => node.classList.add('is-visible'));

  const dismiss = () => {
    node.classList.remove('is-visible');
    node.addEventListener('transitionend', () => node.remove(), { once: true });
    window.setTimeout(() => node.remove(), 500);
  };

  window.setTimeout(dismiss, duration);
  node.addEventListener('click', dismiss);
  return dismiss;
}

export const toastError = (message) => toast(message, { type: 'error', duration: 6000 });
export const toastSuccess = (message) => toast(message, { type: 'success' });
