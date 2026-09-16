import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { requireRole } from '../middleware/auth.js';
import {
  PLATFORMS,
  targets,
  setTargets,
  generateFor,
  queue,
  updatePost,
  removePost,
  clearDone,
} from '../services/social.js';
import config from '../config.js';

const router = Router();

router.get(
  '/',
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    res.json({
      platforms: PLATFORMS,
      languages: config.languages,
      targets: targets(),
      queue: queue(),
    });
  })
);

const TARGETS = z.object({
  targets: z.array(z.string().max(40)).max(200),
});

router.put(
  '/targets',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const parsed = TARGETS.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('invalid', 'That list is not usable.');
    res.json({ targets: setTargets(parsed.data.targets, req.user.id) });
  })
);

router.post(
  '/generate',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const number = Number(req.body?.chapter);
    if (!Number.isInteger(number) || number < 1) {
      throw ApiError.badRequest('invalid', 'That is not a chapter number.');
    }
    const result = await generateFor(number, req.user.id);
    res.json({ ...result, queue: queue() });
  })
);

const UPDATE = z.object({
  body: z.string().max(4000).optional(),
  status: z.enum(['todo', 'posted', 'skipped']).optional(),
});

router.put(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const parsed = UPDATE.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('invalid', 'That change is not usable.');
    const row = updatePost(Number(req.params.id), parsed.data, req.user.id);
    if (!row) throw ApiError.notFound('not_found', 'That post is gone.');
    res.json({ post: row });
  })
);

// Registered before '/:id' so the bare-ish path is not read as an id: DELETE
// /done clears the finished ones, DELETE /:id removes exactly one.
router.delete(
  '/done',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    res.json({ removed: clearDone(req.user.id), queue: queue() });
  })
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    if (!removePost(Number(req.params.id), req.user.id)) {
      throw ApiError.notFound('not_found', 'That post is gone.');
    }
    res.json({ queue: queue() });
  })
);

export default router;
