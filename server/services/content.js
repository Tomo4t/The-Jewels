import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import config from '../config.js';
import { ApiError } from '../middleware/errors.js';

/**
 * The filesystem is the source of truth for chapters and updates.
 *
 * That keeps published content static, cacheable and git-friendly: the site can
 * still be served by any plain static host if the Node server is ever taken
 * away. SQLite holds only the things that genuinely cannot be static — accounts
 * and comments.
 */

const CONFIG_FILE = () => join(config.contentDir, 'config.json');
const chaptersDir = (lang) => join(config.contentDir, 'chapters', lang);
const chapterDir = (lang, n) => join(chaptersDir(lang), `chapter${n}`);
const updatesDir = (lang) => join(config.contentDir, 'updates', lang);

/** Guards against `..` and absolute paths escaping the content directory. */
export function assertInsideContent(target) {
  const root = resolve(config.contentDir);
  const full = resolve(target);
  if (full !== root && !full.startsWith(root + sep)) {
    throw ApiError.badRequest(
      'bad_path',
      'Refusing to touch a path outside the content directory.'
    );
  }
  return full;
}

export function assertLanguage(lang) {
  if (!config.languages.includes(lang)) {
    throw ApiError.badRequest('bad_language', `Unknown language "${lang}".`);
  }
  return lang;
}

export function assertChapterNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    throw ApiError.badRequest(
      'bad_chapter',
      'Chapter number must be a whole number from 1 to 9999.'
    );
  }
  return n;
}

// --- site config ----------------------------------------------------------

const EMPTY_LANG = { chapters: 0, updates: 0 };

export async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    const languages = {};
    for (const lang of config.languages) {
      languages[lang] = { ...EMPTY_LANG, ...(parsed.languages?.[lang] || {}) };
    }
    return {
      version: 2,
      defaultLanguage: parsed.defaultLanguage || config.defaultLanguage,
      languages,
    };
  } catch {
    const languages = Object.fromEntries(config.languages.map((l) => [l, { ...EMPTY_LANG }]));
    return { version: 2, defaultLanguage: config.defaultLanguage, languages };
  }
}

