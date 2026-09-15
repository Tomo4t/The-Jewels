import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import config from '../config.js';
import db, { audit } from '../db.js';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { requireRole } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/security.js';
import { enqueue, subscribersFor, unsubscribeUrl } from '../services/notifications.js';
import { newsletterEmail } from '../services/templates.js';
import { drainQueue } from '../services/mailer.js';

const router = Router();

/**
 * Writing and sending the newsletter.
 *
 * Drafts are blocks, not HTML: the composer hands over a list of {type, ...}
 * and the server renders it. That way the email markup lives in one place and
 * an old draft picks up any later fix to how a button renders, rather than
 * being frozen as whatever the browser produced the day it was written.
 */

const BLOCK = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().max(200) }),
  z.object({ type: z.literal('text'), text: z.string().max(8000) }),
  z.object({
    type: z.literal('image'),
    src: z.string().max(500),
    alt: z.string().max(200).default(''),
    href: z.string().max(500).optional().nullable(),
  }),
  z.object({ type: z.literal('button'), label: z.string().max(60), href: z.string().max(500) }),
  z.object({ type: z.literal('divider') }),
  z.object({
    type: z.literal('chapter'),
    lang: z.string().length(2),
    number: z.number().int().positive(),
    title: z.string().max(200).default(''),
  }),
]);

const DRAFT = z.object({
  subject: z.string().max(200).default(''),
  blocks: z.array(BLOCK).max(80).default([]),
});

const rowToDraft = (row) =>
  row && {
    id: row.id,
    subject: row.subject,
    blocks: JSON.parse(row.blocks || '[]'),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    recipients: row.recipients,
  };

const findDraft = (id) => db.prepare('SELECT * FROM newsletters WHERE id = ?').get(id);

// --- drafts ----------------------------------------------------------------

router.get(
  '/',
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    const rows = db.prepare('SELECT * FROM newsletters ORDER BY id DESC LIMIT 50').all();
    res.json({
      newsletters: rows.map(rowToDraft),
      subscribers: subscribersFor('newsletter').length,
      dailyLimit: config.mail.dailyLimit,
    });
  })
);

router.post(
  '/',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = db
      .prepare(
        `INSERT INTO newsletters (subject, blocks, created_by) VALUES ('', '[]', ?) RETURNING id`
      )
      .get(req.user.id);
    res.status(201).json(rowToDraft(findDraft(id)));
  })
);

