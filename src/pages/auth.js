import { el, escapeHTML } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { navigate, buildHash } from '../router.js';
import session from '../lib/session.js';
import { ApiError } from '../lib/api.js';
import { toastSuccess, toastError } from '../components/toast.js';

/**
 * Sign in and sign up share one page; `mode` decides which fields show.
 * Validation happens client-side for immediate feedback and again on the
 * server, which is the copy that actually matters.
 */

function page(mode) {
  const isRegister = mode === 'register';

  return {
    title: () => (isRegister ? t('auth.signUp') : t('auth.signIn')),

    async render(params = {}) {
      if (!session.loaded) await session.refresh();

      if (!session.apiAvailable) {
        return `<div class="auth-card"><p class="empty-note">${escapeHTML(t('errors.offline'))}</p></div>`;
      }

      if (session.isSignedIn) {
        return `
          <div class="auth-card">
            <h1>${escapeHTML(t('auth.signedInAs', { name: session.user.displayName }))}</h1>
            <a class="button button--primary" href="${buildHash('home')}">${escapeHTML(t('nav.home'))}</a>
          </div>`;
      }

      if (isRegister && !session.registrationOpen) {
        return `
          <div class="auth-card">
            <h1>${escapeHTML(t('auth.signUp'))}</h1>
            <p class="form-error">${escapeHTML(t('auth.registrationClosed'))}</p>
            <a class="button" href="${buildHash('signin')}">${escapeHTML(t('auth.signIn'))}</a>
          </div>`;
      }

      const googleMessages = {
        cancelled: t('auth.googleCancelled'),
        expired: t('auth.googleExpired'),
        failed: t('auth.googleFailed'),
        banned: t('auth.accountBanned'),
        registration_closed: t('auth.registrationClosed'),
      };
      const notice = googleMessages[params.google];

      return `
        <div class="auth-card">
          <h1>${escapeHTML(isRegister ? t('auth.signUp') : t('auth.signIn'))}</h1>

          ${notice ? `<p class="form-error" role="alert">${escapeHTML(notice)}</p>` : ''}

          ${
            session.googleSignIn
              ? `<a class="button button--google button--full" href="/api/auth/google">
                   <svg class="google-mark" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                     <path fill="#4285F4" d="M17.6 9.2c0-.6-.05-1.2-.16-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"/>
                     <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/>
                     <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z"/>
                     <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/>
                   </svg>
                   <span>${escapeHTML(t('auth.continueWithGoogle'))}</span>
                 </a>
                 <p class="auth-divider"><span>${escapeHTML(t('auth.orDivider'))}</span></p>`
              : ''
          }

          <form id="auth-form" novalidate>
            <p class="form-error" id="auth-error" role="alert" hidden></p>

            <label class="field">
              <span>${escapeHTML(t('auth.username'))}</span>
              <input name="username" type="text" autocomplete="username" required
                     minlength="3" maxlength="24" pattern="[A-Za-z0-9_-]+"
                     aria-describedby="username-hint">
            </label>
            ${
              isRegister
                ? `<p class="field-hint" id="username-hint">${escapeHTML(t('auth.usernameRules'))}</p>`
                : '<span id="username-hint" hidden></span>'
            }

            ${
              isRegister
                ? `<label class="field">
                     <span>${escapeHTML(t('auth.displayName'))}</span>
                     <input name="displayName" type="text" maxlength="40" autocomplete="nickname">
                   </label>
                   <label class="field">
                     <span>${escapeHTML(t('auth.emailOptional'))}</span>
                     <input name="email" type="email" maxlength="254" autocomplete="email"
                            aria-describedby="email-hint">
                   </label>
                   <p class="field-hint" id="email-hint">${escapeHTML(t('auth.emailHint'))}</p>`
                : ''
            }

            <label class="field">
              <span>${escapeHTML(t('auth.password'))}</span>
              <input name="password" type="password" required minlength="10"
                     autocomplete="${isRegister ? 'new-password' : 'current-password'}"
                     aria-describedby="password-hint">
            </label>
            ${
              isRegister
                ? `<p class="field-hint" id="password-hint">${escapeHTML(t('auth.passwordRules'))}</p>
                   <label class="field">
                     <span>${escapeHTML(t('auth.confirmPassword'))}</span>
                     <input name="confirmPassword" type="password" required minlength="10"
                            autocomplete="new-password">
                   </label>`
                : '<span id="password-hint" hidden></span>'
            }

            <button type="submit" class="button button--primary button--full">
              ${escapeHTML(isRegister ? t('auth.signUp') : t('auth.signIn'))}
            </button>
          </form>

          <p class="auth-switch">
            ${escapeHTML(isRegister ? t('auth.haveAccount') : t('auth.needAccount'))}
            <a href="${buildHash(isRegister ? 'signin' : 'signup')}">
              ${escapeHTML(isRegister ? t('auth.signIn') : t('auth.signUp'))}
            </a>
          </p>
        </div>
      `;
    },

    mount() {
      const form = document.getElementById('auth-form');
      if (!form) return () => {};

      const errorBox = document.getElementById('auth-error');
      const submit = form.querySelector('button[type="submit"]');

      const showError = (message) => {
        errorBox.textContent = message;
        errorBox.hidden = false;
      };

      const onSubmit = async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const data = Object.fromEntries(new FormData(form));
        const username = String(data.username || '').trim();
        const password = String(data.password || '');

        if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) return showError(t('auth.usernameRules'));
        if (password.length < 10) return showError(t('auth.passwordRules'));
        if (isRegister && password !== String(data.confirmPassword || '')) {
          return showError(t('auth.passwordMismatch'));
        }

        submit.disabled = true;
        try {
          if (isRegister) {
            const email = String(data.email || '').trim();
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
              submit.disabled = false;
              return showError(t('auth.emailInvalid'));
            }

            const { verification } = await session.signUp({
              username,
              password,
              displayName: String(data.displayName || '').trim() || undefined,
              email: email || undefined,
            });

            toastSuccess(t('auth.accountCreated'));
            // Only promise an inbox check when one is genuinely on its way.
            if (verification?.status === 'sent') toastSuccess(t('auth.verifySent'));
            else if (verification?.status === 'send_failed') toastError(t('auth.verifySendFailed'));
          } else {
            const user = await session.signIn(username, password);
            toastSuccess(t('auth.welcome', { name: user.displayName }));
          }
          navigate('home', {}, { replace: true });
        } catch (err) {
          if (err instanceof ApiError) {
            const map = {
              invalid_credentials: t('auth.invalidCredentials'),
              username_taken: t('auth.usernameTaken'),
              email_taken: t('auth.emailTaken'),
              registration_closed: t('auth.registrationClosed'),
              account_banned: t('auth.accountBanned'),
              auth_rate_limited: t('auth.rateLimited'),
            };
            showError(map[err.code] || err.message);
          } else {
            showError(t('common.error'));
          }
          submit.disabled = false;
        }
        return undefined;
      };

      form.addEventListener('submit', onSubmit);
      form.querySelector('input[name="username"]')?.focus();

      return () => form.removeEventListener('submit', onSubmit);
    },
  };
}

export const signIn = page('login');
export const signUp = page('register');
export { el };
