import { escapeHTML } from '../lib/dom.js';
import { t, formatDate } from '../lib/i18n.js';
import { buildHash, navigate } from '../router.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { toastSuccess, toastError } from '../components/toast.js';

/**
 * The signed-in reader's own page.
 *
 * It used to be a stack of sections with two forms permanently unfolded, so
 * the first thing you saw on your own account page was an empty "change your
 * password" box. The settings are disclosures now: each row states what the
 * setting currently is, and opens only when you mean to change it. What you
 * actually come here to look at -- who you are, and what you have written --
 * is what is on screen when the page loads.
 *
 * Moderators keep the approval queue here, so the everyday job does not
 * require opening the admin panel.
 */

export function title() {
  // t() returns the key itself when a string is missing, so `||` never falls
  // through -- the page was titled "profile.title". There is one heading for
  // this page and it lives under account.
  return t('account.title');
}

const STATUS_LABEL = {
  visible: 'profile.statusVisible',
  pending: 'profile.statusPending',
  rejected: 'profile.statusRejected',
};

const ROLE_LABEL = { admin: 'comments.admin', moderator: 'comments.moderator' };

const commentCard = (comment, { moderation = false } = {}) => {
  const status = comment.status || 'visible';
  const href = buildHash('reader', { chapter: comment.chapter, lang: comment.lang });

  return `
    <li class="mine-item" data-comment="${comment.id}">
      <div class="mine-head">
        <a class="mine-where" href="${href}">
          ${escapeHTML(t('profile.onChapter', { n: comment.chapter }))}
        </a>
        <span class="mine-status is-${escapeHTML(status)}">
          ${escapeHTML(t(STATUS_LABEL[status] || STATUS_LABEL.visible))}
        </span>
      </div>
      ${moderation ? `<p class="mine-author">${escapeHTML(comment.author?.displayName || comment.author?.username || '')}</p>` : ''}
      <p class="mine-body">${escapeHTML(comment.body || '')}</p>
      ${comment.flagReason ? `<p class="mine-flag">${escapeHTML(comment.flagReason)}</p>` : ''}
      <time class="mine-time" datetime="${escapeHTML(comment.createdAt)}">
        ${escapeHTML(formatDate(comment.createdAt))}
      </time>
      ${
        moderation
          ? `<div class="mine-actions">
               <button type="button" class="icon-action is-approve" data-act="approve"
                       title="${escapeHTML(t('profile.approve'))}"
                       aria-label="${escapeHTML(t('profile.approve'))}">&#10003;</button>
               <button type="button" class="icon-action is-reject" data-act="reject"
                       title="${escapeHTML(t('profile.reject'))}"
                       aria-label="${escapeHTML(t('profile.reject'))}">&#10005;</button>
             </div>`
          : ''
      }
    </li>`;
};

