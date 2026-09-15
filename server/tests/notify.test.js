import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config reads the environment at import time, so the sandbox comes first.
const sandbox = mkdtempSync(join(tmpdir(), 'jewels-notify-'));
const contentDir = join(sandbox, 'content');
for (const lang of ['en', 'ja', 'pl', 'es', 'fr']) {
  mkdirSync(join(contentDir, 'chapters', lang), { recursive: true });
  mkdirSync(join(contentDir, 'updates', lang), { recursive: true });
}
mkdirSync(join(contentDir, 'chapters', 'en', 'chapter1'), { recursive: true });
writeFileSync(
  join(contentDir, 'chapters', 'en', 'chapter1', 'meta.json'),
  JSON.stringify({ title: 'The First Jewel', description: 'It begins.', pages: 1, ext: 'webp' })
);
writeFileSync(
  join(contentDir, 'config.json'),
  JSON.stringify({
    version: 2,
    defaultLanguage: 'en',
    languages: {
      en: { chapters: 1, updates: 0 },
      ja: { chapters: 0, updates: 0 },
      pl: { chapters: 0, updates: 0 },
      es: { chapters: 0, updates: 0 },
      fr: { chapters: 0, updates: 0 },
    },
  })
);

process.env.DATABASE_PATH = join(sandbox, 'jewels.db');
process.env.CONTENT_DIR = contentDir;
process.env.SESSION_SECRET = 'a-secret-for-the-notification-tests';
process.env.PUBLIC_ORIGIN = 'https://www.tomojw.com';
process.env.NODE_ENV = 'test';

const db = (await import('../db.js')).default;
const { createUser, setEmail } = await import('../services/users.js');
const {
  preferencesFor,
  setPreference,
  subscribersFor,
  unsubscribeToken,
  readUnsubscribeToken,
  enqueue,
  queueDepth,
} = await import('../services/notifications.js');
const { announceNewChapters } = await import('../services/mailer.js');
const { releaseEmail, renderBlocks } = await import('../services/templates.js');

const confirm = (id) =>
  db.prepare(`UPDATE users SET email_verified_at = datetime('now') WHERE id = ?`).run(id);

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test('nobody is subscribed to anything by default', async () => {
  const user = await createUser({
    username: 'quiet-reader',
    password: 'Password123!',
    displayName: 'Quiet',
  });
  const prefs = preferencesFor(user.id);
  assert.equal(prefs.newsletter, false, 'newsletter must be off until asked for');
  assert.equal(prefs.release, false, 'releases must be off until asked for');
});

test('an unconfirmed address is never counted as a subscriber', async () => {
  const user = await createUser({
    username: 'unconfirmed-reader',
    password: 'Password123!',
    displayName: 'Unconfirmed',
  });
  setEmail(user.id, 'someone-elses@gmail.com');
  setPreference(user.id, 'release', true);

  // The opt-in is recorded, but the address is not proven to be theirs -- so
  // they must not receive anything. Otherwise typing a stranger's address
  // signs that stranger up.
  const ids = subscribersFor('release').map((s) => s.id);
  assert.ok(!ids.includes(user.id), 'an unconfirmed address must not receive mail');
});

test('a confirmed subscriber is included', async () => {
  const user = await createUser({
    username: 'keen-reader',
    password: 'Password123!',
    displayName: 'Keen',
  });
  setEmail(user.id, 'keen@gmail.com');
  confirm(user.id);
  setPreference(user.id, 'release', true);

  const ids = subscribersFor('release').map((s) => s.id);
  assert.ok(ids.includes(user.id));
});

test('an unsubscribe token round-trips, and a tampered one does not', () => {
  const token = unsubscribeToken(42, 'newsletter');
  assert.deepEqual(readUnsubscribeToken(token), { userId: 42, kind: 'newsletter' });

  // Flipping any character must invalidate it: an unsubscribe link that can be
  // guessed is a way to quietly switch off somebody else's mail.
  const tampered = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(readUnsubscribeToken(tampered), null);
  assert.equal(readUnsubscribeToken(''), null);
  assert.equal(readUnsubscribeToken('nonsense'), null);
  assert.equal(readUnsubscribeToken(`${Buffer.from('42.release').toString('base64url')}.x`), null);
});

