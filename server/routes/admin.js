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
import { DEFINITIONS, allSettings, setSetting } from '../services/settings.js';
import {
  assertChapterNumber,
  assertInsideContent,
  assertLanguage,
  deleteChapter,
  deleteUpdate,
  chapterPageFiles,
  getChapter,
  listChapters,
  listUpdates,
  nextChapterNumber,
  readChapterMeta,
  writeChapterMeta,
  saveUpdate,
  syncConfigFromDisk,
} from '../services/content.js';
import { listUsers, setRole, setStatus, findById } from '../services/users.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getSecret, setSecret } from '../services/secrets.js';
import {
  backupFolder,
  consentUrl,
  disconnect as driveDisconnect,
  driveConfigured,
  exchangeCode,
} from '../services/drive.js';
import { backupState, runBackup } from '../services/backup.js';
import { ensureKeys, pushSummary } from '../services/push.js';

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
    for (const lang of config.languages)
      byLanguage[lang] = await listChapters(lang, { includeHidden: true });
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
    // The number is the site's business, not the author's: the reader walks
    // 1..n, so a gap hides everything after it. An explicit number is still
    // honoured, which is how a chapter gets replaced in place.
    const number = req.body.number
      ? assertChapterNumber(req.body.number)
      : await nextChapterNumber(lang);
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

      // Both optional, and both meant for the same thing: putting a chapter
      // up before it is ready to be read.
      let releaseAt = null;
      if (req.body.releaseAt) {
        const at = new Date(String(req.body.releaseAt));
        if (Number.isNaN(at.getTime())) {
          throw ApiError.badRequest('invalid_date', 'That is not a date and time.', {
            field: 'releaseAt',
          });
        }
        releaseAt = at.toISOString();
      }

      const meta = {
        title,
        description,
        pages: files.length,
        ext: 'webp',
        publishedAt: new Date().toISOString(),
        releaseAt,
        archived: req.body.archived === 'true' || req.body.archived === true,
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

/**
 * Rearrange, replace, add or drop pages without re-uploading the chapter.
 *
 * The client sends the final page list it wants, in order, as `layout`:
 *   "keep:2"  the existing page currently at index 2
 *   "new:0"   the first file in this request's `pages`
 * Anything not named is dropped. Saying what the chapter should end up as,
 * rather than what to do to it, means reorder, replace, insert and delete are
 * all the same operation and none of them can half-happen.
 */
router.put(
  '/chapters/:lang/:number/pages',
  requireRole('admin'),
  uploadLimiter,
  upload.array('pages', config.upload.maxFiles),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    const number = assertChapterNumber(req.params.number);

    const meta = await readChapterMeta(lang, number);
    if (!meta) throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');

    let layout;
    try {
      layout = JSON.parse(String(req.body.layout || '[]'));
    } catch {
      throw ApiError.badRequest('bad_layout', 'The page order was not readable.');
    }
    if (!Array.isArray(layout) || !layout.length) {
      throw ApiError.badRequest('no_pages', 'A chapter needs at least one page.');
    }

    const existing = await chapterPageFiles(lang, number);
    const incoming = req.files || [];
    const dir = assertInsideContent(join(config.contentDir, 'chapters', lang, `chapter${number}`));
    const staging = `${dir}.incoming`;

    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });

    try {
      for (const [index, entry] of layout.entries()) {
        const [kind, rawAt] = String(entry).split(':');
        const at = Number(rawAt);

        if (kind === 'keep') {
          const file = existing[at];
          if (!file) throw ApiError.badRequest('bad_layout', `There is no page ${at + 1} to keep.`);
          // Copied rather than moved: the original has to survive until the
          // swap, or a failure halfway would take the chapter with it.
          await fs.copyFile(join(dir, file), join(staging, `page${index}.webp`));
          continue;
        }

        if (kind === 'new') {
          const file = incoming[at];
          if (!file)
            throw ApiError.badRequest('bad_layout', 'A new page is missing from the upload.');
          const output = await sharp(file.buffer, { failOn: 'error' })
            .rotate()
            .resize({ width: 1800, withoutEnlargement: true })
            .webp({ quality: 82, effort: 4 })
            .toBuffer();
          await fs.writeFile(join(staging, `page${index}.webp`), output);
          continue;
        }

        throw ApiError.badRequest('bad_layout', `Not a page: ${entry}`);
      }

      await fs.writeFile(
        join(staging, 'meta.json'),
        `${JSON.stringify({ ...meta, pages: layout.length, ext: 'webp' }, null, 2)}\n`,
        'utf8'
      );

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
    audit(req.user.id, 'chapter.pages_changed', 'chapter', `${lang}/${number}`, {
      pages: layout.length,
    });

    res.json({ chapter: await getChapter(lang, number, { includeHidden: true }) });
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

/**
 * Schedule, archive or bring back a chapter.
 *
 * releaseAt is a moment in the future; null means it is out now. archived
 * takes it off the shelf without deleting anything, so it can come back.
 */
router.patch(
  '/chapters/:lang/:number/release',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    const number = assertChapterNumber(req.params.number);

    const patch = {};

    if ('releaseAt' in (req.body || {})) {
      const raw = req.body.releaseAt;
      if (raw === null || raw === '') {
        patch.releaseAt = null;
      } else {
        const at = new Date(String(raw));
        if (Number.isNaN(at.getTime())) {
          throw ApiError.badRequest('invalid_date', 'That is not a date and time.', {
            field: 'releaseAt',
          });
        }
        patch.releaseAt = at.toISOString();
      }
    }

    if ('archived' in (req.body || {})) patch.archived = Boolean(req.body.archived);

    if (!Object.keys(patch).length) {
      throw ApiError.badRequest('no_changes', 'Nothing to change.');
    }

    const meta = await writeChapterMeta(lang, number, patch);
    audit(req.user.id, 'chapter.scheduled', 'chapter', `${lang}/${number}`, patch);
    res.json({ chapter: { lang, number, ...meta } });
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
    const body = String(req.body?.body || '').trim();

    if (!body) throw ApiError.badRequest('missing_body', 'The update needs a message.');
    if (body.length > 2000) {
      throw ApiError.badRequest('body_too_long', 'Updates are limited to 2000 characters.');
    }

    // No date comes in. An update is stamped with the moment it is posted --
    // asking the author to type today's date is asking them to get it wrong,
    // and the stored value has to be an instant anyway so that every reader
    // sees it in their own zone.
    const saved = await saveUpdate(lang, { id: req.body?.id, body });
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

// --- runtime settings -------------------------------------------------------

/**
 * GET /api/admin/settings
 *
 * Each setting reports where its current value came from, so it is obvious
 * whether a site is running on what its .env says or on something an
 * administrator changed afterwards.
 */
router.get(
  '/settings',
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    res.json({ settings: allSettings() });
  })
);

