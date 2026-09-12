import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import db, { audit } from '../db.js';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { uploadLimiter } from '../middleware/security.js';
import { requireRole } from '../middleware/auth.js';
import {
  assertChapterNumber,
  assertInsideContent,
  assertLanguage,
  deleteChapter,
  deleteUpdate,
  listChapters,
  listUpdates,
  readChapterMeta,
  saveUpdate,
  syncConfigFromDisk,
} from '../services/content.js';
import { listUsers, setRole, setStatus, findById } from '../services/users.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileBytes,
    files: config.upload.maxFiles,
  },
  fileFilter: (_req, file, cb) => {
    if (!config.upload.allowedMime.includes(file.mimetype)) {
      cb(new ApiError(415, 'unsupported_type', `${file.originalname} is not a JPG, PNG or WebP.`));
      return;
    }
    cb(null, true);
  },
});

/** Natural sort so page2 comes before page10. */
const naturalCompare = (a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// --- chapters -------------------------------------------------------------

router.get(
  '/chapters',
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    const byLanguage = {};
    for (const lang of config.languages) byLanguage[lang] = await listChapters(lang);
    res.json({ chapters: byLanguage });
  })
);

/**
 * POST /api/admin/chapters (multipart/form-data)
 *
 * Fields: lang, number, title, description, order (optional JSON array of
 * original filenames giving the intended page order), pages[] (the images).
 *
 * Pages are normalised to WebP at a sane width so a 40MB scan dump does not
 * become a 40MB download for every reader.
 */
router.post(
  '/chapters',
  requireRole('admin'),
  uploadLimiter,
  upload.array('pages', config.upload.maxFiles),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.body.lang || ''));
    const number = assertChapterNumber(req.body.number);
    const title = String(req.body.title || '')
      .trim()
      .slice(0, 120);
    const description = String(req.body.description || '')
      .trim()
      .slice(0, 600);

    if (!title) throw ApiError.badRequest('missing_title', 'The chapter needs a title.');
    if (!req.files?.length) {
      throw ApiError.badRequest('no_pages', 'Add at least one page image.');
    }

    // Honour an explicit order if the client sent one; otherwise sort by name.
    let files = [...req.files];
    if (req.body.order) {
      try {
        const order = JSON.parse(req.body.order);
        if (Array.isArray(order) && order.length === files.length) {
          const lookup = new Map(files.map((f) => [f.originalname, f]));
          const reordered = order.map((name) => lookup.get(name)).filter(Boolean);
          if (reordered.length === files.length) files = reordered;
        }
      } catch {
        // Malformed order is not worth failing the upload over.
      }
    } else {
      files.sort((a, b) => naturalCompare(a.originalname, b.originalname));
    }

    const dir = assertInsideContent(join(config.contentDir, 'chapters', lang, `chapter${number}`));

    // Write to a staging directory first so a failure halfway through cannot
    // leave a half-published chapter in place.
    const staging = `${dir}.incoming`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });

    try {
      for (const [index, file] of files.entries()) {
        const output = await sharp(file.buffer, { failOn: 'error' })
          .rotate() // honour EXIF orientation, then drop the metadata
          .resize({ width: 1800, withoutEnlargement: true })
          .webp({ quality: 82, effort: 4 })
          .toBuffer();
        await fs.writeFile(join(staging, `page${index}.webp`), output);
      }

      const meta = {
        title,
        description,
        pages: files.length,
        ext: 'webp',
        publishedAt: new Date().toISOString(),
      };
      await fs.writeFile(join(staging, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(staging, dir);
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true });
      if (err instanceof ApiError) throw err;
      throw ApiError.badRequest(
        'image_processing_failed',
        `Could not process those images: ${err.message}`
      );
    }

    await syncConfigFromDisk();
    audit(req.user.id, 'chapter.published', 'chapter', `${lang}/${number}`, {
      title,
      pages: files.length,
    });

    res.status(201).json({
      chapter: { lang, number, title, description, pages: files.length },
    });
  })
);

