import '../styles/index.css';
import './admin.css';

import { el, escapeHTML } from '../lib/dom.js';
import {
  t,
  loadLanguage,
  preferredLanguage,
  LANGUAGES,
  LANGUAGE_NAMES,
  formatRelative,
} from '../lib/i18n.js';
import { initTheme, toggleTheme } from '../lib/theme.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { toast, toastError, toastSuccess } from '../components/toast.js';

const main = document.getElementById('admin-main');
let activeTab = 'chapters';

const fail = (err) => toastError(err instanceof ApiError ? err.message : t('common.error'));

async function boot() {
  initTheme();
  await loadLanguage(preferredLanguage());
  await session.refresh();

  document.getElementById('admin-title').textContent = t('admin.title');
  document.getElementById('admin-theme').addEventListener('click', toggleTheme);
  document.getElementById('admin-signout').addEventListener('click', async () => {
    await session.signOut();
    window.location.href = '/';
  });

  if (!session.apiAvailable) {
    main.innerHTML = `<p class="empty-note">${escapeHTML(t('errors.offline'))}</p>`;
    return;
  }

  if (!session.isSignedIn) {
    main.innerHTML = `
      <div class="auth-card">
        <h2>${escapeHTML(t('auth.signIn'))}</h2>
        <p class="empty-note">${escapeHTML(t('errors.forbidden'))}</p>
        <a class="button button--primary button--full" href="/#signin">${escapeHTML(t('auth.signIn'))}</a>
      </div>`;
    return;
  }

  if (!session.isModerator) {
    main.innerHTML = `<div class="auth-card"><p class="form-error">${escapeHTML(
      t('errors.forbidden')
    )}</p></div>`;
    return;
  }

  // Moderators get the moderation tab only; admins get everything.
  activeTab = session.isAdmin ? 'chapters' : 'moderation';
  renderShell();
}

function renderShell() {
  const tabs = session.isAdmin ? ['chapters', 'updates', 'moderation', 'users'] : ['moderation'];

  main.replaceChildren(
    el(
      'nav',
      { class: 'admin-tabs', role: 'tablist' },
      ...tabs.map((tab) =>
        el('button', {
          type: 'button',
          role: 'tab',
          class: `admin-tab ${tab === activeTab ? 'is-active' : ''}`,
          'aria-selected': String(tab === activeTab),
          text: t(`admin.tabs.${tab}`),
          onClick: () => {
            activeTab = tab;
            renderShell();
          },
        })
      )
    ),
    el('div', { class: 'admin-panel', id: 'admin-panel' })
  );

  const panel = document.getElementById('admin-panel');
  panel.innerHTML = '<div class="skeleton skeleton--block"></div>';

  const render = {
    chapters: renderChapters,
    updates: renderUpdates,
    moderation: renderModeration,
    users: renderUsers,
  }[activeTab];

  render(panel).catch(fail);
}

const languageSelect = (id, value = LANGUAGES[0]) => `
  <label class="field">
    <span>${escapeHTML(t('admin.language'))}</span>
    <select id="${id}" name="lang">
      ${LANGUAGES.map(
        (code) =>
          `<option value="${code}" ${code === value ? 'selected' : ''}>${LANGUAGE_NAMES[code]}</option>`
      ).join('')}
    </select>
  </label>`;

// --- chapters -------------------------------------------------------------

