import db from '../db.js';
import config from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { isModerator } from '../middleware/auth.js';

const SELECT = `
  SELECT c.id, c.lang, c.chapter, c.parent_id, c.user_id, c.body, c.status,
         c.flag_reason, c.flag_score, c.flag_source, c.edited,
         c.created_at, c.updated_at,
         u.username, u.display_name, u.role, u.email_verified_at
  FROM comments c
  JOIN users u ON u.id = c.user_id
`;

/**
 * Shape a row for the client. `viewer` decides how much is revealed: moderation
 * metadata is only ever sent to moderators.
 */
export function present(row, viewer) {
  if (!row) return null;
  const mod = isModerator(viewer);
  const own = viewer?.id === row.user_id;

  const base = {
    id: row.id,
    parentId: row.parent_id,
    chapter: row.chapter,
    lang: row.lang,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: !!row.edited,
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      emailVerified: Boolean(row.email_verified_at),
    },
    canEdit: own && row.status !== 'deleted' && withinEditWindow(row),
    canDelete: (own || mod) && row.status !== 'deleted',
  };

  if (row.status === 'deleted') {
    return { ...base, body: null, deleted: true };
  }

  return {
    ...base,
    body: row.body,
    ...(mod
      ? {
          flagReason: row.flag_reason,
          flagScore: row.flag_score,
          flagSource: row.flag_source,
        }
      : {}),
  };
}

function withinEditWindow(row) {
  const created = new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime();
  return Date.now() - created < config.comment.editWindowMinutes * 60 * 1000;
}

/**
 * Comments for one chapter, nested one level deep.
 *
 * Visibility: everyone sees `visible`. A signed-in reader additionally sees
 * their own `pending` comments, so submitting does not look like it failed.
 * Moderators see everything except hard-deleted rows.
 */
export function listForChapter({ lang, chapter, viewer }) {
  const mod = isModerator(viewer);
  const viewerId = viewer?.id ?? -1;

  const rows = db
    .prepare(
      `${SELECT}
       WHERE c.lang = ? AND c.chapter = ?
         AND (
           c.status = 'visible'
           OR (c.status = 'pending' AND (? = 1 OR c.user_id = ?))
           OR (c.status = 'deleted' AND EXISTS (
                 SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.status = 'visible'))
         )
       ORDER BY c.created_at ASC`
    )
    .all(lang, chapter, mod ? 1 : 0, viewerId);

  const byId = new Map();
  const roots = [];

  for (const row of rows) {
    const node = { ...present(row, viewer), replies: [] };
    byId.set(row.id, node);
  }

  for (const row of rows) {
    const node = byId.get(row.id);
    if (row.parent_id && byId.has(row.parent_id)) byId.get(row.parent_id).replies.push(node);
    else if (!row.parent_id) roots.push(node);
  }

  // Newest conversations first, but replies read oldest-first within a thread.
  roots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return roots;
}

export function countVisible(lang, chapter) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM comments WHERE lang = ? AND chapter = ? AND status = 'visible'"
    )
    .get(lang, chapter).n;
}

export function findById(id) {
  return db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
}

export function insert({ lang, chapter, parentId, userId, body, screening }) {
  const info = db
    .prepare(
      `INSERT INTO comments (lang, chapter, parent_id, user_id, body, status,
                             flag_reason, flag_score, flag_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lang,
      chapter,
      parentId ?? null,
      userId,
      body,
      screening.status,
      screening.flagReason,
      screening.flagScore,
      screening.flagSource
    );
  return findById(info.lastInsertRowid);
}

export function update(id, body) {
  db.prepare(
    `UPDATE comments
     SET body = ?, edited = 1, updated_at = datetime('now')
     WHERE id = ?`
  ).run(body, id);
  return findById(id);
}

/** Soft delete: the row stays so replies beneath it keep their place. */
export function softDelete(id) {
  db.prepare(
    `UPDATE comments SET status = 'deleted', body = '', updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

export function moderate(id, status, moderatorId) {
  db.prepare(
    `UPDATE comments
     SET status = ?, moderated_by = ?, moderated_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(status, moderatorId, id);
  return findById(id);
}

export function queue({ limit = 50, offset = 0 } = {}) {
  const rows = db
    .prepare(
      `${SELECT} WHERE c.status = 'pending' ORDER BY c.flag_score DESC, c.created_at ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").get().n;
  return { total, items: rows };
}

export function assertCanMutate(row, viewer, { requireEditWindow = false } = {}) {
  if (!row) throw ApiError.notFound('comment_not_found', 'That comment no longer exists.');
  if (row.status === 'deleted') {
    throw ApiError.badRequest('comment_deleted', 'That comment has already been removed.');
  }

  const own = row.user_id === viewer.id;
  if (!own && !isModerator(viewer)) throw ApiError.forbidden();
  if (own && !isModerator(viewer) && requireEditWindow && !withinEditWindow(row)) {
    throw ApiError.forbidden(
      'edit_window_closed',
      `Comments can only be edited within ${config.comment.editWindowMinutes} minutes of posting.`
    );
  }
}