router.delete(
  '/chapters/:lang/:number',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    const number = assertChapterNumber(req.params.number);
    await deleteChapter(lang, number);
    audit(req.user.id, 'chapter.deleted', 'chapter', `${lang}/${number}`);
    res.json({ ok: true });
  })
);

/** Retitle a chapter without re-uploading its pages. */
router.patch(
  '/chapters/:lang/:number',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    const number = assertChapterNumber(req.params.number);
    const existing = await readChapterMeta(lang, number);
    if (!existing) throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');

    const meta = {
      ...existing,
      title:
        String(req.body?.title ?? existing.title)
          .trim()
          .slice(0, 120) || existing.title,
      description: String(req.body?.description ?? existing.description)
        .trim()
        .slice(0, 600),
    };

    const file = assertInsideContent(
      join(config.contentDir, 'chapters', lang, `chapter${number}`, 'meta.json')
    );
    await fs.writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    audit(req.user.id, 'chapter.updated', 'chapter', `${lang}/${number}`);
    res.json({ chapter: { lang, number, ...meta } });
  })
);

// --- updates --------------------------------------------------------------

router.get(
  '/updates',
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    const byLanguage = {};
    for (const lang of config.languages) byLanguage[lang] = await listUpdates(lang);
    res.json({ updates: byLanguage });
  })
);

router.post(
  '/updates',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.body?.lang || ''));
    const date = String(req.body?.date || '').trim();
    const body = String(req.body?.body || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw ApiError.badRequest('bad_date', 'Date must look like 2026-09-12.');
    }
    if (!body) throw ApiError.badRequest('missing_body', 'The update needs a message.');
    if (body.length > 2000) {
      throw ApiError.badRequest('body_too_long', 'Updates are limited to 2000 characters.');
    }

    const saved = await saveUpdate(lang, { id: req.body?.id, date, body });
    audit(req.user.id, 'update.saved', 'update', `${lang}/${saved.id}`);
    res.status(201).json({ update: saved });
  })
);

router.delete(
  '/updates/:lang/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    await deleteUpdate(lang, req.params.id);
    audit(req.user.id, 'update.deleted', 'update', `${lang}/${req.params.id}`);
    res.json({ ok: true });
  })
);

// --- users ----------------------------------------------------------------

router.get(
  '/users',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ users: listUsers({ limit, offset }) });
  })
);

router.patch(
  '/users/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const target = findById(id);
    if (!target) throw ApiError.notFound('user_not_found', 'No such user.');

    if (target.id === req.user.id) {
      throw ApiError.badRequest('self_modification', 'You cannot change your own role or status.');
    }

    if (req.body?.role !== undefined) {
      const role = String(req.body.role);
      if (!['user', 'moderator', 'admin'].includes(role)) {
        throw ApiError.badRequest('bad_role', 'Role must be user, moderator or admin.');
      }
      // Never let the last administrator be demoted away.
      if (target.role === 'admin' && role !== 'admin') {
        const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
        if (admins <= 1) {
          throw ApiError.badRequest('last_admin', 'You cannot remove the only administrator.');
        }
      }
      setRole(id, role);
      audit(req.user.id, 'user.role_changed', 'user', id, { from: target.role, to: role });
    }

    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!['active', 'banned'].includes(status)) {
        throw ApiError.badRequest('bad_status', 'Status must be active or banned.');
      }
      setStatus(id, status);
      audit(req.user.id, `user.${status === 'banned' ? 'banned' : 'unbanned'}`, 'user', id);
    }

    const { toPublicUser } = await import('../services/users.js');
    res.json({ user: toPublicUser(findById(id)) });
  })
);

router.get(
  '/audit',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db
      .prepare(
        `SELECT a.*, u.username AS actor_username
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT ?`
      )
      .all(limit);
    res.json({ entries: rows });
  })
);

export default router;