async function renderChapters(panel) {
  const { chapters } = await api.adminChapters();

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.uploadChapter'))}</h2>
      <form id="chapter-form" class="admin-form">
        <div class="admin-form-row">
          ${languageSelect('chapter-lang')}
          <label class="field">
            <span>${escapeHTML(t('admin.chapterNumber'))}</span>
            <input type="number" name="number" min="1" max="9999" required value="1">
          </label>
        </div>
        <label class="field">
          <span>${escapeHTML(t('admin.chapterTitle'))}</span>
          <input type="text" name="title" maxlength="120" required>
        </label>
        <label class="field">
          <span>${escapeHTML(t('admin.chapterDescription'))}</span>
          <textarea name="description" rows="2" maxlength="600"></textarea>
        </label>

        <div class="dropzone" id="dropzone" tabindex="0" role="button"
             aria-label="${escapeHTML(t('admin.dropPages'))}">
          <p>${escapeHTML(t('admin.dropPages'))}</p>
          <p class="field-hint">${escapeHTML(t('admin.dropHint'))}</p>
          <input type="file" id="page-input" name="pages" accept="image/jpeg,image/png,image/webp"
                 multiple hidden>
        </div>

        <ol class="page-preview" id="page-preview"></ol>

        <button type="submit" class="button button--primary" id="chapter-submit" disabled>
          ${escapeHTML(t('admin.publish'))}
        </button>
        <progress id="upload-progress" max="100" value="0" hidden></progress>
      </form>
    </section>

    <section class="admin-section">
      <h2>${escapeHTML(t('admin.tabs.chapters'))}</h2>
      ${LANGUAGES.map((lang) => {
        const list = chapters[lang] || [];
        return `
          <div class="admin-lang-group">
            <h3>${LANGUAGE_NAMES[lang]} <span class="count">${list.length}</span></h3>
            ${
              list.length
                ? `<ul class="admin-list">${list
                    .map(
                      (c) => `
                        <li>
                          <img src="${escapeHTML(c.cover)}" alt="" loading="lazy" width="40" height="56">
                          <span class="admin-list-main">
                            <strong>${escapeHTML(t('chapters.chapter', { n: c.number }))}</strong>
                            ${escapeHTML(c.title)}
                            <small>${c.pages} pages</small>
                          </span>
                          <button type="button" class="link-button link-button--danger"
                                  data-delete-chapter="${lang}:${c.number}">
                            ${escapeHTML(t('common.delete'))}
                          </button>
                        </li>`
                    )
                    .join('')}</ul>`
                : `<p class="empty-note">${escapeHTML(t('chapters.empty'))}</p>`
            }
          </div>`;
      }).join('')}
    </section>
  `;

  wireChapterForm(panel);

  panel.querySelectorAll('[data-delete-chapter]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [lang, number] = button.dataset.deleteChapter.split(':');
      if (!window.confirm(t('admin.confirmDeleteChapter'))) return;
      try {
        await api.adminDeleteChapter(lang, number);
        toastSuccess(t('common.delete'));
        renderShell();
      } catch (err) {
        fail(err);
      }
    });
  });
}

function wireChapterForm(panel) {
  const form = panel.querySelector('#chapter-form');
  const dropzone = panel.querySelector('#dropzone');
  const input = panel.querySelector('#page-input');
  const preview = panel.querySelector('#page-preview');
  const submit = panel.querySelector('#chapter-submit');
  const progress = panel.querySelector('#upload-progress');

  let files = [];

  const naturalCompare = (a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

  const drawPreview = () => {
    preview.replaceChildren();
    files.forEach((file, index) => {
      const url = URL.createObjectURL(file);
      const item = el(
        'li',
        { class: 'page-preview-item', draggable: 'true', dataset: { index: String(index) } },
        el('img', { src: url, alt: '', loading: 'lazy', onLoad: () => URL.revokeObjectURL(url) }),
        el('span', { class: 'page-preview-index', text: String(index) }),
        el('button', {
          type: 'button',
          class: 'page-preview-remove',
          'aria-label': t('common.delete'),
          text: '×',
          onClick: () => {
            files.splice(index, 1);
            drawPreview();
          },
        })
      );
      preview.append(item);
    });
    submit.disabled = files.length === 0;
  };

  // Drag to reorder pages.
  let dragIndex = null;
  preview.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.page-preview-item');
    if (!item) return;
    dragIndex = Number(item.dataset.index);
    event.dataTransfer.effectAllowed = 'move';
  });
  preview.addEventListener('dragover', (event) => event.preventDefault());
  preview.addEventListener('drop', (event) => {
    event.preventDefault();
    const item = event.target.closest('.page-preview-item');
    if (!item || dragIndex === null) return;
    const target = Number(item.dataset.index);
    const [moved] = files.splice(dragIndex, 1);
    files.splice(target, 0, moved);
    dragIndex = null;
    drawPreview();
  });

  const addFiles = (list) => {
    const incoming = Array.from(list).filter((file) => file.type.startsWith('image/'));
    files = [...files, ...incoming.sort(naturalCompare)];
    drawPreview();
  };

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    addFiles(event.dataTransfer.files);
  });
  input.addEventListener('change', () => addFiles(input.files));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!files.length) return;

    const data = new FormData();
    data.set('lang', form.querySelector('#chapter-lang').value);
    data.set('number', form.querySelector('[name="number"]').value);
    data.set('title', form.querySelector('[name="title"]').value);
    data.set('description', form.querySelector('[name="description"]').value);
    data.set('order', JSON.stringify(files.map((f) => f.name)));
    for (const file of files) data.append('pages', file, file.name);

    submit.disabled = true;
    progress.hidden = false;
    progress.removeAttribute('value'); // indeterminate while the server works

    try {
      await api.adminUploadChapter(data);
      toastSuccess(t('admin.publish'));
      files = [];
      renderShell();
    } catch (err) {
      fail(err);
      submit.disabled = false;
    } finally {
      progress.hidden = true;
    }
  });
}

// --- updates --------------------------------------------------------------

async function renderUpdates(panel) {
  const { updates } = await api.adminUpdates();
  const today = new Date().toISOString().slice(0, 10);

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.newUpdate'))}</h2>
      <form id="update-form" class="admin-form">
        <div class="admin-form-row">
          ${languageSelect('update-lang')}
          <label class="field">
            <span>${escapeHTML(t('admin.updateDate'))}</span>
            <input type="date" name="date" required value="${today}">
          </label>
        </div>
        <label class="field">
          <span>${escapeHTML(t('admin.updateBody'))}</span>
          <textarea name="body" rows="4" maxlength="2000" required></textarea>
        </label>
        <button type="submit" class="button button--primary">${escapeHTML(t('common.save'))}</button>
      </form>
    </section>

    <section class="admin-section">
      ${LANGUAGES.map((lang) => {
        const list = updates[lang] || [];
        return `
          <div class="admin-lang-group">
            <h3>${LANGUAGE_NAMES[lang]} <span class="count">${list.length}</span></h3>
            ${
              list.length
                ? `<ul class="admin-list">${list
                    .map(
                      (u) => `
                        <li>
                          <span class="admin-list-main">
                            <strong>${escapeHTML(u.date)}</strong>
                            ${escapeHTML(u.body.slice(0, 140))}${u.body.length > 140 ? '…' : ''}
                          </span>
                          <button type="button" class="link-button link-button--danger"
                                  data-delete-update="${lang}:${u.id}">
                            ${escapeHTML(t('common.delete'))}
                          </button>
                        </li>`
                    )
                    .join('')}</ul>`
                : `<p class="empty-note">${escapeHTML(t('home.noUpdates'))}</p>`
            }
          </div>`;
      }).join('')}
    </section>
  `;

  panel.querySelector('#update-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api.adminSaveUpdate({
        lang: form.querySelector('#update-lang').value,
        date: form.querySelector('[name="date"]').value,
        body: form.querySelector('[name="body"]').value,
      });
      toastSuccess(t('common.save'));
      renderShell();
    } catch (err) {
      fail(err);
    }
  });

  panel.querySelectorAll('[data-delete-update]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [lang, id] = button.dataset.deleteUpdate.split(':');
      try {
        await api.adminDeleteUpdate(lang, id);
        renderShell();
      } catch (err) {
        fail(err);
      }
    });
  });
}

