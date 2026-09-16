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
  formatDateTime,
} from '../lib/i18n.js';
import { initTheme, toggleTheme } from '../lib/theme.js';
import session from '../lib/session.js';
import api, { ApiError } from '../lib/api.js';
import { confirmDialog, chooseDialog } from '../components/modal.js';
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
  // Coming back from Google's consent screen should land on the panel that
  // sent you there, with the outcome said out loud.
  if (session.isAdmin && reportDriveReturn()) activeTab = 'settings';
  renderShell();
}

function renderShell() {
  const tabs = session.isAdmin
    ? ['chapters', 'updates', 'newsletter', 'social', 'moderation', 'users', 'settings']
    : ['moderation'];

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
    newsletter: renderNewsletter,
    social: renderSocial,
    settings: renderSettings,
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

/**
 * <input type="datetime-local"> speaks local wall-clock time with no zone, so
 * an ISO string with a Z on it has to be shifted into the viewer's offset
 * before it will display, and shifted back on the way out. Handing it the ISO
 * string directly shows the wrong hour to everyone not on UTC.
 */
function toLocalInput(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

async function renderChapters(panel) {
  const { chapters } = await api.adminChapters();

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.uploadChapter'))}</h2>
      <form id="chapter-form" class="admin-form">
        <div class="admin-form-row">
          ${languageSelect('chapter-lang')}
          <label class="field">
            <span>${escapeHTML(t('admin.release.releaseAt'))}</span>
            <input type="datetime-local" name="releaseAt">
          </label>
        </div>
        <p class="field-hint" id="next-number"></p>
        <p class="field-hint">${escapeHTML(t('admin.release.uploadDateHint'))}</p>
        <label class="switch-label">
          <input type="checkbox" name="archived">
          <span>${escapeHTML(t('admin.release.uploadArchived'))}</span>
        </label>
        <p class="field-hint">${escapeHTML(t('admin.release.uploadArchivedHint'))}</p>
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
                        <li class="${c.archived ? 'is-archived' : ''}">
                          <img src="${escapeHTML(c.cover)}" alt="" loading="lazy" width="40" height="56">
                          <span class="admin-list-main">
                            <strong>${escapeHTML(t('chapters.chapter', { n: c.number }))}</strong>
                            ${escapeHTML(c.title)}
                            <small>${c.pages} pages</small>
                            <span class="chapter-state">
                              ${
                                c.archived
                                  ? `<span class="state-pill is-archived">${escapeHTML(t('admin.release.archived'))}</span>`
                                  : c.released === false
                                    ? `<span class="state-pill is-scheduled">${escapeHTML(t('admin.release.scheduled'))}</span>`
                                    : `<span class="state-pill is-live">${escapeHTML(t('admin.release.live'))}</span>`
                              }
                            </span>
                          </span>
                          <span class="admin-list-controls">
                            <button type="button" class="link-button" data-edit="${lang}:${c.number}">
                              ${escapeHTML(t('admin.release.edit'))}
                            </button>
                            <button type="button" class="link-button" data-archive="${lang}:${c.number}:${c.archived ? '1' : '0'}">
                              ${escapeHTML(c.archived ? t('admin.release.unarchive') : t('admin.release.archive'))}
                            </button>
                            <a class="link-button" href="/#reader?lang=${lang}&chapter=${c.number}&page=0" target="_blank" rel="noopener">
                              ${escapeHTML(t('admin.release.preview'))}
                            </a>
                            <button type="button" class="link-button link-button--danger"
                                    data-delete-chapter="${lang}:${c.number}">
                              ${escapeHTML(t('common.delete'))}
                            </button>
                          </span>
                        </li>`
                    )
                    .join('')}</ul>`
                : `<p class="empty-note">${escapeHTML(t('chapters.empty'))}</p>`
            }
          </div>`;
      }).join('')}
    </section>
  `;

  wireChapterForm(panel, chapters);

  panel.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const [lang, number] = button.dataset.edit.split(':');
      openChapterEditor(button.closest('li'), lang, Number(number), chapters);
    });
  });

  panel.querySelectorAll('[data-archive]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [lang, number, archived] = button.dataset.archive.split(':');
      try {
        await api.adminScheduleChapter(lang, number, { archived: archived !== '1' });
        renderShell();
      } catch (err) {
        fail(err);
      }
    });
  });

  panel.querySelectorAll('[data-delete-chapter]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [lang, number] = button.dataset.deleteChapter.split(':');
      const goAhead = await confirmDialog({
        title: t('admin.confirmDeleteChapter'),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (!goAhead) return;
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

// --- chapter editor ---------------------------------------------------------

/**
 * Opens inline under the chapter it edits.
 *
 * Title, description, release date and archived save together; the pages save
 * separately, because sending thirty images every time a title changes would
 * be absurd. The page list is edited as the list you want to end up with --
 * reorder, replace, drop and add are all just that list coming out different,
 * which is also exactly what the server is told.
 */
async function openChapterEditor(host, lang, number, chapters) {
  const existing = host.querySelector('.chapter-editor');
  if (existing) {
    existing.remove();
    return;
  }

  const meta = (chapters[lang] || []).find((c) => c.number === number);
  if (!meta) return;

  let detail;
  try {
    detail = await api.chapter(lang, number);
  } catch (err) {
    fail(err);
    return;
  }

  // Each entry is either a page already on the server or a file about to be.
  let layout = detail.pages.map((src, index) => ({ kind: 'keep', at: index, src }));

  const box = el('div', { class: 'chapter-editor' });
  box.innerHTML = `
    <form class="admin-form chapter-editor-form">
      <label class="field">
        <span>${escapeHTML(t('admin.chapterTitle'))}</span>
        <input type="text" name="title" maxlength="120" required value="${escapeHTML(meta.title)}">
      </label>
      <label class="field">
        <span>${escapeHTML(t('admin.chapterDescription'))}</span>
        <textarea name="description" rows="2" maxlength="600">${escapeHTML(meta.description || '')}</textarea>
      </label>
      <div class="admin-form-row">
        <label class="field">
          <span>${escapeHTML(t('admin.release.releaseAt'))}</span>
          <input type="datetime-local" name="releaseAt" value="${escapeHTML(toLocalInput(meta.releaseAt))}">
        </label>
        <label class="switch-label">
          <input type="checkbox" name="archived" ${meta.archived ? 'checked' : ''}>
          <span>${escapeHTML(t('admin.release.archived'))}</span>
        </label>
      </div>
      <button type="submit" class="button button--primary">${escapeHTML(t('admin.release.saveDetails'))}</button>
    </form>

    <div class="page-editor">
      <h4>${escapeHTML(t('admin.release.pages'))} <span class="count" data-page-count>${layout.length}</span></h4>
      <ol class="page-grid" data-page-grid></ol>
      <div class="page-editor-actions">
        <label class="link-button">
          ${escapeHTML(t('admin.release.addPages'))}
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-add-pages>
        </label>
        <button type="button" class="button button--primary" data-save-pages disabled>
          ${escapeHTML(t('admin.release.savePages'))}
        </button>
        <progress data-page-progress max="100" value="0" hidden></progress>
      </div>
    </div>
  `;
  host.append(box);

  const grid = box.querySelector('[data-page-grid]');
  const savePages = box.querySelector('[data-save-pages]');
  const count = box.querySelector('[data-page-count]');
  let dirty = false;

  const markDirty = () => {
    dirty = true;
    savePages.disabled = false;
  };

  const draw = () => {
    grid.replaceChildren();
    layout.forEach((entry, index) => {
      const src = entry.kind === 'keep' ? entry.src : URL.createObjectURL(entry.file);

      const item = el(
        'li',
        { class: `page-cell ${entry.kind === 'new' ? 'is-new' : ''}` },
        el('img', {
          src,
          alt: '',
          loading: 'lazy',
          onLoad: () => entry.kind === 'new' && URL.revokeObjectURL(src),
        }),
        el('span', { class: 'page-cell-index', text: String(index + 1) }),
        el(
          'span',
          { class: 'page-cell-tools' },
          el('button', {
            type: 'button',
            class: 'page-tool',
            title: t('admin.release.moveUp'),
            'aria-label': t('admin.release.moveUp'),
            text: '←',
            disabled: index === 0,
            onClick: () => {
              [layout[index - 1], layout[index]] = [layout[index], layout[index - 1]];
              markDirty();
              draw();
            },
          }),
          el('button', {
            type: 'button',
            class: 'page-tool',
            title: t('admin.release.moveDown'),
            'aria-label': t('admin.release.moveDown'),
            text: '→',
            disabled: index === layout.length - 1,
            onClick: () => {
              [layout[index + 1], layout[index]] = [layout[index], layout[index + 1]];
              markDirty();
              draw();
            },
          }),
          el(
            'label',
            { class: 'page-tool', title: t('admin.release.replace') },
            '⤒',
            el('input', {
              type: 'file',
              accept: 'image/jpeg,image/png,image/webp',
              hidden: true,
              onChange: (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                layout[index] = { kind: 'new', file };
                markDirty();
                draw();
              },
            })
          ),
          el('button', {
            type: 'button',
            class: 'page-tool is-danger',
            title: t('common.delete'),
            'aria-label': t('common.delete'),
            text: '×',
            onClick: () => {
              // A chapter with no pages is not a chapter, so the last one
              // cannot be removed -- delete the chapter instead.
              if (layout.length === 1) {
                toastError(t('admin.release.lastPage'));
                return;
              }
              layout.splice(index, 1);
              markDirty();
              draw();
            },
          })
        )
      );
      grid.append(item);
    });
    count.textContent = String(layout.length);
  };

  draw();

  box.querySelector('[data-add-pages]').addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    layout = [...layout, ...files.map((file) => ({ kind: 'new', file }))];
    markDirty();
    draw();
    event.target.value = '';
  });

  // --- the details, which do not need the images -------------------------
  box.querySelector('.chapter-editor-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      await api.adminUpdateChapter(lang, number, {
        title: form.querySelector('[name="title"]').value,
        description: form.querySelector('[name="description"]').value,
      });
      const releaseAt = form.querySelector('[name="releaseAt"]').value;
      await api.adminScheduleChapter(lang, number, {
        releaseAt: releaseAt ? new Date(releaseAt).toISOString() : null,
        archived: form.querySelector('[name="archived"]').checked,
      });
      toastSuccess(t('admin.release.savedDetails'));
      renderShell();
    } catch (err) {
      fail(err);
      submit.disabled = false;
    }
  });

  // --- the pages ----------------------------------------------------------
  savePages.addEventListener('click', async () => {
    if (!dirty) return;
    const progress = box.querySelector('[data-page-progress]');
    savePages.disabled = true;
    progress.hidden = false;
    progress.removeAttribute('value');

    const data = new FormData();
    const spec = [];
    let newIndex = 0;

    for (const entry of layout) {
      if (entry.kind === 'keep') {
        spec.push(`keep:${entry.at}`);
      } else {
        data.append('pages', entry.file, entry.file.name);
        spec.push(`new:${newIndex}`);
        newIndex += 1;
      }
    }
    data.set('layout', JSON.stringify(spec));

    try {
      await api.adminUpdateChapterPages(lang, number, data);
      toastSuccess(t('admin.release.savedPages'));
      renderShell();
    } catch (err) {
      fail(err);
      savePages.disabled = false;
    } finally {
      progress.hidden = true;
    }
  });
}

