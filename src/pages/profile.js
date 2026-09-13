import { escapeHTML } from '../lib/dom.js';
import { t, formatDate } from '../lib/i18n.js';
import { buildHash, navigate } from '../router.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { toastSuccess, toastError } from '../components/toast.js';

/**
 * The signed-in user's own page: who they are, the address on the account, the
 * password, and everything they have written -- including the comments still
 * waiting on a moderator, since not being able to see those is exactly the
 * confusion this answers.
 *
 * Moderators additionally get the approval queue here, so the everyday job does
 * not require opening the admin panel.
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

const badge = (verified) =>
  `<span class="verify-badge${verified ? ' is-verified' : ''}">
     ${escapeHTML(verified ? t('auth.verified') : t('auth.unverified'))}
   </span>`;

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

  return `
    <div class="account-page">
      <div class="profile-head">
        <h1>${escapeHTML(t('account.title'))}</h1>
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
      </div>

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
                   <input name="newPassword" type="password" autocomplete="new-password" required minlength="10">
                 </label>
                 <p class="field-hint">${escapeHTML(t('auth.passwordRules'))}</p>
                 <button type="submit" class="button button--primary">
                   ${escapeHTML(t('account.changePassword'))}
                 </button>
               </form>`
            : `<p class="account-note">${escapeHTML(t('account.noPassword'))}</p>`
        }
        ${user.linkedGoogle ? `<p class="account-note">${escapeHTML(t('account.googleLinked'))}</p>` : ''}
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
