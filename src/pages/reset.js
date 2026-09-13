import { escapeHTML } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { buildHash, navigate } from '../router.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { toastSuccess } from '../components/toast.js';

/**
 * Two jobs on one route.
 *
 * With no token it asks for an address and starts a reset. With a token it
 * checks the link is still live before showing a password field, so somebody
 * arriving on a dead link is told immediately rather than after typing.
 */

export function title() {
  return t('auth.resetTitle');
}

export async function render(params = {}) {
  const token = String(params.token || '');

  if (!token) {
    return `
      <div class="auth-card">
        <h1>${escapeHTML(t('auth.resetTitle'))}</h1>
        <form id="forgot-form" novalidate>
          <p class="form-error" id="forgot-error" role="alert" hidden></p>
          <p class="form-success" id="forgot-sent" role="status" hidden>
            ${escapeHTML(t('auth.resetSent'))}
          </p>
          <label class="field">
            <span>${escapeHTML(t('auth.email'))}</span>
            <input name="email" type="email" autocomplete="email" required maxlength="254">
          </label>
          <button type="submit" class="button button--primary button--full">
            ${escapeHTML(t('auth.sendResetLink'))}
          </button>
        </form>
        <p class="auth-switch">
          <a href="${buildHash('signin')}">${escapeHTML(t('auth.backToSignIn'))}</a>
        </p>
      </div>`;
  }

  let valid = false;
  try {
    ({ valid } = await api.checkResetToken(token));
  } catch {
    valid = false;
  }

  if (!valid) {
    return `
      <div class="auth-card">
        <h1>${escapeHTML(t('auth.resetTitle'))}</h1>
        <p class="form-error">${escapeHTML(t('auth.resetInvalid'))}</p>
        <a class="button button--primary button--full" href="${buildHash('reset')}">
          ${escapeHTML(t('auth.sendResetLink'))}
        </a>
      </div>`;
  }

  return `
    <div class="auth-card">
      <h1>${escapeHTML(t('auth.resetTitle'))}</h1>
      <form id="reset-form" novalidate data-token="${escapeHTML(token)}">
        <p class="form-error" id="reset-error" role="alert" hidden></p>
        <label class="field">
          <span>${escapeHTML(t('account.newPassword'))}</span>
          <input name="password" type="password" autocomplete="new-password" required minlength="10">
        </label>
        <p class="field-hint">${escapeHTML(t('auth.passwordRules'))}</p>
        <button type="submit" class="button button--primary button--full">
          ${escapeHTML(t('auth.resetTitle'))}
        </button>
      </form>
    </div>`;
}

export function mount() {
  const cleanups = [];
  const bind = (node, event, handler) => {
    if (!node) return;
    node.addEventListener(event, handler);
    cleanups.push(() => node.removeEventListener(event, handler));
  };

  const forgot = document.getElementById('forgot-form');
  bind(forgot, 'submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('forgot-error');
    const sent = document.getElementById('forgot-sent');
    error.hidden = true;

    const email = String(new FormData(forgot).get('email') || '').trim();
    const submit = forgot.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      await api.forgotPassword(email);
      // Shown whatever the outcome: the server deliberately does not say
      // whether that address has an account, and neither does this.
      sent.hidden = false;
      forgot.querySelector('input').value = '';
    } catch (err) {
      error.textContent =
        err instanceof ApiError && err.code === 'auth_rate_limited'
          ? t('auth.rateLimited')
          : t('common.error');
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  const reset = document.getElementById('reset-form');
  bind(reset, 'submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('reset-error');
    error.hidden = true;

    const password = String(new FormData(reset).get('password') || '');
    if (password.length < 10) {
      error.textContent = t('auth.passwordRules');
      error.hidden = false;
      return;
    }

    const submit = reset.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api.resetPassword(reset.dataset.token, password);
      await session.refresh();
      toastSuccess(t('auth.resetDone'));
      navigate('home', {}, { replace: true });
    } catch (err) {
      error.textContent =
        err instanceof ApiError && err.code === 'invalid_token'
          ? t('auth.resetInvalid')
          : t('common.error');
      error.hidden = false;
      submit.disabled = false;
    }
  });

  return () => cleanups.forEach((fn) => fn());
}
