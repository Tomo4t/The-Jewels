import { el, escapeHTML, textToHTML } from '../lib/dom.js';
import { t, formatRelative } from '../lib/i18n.js';
import { buildHash } from '../router.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { toastError, toastSuccess } from './toast.js';

/**
 * Comment thread for one chapter. Roots newest-first, replies oldest-first,
 * one level of nesting. Everything user-written goes through escapeHTML.
 */

const MAX_LENGTH = 2000;

export async function mountComments(root, { lang, chapter }) {
  if (!root) return () => {};

  if (!session.loaded) await session.refresh();

  if (!session.apiAvailable) {
    root.innerHTML = `<p class="empty-note">${escapeHTML(t('errors.offline'))}</p>`;
    return () => {};
  }

  let comments = [];

  const load = async () => {
    try {
      const data = await api.comments(lang, chapter);
      comments = data.comments || [];
    } catch (err) {
      root.innerHTML = `<p class="empty-note">${escapeHTML(
        err instanceof ApiError ? err.message : t('common.error')
      )}</p>`;
      return false;
    }
    return true;
  };

  const draw = () => {
    root.replaceChildren();
    root.append(composer({ lang, chapter, parentId: null, onPosted: refresh }));

    const heading = document.getElementById('comments-heading');
    if (heading) {
      const count = countVisible(comments);
      heading.textContent =
        count === 0
          ? t('comments.title')
          : count === 1
            ? t('comments.countOne')
            : t('comments.count', { count });
    }

    if (!comments.length) {
      root.append(el('p', { class: 'empty-note', text: t('comments.empty') }));
      return;
    }

    const list = el('ol', { class: 'comment-list' });
    for (const comment of comments) list.append(commentNode(comment, { lang, chapter, refresh }));
    root.append(list);
  };

  async function refresh() {
    if (await load()) draw();
  }

  await refresh();
  return () => {};
}

const countVisible = (comments) =>
  comments.reduce(
    (total, comment) =>
      total +
      (comment.status === 'visible' && !comment.deleted ? 1 : 0) +
      (comment.replies || []).filter((r) => r.status === 'visible' && !r.deleted).length,
    0
  );

// --- composer -------------------------------------------------------------

function composer({ lang, chapter, parentId, onPosted, onCancel }) {
  if (!session.isSignedIn) {
    return el(
      'p',
      { class: 'comment-signin' },
      el('a', { href: buildHash('signin'), text: t('comments.signInPrompt') })
    );
  }

  const textarea = el('textarea', {
    class: 'comment-input',
    rows: parentId ? 2 : 3,
    maxlength: MAX_LENGTH,
    placeholder: parentId ? t('comments.replyPlaceholder') : t('comments.placeholder'),
    'aria-label': parentId ? t('comments.replyPlaceholder') : t('comments.placeholder'),
  });

  const counter = el('span', { class: 'comment-counter', text: `0 / ${MAX_LENGTH}` });
  const submit = el('button', {
    type: 'submit',
    class: 'button button--primary',
    text: parentId ? t('comments.reply') : t('comments.post'),
    disabled: true,
  });

  textarea.addEventListener('input', () => {
    const length = textarea.value.trim().length;
    counter.textContent = `${textarea.value.length} / ${MAX_LENGTH}`;
    submit.disabled = length < 2;
  });

  const form = el(
    'form',
    { class: `comment-composer ${parentId ? 'comment-composer--reply' : ''}` },
    textarea,
    el(
      'div',
      { class: 'comment-composer-actions' },
      counter,
      onCancel &&
        el('button', {
          type: 'button',
          class: 'button',
          text: t('common.cancel'),
          onClick: onCancel,
        }),
      submit
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = textarea.value.trim();
    if (body.length < 2) return;

    submit.disabled = true;
    try {
      const result = await api.postComment({ lang, chapter, body, parentId });
      textarea.value = '';
      counter.textContent = `0 / ${MAX_LENGTH}`;
      if (result.pending) toastSuccess(t('comments.pendingNotice'));
      await onPosted?.();
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : t('common.error'));
      submit.disabled = false;
    }
  });

  return form;
}

// --- a single comment -----------------------------------------------------