router.put(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const row = findDraft(Number(req.params.id));
    if (!row) throw ApiError.notFound('not_found', 'That newsletter is gone.');
    // A sent newsletter is a record of what people received. Editing it would
    // make the archive a lie.
    if (row.status === 'sent') {
      throw ApiError.badRequest('already_sent', 'That newsletter has already gone out.');
    }

    const parsed = DRAFT.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw ApiError.badRequest('invalid', 'Something in that draft is not usable.', {
        detail: parsed.error.issues[0]?.message,
      });
    }

    db.prepare(
      `UPDATE newsletters SET subject = ?, blocks = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(parsed.data.subject, JSON.stringify(parsed.data.blocks), row.id);
    res.json(rowToDraft(findDraft(row.id)));
  })
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    db.prepare(`DELETE FROM newsletters WHERE id = ? AND status != 'sent'`).run(
      Number(req.params.id)
    );
    res.json({ ok: true });
  })
);

/** The rendered email, for the preview pane and for a test send. */
router.post(
  '/:id/preview',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const parsed = DRAFT.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('invalid', 'That draft is not usable.');

    const mail = newsletterEmail({
      subject: parsed.data.subject || '(no subject)',
      blocks: parsed.data.blocks,
      unsubscribe: unsubscribeUrl(req.user.id, 'newsletter'),
    });
    res.json({ subject: mail.subject, html: mail.html, text: mail.text });
  })
);

/**
 * Sends a copy to the administrator only.
 *
 * Worth doing every time. A newsletter looks fine in the preview pane and then
 * arrives with the images blocked, the buttons grey and the spacing collapsed,
 * because the preview is a browser and the inbox is not.
 */
router.post(
  '/:id/test',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const row = findDraft(Number(req.params.id));
    if (!row) throw ApiError.notFound('not_found', 'That newsletter is gone.');
    if (!req.user.email || !req.user.email_verified_at) {
      throw ApiError.badRequest('no_address', 'Confirm your own email address first.');
    }

    const draft = rowToDraft(row);
    const mail = newsletterEmail({
      subject: `[test] ${draft.subject || '(no subject)'}`,
      blocks: draft.blocks,
      unsubscribe: unsubscribeUrl(req.user.id, 'newsletter'),
    });

    enqueue([
      {
        userId: req.user.id,
        address: req.user.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        kind: 'newsletter',
        // A unique key each time, so a test can be sent over and over while a
        // real send stays deduplicated.
        dedupeKey: `test:${row.id}:${randomBytes(6).toString('hex')}`,
      },
    ]);
    drainQueue().catch(() => {});
    res.json({ ok: true, to: req.user.email });
  })
);

/**
 * Sends it for real.
 *
 * Queued rather than sent here: a few hundred messages cannot go out inside one
 * HTTP request, and the provider's daily cap means a large list is delivered
 * over days. The status moves to 'sent' as soon as it is queued, because the
 * decision to send is what is irreversible -- not the delivery.
 */
router.post(
  '/:id/send',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const row = findDraft(Number(req.params.id));
    if (!row) throw ApiError.notFound('not_found', 'That newsletter is gone.');
    if (row.status === 'sent') {
      throw ApiError.badRequest('already_sent', 'That one has already gone out.');
    }

    const draft = rowToDraft(row);
    if (!draft.subject.trim()) {
      throw ApiError.badRequest('no_subject', 'Give it a subject line first.');
    }
    if (!draft.blocks.length) {
      throw ApiError.badRequest('empty', 'There is nothing in it yet.');
    }

    const readers = subscribersFor('newsletter');
    const queued = enqueue(
      readers.map((reader) => {
        const mail = newsletterEmail({
          subject: draft.subject,
          blocks: draft.blocks,
          unsubscribe: unsubscribeUrl(reader.id, 'newsletter'),
        });
        return {
          userId: reader.id,
          address: reader.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          kind: 'newsletter',
          dedupeKey: `newsletter:${row.id}:${reader.id}`,
        };
      })
    );

    db.prepare(
      `UPDATE newsletters SET status = 'sent', sent_at = datetime('now'), recipients = ? WHERE id = ?`
    ).run(queued, row.id);
    audit(req.user.id, 'newsletter.sent', 'newsletter', row.id, { recipients: queued });

    drainQueue().catch(() => {});
    res.json({ ok: true, queued, dailyLimit: config.mail.dailyLimit });
  })
);

// --- images ----------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  // Generous, because an animated GIF is not small -- but not unlimited, since
  // every recipient downloads it.
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

const imageDir = () => join(config.contentDir, 'newsletter');

/**
 * Stores an image for use in a newsletter.
 *
 * Two things the chapter pipeline gets right for chapters and wrong for email.
 * It converts everything to WebP, which Outlook cannot display at all -- so
 * these become PNG or JPEG. And WebP conversion flattens an animated GIF to a
 * single frame, so GIFs are stored exactly as uploaded: it is the one format
 * that animates everywhere an email is read.
 */
router.post(
  '/image',
  requireRole('admin'),
  uploadLimiter,
  upload.single('image'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('no_file', 'No image arrived.');
    await fs.mkdir(imageDir(), { recursive: true });

    const stamp = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    let name;
    let bytes;

    if (req.file.mimetype === 'image/gif') {
      name = `${stamp}.gif`;
      bytes = req.file.buffer;
    } else {
      const image = sharp(req.file.buffer, { failOn: 'error' }).rotate().resize({
        width: 1080,
        withoutEnlargement: true,
      });
      const meta = await sharp(req.file.buffer)
        .metadata()
        .catch(() => ({}));
      if (meta.hasAlpha) {
        name = `${stamp}.png`;
        bytes = await image.png({ compressionLevel: 9 }).toBuffer();
      } else {
        name = `${stamp}.jpg`;
        bytes = await image.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      }
    }

    await fs.writeFile(join(imageDir(), name), bytes);
    res.status(201).json({
      src: `/content/newsletter/${name}`,
      bytes: bytes.length,
      animated: req.file.mimetype === 'image/gif',
    });
  })
);

export default router;