/** PATCH /api/admin/settings  { key: value, ... } */
router.patch(
  '/settings',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const keys = Object.keys(payload);

    if (!keys.length) {
      throw ApiError.badRequest('no_changes', 'No settings were supplied.');
    }

    const unknown = keys.filter((key) => !DEFINITIONS[key]);
    if (unknown.length) {
      throw ApiError.badRequest('unknown_setting', `Not a setting: ${unknown.join(', ')}.`);
    }

    for (const key of keys) {
      const definition = DEFINITIONS[key];
      const raw = payload[key];
      if (definition.type === 'boolean' && typeof raw !== 'boolean') {
        throw ApiError.badRequest('validation_failed', `${key} must be true or false.`, {
          field: key,
        });
      }
      setSetting(key, raw, req.user.id);
    }

    res.json({ settings: allSettings() });
  })
);

// --- backups ---------------------------------------------------------------

/**
 * Connecting Google Drive happens here rather than through pasted credentials.
 *
 * The consent round trip leaves and re-enters the site, so the callback cannot
 * be protected by the same-origin check the rest of the admin API uses -- it
 * arrives as a top-level navigation from Google. A signed, single-use,
 * short-lived state value does that job instead: it proves the callback belongs
 * to a connect that this administrator started minutes ago, which is what stops
 * someone from handing Tomo a link that quietly attaches the site's backups to
 * a Drive they own.
 */
const CONNECT_STATE = 'drive.connect_state';
const STATE_TTL = 10 * 60_000;

router.get(
  '/drive/connect',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    if (!driveConfigured()) {
      throw ApiError.badRequest(
        'drive_not_configured',
        'Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET first.'
      );
    }
    const state = `${req.user.id}.${Date.now()}.${randomBytes(24).toString('hex')}`;
    setSecret(CONNECT_STATE, state, req.user.id);
    audit(req.user.id, 'drive.connect_started', 'drive', null);
    res.json({ url: consentUrl(state) });
  })
);

router.get(
  '/drive/callback',
  asyncRoute(async (req, res) => {
    const expected = getSecret(CONNECT_STATE);
    const given = String(req.query.state || '');
    // Cleared whatever happens, so a state value is good for exactly one
    // callback and a replayed link is simply dead.
    setSecret(CONNECT_STATE, '');

    const done = (ok, message) =>
      res.redirect(
        302,
        `/admin/#settings?drive=${ok ? 'connected' : 'failed'}` +
          (message ? `&message=${encodeURIComponent(message)}` : '')
      );

    if (!expected || !given)
      return done(false, 'That link did not come from a connect you started.');

    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return done(false, 'That link did not come from a connect you started.');
    }

    const [userId, startedAt] = expected.split('.');
    if (Date.now() - Number(startedAt) > STATE_TTL) {
      return done(false, 'That took too long — start again.');
    }
    if (req.query.error) return done(false, String(req.query.error).slice(0, 120));
    if (!req.query.code) return done(false, 'Google sent no authorisation back.');

    try {
      await exchangeCode(String(req.query.code));
      await backupFolder();
      audit(Number(userId), 'drive.connected', 'drive', null);
      return done(true);
    } catch (err) {
      return done(false, String(err.message || err).slice(0, 200));
    }
  })
);

router.delete(
  '/drive',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    driveDisconnect();
    audit(req.user.id, 'drive.disconnected', 'drive', null);
    res.json({ ok: true });
  })
);

router.post(
  '/push/keys',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    // ensureKeys refuses to replace an existing pair, so this is safe to press
    // twice: the second press returns the key already in use rather than
    // quietly invalidating every subscription a browser has granted.
    const result = ensureKeys(req.user.id);
    res.json({ ...result, ...pushSummary() });
  })
);

router.get(
  '/backups',
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    res.json(await backupState());
  })
);

router.post(
  '/backups',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const result = await runBackup({ reason: `manual by ${req.user.username}` });
    audit(req.user.id, 'backup.manual', 'backup', null, { ok: !!result.ok });
    if (result.skipped) throw ApiError.badRequest('not_ready', result.skipped);
    if (!result.ok) throw new ApiError(502, 'backup_failed', result.error);
    res.json(result);
  })
);

export default router;