export async function writeConfig(next) {
  await fs.mkdir(config.contentDir, { recursive: true });
  await fs.writeFile(CONFIG_FILE(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Rebuild config.json from what is actually on disk. Used after any upload or
 * delete so the counts can never drift away from reality.
 */
export async function syncConfigFromDisk() {
  const current = await readConfig();
  const languages = {};

  for (const lang of config.languages) {
    const dir = chaptersDir(lang);
    let chapters = 0;
    if (existsSync(dir)) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const numbers = entries
        .filter((e) => e.isDirectory() && /^chapter\d+$/.test(e.name))
        .map((e) => Number(e.name.replace('chapter', '')))
        .sort((a, b) => a - b);
      // Count only the unbroken run from chapter 1 — the reader assumes 1..n.
      for (let i = 0; i < numbers.length; i += 1) {
        if (numbers[i] === i + 1) chapters = numbers[i];
        else break;
      }
    }

    const uDir = updatesDir(lang);
    let updates = 0;
    if (existsSync(uDir)) {
      const files = (await fs.readdir(uDir)).filter((f) => /^\d+\.txt$/.test(f));
      updates = files.length;
    }

    languages[lang] = { chapters, updates };
  }

  return writeConfig({ ...current, languages });
}

// --- chapters -------------------------------------------------------------

/**
 * A chapter is released when it has no release time, or when that time has
 * passed. Nothing runs on a schedule: the comparison happens on every read, so
 * a chapter goes live on the stroke of its date whether or not anybody is
 * awake to press a button.
 */
export const isReleased = (meta, now = Date.now()) => {
  if (!meta?.releaseAt) return true;
  const at = Date.parse(meta.releaseAt);
  return Number.isNaN(at) ? true : at <= now;
};

export async function readChapterMeta(lang, n) {
  try {
    const raw = await fs.readFile(join(chapterDir(lang, n), 'meta.json'), 'utf8');
    const meta = JSON.parse(raw);
    return {
      title: String(meta.title || `Chapter ${n}`),
      description: String(meta.description || ''),
      pages: Number(meta.pages) || 0,
      publishedAt: meta.publishedAt || null,
      // A moment in the future, or null for something already out.
      releaseAt: meta.releaseAt || null,
      // Off the shelf but not deleted: hidden from readers, still there for
      // the author and still openable by them.
      archived: Boolean(meta.archived),
    };
  } catch {
    return null;
  }
}

export async function writeChapterMeta(lang, n, patch) {
  const existing = await readChapterMeta(lang, n);
  if (!existing) throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');

  const next = { ...existing, ...patch };
  const file = assertInsideContent(join(chapterDir(lang, n), 'meta.json'));
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.includeHidden] Include archived chapters and the
 *   ones still counting down. Only ever true for the author.
 */
export async function listChapters(lang, { includeHidden = false } = {}) {
  assertLanguage(lang);
  const cfg = await readConfig();
  const count = cfg.languages[lang]?.chapters || 0;
  const now = Date.now();

  const chapters = [];
  for (let n = 1; n <= count; n += 1) {
    const meta = await readChapterMeta(lang, n);
    if (!meta) continue;

    const released = isReleased(meta, now);
    // An archived chapter is gone from the reader's view entirely. An
    // unreleased one is listed, with its date, so the countdown has something
    // to count -- but without its page count, which would give away length.
    if (meta.archived && !includeHidden) continue;

    chapters.push({
      number: n,
      title: meta.title,
      description: released || includeHidden ? meta.description : '',
      pages: released || includeHidden ? meta.pages : 0,
      publishedAt: meta.publishedAt,
      releaseAt: meta.releaseAt,
      released,
      archived: meta.archived,
      cover: `/content/chapters/${lang}/chapter${n}/page0.jpg`,
    });
  }
  return chapters;
}

export async function getChapter(lang, n, { includeHidden = false } = {}) {
  assertLanguage(lang);
  assertChapterNumber(n);
  const meta = await readChapterMeta(lang, n);
  if (!meta) throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');

  // The pages are the thing being held back, so the refusal happens here
  // rather than only in the listing -- otherwise guessing the URL would walk
  // straight past the countdown.
  if (!includeHidden) {
    if (meta.archived) {
      throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');
    }
    if (!isReleased(meta)) {
      throw new ApiError(403, 'not_released_yet', 'This chapter is not out yet.', {
        releaseAt: meta.releaseAt,
      });
    }
  }

  const dir = chapterDir(lang, n);
  const files = existsSync(dir) ? await fs.readdir(dir) : [];
  const pageFiles = files
    .filter((f) => /^page\d+\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  return {
    lang,
    number: n,
    title: meta.title,
    description: meta.description,
    publishedAt: meta.publishedAt,
    releaseAt: meta.releaseAt,
    released: isReleased(meta),
    archived: meta.archived,
    pages: pageFiles.map((f) => `/content/chapters/${lang}/chapter${n}/${f}`),
  };
}

/**
 * The number a new chapter should get: one past the last unbroken one.
 *
 * The reader walks 1..n, so a gap would hide everything after it. Asking the
 * author to type the number was asking them to remember where they were, and
 * to be wrong about it exactly once.
 */
export async function nextChapterNumber(lang) {
  assertLanguage(lang);
  const cfg = await readConfig();
  return (cfg.languages[lang]?.chapters || 0) + 1;
}

/** The page files of a chapter, in reading order. */
export async function chapterPageFiles(lang, n) {
  const dir = chapterDir(lang, n);
  if (!existsSync(dir)) return [];
  return (await fs.readdir(dir))
    .filter((f) => /^page\d+\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

export async function deleteChapter(lang, n) {
  assertLanguage(lang);
  assertChapterNumber(n);
  const dir = assertInsideContent(chapterDir(lang, n));
  if (!existsSync(dir))
    throw ApiError.notFound('chapter_not_found', 'That chapter does not exist.');
  await fs.rm(dir, { recursive: true, force: true });
  await syncConfigFromDisk();
}

// --- updates --------------------------------------------------------------
// Stored as `<n>.txt` with the date on the first line and the body beneath —
// the format the site already used, kept so nothing needs migrating.

export async function listUpdates(lang) {
  assertLanguage(lang);
  const dir = updatesDir(lang);
  if (!existsSync(dir)) return [];

  const files = (await fs.readdir(dir)).filter((f) => /^\d+\.txt$/.test(f));
  const updates = [];

  for (const file of files) {
    const id = Number(file.replace('.txt', ''));
    const raw = (await fs.readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n').trim();
    if (!raw) continue;
    const [dateLine = '', ...rest] = raw.split('\n');
    updates.push({ id, date: dateLine.trim(), body: rest.join('\n').trim() });
  }

  return updates.sort((a, b) => b.id - a.id);
}

/**
 * @param {object} update
 * @param {number} [update.id] Overwrite an existing one; omitted means a new one.
 * @param {string} [update.date] Only ever passed when rewriting history in a
 *   test. An update is stamped with the moment it is written: asking an author
 *   to type today's date is asking them to get it wrong.
 */
export async function saveUpdate(lang, { id, date, body }) {
  assertLanguage(lang);
  const dir = assertInsideContent(updatesDir(lang));
  await fs.mkdir(dir, { recursive: true });

  let targetId = Number(id);
  if (!Number.isInteger(targetId) || targetId < 1) {
    const existing = (await fs.readdir(dir)).filter((f) => /^\d+\.txt$/.test(f));
    targetId = existing.reduce((max, f) => Math.max(max, Number(f.replace('.txt', ''))), 0) + 1;
  }

  // A full instant, not a bare day: the reader's clock decides which day that
  // is for them, and it cannot do that from a date with no time in it.
  const stamp = date ? String(date).trim() : new Date().toISOString();
  const content = `${stamp}\n${String(body).trim()}\n`;
  await fs.writeFile(join(dir, `${targetId}.txt`), content, 'utf8');
  await syncConfigFromDisk();
  return { id: targetId, date: stamp, body: String(body).trim() };
}

export async function deleteUpdate(lang, id) {
  assertLanguage(lang);
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw ApiError.badRequest('bad_update', 'Invalid update id.');
  const file = assertInsideContent(join(updatesDir(lang), `${n}.txt`));
  if (!existsSync(file)) throw ApiError.notFound('update_not_found', 'That update does not exist.');
  await fs.rm(file, { force: true });
  await syncConfigFromDisk();
}
