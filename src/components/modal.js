import { el } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

/**
 * Asking before something irreversible happens.
 *
 * window.confirm looked like the honest, dependency-free choice and is not:
 * browsers suppress repeat dialogs from the same page -- Chrome offers "prevent
 * this page from creating additional dialogs" and then remembers it -- and
 * several in-app browsers never show them at all. A suppressed confirm returns
 * false, so the button silently becomes a no-op: nothing happens, no error, no
 * explanation. That is exactly how the "send the newsletter" button came to do
 * nothing at all.
 *
 * This is the same question asked inside the page, where nothing can swallow it.
 */

let active = null;

function close(result) {
  if (!active) return;
  const { node, resolve, onKey, previousFocus } = active;
  active = null;
  document.removeEventListener('keydown', onKey, true);
  node.remove();
  previousFocus?.focus?.();
  resolve(result);
}

function present({ title, message, hint, actions }) {
  // One at a time: a second question stacked on the first is a question nobody
  // can answer sensibly.
  if (active) close(null);

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;

    const buttons = actions.map((action) =>
      el('button', {
        type: 'button',
        class: `button ${action.class || ''}`.trim(),
        text: action.label,
        onClick: () => close(action.value),
      })
    );

    const node = el(
      'div',
      { class: 'dialog-backdrop', role: 'presentation' },
      el(
        'div',
        { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
        el('h2', { class: 'dialog-title', text: title }),
        message ? el('p', { class: 'dialog-message', text: message }) : null,
        hint ? el('p', { class: 'dialog-hint', text: hint }) : null,
        el('div', { class: 'dialog-actions' }, ...buttons)
      )
    );

    // Clicking the backdrop is a way out, the same as cancelling.
    node.addEventListener('click', (event) => {
      if (event.target === node) close(null);
    });

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape belongs to the dialog while one is open. The reader uses it to
        // leave focus mode and the navbar to close its menu, and backing out of
        // a question should not also do either of those.
        event.stopPropagation();
        close(null);
        return;
      }
      // Focus stays inside. Tabbing out of a modal and hitting the button behind
      // it is how people confirm things they never read.
      if (event.key !== 'Tab') return;
      const focusable = [...node.querySelectorAll('button')];
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

    document.addEventListener('keydown', onKey, true);
    document.body.append(node);
    active = { node, resolve, onKey, previousFocus };

    // The safe option takes focus, so Enter never confirms something
    // destructive by reflex.
    (buttons.find((button) => button.classList.contains('button--quiet')) || buttons[0]).focus();
  });
}

/** Yes or no. Resolves true only if they actually said yes. */
export function confirmDialog({ title, message, hint, confirmLabel, danger = false }) {
  return present({
    title,
    message,
    hint,
    actions: [
      { label: t('common.cancel'), value: false, class: 'button--quiet' },
      {
        label: confirmLabel || t('common.confirm'),
        value: true,
        class: danger ? 'button--danger' : 'button--primary',
      },
    ],
  }).then((value) => value === true);
}

/**
 * One of several. Resolves the chosen value, or null if they backed out.
 * Replaces asking somebody to type "1", "2" or "3" into a prompt box.
 */
export function chooseDialog({ title, message, hint, options }) {
  return present({
    title,
    message,
    hint,
    actions: [
      ...options.map((option) => ({
        label: option.label,
        value: option.value,
        class: option.danger ? 'button--danger' : '',
      })),
      { label: t('common.cancel'), value: null, class: 'button--quiet' },
    ],
  });
}
