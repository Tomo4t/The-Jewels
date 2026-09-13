import { escapeHTML } from '../lib/dom.js';
import { t, formatDate } from '../lib/i18n.js';
import { buildHash, navigate } from '../router.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { toastSuccess, toastError } from '../components/toast.js';

/**
 * The signed-in user's own settings: the address on the account, whether it has
 * been confirmed, and the password. Everything here is scoped to the current
 * user; moderation and other people's accounts live in the admin page.
 */

export function title() {
  return t('account.title');
}

const badge = (verified) =>
  `<span class="verify-badge${verified ? ' is-verified' : ''}">
     ${escapeHTML(verified ? t('auth.verified') : t('auth.unverified'))}
   </span>`;

export async function render(params = {}) {
  if (!session.loaded) await session.refresh();

  if (!session.apiAvailable) {
    return `<div class="auth-card"><p class="empty-note">${escapeHTML(t('errors.offline'))}</p></div>`;
  }

  if (!session.isSignedIn) {
    return `
      <div class="auth-card">
        <h1>${escapeHTML(t('account.title'))}</h1>
        <a class="button button--primary button--full" href="${buildHash('signin')}">
          ${escapeHTML(t('auth.signIn'))}
        </a>
      </div>`;
  }

  const user = session.user;

  // The verification link redirects back here with the outcome in the hash.
  const verifyNotice =
    params.verified === '1'
      ? `<p class="form-success" role="status">${escapeHTML(t('auth.verifySuccess'))}</p>`
      : params.verified === '0'
        ? `<p class="form-error" role="alert">${escapeHTML(t('auth.verifyFailed'))}</p>`
        : '';

  return `
    <div class="account-page">
      <h1>${escapeHTML(t('account.title'))}</h1>
      ${verifyNotice}

      <section class="account-section">
        <dl class="account-facts">
          <div>
            <dt>${escapeHTML(t('account.usernameLabel'))}</dt>
            <dd>${escapeHTML(user.username)}</dd>
          </div>
          <div>
            <dt>${escapeHTML(t('account.memberSince'))}</dt>
            <dd>${escapeHTML(formatDate(user.createdAt))}</dd>
          </div>
        </dl>
      </section>

      <section class="account-section">
        <h2>${escapeHTML(t('account.emailSection'))}</h2>

        ${
          user.email
            ? `<p class="account-email">
                 <span class="account-email-address">${escapeHTML(user.email)}</span>
                 ${badge(user.emailVerified)}
               </p>
               ${
                 !user.emailVerified && session.emailVerification
                   ? `<button type="button" class="button" id="resend-verify">
                        ${escapeHTML(t('auth.resendVerification'))}
                      </button>`
                   : ''
               }`
            : `<p class="empty-note">${escapeHTML(t('account.noEmail'))}</p>`
        }

        <form id="email-form" class="account-form" novalidate>
          <p class="form-error" id="email-error" role="alert" hidden></p>
          <label class="field">
            <span>${escapeHTML(user.email ? t('account.changeEmail') : t('account.addEmail'))}</span>
            <input name="email" type="email" maxlength="254" autocomplete="email" required>
          </label>
          <button type="submit" class="button button--primary">
            ${escapeHTML(t('account.save'))}
          </button>
        </form>
      </section>

      ${
        user.linkedGoogle
          ? `<section class="account-section">
               <h2>${escapeHTML(t('account.signInMethods'))}</h2>
               <p class="account-note">${escapeHTML(t('account.googleLinked'))}</p>
             </section>`
          : ''
      }

      <section class="account-section">
        <h2>${escapeHTML(t('account.passwordSection'))}</h2>
        ${
          user.hasPassword
            ? `<form id="password-form" class="account-form" novalidate>
                 <p class="form-error" id="password-error" role="alert" hidden></p>
                 <label class="field">
                   <span>${escapeHTML(t('account.currentPassword'))}</span>
                   <input name="currentPassword" type="password" autocomplete="current-password" required>
                 </label>
                 <label class="field">
                   <span>${escapeHTML(t('account.newPassword'))}</span>
                   <input name="newPassword" type="password" autocomplete="new-password"
                          required minlength="10">
                 </label>
                 <p class="field-hint">${escapeHTML(t('auth.passwordRules'))}</p>
                 <button type="submit" class="button button--primary">
                   ${escapeHTML(t('account.changePassword'))}
                 </button>
               </form>`
            : `<p class="account-note">${escapeHTML(t('account.noPassword'))}</p>`
        }
      </section>
    </div>
  `;
}

export function mount() {
  const cleanups = [];

  const bind = (node, event, handler) => {
    if (!node) return;
    node.addEventListener(event, handler);
    cleanups.push(() => node.removeEventListener(event, handler));
  };

  const fail = (box, message) => {
    box.textContent = message;
    box.hidden = false;
  };

  // --- change or add the address ---
  const emailForm = document.getElementById('email-form');
  const emailError = document.getElementById('email-error');

  bind(emailForm, 'submit', async (event) => {
    event.preventDefault();
    emailError.hidden = true;

    const value = String(new FormData(emailForm).get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      return fail(emailError, t('auth.emailInvalid'));
    }

    const submit = emailForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const { verification } = await session.setEmail(value);
      toastSuccess(t('account.emailUpdated'));
      if (verification?.status === 'sent') toastSuccess(t('auth.verifySent'));
      else if (verification?.status === 'send_failed') toastError(t('auth.verifySendFailed'));
      navigate('account', {}, { replace: true });
    } catch (err) {
      const map = {
        email_taken: t('auth.emailTaken'),
        validation_failed: t('auth.emailInvalid'),
        auth_rate_limited: t('auth.rateLimited'),
      };
      fail(emailError, err instanceof ApiError ? map[err.code] || err.message : t('common.error'));
      submit.disabled = false;
    }
    return undefined;
  });

  // --- resend the confirmation link ---
  bind(document.getElementById('resend-verify'), 'click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await session.resendVerification();
      if (result?.status === 'sent') toastSuccess(t('auth.verifySent'));
      else if (result?.status === 'already_verified') toastSuccess(t('auth.alreadyVerified'));
      else toastError(t('auth.verifySendFailed'));
    } catch (err) {
      toastError(
        err instanceof ApiError && err.code === 'auth_rate_limited'
          ? t('auth.rateLimited')
          : t('common.error')
      );
    } finally {
      button.disabled = false;
    }
  });

  // --- change the password ---
  const passwordForm = document.getElementById('password-form');
  const passwordError = document.getElementById('password-error');

  bind(passwordForm, 'submit', async (event) => {
    event.preventDefault();
    passwordError.hidden = true;

    const data = Object.fromEntries(new FormData(passwordForm));
    const next = String(data.newPassword || '');
    if (next.length < 10) return fail(passwordError, t('auth.passwordRules'));

    const submit = passwordForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api.changePassword(String(data.currentPassword || ''), next);
      toastSuccess(t('account.passwordChanged'));
      passwordForm.reset();
    } catch (err) {
      const map = {
        invalid_credentials: t('auth.invalidCredentials'),
        auth_rate_limited: t('auth.rateLimited'),
      };
      fail(
        passwordError,
        err instanceof ApiError ? map[err.code] || err.message : t('common.error')
      );
    } finally {
      submit.disabled = false;
    }
    return undefined;
  });

  return () => cleanups.forEach((fn) => fn());
}