// --- moderation -----------------------------------------------------------

async function renderModeration(panel) {
  const { total, items } = await api.moderationQueue();

  if (!items.length) {
    panel.innerHTML = `<p class="empty-note">${escapeHTML(t('admin.queueEmpty'))}</p>`;
    return;
  }

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.tabs.moderation'))} <span class="count">${total}</span></h2>
      <ul class="admin-list admin-list--stacked">
        ${items
          .map(
            (item) => `
              <li class="queue-item ${item.flagScore >= 0.6 ? 'queue-item--severe' : ''}">
                <div class="queue-meta">
                  <strong>${escapeHTML(item.author.displayName || item.author.username)}</strong>
                  <span>${escapeHTML(item.lang)} · ${escapeHTML(
                    t('chapters.chapter', { n: item.chapter })
                  )}</span>
                  <time datetime="${item.createdAt}">${escapeHTML(formatRelative(item.createdAt))}</time>
                </div>
                ${
                  item.flagReason
                    ? `<p class="queue-flag">${escapeHTML(
                        t('admin.flagReason', { reason: item.flagReason })
                      )} <span class="queue-score">${item.flagScore}</span></p>`
                    : ''
                }
                <blockquote class="queue-body">${escapeHTML(item.body)}</blockquote>
                <div class="queue-actions">
                  <button type="button" class="button" data-moderate="approve:${item.id}">
                    ${escapeHTML(t('admin.approve'))}
                  </button>
                  <button type="button" class="button" data-moderate="reject:${item.id}">
                    ${escapeHTML(t('admin.reject'))}
                  </button>
                </div>
              </li>`
          )
          .join('')}
      </ul>
    </section>
  `;

  panel.querySelectorAll('[data-moderate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [action, id] = button.dataset.moderate.split(':');
      button.disabled = true;
      try {
        await api.moderate(id, action);
        toast(action === 'approve' ? t('admin.approve') : t('admin.reject'));
        renderShell();
      } catch (err) {
        fail(err);
        button.disabled = false;
      }
    });
  });
}

// --- users ----------------------------------------------------------------

async function renderUsers(panel) {
  const { users } = await api.adminUsers();

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.tabs.users'))} <span class="count">${users.length}</span></h2>
      <div class="table-scroll">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">${escapeHTML(t('auth.username'))}</th>
              <th scope="col">${escapeHTML(t('admin.role'))}</th>
              <th scope="col">${escapeHTML(t('comments.title'))}</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            ${users
              .map(
                (user) => `
                  <tr class="${user.status === 'banned' ? 'is-banned' : ''}">
                    <td>
                      <strong>${escapeHTML(user.displayName)}</strong>
                      <small>@${escapeHTML(user.username)}</small>
                    </td>
                    <td>
                      <select data-role="${user.id}" ${
                        user.id === session.user.id ? 'disabled' : ''
                      }>
                        ${['user', 'moderator', 'admin']
                          .map(
                            (role) =>
                              `<option value="${role}" ${role === user.role ? 'selected' : ''}>${escapeHTML(
                                t(`admin.roles.${role}`)
                              )}</option>`
                          )
                          .join('')}
                      </select>
                    </td>
                    <td>${user.commentCount}</td>
                    <td>
                      ${
                        user.id === session.user.id
                          ? ''
                          : `<button type="button" class="link-button ${
                              user.status === 'banned' ? '' : 'link-button--danger'
                            }" data-ban="${user.id}:${user.status}">
                              ${escapeHTML(
                                user.status === 'banned' ? t('admin.unbanUser') : t('admin.banUser')
                              )}
                            </button>`
                      }
                    </td>
                  </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  panel.querySelectorAll('[data-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api.adminUpdateUser(select.dataset.role, { role: select.value });
        toastSuccess(t('admin.role'));
      } catch (err) {
        fail(err);
        renderShell();
      }
    });
  });

  panel.querySelectorAll('[data-ban]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [id, status] = button.dataset.ban.split(':');
      try {
        await api.adminUpdateUser(id, { status: status === 'banned' ? 'active' : 'banned' });
        renderShell();
      } catch (err) {
        fail(err);
      }
    });
  });
}

boot().catch((err) => {
  console.error(err);
  main.innerHTML = '<p class="form-error">Could not load the admin panel.</p>';
});