/** One settings row: what it is now in the summary, the form behind it. */
const setting = (id, label, value, body, { tone = '' } = {}) => `
  <details class="setting" id="setting-${id}">
    <summary class="setting-summary">
      <span class="setting-label">${escapeHTML(label)}</span>
      <span class="setting-value${tone ? ` is-${tone}` : ''}">${value}</span>
    </summary>
    <div class="setting-body">${body}</div>
  </details>`;

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

  const verifyNotice =
    params.verified === '1'
      ? `<p class="form-success" role="status">${escapeHTML(t('auth.verifySuccess'))}</p>`
      : params.verified === '0'
        ? `<p class="form-error" role="alert">${escapeHTML(t('auth.verifyFailed'))}</p>`
        : '';

  // Both lists are fetched up front so the page arrives complete rather than
  // filling in underneath the reader.
  let mine = { comments: [], total: 0 };
  try {
    mine = await api.myComments({ limit: 50 });
  } catch {
    mine = { comments: [], total: 0 };
  }

  let queue = null;
  if (session.isModerator) {
    try {
      queue = await api.moderationQueue();
    } catch {
      queue = null;
    }
  }

  const roleKey = ROLE_LABEL[user.role];

  // Shown once, to an account that never chose the names it appears under --
  // in practice a Google sign-up, where the server picked the username and
  // Google supplied the display name.
  const welcome = session.profileSetupPending
    ? `
      <section class="account-section welcome-panel" id="welcome-panel">
        <h2>${escapeHTML(t('profile.welcomeTitle'))}</h2>
        <p>${escapeHTML(t('profile.welcomeBody'))}</p>
        <form id="welcome-form" class="account-form" novalidate>
          <p class="form-error" id="welcome-error" role="alert" hidden></p>
          <label class="field">
            <span>${escapeHTML(t('account.usernameLabel'))}</span>
            <input name="username" type="text" value="${escapeHTML(user.username)}"
                   minlength="3" maxlength="24" autocomplete="username" required>
          </label>
          <p class="field-hint">${escapeHTML(t('profile.usernameOnce'))}</p>
          <label class="field">
            <span>${escapeHTML(t('account.displayNameLabel'))}</span>
            <input name="displayName" type="text" value="${escapeHTML(user.displayName || user.username)}"
                   maxlength="40" required>
          </label>
          <p class="field-hint">${escapeHTML(t('account.displayNameHint'))}</p>
          <button type="submit" class="button button--primary">
            ${escapeHTML(t('profile.welcomeSave'))}
          </button>
        </form>
      </section>`
    : '';

  const emailBody = `
    ${
      user.email && !user.emailVerified && session.emailVerification
        ? `<button type="button" class="button" id="resend-verify">
             ${escapeHTML(t('auth.resendVerification'))}
           </button>`
        : ''
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
    </form>`;

  const passwordBody = user.hasPassword
    ? `<form id="password-form" class="account-form" novalidate>
         <p class="form-error" id="password-error" role="alert" hidden></p>
         <label class="field">
           <span>${escapeHTML(t('account.currentPassword'))}</span>
           <input name="currentPassword" type="password" autocomplete="current-password" required>
         </label>
         <label class="field">
           <span>${escapeHTML(t('account.newPassword'))}</span>
           <input name="newPassword" type="password" autocomplete="new-password" required minlength="10">
         </label>
         <p class="field-hint">${escapeHTML(t('auth.passwordRules'))}</p>
         <button type="submit" class="button button--primary">
           ${escapeHTML(t('account.changePassword'))}
         </button>
       </form>`
    : `<p class="account-note">${escapeHTML(t('account.noPassword'))}</p>`;

  const displayNameBody = `
    <form id="display-name-form" class="account-form" novalidate>
      <p class="form-error" id="display-name-error" role="alert" hidden></p>
      <label class="field">
        <span>${escapeHTML(t('account.displayNameLabel'))}</span>
        <input name="displayName" type="text" maxlength="40" required
               value="${escapeHTML(user.displayName || '')}">
      </label>
      <p class="field-hint">${escapeHTML(t('account.displayNameHint'))}</p>
      <button type="submit" class="button button--primary">
        ${escapeHTML(t('account.save'))}
      </button>
    </form>`;

  const emailSummary = user.email
    ? `${escapeHTML(user.email)}${
        user.emailVerified
          ? ''
          : ` <span class="setting-flag">${escapeHTML(t('auth.unverified'))}</span>`
      }`
    : `<span class="setting-empty">${escapeHTML(t('account.noEmail'))}</span>`;

  return `
    <div class="account-page">
      <header class="profile-head">
        <div class="profile-identity">
          <h1 class="profile-name">${escapeHTML(user.displayName || user.username)}</h1>
          <p class="profile-meta">
            <span class="profile-handle">@${escapeHTML(user.username)}</span>
            ${roleKey ? `<span class="profile-role is-${escapeHTML(user.role)}">${escapeHTML(t(roleKey))}</span>` : ''}
            <span class="profile-since">${escapeHTML(t('account.memberSince'))} ${escapeHTML(formatDate(user.createdAt))}</span>
          </p>
        </div>
        <div class="profile-head-actions">
          ${
            session.isAdmin
              ? `<a class="icon-action" href="/admin"
                    title="${escapeHTML(t('profile.adminPanel'))}"
                    aria-label="${escapeHTML(t('profile.adminPanel'))}">
                   <img src="/images/admin.svg" alt="" aria-hidden="true">
                 </a>`
              : ''
          }
          <button type="button" class="icon-action is-signout" id="sign-out"
                  title="${escapeHTML(t('auth.signOut'))}"
                  aria-label="${escapeHTML(t('auth.signOut'))}">
            <img src="/images/logout.svg" alt="" aria-hidden="true">
          </button>
        </div>
      </header>

      ${verifyNotice}
      ${welcome}

      ${
        session.setupPending
          ? `<section class="account-section setup-pending" role="status">
               <h2>${escapeHTML(t('profile.finishSetupTitle'))}</h2>
               <p>${escapeHTML(
                 user.email
                   ? t('profile.finishSetupSent', { email: user.email })
                   : t('profile.finishSetupNoEmail')
               )}</p>
               ${
                 user.email
                   ? `<button type="button" class="button button--primary" id="resend-verify-setup">
                        ${escapeHTML(t('auth.resendVerification'))}
                      </button>`
                   : ''
               }
             </section>`
          : ''
      }

      <section class="account-section">
        <h2>${escapeHTML(t('account.settings'))}</h2>
        <div class="settings-list">
          ${setting('display-name', t('account.displayNameLabel'), escapeHTML(user.displayName || user.username), displayNameBody)}
          ${setting('email', t('account.emailSection'), emailSummary, emailBody, {
            tone: user.email && !user.emailVerified ? 'warn' : '',
          })}
          ${setting(
            'password',
            t('account.passwordSection'),
            user.hasPassword
              ? '••••••••'
              : `<span class="setting-empty">${escapeHTML(t('account.googleLinked'))}</span>`,
            passwordBody
          )}
        </div>
      </section>

      ${
        queue
          ? `<section class="account-section" id="queue-section">
               <h2>${escapeHTML(t('profile.moderationQueue'))} <span class="count-pill">${queue.total ?? queue.items?.length ?? 0}</span></h2>
               ${
                 (queue.items || []).length
                   ? `<ul class="mine-list" id="queue-list">
                        ${queue.items.map((c) => commentCard(c, { moderation: true })).join('')}
                      </ul>`
                   : `<p class="empty-note">${escapeHTML(t('profile.queueEmpty'))}</p>`
               }
             </section>`
          : ''
      }

      <section class="account-section">
        <h2>${escapeHTML(t('profile.myComments'))} <span class="count-pill">${mine.total}</span></h2>
        ${
          mine.comments.length
            ? `<ul class="mine-list">${mine.comments.map((c) => commentCard(c)).join('')}</ul>`
            : `<p class="empty-note">${escapeHTML(t('profile.noComments'))}</p>`
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

  bind(document.getElementById('sign-out'), 'click', async (event) => {
    event.currentTarget.disabled = true;
    await session.signOut();
    navigate('home', {}, { replace: true });
  });

  // --- the one-time welcome: pick a username and a display name -----------
  const welcomeForm = document.getElementById('welcome-form');
  const welcomeError = document.getElementById('welcome-error');

  bind(welcomeForm, 'submit', async (event) => {
    event.preventDefault();
    welcomeError.hidden = true;
    const data = Object.fromEntries(new FormData(welcomeForm));
    const username = String(data.username || '').trim();
    const displayName = String(data.displayName || '').trim();

    if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
      return fail(welcomeError, t('auth.usernameRules'));
    }
    if (!displayName) return fail(welcomeError, t('account.displayNameRequired'));

    const submit = welcomeForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api.updateProfile({ username, displayName, done: true });
      await session.refresh();
      toastSuccess(t('profile.welcomeSaved'));
      navigate('profile', {}, { replace: true });
    } catch (err) {
      const map = {
        username_taken: t('auth.usernameTaken'),
        invalid_username: t('auth.usernameRules'),
        username_fixed: t('profile.usernameOnce'),
      };
      fail(
        welcomeError,
        err instanceof ApiError ? map[err.code] || err.message : t('common.error')
      );
      submit.disabled = false;
    }
    return undefined;
  });

  // --- display name --------------------------------------------------------
  const nameForm = document.getElementById('display-name-form');
  const nameError = document.getElementById('display-name-error');

  bind(nameForm, 'submit', async (event) => {
    event.preventDefault();
    nameError.hidden = true;
    const value = String(new FormData(nameForm).get('displayName') || '').trim();
    if (!value) return fail(nameError, t('account.displayNameRequired'));

    const submit = nameForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api.updateProfile({ displayName: value });
      await session.refresh();
      toastSuccess(t('account.displayNameSaved'));
      navigate('profile', {}, { replace: true });
    } catch (err) {
      fail(nameError, err instanceof ApiError ? err.message : t('common.error'));
      submit.disabled = false;
    }
    return undefined;
  });

  // --- email ---
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
      navigate('profile', {}, { replace: true });
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

  const onResend = async (event) => {
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
  };

  bind(document.getElementById('resend-verify'), 'click', onResend);
  bind(document.getElementById('resend-verify-setup'), 'click', onResend);

  // --- password ---
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
      document.getElementById('setting-password')?.removeAttribute('open');
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

  // --- moderation queue, handled by delegation so the list can shrink ---
  const queueList = document.getElementById('queue-list');
  bind(queueList, 'click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;

    const item = button.closest('[data-comment]');
    const id = Number(item?.dataset.comment);
    const action = button.dataset.act;
    if (!id || !action) return;

    item.querySelectorAll('[data-act]').forEach((b) => {
      b.disabled = true;
    });

    try {
      await api.moderate(id, action);
      toastSuccess(t(action === 'approve' ? 'profile.commentApproved' : 'profile.commentRejected'));
      item.remove();
      if (!queueList.children.length) navigate('profile', {}, { replace: true });
    } catch {
      toastError(t('common.error'));
      item.querySelectorAll('[data-act]').forEach((b) => {
        b.disabled = false;
      });
    }
  });

  return () => cleanups.forEach((fn) => fn());
}

export default { render, mount, title };
