import { Router } from 'express';
import config from '../config.js';
import { asyncRoute } from '../middleware/errors.js';
import {
  readConfig,
  listChapters,
  getChapter,
  listUpdates,
  assertLanguage,
  assertChapterNumber,
} from '../services/content.js';
import { countVisible } from '../services/comments.js';
import { attachUser } from '../middleware/auth.js';

const router = Router();

// The author sees what is not out yet. Everyone else sees what is.
const isAuthor = (req) => req.user?.role === 'admin';

// Published content changes rarely and is safe to cache briefly at the edge.
const cacheable = (res, seconds = 60) => {
  res.set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=300`);
};

router.get(
  '/config',
  asyncRoute(async (_req, res) => {
    cacheable(res, 30);
    const cfg = await readConfig();
    res.json({ ...cfg, availableLanguages: config.languages });
  })
);

router.get(
  '/chapters',
  attachUser,
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.query.lang || config.defaultLanguage));
    const includeHidden = isAuthor(req);
    // What comes back depends on who is asking, so it must never be cached by
    // anything in front of the server -- the author's view of an unreleased
    // chapter cannot be allowed to leak to a reader.
    if (includeHidden) res.set('Cache-Control', 'private, no-store');
    else cacheable(res, 30);
    res.json({ lang, chapters: await listChapters(lang, { includeHidden }) });
  })
);

router.get(
  '/chapters/:lang/:number',
  attachUser,
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    const number = assertChapterNumber(req.params.number);
    const includeHidden = isAuthor(req);
    const chapter = await getChapter(lang, number, { includeHidden });
    if (includeHidden) res.set('Cache-Control', 'private, no-store');
    else cacheable(res, 30);
    res.json({ ...chapter, commentCount: countVisible(lang, number) });
  })
);

router.get(
  '/updates',
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.query.lang || config.defaultLanguage));
    cacheable(res, 30);
    res.json({ lang, updates: await listUpdates(lang) });
  })
);

export default router;
