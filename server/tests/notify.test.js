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

test('push keys are made once and never silently replaced', async () => {
  const { ensureKeys, pushConfigured, pushSummary } = await import('../services/push.js');

  assert.equal(pushConfigured(), false, 'nothing is configured to begin with');

  const first = ensureKeys(1);
  assert.equal(first.created, true);
  assert.ok(first.publicKey?.length > 20, 'a real key came back');
  assert.equal(pushConfigured(), true);

  // The public half is baked into every subscription a browser has already
  // granted. Replacing it would leave readers switched on and receiving
  // nothing at all -- so asking again must be a no-op, not a new pair.
  const second = ensureKeys(1);
  assert.equal(second.created, false, 'a second call must not make new keys');
  assert.equal(second.publicKey, first.publicKey, 'the key is unchanged');
  assert.equal(pushSummary().publicKey, first.publicKey);
});

test('the private half is never handed to a client', async () => {
  const { pushSummary } = await import('../services/push.js');
  const summary = pushSummary();
  assert.ok('publicKey' in summary);
  assert.ok(!('privateKey' in summary), 'the private key must not be in anything serialised');
  assert.equal(
    JSON.stringify(summary).includes('private'),
    false,
    'nothing resembling the private key leaves the server'
  );
});

// --- moderation and newsletter blocks ---------------------------------------

test('a timeout expires on its own; a standing ban does not', async () => {
  const { setMute, muteFor, FOREVER } = await import('../services/users.js');
  const { createUser } = await import('../services/users.js');
  const user = await createUser({
    username: 'noisy-reader',
    password: 'Password123!',
    displayName: 'Noisy',
  });

  assert.equal(muteFor(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), null);

  // An hour from now: muted.
  const soon = new Date(Date.now() + 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  setMute(user.id, soon);
  const active = muteFor(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
  assert.ok(active, 'they are muted');
  assert.equal(active.forever, false);

  // A moment in the past: the mute is over, with nothing having run to end it.
  const past = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
  setMute(user.id, past);
  assert.equal(
    muteFor(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)),
    null,
    'an expired timeout lifts itself'
  );

  setMute(user.id, FOREVER);
  const forever = muteFor(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
  assert.ok(forever?.forever, 'a standing ban does not expire');

  setMute(user.id, null);
  assert.equal(muteFor(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), null);
});

test('a YouTube block renders a thumbnail and a link, never an embed', async () => {
  const { renderBlocks } = await import('../services/templates.js');
  const { html, text } = renderBlocks([
    { type: 'video', url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Watch chapter one' },
  ]);

  assert.match(html, /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/, 'the real thumbnail');
  assert.match(html, /youtube\.com\/watch\?v=dQw4w9WgXcQ/, 'links out to the video');
  // The point of the whole block: an iframe would be stripped and the reader
  // would get a blank space where the video was meant to be.
  assert.doesNotMatch(html, /<iframe/i, 'no embed, which no email client would run');
  assert.doesNotMatch(html, /<video/i);
  assert.match(text, /dQw4w9WgXcQ/, 'the plain-text half carries the link');
});

test('a video block with a link that is not YouTube renders nothing', async () => {
  const { renderBlocks } = await import('../services/templates.js');
  for (const url of ['https://vimeo.com/12345', 'not a url', '', 'https://evil.example/x']) {
    assert.equal(renderBlocks([{ type: 'video', url }]).html, '', `${url} should render nothing`);
  }
});

test('a file block links rather than attaching', async () => {
  const { renderBlocks } = await import('../services/templates.js');
  const { html } = renderBlocks([
    {
      type: 'file',
      src: '/content/newsletter/song.mp3',
      name: 'song.mp3',
      kind: 'MP3',
      bytes: 4_200_000,
    },
  ]);
  assert.match(html, /href="https:\/\/www\.tomojw\.com\/content\/newsletter\/song\.mp3"/);
  assert.match(html, /MP3/);
  assert.match(html, /4102 KB/, 'the size is stated so nobody taps a 4MB download blind');
  assert.doesNotMatch(html, /<audio/i, 'no player, because no inbox has one');
});

test('links in comments become links, and nothing else does', async () => {
  const { textToHTML } = await import('../../src/lib/dom.js');

  const plain = textToHTML('Read it at https://www.tomojw.com/#chapters', { links: true });
  assert.match(plain, /<a href="https:\/\/www\.tomojw\.com\/#chapters"/);
  // Without these a comment box hands the site's search ranking to whatever a
  // stranger pastes, and a target=_blank link can navigate the page it came from.
  assert.match(plain, /rel="nofollow ugc noopener noreferrer"/);

  // A bare domain is what people actually type.
  assert.match(
    textToHTML('Go to www.tomojw.com now', { links: true }),
    /href="https:\/\/www\.tomojw\.com"/
  );

  // Sentence punctuation belongs to the sentence, not the URL.
  const bracketed = textToHTML('Great chapter (https://tomojw.com).', { links: true });
  assert.match(bracketed, /tomojw\.com<\/a>\)\./);

  // Escaping happens first, so markup can never survive as markup.
  const nasty = textToHTML('<script>alert(1)</script> https://tomojw.com', { links: true });
  assert.doesNotMatch(nasty, /<script/i);
  assert.match(nasty, /&lt;script&gt;/);
  assert.match(nasty, /<a href="https:\/\/tomojw\.com"/);

  // Only http(s). A scheme that runs code must stay inert text.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x', 'file:///etc/passwd']) {
    assert.doesNotMatch(textToHTML(bad, { links: true }), /<a /, `${bad} must not become a link`);
  }

  // And off by default, so nothing starts linkifying where it was not asked for.
  assert.doesNotMatch(textToHTML('https://tomojw.com'), /<a /);
});
