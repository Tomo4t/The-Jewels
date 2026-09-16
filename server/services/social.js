import db, { audit } from '../db.js';
import config from '../config.js';
import { listChapters } from './content.js';

/**
 * The social queue.
 *
 * It does not post anything. Posting means five developer accounts, five
 * OAuth flows and a standing bet that none of them changes its terms -- and
 * the part that is actually work was never the clicking, it was writing the
 * same announcement five times over and finding the cover image again.
 *
 * So this prepares and it tracks: when a chapter goes out it writes one draft
 * per place that chapter is announced, in that place's language, and remembers
 * which ones have gone up. What it cannot know is which of those places exist
 * -- a comic with one global Instagram and a French-only Twitter is a normal
 * shape -- so that is a setting rather than a guess baked into the code.
 */

/**
 * The places a chapter gets announced -- which is not the same list as the
 * contact page. VGen is a commissions shop and Tellonym is an ask box; neither
 * is somewhere you post "chapter 4 is up", so neither is offered here.
 */
export const PLATFORMS = ['instagram', 'twitter', 'tiktok', 'youtube', 'pinterest', 'twitch'];

const TARGETS_KEY = 'socialTargets';

/**
 * Kept out of the settings DEFINITIONS map on purpose: everything in there is
 * rendered as a labelled row in the settings tab, and a JSON array of
 * "lang:platform" pairs is not something anybody should be editing as text.
 */
export function targets() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TARGETS_KEY);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function setTargets(list, actorId) {
  const clean = [...new Set((list || []).filter((t) => /^[a-z]{2}:[a-z]+$/.test(t)))].sort();
  db.prepare(
    `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = datetime('now'),
                                    updated_by = excluded.updated_by`
  ).run(TARGETS_KEY, JSON.stringify(clean), actorId ?? null);
  audit(actorId, 'social.targets', 'setting', TARGETS_KEY, { count: clean.length });
  return clean;
}

/**
 * The announcement itself, in the language of the account it is going to.
 *
 * Deliberately plain and deliberately short. It is a starting point somebody
 * edits, not a finished post -- a generated caption that reads like a generated
 * caption is worse than no caption.
 */
const COPY = {
  en: (n, title, url) => `Chapter ${n} of The Jewels is out — "${title}"\n\nRead it here: ${url}`,
  fr: (n, title, url) =>
    `Le chapitre ${n} de The Jewels est en ligne — « ${title} »\n\nÀ lire ici : ${url}`,
  es: (n, title, url) =>
    `El capítulo ${n} de The Jewels ya está disponible — «${title}»\n\nLéelo aquí: ${url}`,
  ja: (n, title, url) => `The Jewels 第${n}話を公開しました — 「${title}」\n\nこちらから: ${url}`,
  pl: (n, title, url) =>
    `Rozdział ${n} The Jewels jest już dostępny — „${title}”\n\nPrzeczytaj: ${url}`,
};

export function draftBody(lang, number, title) {
  const url = `${config.publicOrigin}/#reader?lang=${lang}&chapter=${number}&page=0`;
  return (COPY[lang] || COPY.en)(number, title || `Chapter ${number}`, url);
}

/**
 * Writes the drafts for one chapter number, for every target that is turned on.
 *
 * A target whose language does not have that chapter is skipped rather than
 * given a draft pointing at a page that says "not translated yet".
 */
export async function generateFor(number, actorId) {
  const wanted = targets();
  if (!wanted.length) return { written: 0, skipped: 0 };

  const byLang = new Map();
  for (const target of wanted) {
    const [lang, platform] = target.split(':');
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(platform);
  }

  const insert = db.prepare(
    `INSERT INTO social_posts (lang, platform, chapter, body)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (lang, platform, chapter) DO NOTHING`
  );

  let written = 0;
  let skipped = 0;
  for (const [lang, platforms] of byLang) {
    let chapter = null;
    try {
      const chapters = await listChapters(lang, { includeHidden: true });
      chapter = chapters.find((c) => Number(c.number) === Number(number)) || null;
    } catch {
      chapter = null;
    }
    if (!chapter) {
      skipped += platforms.length;
      continue;
    }
    const body = draftBody(lang, number, chapter.title);
    for (const platform of platforms) {
      written += insert.run(lang, platform, Number(number), body).changes;
    }
  }

  audit(actorId, 'social.generated', 'chapter', String(number), { written, skipped });
  return { written, skipped };
}

/**
 * One shape for a post, used by both the list and the single-row read. They
 * used to differ -- the list aliased the timestamps and the update handed back
 * a raw row -- so a post that had just been marked posted came back without the
 * postedAt the page was reading, and the "posted just now" line never appeared.
 */
const COLUMNS = `id, lang, platform, chapter, body, status,
                 created_at AS createdAt, posted_at AS postedAt`;

export function queue() {
  return db
    .prepare(`SELECT ${COLUMNS} FROM social_posts ORDER BY chapter DESC, lang, platform`)
    .all();
}

function post(id) {
  return db.prepare(`SELECT ${COLUMNS} FROM social_posts WHERE id = ?`).get(id);
}

export function updatePost(id, { body, status }, actorId) {
  const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
  if (!row) return null;

  const nextBody = body === undefined ? row.body : String(body).slice(0, 4000);
  const nextStatus = ['todo', 'posted', 'skipped'].includes(status) ? status : row.status;

  db.prepare(
    `UPDATE social_posts
        SET body = ?, status = ?,
            posted_at = CASE WHEN ? = 'posted' AND posted_at IS NULL
                             THEN datetime('now')
                             WHEN ? <> 'posted' THEN NULL
                             ELSE posted_at END
      WHERE id = ?`
  ).run(nextBody, nextStatus, nextStatus, nextStatus, id);

  if (nextStatus !== row.status) {
    audit(actorId, 'social.status', 'social_post', String(id), { status: nextStatus });
  }
  return post(id);
}
