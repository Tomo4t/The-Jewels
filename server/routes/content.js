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

const router = Router();

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
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(String(req.query.lang || config.defaultLanguage));
    cacheable(res, 30);
    res.json({ lang, chapters: await listChapters(lang) });
  })
);

router.get(
  '/chapters/:lang/:number',
  asyncRoute(async (req, res) => {
    const lang = assertLanguage(req.params.lang);
    const number = assertChapterNumber(req.params.number);
    const chapter = await getChapter(lang, number);
    cacheable(res, 30);
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