function wireChapterForm(panel, chapters) {
  const form = panel.querySelector('#chapter-form');
  const nextNote = panel.querySelector('#next-number');
  const langSelect = panel.querySelector('#chapter-lang');

  // The number is not a field any more, so it has to be said out loud --
  // otherwise the author has no idea what they are about to publish.
  const showNextNumber = () => {
    const list = chapters[langSelect.value] || [];
    const next = list.reduce((max, c) => Math.max(max, c.number), 0) + 1;
    nextNote.textContent = t('admin.release.willBeChapter', { n: next });
  };
  langSelect.addEventListener('change', showNextNumber);
  showNextNumber();

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
    // No number: the server takes the next one, so a gap can never open up
    // and hide everything after it.
    data.set('lang', form.querySelector('#chapter-lang').value);
    data.set('title', form.querySelector('[name="title"]').value);
    data.set('description', form.querySelector('[name="description"]').value);
    const releaseAt = form.querySelector('[name="releaseAt"]').value;
    if (releaseAt) data.set('releaseAt', new Date(releaseAt).toISOString());
    if (form.querySelector('[name="archived"]').checked) data.set('archived', 'true');
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

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.newUpdate'))}</h2>
      <form id="update-form" class="admin-form">
        <div class="admin-form-row">
          ${languageSelect('update-lang')}
        </div>
        <p class="field-hint">${escapeHTML(t('admin.updateStamped'))}</p>
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
                            <strong>${escapeHTML(formatDateTime(u.date))}</strong>
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
              <th scope="col">${escapeHTML(t('admin.mute'))}</th>
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
                    <td class="mute-state">${
                      user.mutedUntil
                        ? escapeHTML(
                            user.mutedForever
                              ? t('admin.mutedForever')
                              : t('admin.mutedUntil', { when: formatDateTime(user.mutedUntil) })
                          )
                        : ''
                    }</td>
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
                            </button>
                            <button type="button" class="link-button"
                                    data-mute="${user.id}:${escapeHTML(user.username)}">
                              ${escapeHTML(user.mutedUntil ? t('admin.muteLift') : t('admin.mute'))}
                            </button>
                            <button type="button" class="link-button link-button--danger"
                                    data-remove-user="${user.id}:${escapeHTML(user.username)}">
                              ${escapeHTML(t('admin.removeUser'))}
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

  panel.querySelectorAll('[data-mute]').forEach((button) => {
    button.addEventListener('click', async () => {
      const raw = button.dataset.mute;
      const id = raw.slice(0, raw.indexOf(':'));
      const username = raw.slice(raw.indexOf(':') + 1);
      const lifting = button.textContent.trim() === t('admin.muteLift');

      let span = 'lift';
      if (!lifting) {
        // A timeout is the common case and a standing ban the rare one, so the
        // choices are offered shortest-first rather than defaulting to the door.
        // They used to be typed as "1" to "4" into a prompt box, which asked a
        // moderator to read a legend and then not fat-finger it.
        span = await chooseDialog({
          title: t('admin.muteWhich', { username }),
          options: [
            { label: t('admin.muteHour'), value: 'hour' },
            { label: t('admin.muteDay'), value: 'day' },
            { label: t('admin.muteWeek'), value: 'week' },
            { label: t('admin.muteForever'), value: 'forever', danger: true },
          ],
        });
        if (!span) return;
      }

      try {
        await api.adminMuteUser(id, span);
        toastSuccess(t(lifting ? 'admin.muteLifted' : 'admin.muteDone', { username }));
        renderShell();
      } catch (err) {
        fail(err);
      }
    });
  });

  panel.querySelectorAll('[data-remove-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      const raw = button.dataset.removeUser;
      const id = raw.slice(0, raw.indexOf(':'));
      const username = raw.slice(raw.indexOf(':') + 1);

      // One question with both answers on it. This used to be two stacked
      // confirms where OK meant erase and Cancel meant keep -- a coin toss
      // dressed up as a question.
      const mode = await chooseDialog({
        title: t('admin.confirmRemove', { username }),
        hint: t('admin.removeHint'),
        options: [
          { label: t('admin.removeKeep'), value: 'anonymise' },
          { label: t('admin.removePurge'), value: 'purge', danger: true },
        ],
      });
      if (!mode) return;

      try {
        await api.adminDeleteUser(id, mode);
        toastSuccess(t('admin.removed', { username }));
        renderShell();
      } catch (err) {
        fail(err);
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

// --- settings ---------------------------------------------------------------

/**
 * Everything an administrator can change while the site is running.
 *
 * Grouped rather than listed flat: the two switches that decide whether a
 * comment appears at all belong together, and the numbers behind the spam
 * rules belong under the list that uses them.
 */

const GROUPS = [
  { id: 'comments', keys: ['moderationQueue', 'requireVerifiedEmail', 'allowRegistration'] },
  { id: 'words', keys: ['bannedWords', 'bannedWordsAction'] },
  { id: 'limits', keys: ['commentCooldownMinutes', 'commentDuplicateHours'] },
];

const settingField = (key, setting) => {
  const label = t(`admin.settings.${key}`);
  const describe = escapeHTML(setting.describe || '');
  const id = `set-${key}`;

  if (setting.type === 'boolean') {
    return `
      <div class="setting-row">
        <label class="switch-label" for="${id}">
          <input type="checkbox" id="${id}" data-setting="${key}" ${setting.value ? 'checked' : ''}>
          <span>${escapeHTML(label)}</span>
        </label>
        <p class="setting-describe">${describe}</p>
      </div>`;
  }

  if (key === 'bannedWordsAction') {
    return `
      <div class="setting-row">
        <label class="field">
          <span>${escapeHTML(label)}</span>
          <select id="${id}" data-setting="${key}">
            <option value="hold" ${setting.value === 'hold' ? 'selected' : ''}>${escapeHTML(t('admin.settings.actionHold'))}</option>
            <option value="reject" ${setting.value === 'reject' ? 'selected' : ''}>${escapeHTML(t('admin.settings.actionReject'))}</option>
          </select>
        </label>
        <p class="setting-describe">${describe}</p>
      </div>`;
  }

  if (setting.type === 'number') {
    return `
      <div class="setting-row">
        <label class="field">
          <span>${escapeHTML(label)}</span>
          <input type="number" min="0" step="1" id="${id}" data-setting="${key}" value="${escapeHTML(String(setting.value))}">
        </label>
        <p class="setting-describe">${describe}</p>
      </div>`;
  }

  return `
    <div class="setting-row">
      <label class="field">
        <span>${escapeHTML(label)}</span>
        <textarea id="${id}" data-setting="${key}" rows="6"
                  placeholder="${escapeHTML(t('admin.settings.bannedWordsPlaceholder'))}">${escapeHTML(String(setting.value ?? ''))}</textarea>
      </label>
      <p class="setting-describe">${describe}</p>
    </div>`;
};

async function renderSettings(panel) {
  const { settings } = await api.adminSettings();

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.tabs.settings'))}</h2>
      ${GROUPS.map(
        (group) => `
          <div class="setting-group">
            <h3>${escapeHTML(t(`admin.settings.group_${group.id}`))}</h3>
            ${group.keys
              .filter((key) => settings[key])
              .map((key) => settingField(key, settings[key]))
              .join('')}
          </div>`
      ).join('')}
      <div class="setting-actions">
        <button type="button" class="button button--primary" id="save-settings">
          ${escapeHTML(t('admin.settings.save'))}
        </button>
        <span class="setting-saved" id="settings-saved" hidden>${escapeHTML(t('admin.settings.saved'))}</span>
      </div>
    </section>
    <section class="admin-section" id="push-section"></section>
    <section class="admin-section" id="backups-section"></section>
  `;

  renderPushSetup(panel.querySelector('#push-section'));
  renderBackups(panel.querySelector('#backups-section'));

  // Saved in one go rather than on every keystroke: a banned-words list is
  // edited in bursts, and a save per character would be a save per typo.
  panel.querySelector('#save-settings').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;

    const changes = {};
    panel.querySelectorAll('[data-setting]').forEach((node) => {
      const key = node.dataset.setting;
      changes[key] = node.type === 'checkbox' ? node.checked : node.value;
    });

    try {
      await api.updateAdminSettings(changes);
      toastSuccess(t('admin.settings.saved'));
      const flag = panel.querySelector('#settings-saved');
      flag.hidden = false;
      setTimeout(() => {
        flag.hidden = true;
      }, 2500);
    } catch (err) {
      fail(err);
    } finally {
      button.disabled = false;
    }
  });
}

/**
 * The backups panel.
 *
 * Its whole job is to make a failure impossible to miss. A backup that quietly
 * stopped working eight weeks ago is worse than no backup at all, because you
 * only discover it on the day you needed it -- so the state, the date of the
 * last success and the recent history are all on the page, and a run that
 * failed says why.
 */
const bytes = (n) => {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

/**
 * Push setup.
 *
 * The keys are made here rather than by hand, so no private key has to travel
 * through a terminal and a hosting console. There is no "regenerate" button on
 * purpose: the public half is baked into every subscription already granted,
 * and replacing it would leave readers switched on and silently receiving
 * nothing.
 */
async function renderPushSetup(host) {
  const draw = (state) => {
    host.innerHTML = `
      <div class="setting-group">
        <h3>${escapeHTML(t('admin.push.title'))}</h3>
        ${
          state.configured
            ? `<p class="backup-state">${escapeHTML(
                t('admin.push.ready', { devices: state.devices })
              )}</p>`
            : `<p class="backup-state is-warn">${escapeHTML(t('admin.push.notReady'))}</p>
               <button type="button" class="button button--primary" data-setup-push>
                 ${escapeHTML(t('admin.push.setUp'))}
               </button>`
        }
      </div>`;

    host.querySelector('[data-setup-push]')?.addEventListener('click', async (event) => {
      // Held in a variable rather than read back off the event: once this
      // handler awaits, dispatch is over and event.currentTarget is null.
      const button = event.currentTarget;
      button.disabled = true;
      try {
        draw(await api.adminSetupPush());
        toastSuccess(t('admin.push.done'));
      } catch (err) {
        fail(err);
        button.disabled = false;
      }
    });
  };

  try {
    draw((await api.adminBackups()).push || { configured: false, devices: 0 });
  } catch {
    host.innerHTML = '';
  }
}

async function renderBackups(host) {
  const draw = (state) => {
    const rows = (state.history || [])
      .map(
        (run) => `
        <li class="backup-run is-${run.status}">
          <span class="backup-when">${escapeHTML(formatDateTime(run.startedAt))}</span>
          <span class="backup-status">${escapeHTML(
            run.status === 'ok' ? t('admin.backups.ok') : t('admin.backups.failed')
          )}</span>
          <span class="backup-size">${escapeHTML(bytes(run.bytes))}</span>
          ${run.error ? `<span class="backup-error">${escapeHTML(run.error)}</span>` : ''}
        </li>`
      )
      .join('');

    host.innerHTML = `
      <div class="setting-group backups-group">
        <h3>${escapeHTML(t('admin.backups.title'))}</h3>
        <p class="field-hint">${escapeHTML(t('admin.backups.intro'))}</p>

        ${
          !state.configured
            ? `<p class="backup-state is-warn">${escapeHTML(t('admin.backups.notConfigured'))}</p>`
            : !state.connected
              ? `<p class="backup-state is-warn">${escapeHTML(t('admin.backups.notConnected'))}</p>
                 <button type="button" class="button button--primary" data-connect>
                   ${escapeHTML(t('admin.backups.connect'))}
                 </button>`
              : `<p class="backup-state">
                   ${escapeHTML(
                     state.account?.emailAddress
                       ? t('admin.backups.connectedAs', { email: state.account.emailAddress })
                       : t('admin.backups.title')
                   )}
                 </p>
                 <p class="field-hint">
                   ${escapeHTML(
                     t('admin.backups.every', { days: state.intervalDays, keep: state.keep })
                   )}
                   ${escapeHTML(
                     state.lastSuccess
                       ? t('admin.backups.lastSuccess', {
                           when: formatDateTime(state.lastSuccess),
                         })
                       : t('admin.backups.never')
                   )}
                 </p>
                 <div class="setting-actions">
                   <button type="button" class="button button--primary" data-run
                           ${state.running ? 'disabled' : ''}>
                     ${escapeHTML(
                       state.running ? t('admin.backups.running') : t('admin.backups.runNow')
                     )}
                   </button>
                   <button type="button" class="button" data-disconnect>
                     ${escapeHTML(t('admin.backups.disconnect'))}
                   </button>
                 </div>`
        }

        ${
          rows
            ? `<h4>${escapeHTML(t('admin.backups.history'))}</h4>
               <ul class="backup-history">${rows}</ul>`
            : ''
        }
      </div>
    `;

    host.querySelector('[data-connect]')?.addEventListener('click', async (event) => {
      // Held in a variable rather than read back off the event: once this
      // handler awaits, dispatch is over and event.currentTarget is null.
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const { url } = await api.adminDriveConnect();
        window.location.href = url;
      } catch (err) {
        fail(err);
        button.disabled = false;
      }
    });

    host.querySelector('[data-disconnect]')?.addEventListener('click', async () => {
      const goAhead = await confirmDialog({
        title: t('admin.backups.confirmDisconnect'),
        confirmLabel: t('admin.backups.disconnect'),
        danger: true,
      });
      if (!goAhead) return;
      try {
        await api.adminDriveDisconnect();
        await renderBackups(host);
      } catch (err) {
        fail(err);
      }
    });

    host.querySelector('[data-run]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = t('admin.backups.running');
      try {
        await api.adminRunBackup();
        toastSuccess(t('admin.backups.done'));
      } catch (err) {
        fail(err);
      } finally {
        await renderBackups(host);
      }
    });
  };

  try {
    draw(await api.adminBackups());
  } catch (err) {
    fail(err);
  }
}

/**
 * Google sends the administrator back here after the consent screen, so the
 * result of that round trip has to be reported on arrival -- otherwise a failed
 * connect looks exactly like a successful one.
 */
function reportDriveReturn() {
  const hash = window.location.hash;
  const at = hash.indexOf('?');
  if (at < 0) return false;
  const params = new URLSearchParams(hash.slice(at + 1));
  const outcome = params.get('drive');
  if (!outcome) return false;

  window.history.replaceState({}, '', `${window.location.pathname}#settings`);
  if (outcome === 'connected') toastSuccess(t('admin.backups.connected'));
  else toastError(t('admin.backups.connectFailed', { message: params.get('message') || outcome }));
  return true;
}

// --- newsletter ------------------------------------------------------------

/**
 * The composer.
 *
 * A newsletter is a list of blocks, not a blob of HTML. The server owns how a
 * block becomes email markup, so a draft written today picks up any later fix
 * to how a button renders in Outlook -- which would not happen if the browser
 * had frozen its own HTML into the record.
 *
 * The preview is an iframe with the real email inside it. Dropping that markup
 * into the page directly would let the email's own body styling loose on the
 * admin panel, and would also flatter it: the preview would inherit fonts and
 * resets the inbox will not provide.
 */

const BLOCK_KINDS = ['heading', 'text', 'image', 'video', 'file', 'button', 'chapter', 'divider'];

const blockDefaults = {
  heading: () => ({ type: 'heading', text: '' }),
  text: () => ({ type: 'text', text: '' }),
  image: () => ({ type: 'image', src: '', alt: '', href: '' }),
  button: () => ({ type: 'button', label: '', href: '' }),
  divider: () => ({ type: 'divider' }),
  file: () => ({ type: 'file', src: '', name: '', label: '', kind: 'File' }),
  video: () => ({ type: 'video', url: '', title: '' }),
  chapter: () => ({ type: 'chapter', lang: 'en', number: 1, title: '' }),
};

const field = (label, inner) => `
  <label class="field">
    <span>${escapeHTML(label)}</span>
    ${inner}
  </label>`;

function blockEditor(block, index, chapters) {
  const body = {
    heading: () =>
      field(
        t('admin.news.headingText'),
        `<input type="text" data-prop="text" maxlength="200" value="${escapeHTML(block.text || '')}">`
      ),

    text: () => `
      ${field(
        t('admin.news.bodyText'),
        `<textarea data-prop="text" rows="5" maxlength="8000">${escapeHTML(block.text || '')}</textarea>`
      )}
      <p class="field-hint">${escapeHTML(t('admin.news.textHint'))}</p>`,

    image: () => `
      <div class="block-image">
        ${
          block.src
            ? `<img src="${escapeHTML(block.src)}" alt="" class="block-thumb">`
            : `<p class="field-hint">${escapeHTML(t('admin.news.noImage'))}</p>`
        }
        <label class="link-button">
          ${escapeHTML(block.src ? t('admin.news.replaceImage') : t('admin.news.addImage'))}
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden data-image>
        </label>
        <p class="field-hint">${escapeHTML(t('admin.news.gifHint'))}</p>
      </div>
      ${field(
        t('admin.news.altText'),
        `<input type="text" data-prop="alt" maxlength="200" value="${escapeHTML(block.alt || '')}">`
      )}
      ${field(
        t('admin.news.imageLink'),
        `<input type="url" data-prop="href" maxlength="500" value="${escapeHTML(block.href || '')}" placeholder="https://">`
      )}`,

    button: () => `
      ${field(
        t('admin.news.buttonLabel'),
        `<input type="text" data-prop="label" maxlength="60" value="${escapeHTML(block.label || '')}">`
      )}
      ${field(
        t('admin.news.buttonLink'),
        `<input type="url" data-prop="href" maxlength="500" value="${escapeHTML(block.href || '')}" placeholder="https://">`
      )}`,

    chapter: () => {
      const all = Object.entries(chapters || {}).flatMap(([lang, list]) =>
        list.map((c) => ({ lang, number: c.number, title: c.title }))
      );
      return `
        ${field(
          t('admin.news.whichChapter'),
          `<select data-chapter>
             ${all
               .map(
                 (c) =>
                   `<option value="${c.lang}:${c.number}" ${
                     c.lang === block.lang && c.number === block.number ? 'selected' : ''
                   }>${escapeHTML(`${LANGUAGE_NAMES[c.lang] || c.lang} — ${c.number}. ${c.title}`)}</option>`
               )
               .join('')}
           </select>`
        )}`;
    },

    file: () => `
      <div class="block-image">
        ${
          block.src
            ? `<p class="field-hint"><strong>${escapeHTML(block.name || block.src)}</strong>${
                block.bytes ? ` &middot; ${Math.max(1, Math.round(block.bytes / 1024))} KB` : ''
              }</p>`
            : ''
        }
        <label class="link-button">
          ${escapeHTML(block.src ? t('admin.news.replaceFile') : t('admin.news.addFile'))}
          <input type="file" accept="audio/*,application/pdf,application/zip,text/plain" hidden data-file>
        </label>
        <p class="field-hint">${escapeHTML(t('admin.news.fileHint'))}</p>
      </div>
      ${field(
        t('admin.news.fileLabel'),
        `<input type="text" data-prop="label" maxlength="120" value="${escapeHTML(block.label || '')}">`
      )}`,

    video: () => `
      ${field(
        t('admin.news.videoUrl'),
        `<input type="url" data-prop="url" maxlength="500" value="${escapeHTML(block.url || '')}" placeholder="https://www.youtube.com/watch?v=...">`
      )}
      ${field(
        t('admin.news.videoTitle'),
        `<input type="text" data-prop="title" maxlength="200" value="${escapeHTML(block.title || '')}">`
      )}
      <p class="field-hint">${escapeHTML(t('admin.news.videoHint'))}</p>`,

    divider: () => `<p class="field-hint">${escapeHTML(t('admin.news.dividerHint'))}</p>`,
  }[block.type];

  return `
    <li class="block-card" data-index="${index}">
      <div class="block-head">
        <span class="block-kind">${escapeHTML(t(`admin.news.kind_${block.type}`))}</span>
        <span class="block-tools">
          <button type="button" class="page-tool" data-move="-1" ${index === 0 ? 'disabled' : ''}
                  title="${escapeHTML(t('admin.release.moveUp'))}">↑</button>
          <button type="button" class="page-tool" data-move="1" title="${escapeHTML(t('admin.release.moveDown'))}">↓</button>
          <button type="button" class="page-tool is-danger" data-remove
                  title="${escapeHTML(t('common.delete'))}">×</button>
        </span>
      </div>
      <div class="block-body">${body ? body() : ''}</div>
    </li>`;
}

async function renderNewsletter(panel) {
  const { newsletters, subscribers, dailyLimit } = await api.adminNewsletters();
  const { chapters } = await api.adminChapters();

  let current = newsletters.find((n) => n.status === 'draft') || null;

  const shell = () => {
    panel.innerHTML = `
      <section class="admin-section">
        <h2>${escapeHTML(t('admin.tabs.newsletter'))}</h2>
        <p class="field-hint">
          ${escapeHTML(t('admin.news.subscriberCount', { count: subscribers }))}
          ${
            subscribers > dailyLimit
              ? escapeHTML(t('admin.news.overDailyLimit', { limit: dailyLimit }))
              : ''
          }
        </p>
        <div class="news-layout">
          <aside class="news-list">
            <button type="button" class="button button--primary" id="new-draft">
              ${escapeHTML(t('admin.news.newDraft'))}
            </button>
            <ul>
              ${newsletters
                .map(
                  (n) => `
                <li>
                  <button type="button" class="news-item ${current?.id === n.id ? 'is-active' : ''}"
                          data-open="${n.id}" ${n.status === 'sent' ? 'data-sent' : ''}>
                    <span class="news-subject">${escapeHTML(n.subject || t('admin.news.untitled'))}</span>
                    <span class="news-meta">${escapeHTML(
                      n.status === 'sent'
                        ? t('admin.news.sentTo', { count: n.recipients })
                        : t('admin.news.draft')
                    )}</span>
                  </button>
                </li>`
                )
                .join('')}
            </ul>
          </aside>
          <div class="news-editor" id="news-editor"></div>
        </div>
      </section>`;

    panel.querySelector('#new-draft').addEventListener('click', async () => {
      current = await api.createNewsletter();
      newsletters.unshift(current);
      shell();
    });

    panel.querySelectorAll('[data-open]').forEach((button) =>
      button.addEventListener('click', () => {
        current = newsletters.find((n) => n.id === Number(button.dataset.open));
        shell();
      })
    );

    drawEditor();
  };

  const drawEditor = () => {
    const host = panel.querySelector('#news-editor');
    if (!current) {
      host.innerHTML = `<p class="empty-note">${escapeHTML(t('admin.news.pickOne'))}</p>`;
      return;
    }

    const sent = current.status === 'sent';
    host.innerHTML = `
      <form class="admin-form" id="news-form">
        <label class="field">
          <span>${escapeHTML(t('admin.news.subject'))}</span>
          <input type="text" id="news-subject" maxlength="200" ${sent ? 'disabled' : ''}
                 value="${escapeHTML(current.subject || '')}">
        </label>

        <ol class="block-list" id="block-list"></ol>

        ${
          sent
            ? `<p class="field-hint">${escapeHTML(t('admin.news.alreadySent'))}</p>`
            : `<div class="block-add">
                 ${BLOCK_KINDS.map(
                   (kind) =>
                     `<button type="button" class="button" data-add="${kind}">+ ${escapeHTML(
                       t(`admin.news.kind_${kind}`)
                     )}</button>`
                 ).join('')}
               </div>
               <div class="setting-actions">
                 <button type="button" class="button button--primary" id="news-save">
                   ${escapeHTML(t('admin.news.save'))}
                 </button>
                 <button type="button" class="button" id="news-test">
                   ${escapeHTML(t('admin.news.sendTest'))}
                 </button>
                 <button type="button" class="button button--danger" id="news-send">
                   ${escapeHTML(t('admin.news.sendToAll', { count: subscribers }))}
                 </button>
               </div>`
        }
      </form>

      <div class="news-preview">
        <h3>${escapeHTML(t('admin.news.preview'))}</h3>
        <div class="news-preview-shell" id="news-preview-shell">
          <!--
            allow-same-origin, and nothing else. A bare sandbox="" gives the
            frame an opaque origin, and this page's CSP allows images from
            'self' -- which an opaque origin can never match, so every image in
            the preview came out broken while the real email was fine. The
            preview lying about the email is worse than having no preview.
            Scripts stay off: allow-scripts is what would make this dangerous,
            and it is not here.
          -->
          <iframe id="news-preview-frame" title="${escapeHTML(t('admin.news.preview'))}"
                  sandbox="allow-same-origin"></iframe>
        </div>
      </div>`;

    drawBlocks();
    bindEditor();
    fitPreview();
    refreshPreview();
  };

  // The email is 600px wide whatever this column happens to be, so the scale is
  // measured rather than guessed -- and re-measured when the window changes.
  const fitPreview = () => {
    const shell = panel.querySelector('#news-preview-shell');
    if (!shell) return;
    const apply = () => {
      const scale = Math.min(1, shell.clientWidth / 640);
      shell.style.setProperty('--preview-scale', String(scale || 1));
    };
    apply();
    if (window.ResizeObserver && !shell.dataset.watched) {
      shell.dataset.watched = '1';
      new ResizeObserver(apply).observe(shell);
    }
  };

  const drawBlocks = () => {
    const list = panel.querySelector('#block-list');
    list.innerHTML = current.blocks
      .map((block, index) => blockEditor(block, index, chapters))
      .join('');
    if (current.status === 'sent') {
      list.querySelectorAll('input, textarea, select, button').forEach((n) => {
        n.disabled = true;
      });
    }
    bindBlocks();
  };

  const bindBlocks = () => {
    panel.querySelectorAll('.block-card').forEach((card) => {
      const index = Number(card.dataset.index);

      card.querySelectorAll('[data-prop]').forEach((input) =>
        input.addEventListener('input', () => {
          current.blocks[index][input.dataset.prop] = input.value;
          schedulePreview();
        })
      );

      card.querySelector('[data-chapter]')?.addEventListener('change', (event) => {
        const [lang, number] = event.target.value.split(':');
        const meta = (chapters[lang] || []).find((c) => c.number === Number(number));
        current.blocks[index] = {
          type: 'chapter',
          lang,
          number: Number(number),
          title: meta?.title || '',
        };
        schedulePreview();
      });

      card.querySelector('[data-file]')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          const uploaded = await api.uploadNewsletterFile(file);
          Object.assign(current.blocks[index], uploaded);
          drawBlocks();
          schedulePreview();
        } catch (err) {
          fail(err);
        }
      });

      card.querySelector('[data-image]')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          const uploaded = await api.uploadNewsletterImage(file);
          current.blocks[index].src = uploaded.src;
          drawBlocks();
          schedulePreview();
        } catch (err) {
          fail(err);
        }
      });

      card.querySelectorAll('[data-move]').forEach((button) =>
        button.addEventListener('click', () => {
          const to = index + Number(button.dataset.move);
          if (to < 0 || to >= current.blocks.length) return;
          [current.blocks[index], current.blocks[to]] = [current.blocks[to], current.blocks[index]];
          drawBlocks();
          schedulePreview();
        })
      );

      card.querySelector('[data-remove]')?.addEventListener('click', () => {
        current.blocks.splice(index, 1);
        drawBlocks();
        schedulePreview();
      });
    });
  };

  const bindEditor = () => {
    panel.querySelector('#news-subject')?.addEventListener('input', (event) => {
      current.subject = event.target.value;
      schedulePreview();
    });

    panel.querySelectorAll('[data-add]').forEach((button) =>
      button.addEventListener('click', () => {
        current.blocks.push(blockDefaults[button.dataset.add]());
        drawBlocks();
        schedulePreview();
      })
    );

    panel.querySelector('#news-save')?.addEventListener('click', async (event) => {
      // Held in a variable rather than read back off the event: once this
      // handler awaits, dispatch is over and event.currentTarget is null.
      const button = event.currentTarget;
      button.disabled = true;
      try {
        Object.assign(current, await api.saveNewsletter(current.id, current));
        toastSuccess(t('admin.news.saved'));
        shell();
      } catch (err) {
        fail(err);
        button.disabled = false;
      }
    });

    panel.querySelector('#news-test')?.addEventListener('click', async (event) => {
      // Held in a variable rather than read back off the event: once this
      // handler awaits, dispatch is over and event.currentTarget is null.
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api.saveNewsletter(current.id, current);
        const { to } = await api.testNewsletter(current.id);
        toastSuccess(t('admin.news.testSent', { email: to }));
      } catch (err) {
        fail(err);
      } finally {
        button.disabled = false;
      }
    });

    panel.querySelector('#news-send')?.addEventListener('click', async (event) => {
      // Held in a variable rather than read back off the event: once this
      // handler awaits, dispatch is over and event.currentTarget is null.
      const button = event.currentTarget;

      // Irreversible and public, so it is worth asking -- but asked in the page.
      // This was a window.confirm, and a browser that had suppressed native
      // dialogs made it return false every time, which turned the send button
      // into one that did nothing at all and said nothing about why.
      const goAhead = await confirmDialog({
        title: t('admin.news.confirmSend', { count: subscribers }),
        confirmLabel: t('admin.news.sendToAll', { count: subscribers }),
        danger: true,
      });
      if (!goAhead) return;

      button.disabled = true;
      try {
        await api.saveNewsletter(current.id, current);
        const { queued } = await api.sendNewsletter(current.id);
        toastSuccess(t('admin.news.queued', { count: queued }));
        renderNewsletter(panel);
      } catch (err) {
        fail(err);
        button.disabled = false;
      }
    });
  };

  // The preview is rendered by the server, so it is the real email rather than
  // a guess at one -- but that means a request per keystroke without a pause.
  let previewTimer = null;
  const schedulePreview = () => {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(refreshPreview, 400);
  };

  const refreshPreview = async () => {
    const frame = panel.querySelector('#news-preview-frame');
    if (!frame || !current) return;
    try {
      const { html } = await api.previewNewsletter(current.id, current);
      frame.srcdoc = html;
    } catch {
      /* a half-typed draft failing to render is not worth shouting about */
    }
  };

  shell();
}