function commentNode(comment, ctx) {
  const item = el('li', {
    class: `comment ${comment.status !== 'visible' ? `comment--${comment.status}` : ''}`,
    dataset: { id: comment.id },
  });

  if (comment.deleted) {
    item.append(el('p', { class: 'comment-removed', text: t('comments.deleted') }));
  } else {
    item.append(header(comment), body(comment), actions(comment, ctx, item));
  }

  if (comment.replies?.length) {
    const list = el('ol', { class: 'comment-replies' });
    for (const reply of comment.replies) list.append(commentNode(reply, ctx));
    item.append(list);
  }

  return item;
}

function header(comment) {
  const badge =
    comment.author.role === 'admin'
      ? t('comments.admin')
      : comment.author.role === 'moderator'
        ? t('comments.moderator')
        : null;

  return el(
    'div',
    { class: 'comment-header' },
    el('span', {
      class: 'comment-author',
      text: comment.author.displayName || comment.author.username,
    }),
    badge &&
      el('span', { class: `comment-badge comment-badge--${comment.author.role}`, text: badge }),
    comment.author.emailVerified &&
      el('span', {
        class: 'comment-verified',
        title: t('comments.verifiedBadge'),
        'aria-label': t('comments.verifiedBadge'),
        text: '\u2713',
      }),
    el('time', {
      class: 'comment-time',
      datetime: comment.createdAt,
      text: formatRelative(comment.createdAt),
    }),
    comment.edited && el('span', { class: 'comment-edited', text: t('comments.edited') }),
    comment.status === 'pending' &&
      el('span', { class: 'comment-pending', text: t('comments.pending') }),
    comment.flagReason &&
      el('span', {
        class: 'comment-flag',
        title: comment.flagReason,
        text: t('admin.flagReason', { reason: comment.flagReason }),
      })
  );
}

const body = (comment) => el('div', { class: 'comment-body', html: textToHTML(comment.body) });

function actions(comment, ctx, item) {
  const row = el('div', { class: 'comment-actions' });

  // Replies only hang off root comments.
  if (session.isSignedIn && !comment.parentId) {
    row.append(
      el('button', {
        type: 'button',
        class: 'link-button',
        text: t('comments.reply'),
        onClick: () => openReply(comment, ctx, item),
      })
    );
  }

  if (comment.canEdit) {
    row.append(
      el('button', {
        type: 'button',
        class: 'link-button',
        text: t('common.edit'),
        onClick: () => openEditor(comment, ctx, item),
      })
    );
  }

  if (comment.canDelete) {
    row.append(
      el('button', {
        type: 'button',
        class: 'link-button link-button--danger',
        text: t('common.delete'),
        onClick: async () => {
          if (!window.confirm(t('comments.confirmDelete'))) return;
          try {
            await api.deleteComment(comment.id);
            await ctx.refresh();
          } catch (err) {
            toastError(err instanceof ApiError ? err.message : t('common.error'));
          }
        },
      })
    );
  }

  if (session.isModerator && comment.status === 'pending') {
    for (const action of ['approve', 'reject']) {
      row.append(
        el('button', {
          type: 'button',
          class: `link-button link-button--${action}`,
          text: t(`admin.${action}`),
          onClick: async () => {
            try {
              await api.moderate(comment.id, action);
              await ctx.refresh();
            } catch (err) {
              toastError(err instanceof ApiError ? err.message : t('common.error'));
            }
          },
        })
      );
    }
  }

  return row;
}

function openReply(comment, ctx, item) {
  if (item.querySelector(':scope > .comment-composer--reply')) return;
  const form = composer({
    lang: ctx.lang,
    chapter: ctx.chapter,
    parentId: comment.id,
    onPosted: ctx.refresh,
    onCancel: () => form.remove(),
  });
  item.insertBefore(form, item.querySelector(':scope > .comment-replies'));
  form.querySelector('textarea')?.focus();
}

function openEditor(comment, ctx, item) {
  const existing = item.querySelector(':scope > .comment-body');
  if (!existing) return;

  const textarea = el('textarea', {
    class: 'comment-input',
    rows: 3,
    maxlength: MAX_LENGTH,
    'aria-label': t('common.edit'),
  });
  textarea.value = comment.body;

  const form = el(
    'form',
    { class: 'comment-composer' },
    textarea,
    el(
      'div',
      { class: 'comment-composer-actions' },
      el('button', {
        type: 'button',
        class: 'button',
        text: t('common.cancel'),
        onClick: () => form.replaceWith(existing),
      }),
      el('button', { type: 'submit', class: 'button button--primary', text: t('common.save') })
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.editComment(comment.id, textarea.value.trim());
      await ctx.refresh();
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : t('common.error'));
    }
  });

  existing.replaceWith(form);
  textarea.focus();
}