test('announcing a chapter twice does not queue it twice', async () => {
  const before = queueDepth();

  // The first pass on a site that already has chapters must not mail the whole
  // back catalogue, so it records without sending.
  await announceNewChapters({ silent: true });
  assert.equal(queueDepth(), before, 'the back catalogue must not be announced');

  // And having recorded them, a later pass has nothing new to say -- which is
  // what stops a container restart re-announcing everything.
  await announceNewChapters();
  await announceNewChapters();
  assert.equal(queueDepth(), before, 'an already-announced chapter must not be queued again');

  const rows = db.prepare('SELECT lang, chapter FROM announcements').all();
  assert.ok(rows.length >= 1, 'the chapter was recorded as announced');
});

test('the dedupe key stops the same reader being queued twice for one chapter', () => {
  const message = {
    userId: 1,
    address: 'keen@gmail.com',
    subject: 'Chapter 1',
    html: '<p>hi</p>',
    text: 'hi',
    kind: 'release',
    dedupeKey: 'release:en:1:1',
  };
  const first = enqueue([message]);
  const second = enqueue([message]);
  assert.equal(first, 1, 'the first attempt queues');
  assert.equal(second, 0, 'the second is dropped rather than duplicated');
});

test('a release email carries a working link and an unsubscribe', () => {
  const mail = releaseEmail({
    displayName: 'Keen',
    lang: 'en',
    chapter: { number: 3, title: 'The Third Jewel', description: 'More of it.' },
    unsubscribe: 'https://www.tomojw.com/api/notify/unsubscribe?token=abc',
  });

  assert.match(mail.subject, /Chapter 3/);
  assert.match(mail.html, /chapter=3/, 'links to the chapter');
  assert.match(mail.html, /unsubscribe\?token=abc/, 'every message has a way out');
  assert.match(mail.text, /Chapter 3/, 'the plain-text half is real, not empty');
  assert.match(mail.text, /unsubscribe/i);
  // Tables, not flexbox: the latter does not exist in Outlook.
  assert.match(mail.html, /<table/);
  assert.doesNotMatch(mail.html, /display:\s*flex/);
});

test('a text block cannot smuggle markup into an inbox', () => {
  const { html } = renderBlocks([
    { type: 'text', text: 'Hello <script>alert(1)</script> and <img src=x onerror=y>' },
  ]);
  // The escaped text still contains the characters "onerror=" -- that is fine
  // and inert. What must not exist is a real tag or a real attribute, so the
  // assertion is about live markup rather than about the substring.
  assert.doesNotMatch(html, /<script/i, 'no live script tag');
  assert.doesNotMatch(html, /<img/i, 'no live img tag from the text block');
  assert.match(html, /&lt;script&gt;/, 'it survives as visible, inert text');
  assert.match(html, /&lt;img src=x onerror=y&gt;/);
});

test('only http links survive a text block', () => {
  const { html } = renderBlocks([
    { type: 'text', text: 'safe [here](https://tomojw.com) and [bad](javascript:alert(1))' },
  ]);
  assert.match(html, /href="https:\/\/tomojw\.com/);
  // The refused link stays as the literal text the author typed, which is the
  // right outcome -- it is visible and harmless. What matters is that it never
  // became an href.
  assert.doesNotMatch(html, /href="javascript:/i, 'never becomes a link');
  assert.doesNotMatch(html, /<a[^>]*javascript/i);
  assert.match(html, /\[bad\]\(javascript:/, 'left as plain text instead');
});

test('a button with no usable link renders nothing rather than a dead one', () => {
  assert.equal(renderBlocks([{ type: 'button', label: 'Go', href: 'ftp://x' }]).html, '');
  assert.equal(renderBlocks([{ type: 'button', href: 'https://tomojw.com' }]).html, '');
  assert.match(
    renderBlocks([{ type: 'button', label: 'Read', href: 'https://tomojw.com' }]).html,
    /Read/
  );
});