// --- social ---------------------------------------------------------------

/**
 * Brand names, spelled the way the brands spell them. Not in the locale files
 * on purpose: "YouTube" is "YouTube" in Polish too, and a translator given the
 * string would only have the chance to get the capitals wrong.
 */
const PLATFORM_NAMES = {
  instagram: 'Instagram',
  twitter: 'Twitter',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  twitch: 'Twitch',
};

async function renderSocial(panel) {
  const [{ platforms, languages, targets, queue }, { chapters }] = await Promise.all([
    api.adminSocial(),
    api.adminChapters(),
  ]);

  let posts = queue;
  const picked = new Set(targets);

  // Every chapter number that exists in any language, newest first. A select
  // rather than a number box: drafting for a chapter nobody has uploaded
  // produces nothing and gives you no hint as to why.
  const numbers = [
    ...new Set(
      Object.values(chapters || {})
        .flat()
        .map((chapter) => Number(chapter.number))
        .filter(Number.isInteger)
    ),
  ].sort((a, b) => b - a);

  panel.innerHTML = `
    <section class="admin-section">
      <h2>${escapeHTML(t('admin.social.title'))}</h2>

      <h3>${escapeHTML(t('admin.social.where'))}</h3>
      <p class="field-hint">${escapeHTML(t('admin.social.whereHint'))}</p>

      <div class="social-targets-scroll">
        <table class="social-targets">
          <thead>
            <tr>
              <th scope="col"><span class="visually-hidden">${escapeHTML(
                t('admin.social.where')
              )}</span></th>
              ${languages
                .map(
                  (code) =>
                    `<th scope="col"><span class="social-lang">${escapeHTML(
                      LANGUAGE_NAMES[code] || code
                    )}</span></th>`
                )
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${platforms
              .map(
                (platform) => `
              <tr>
                <th scope="row">
                  <img src="/images/socials/${platform}.svg" alt="" width="18" height="18">
                  <span>${escapeHTML(PLATFORM_NAMES[platform] || platform)}</span>
                </th>
                ${languages
                  .map(
                    (code) => `
                  <td>
                    <label class="social-tick">
                      <input type="checkbox" data-target="${code}:${platform}"
                             ${picked.has(`${code}:${platform}`) ? 'checked' : ''}>
                      <span class="visually-hidden">${escapeHTML(
                        `${PLATFORM_NAMES[platform] || platform} — ${LANGUAGE_NAMES[code] || code}`
                      )}</span>
                    </label>
                  </td>`
                  )
                  .join('')}
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div class="setting-actions">
        <button type="button" class="button button--primary" id="social-save">
          ${escapeHTML(t('admin.social.saveTargets'))}
        </button>
      </div>

      <div class="social-draft">
        <label class="field field--inline">
          <span>${escapeHTML(t('admin.social.generate'))}</span>
          <select id="social-chapter" ${numbers.length ? '' : 'disabled'}>
            ${numbers.map((n) => `<option value="${n}">${n}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="button" id="social-generate" ${
          numbers.length ? '' : 'disabled'
        }>
          ${escapeHTML(t('admin.social.generateGo'))}
        </button>
      </div>

      <div class="social-queue-head">
        <h3>${escapeHTML(t('admin.social.queue'))} <span class="count" id="social-count"></span></h3>
        <button type="button" class="button button--quiet" id="social-clear" hidden>
          ${escapeHTML(t('admin.social.clearDone'))}
        </button>
      </div>
      <p class="field-hint">${escapeHTML(t('admin.social.removeHint'))}</p>
      <div id="social-queue"></div>
    </section>`;

  const statusLabel = (status) =>
    status === 'posted'
      ? t('admin.social.posted')
      : status === 'skipped'
        ? t('admin.social.skipped')
        : '';

  const drawQueue = () => {
    const host = panel.querySelector('#social-queue');
    const left = posts.filter((post) => post.status === 'todo').length;
    panel.querySelector('#social-count').textContent = left ? String(left) : '';
    panel.querySelector('#social-clear').hidden = posts.length === left;

    if (!posts.length) {
      host.innerHTML = `<p class="empty-note">${escapeHTML(t('admin.social.empty'))}</p>`;
      return;
    }

    // Grouped by chapter, because that is how the work actually arrives: a
    // chapter goes up and then you go around the accounts announcing it.
    const byChapter = new Map();
    for (const post of posts) {
      if (!byChapter.has(post.chapter)) byChapter.set(post.chapter, []);
      byChapter.get(post.chapter).push(post);
    }

    host.innerHTML = [...byChapter.entries()]
      .map(
        ([number, group]) => `
      <div class="social-chapter">
        <h4>${escapeHTML(t('admin.social.chapterLabel', { n: number }))}</h4>
        <ul class="social-posts">
          ${group
            .map(
              (post) => `
            <li class="social-post is-${post.status}" data-post="${post.id}">
              <div class="social-post-head">
                <img src="/images/socials/${post.platform}.svg" alt="" width="18" height="18">
                <span class="social-post-where">${escapeHTML(
                  PLATFORM_NAMES[post.platform] || post.platform
                )}</span>
                <span class="social-post-lang">${escapeHTML(
                  LANGUAGE_NAMES[post.lang] || post.lang
                )}</span>
                ${
                  post.status === 'todo'
                    ? ''
                    : `<span class="state-pill ${
                        post.status === 'posted' ? 'is-live' : 'is-archived'
                      }">${escapeHTML(statusLabel(post.status))}</span>`
                }
                ${
                  post.postedAt
                    ? `<span class="social-post-when">${escapeHTML(
                        formatRelative(post.postedAt)
                      )}</span>`
                    : ''
                }
              </div>
              <textarea class="social-body" rows="4" maxlength="4000"
                        data-body="${post.id}">${escapeHTML(post.body)}</textarea>
              <div class="social-post-tools">
                <button type="button" class="button button--quiet" data-copy="${post.id}">
                  ${escapeHTML(t('admin.social.copy'))}
                </button>
                <button type="button" class="button button--quiet"
                        data-status="${post.id}" data-to="${
                          post.status === 'posted' ? 'todo' : 'posted'
                        }">
                  ${escapeHTML(
                    post.status === 'posted'
                      ? t('admin.social.markTodo')
                      : t('admin.social.markPosted')
                  )}
                </button>
                ${
                  post.status === 'skipped'
                    ? ''
                    : `<button type="button" class="button button--quiet"
                               data-status="${post.id}" data-to="skipped">
                         ${escapeHTML(t('admin.social.skip'))}
                       </button>`
                }
                <button type="button" class="button button--quiet social-remove"
                        data-remove="${post.id}">
                  ${escapeHTML(t('admin.social.remove'))}
                </button>
              </div>
            </li>`
            )
            .join('')}
        </ul>
      </div>`
      )
      .join('');

    bindQueue();
  };

  const patch = async (id, body) => {
    const updated = await api.updateSocialPost(id, body);
    posts = posts.map((post) =>
      post.id === updated.post.id ? { ...post, ...updated.post } : post
    );
    return updated.post;
  };

  const bindQueue = () => {
    panel.querySelectorAll('[data-body]').forEach((box) =>
      // change, not input: this fires once when you look away from the box,
      // rather than a request per keystroke.
      box.addEventListener('change', async () => {
        const id = Number(box.dataset.body);
        try {
          await patch(id, { body: box.value });
        } catch (err) {
          fail(err);
        }
      })
    );

    panel.querySelectorAll('[data-copy]').forEach((button) =>
      button.addEventListener('click', async () => {
        const id = Number(button.dataset.copy);
        const box = panel.querySelector(`[data-body="${id}"]`);
        if (!box) return;
        try {
          await navigator.clipboard.writeText(box.value);
          toastSuccess(t('admin.social.copied'));
        } catch {
          // Clipboard access can be refused outright -- over plain http, or
          // when the window is not focused. Selecting the text is the honest
          // fallback: it is one keystroke away rather than a lie about success.
          box.focus();
          box.select();
        }
      })
    );

    panel.querySelectorAll('[data-remove]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        // Held before the first await, or dispatch is over and this is null.
        const pressed = event.currentTarget;
        const id = Number(pressed.dataset.remove);
        pressed.disabled = true;
        try {
          // No dialog for a single card: the chapter's own draft button puts it
          // straight back, so the worst case is retyping an edit rather than
          // losing a decision.
          const { queue: rest } = await api.removeSocialPost(id);
          posts = rest;
          drawQueue();
          toast(t('admin.social.removed'));
        } catch (err) {
          fail(err);
          pressed.disabled = false;
        }
      })
    );

    panel.querySelectorAll('[data-status]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        // Held before the await: dispatch is over by the time this resumes and
        // event.currentTarget is null.
        const pressed = event.currentTarget;
        const id = Number(pressed.dataset.status);
        const to = pressed.dataset.to;
        const box = panel.querySelector(`[data-body="${id}"]`);
        pressed.disabled = true;
        try {
          // The open textarea may hold an edit that never blurred, so it rides
          // along rather than being thrown away by the redraw.
          await patch(id, { status: to, ...(box ? { body: box.value } : {}) });
          drawQueue();
        } catch (err) {
          fail(err);
          pressed.disabled = false;
        }
      })
    );
  };

  panel.querySelector('#social-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const wanted = [...panel.querySelectorAll('[data-target]')]
      .filter((box) => box.checked)
      .map((box) => box.dataset.target);
    button.disabled = true;
    try {
      await api.saveSocialTargets(wanted);
      toastSuccess(t('admin.social.targetsSaved'));
    } catch (err) {
      fail(err);
    } finally {
      button.disabled = false;
    }
  });

  panel.querySelector('#social-clear').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const done = posts.filter((post) => post.status !== 'todo').length;

    // This one does ask. It is several cards at once, some of them possibly
    // rewritten by hand, and nothing on screen would tell you what went.
    const goAhead = await confirmDialog({
      title: t('admin.social.clearDoneConfirm', { count: done }),
      confirmLabel: t('admin.social.clearDone'),
      danger: true,
    });
    if (!goAhead) return;

    button.disabled = true;
    try {
      const { removed, queue: rest } = await api.clearSocialDone();
      posts = rest;
      drawQueue();
      toast(t('admin.social.cleared', { count: removed }));
    } catch (err) {
      fail(err);
    } finally {
      button.disabled = false;
    }
  });

  panel.querySelector('#social-generate').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const number = Number(panel.querySelector('#social-chapter').value);
    button.disabled = true;
    try {
      const result = await api.generateSocial(number);
      posts = result.queue;
      drawQueue();
      toast(
        result.written
          ? t('admin.social.generated', { count: result.written })
          : t('admin.social.nothingNew')
      );
    } catch (err) {
      fail(err);
    } finally {
      button.disabled = false;
    }
  });

  drawQueue();
}

boot().catch((err) => {
  console.error(err);
  main.innerHTML = '<p class="form-error">Could not load the admin panel.</p>';
});
