import { Router } from 'express';
import config, { mailEnabled } from '../config.js';
import { audit } from '../db.js';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { commentLimiter } from '../middleware/security.js';
import { requireAuth, requireRole, isModerator } from '../middleware/auth.js';
import { assertLanguage, assertChapterNumber, readChapterMeta } from '../services/content.js';
import { screenComment } from '../services/moderation.js';
import * as comments from '../services/comments.js';
import { getSetting } from '../services/settings.js';
import { findById } from '../services/users.js';

const router = Router();

const readBody = (raw) => {
  const body = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (body.length < config.comment.minLength) {
    throw ApiError.badRequest('comment_too_short', 'Your comment is empty.');
  }
  if (body.length > config.comment.maxLength) {
    throw ApiError.badRequest(
      'comment_too_long',
      `Comments are limited to ${config.comment.maxLength} characters.`
    );
  }
  return body;
};

/** GET /api/comments?lang=en&chapter=3 */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.query.lang || config.defaultLanguage));
    const chapter = assertChapterNumber(req.query.chapter);

    res.json({
      lang,
      chapter,
      total: comments.countVisible(lang, chapter),
      comments: comments.listForChapter({ lang, chapter, viewer: req.user }),
    });
  })
);

/**
 * GET /api/comments/mine
 *
 * Everything the signed-in user has written, newest first, including the ones
 * still waiting on a moderator -- the point of the profile page is being able
 * to see what has and has not gone live.
 */
router.get(
  '/mine',
  requireAuth,
  asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows, total } = comments.listForUser(req.user.id, { limit, offset });
    res.json({
      total,
      comments: rows.map((row) => comments.present(row, req.user)),
    });
  })
);

/** POST /api/comments */
router.post(
  '/',
  requireAuth,
  commentLimiter,
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.body?.lang || config.defaultLanguage));
    const chapter = assertChapterNumber(req.body?.chapter);
    const body = readBody(req.body?.body);

    if (!(await readChapterMeta(lang, chapter))) {
      throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');
    }

    // Posting can be held behind a confirmed address. Reading never is, and
    // moderators are exempt so a site cannot lock out the people who run it.
    //
    // The gate also stands down when no mail provider is configured. Confirming
    // an address would be impossible in that state, so enforcing it would lock
    // every ordinary reader out of commenting with no way back in.
    if (getSetting('requireVerifiedEmail') && mailEnabled() && !isModerator(req.user)) {
      const me = findById(req.user.id);
      if (!me?.email_verified_at) {
        throw ApiError.forbidden(
          'email_not_verified',
          'Confirm your email address before posting a comment.'
        );
      }
    }

    let parentId = null;
    if (req.body?.parentId != null && req.body.parentId !== '') {
      const parent = comments.findById(Number(req.body.parentId));
      if (!parent || parent.lang !== lang || parent.chapter !== chapter) {
        throw ApiError.badRequest('bad_parent', 'That comment cannot be replied to.');
      }
      // Only one level of nesting: a reply to a reply attaches to its root.
      parentId = parent.parent_id ?? parent.id;
    }

    const screening = await screenComment(body, { user: req.user, lang, chapter });
    const row = comments.insert({
      lang,
      chapter,
      parentId,
      userId: req.user.id,
      body,
      screening,
    });

    if (screening.flagReason) {
      audit(req.user.id, 'comment.auto_flagged', 'comment', row.id, {
        score: screening.flagScore,
        reason: screening.flagReason,
        source: screening.flagSource,
      });
    }

    res.status(201).json({
      comment: comments.present(row, req.user),
      pending: row.status === 'pending',
    });
  })
);

/** PATCH /api/comments/:id */
router.patch(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const row = comments.findById(Number(req.params.id));
    comments.assertCanMutate(row, req.user, { requireEditWindow: true });

    const body = readBody(req.body?.body);
    const screening = await screenComment(body, {
      user: req.user,
      lang: row.lang,
      chapter: row.chapter,
    });

    let updated = comments.update(row.id, body);

    // An edit that trips the filter goes back into the queue, unless a
    // moderator is the one making the edit.
    if (screening.flagReason && !isModerator(req.user)) {
      updated = comments.moderate(row.id, 'pending', null);
      audit(req.user.id, 'comment.auto_flagged_on_edit', 'comment', row.id, {
        reason: screening.flagReason,
      });
    }

    res.json({
      comment: comments.present(updated, req.user),
      pending: updated.status === 'pending',
    });
  })
);

/** DELETE /api/comments/:id — author or moderator. */
router.delete(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const row = comments.findById(Number(req.params.id));
    comments.assertCanMutate(row, req.user);

    comments.softDelete(row.id);
    if (row.user_id !== req.user.id) {
      audit(req.user.id, 'comment.deleted_by_moderator', 'comment', row.id, {
        author: row.username,
      });
    }
    res.json({ ok: true });
  })
);

// --- moderation -----------------------------------------------------------

/** GET /api/comments/moderation/queue */
router.get(
  '/moderation/queue',
  requireRole('moderator'),
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { total, items } = comments.queue({ limit, offset });
    res.json({ total, items: items.map((row) => comments.present(row, req.user)) });
  })
);

/** POST /api/comments/:id/moderate  { action: 'approve' | 'reject' } */
router.post(
  '/:id/moderate',
  requireRole('moderator'),
  asyncRoute(async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['approve', 'reject'].includes(action)) {
      throw ApiError.badRequest('bad_action', 'Action must be "approve" or "reject".');
    }

    const row = comments.findById(Number(req.params.id));
    if (!row) throw ApiError.notFound('comment_not_found', 'That comment no longer exists.');

    const status = action === 'approve' ? 'visible' : 'rejected';
    const updated = comments.moderate(row.id, status, req.user.id);
    audit(req.user.id, `comment.${action}`, 'comment', row.id, { author: row.username });

    res.json({ comment: comments.present(updated, req.user) });
  })
);

export default router;
