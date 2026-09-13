import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config module reads the environment at import time, so the test sandbox
// has to be in place before the app is loaded.
const sandbox = mkdtempSync(join(tmpdir(), 'jewels-test-'));
const contentDir = join(sandbox, 'content');

for (const lang of ['en', 'ja', 'pl', 'es', 'fr']) {
  mkdirSync(join(contentDir, 'chapters', lang), { recursive: true });
  mkdirSync(join(contentDir, 'updates', lang), { recursive: true });
}
mkdirSync(join(contentDir, 'chapters', 'en', 'chapter1'), { recursive: true });
writeFileSync(
  join(contentDir, 'chapters', 'en', 'chapter1', 'meta.json'),
  JSON.stringify({ title: 'Test Chapter', description: 'For tests', pages: 1, ext: 'webp' })
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

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = join(sandbox, 'test.db');
process.env.CONTENT_DIR = contentDir;
process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough-for-tests';
process.env.MODERATION_QUEUE = 'true';
process.env.ALLOW_REGISTRATION = 'true';
process.env.ANTHROPIC_API_KEY = '';
// The credential limiter is real and works; the suite simply makes more auth
// calls than a production budget allows, so it is raised rather than bypassed.
process.env.AUTH_RATE_LIMIT = '500';
// The comment suites predate the verification gate and post from accounts with
// no address. The gate gets its own tests below, which switch it on explicitly.
process.env.REQUIRE_VERIFIED_EMAIL = 'false';

let server;
let base;

/** Minimal cookie-aware fetch wrapper. */
const makeClient = () => {
  let cookie = '';
  return async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (options.body && typeof options.body === 'string' && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(`${base}${path}`, {
      redirect: 'manual',
      ...options,
      headers,
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const entry of setCookie) {
      const [pair] = entry.split(';');
      if (pair.startsWith('jewels_session=')) cookie = pair;
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, location: res.headers.get('location') };
  };
};

const json = (payload) => JSON.stringify(payload);

before(async () => {
  const { default: app } = await import('../app.js');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('health and content', () => {
  test('health responds', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test('config lists every language', async () => {
    const client = makeClient();
    const { body } = await client('/api/content/config');
    assert.deepEqual(body.availableLanguages, ['en', 'ja', 'pl', 'es', 'fr']);
    assert.equal(body.languages.en.chapters, 1);
    assert.equal(body.languages.pl.chapters, 0);
  });

  test('unknown language is rejected', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/content/chapters?lang=ar');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad_language');
  });
});

describe('authentication', () => {
  test('first registered account becomes admin', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    assert.equal(status, 201);
    assert.equal(body.user.role, 'admin');
  });

  test('second account is an ordinary user', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });
    assert.equal(status, 201);
    assert.equal(body.user.role, 'user');
  });

  test('duplicate usernames are refused', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'TOMO', password: 'yet-another-long-password' }),
    });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'username_taken');
  });

  test('short passwords are refused', async () => {
    const client = makeClient();
    const { status } = await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'shorty', password: 'abc' }),
    });
    assert.equal(status, 400);
  });

  test('wrong password does not sign in', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'not-the-password' }),
    });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'invalid_credentials');
  });

  test('login then me then logout', async () => {
    const client = makeClient();
    await client('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });

    const me = await client('/api/auth/me');
    assert.equal(me.body.user.username, 'reader');

    await client('/api/auth/logout', { method: 'POST' });
    const after = await client('/api/auth/me');
    assert.equal(after.body.user, null);
  });
});

describe('comments and moderation', () => {
  const asReader = makeClient();
  const asAdmin = makeClient();

  before(async () => {
    await asReader('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });
    await asAdmin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
  });

  test('anonymous users cannot comment', async () => {
    const anon = makeClient();
    const { status } = await anon('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'hello there' }),
    });
    assert.equal(status, 401);
  });

  test('a comment lands in the queue when moderation is on', async () => {
    const { status, body } = await asReader('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Really enjoyed this chapter.' }),
    });
    assert.equal(status, 201);
    assert.equal(body.pending, true);
    assert.equal(body.comment.status, 'pending');
  });

  test('the author sees their own pending comment, strangers do not', async () => {
    const own = await asReader('/api/comments?lang=en&chapter=1');
    assert.equal(own.body.comments.length, 1);

    const anon = makeClient();
    const seen = await anon('/api/comments?lang=en&chapter=1');
    assert.equal(seen.body.comments.length, 0);
  });

  test('spam is auto-flagged with a reason', async () => {
    const { body } = await asReader('/api/comments', {
      method: 'POST',
      body: json({
        lang: 'en',
        chapter: 1,
        body: 'FREE ROBUX!!! http://spam.xyz http://spam2.xyz http://spam3.xyz http://spam4.xyz',
      }),
    });
    assert.equal(body.comment.status, 'pending');

    const queue = await asAdmin('/api/comments/moderation/queue');
    const flagged = queue.body.items.find((c) => c.body.includes('FREE ROBUX'));
    assert.ok(flagged, 'flagged comment should be in the queue');
    assert.ok(flagged.flagScore > 0.4, `expected a high flag score, got ${flagged.flagScore}`);
    assert.match(flagged.flagReason, /links|spam phrase/);
  });

  test('ordinary readers cannot see the moderation queue', async () => {
    const { status } = await asReader('/api/comments/moderation/queue');
    assert.equal(status, 403);
  });

  test('approving a comment makes it public', async () => {
    const queue = await asAdmin('/api/comments/moderation/queue');
    const target = queue.body.items.find((c) => c.body.includes('Really enjoyed'));
    assert.ok(target);

    const approved = await asAdmin(`/api/comments/${target.id}/moderate`, {
      method: 'POST',
      body: json({ action: 'approve' }),
    });
    assert.equal(approved.body.comment.status, 'visible');

    const anon = makeClient();
    const seen = await anon('/api/comments?lang=en&chapter=1');
    assert.equal(seen.body.comments.length, 1);
    assert.equal(seen.body.comments[0].body, 'Really enjoyed this chapter.');
  });

  test('replies nest one level and never deeper', async () => {
    const anon = makeClient();
    const list = await anon('/api/comments?lang=en&chapter=1');
    const root = list.body.comments[0];

    const reply = await asAdmin('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, parentId: root.id, body: 'Thank you for reading.' }),
    });
    assert.equal(reply.body.comment.parentId, root.id);

    await asAdmin(`/api/comments/${reply.body.comment.id}/moderate`, {
      method: 'POST',
      body: json({ action: 'approve' }),
    });

    // A reply to the reply should attach to the root, not create a third level.
    const nested = await asAdmin('/api/comments', {
      method: 'POST',
      body: json({
        lang: 'en',
        chapter: 1,
        parentId: reply.body.comment.id,
        body: 'Nesting should stop here.',
      }),
    });
    assert.equal(nested.body.comment.parentId, root.id);
  });

  test('an author can edit and delete their own comment', async () => {
    const posted = await asReader('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'First draft of my thoughts.' }),
    });
    const id = posted.body.comment.id;

    const edited = await asReader(`/api/comments/${id}`, {
      method: 'PATCH',
      body: json({ body: 'Second draft, much better.' }),
    });
    assert.equal(edited.body.comment.body, 'Second draft, much better.');
    assert.equal(edited.body.comment.edited, true);

    const removed = await asReader(`/api/comments/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
  });

  test('a reader cannot edit somebody else comment', async () => {
    const mine = await asAdmin('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'An admin comment.' }),
    });
    const { status } = await asReader(`/api/comments/${mine.body.comment.id}`, {
      method: 'PATCH',
      body: json({ body: 'Hijacked.' }),
    });
    assert.equal(status, 403);
  });

  test('comments on a chapter that does not exist are refused', async () => {
    const { status, body } = await asReader('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 99, body: 'Does this chapter exist?' }),
    });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'chapter_not_found');
  });

  test('over-long comments are refused', async () => {
    const { status, body } = await asReader('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'x'.repeat(2500) }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'comment_too_long');
  });
});

describe('admin', () => {
  const asReader = makeClient();
  const asAdmin = makeClient();

  before(async () => {
    await asReader('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });
    await asAdmin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
  });

  test('readers cannot reach admin endpoints', async () => {
    const { status } = await asReader('/api/admin/users');
    assert.equal(status, 403);
  });

  test('admin can promote a user to moderator', async () => {
    const users = await asAdmin('/api/admin/users');
    const reader = users.body.users.find((u) => u.username === 'reader');

    const { status, body } = await asAdmin(`/api/admin/users/${reader.id}`, {
      method: 'PATCH',
      body: json({ role: 'moderator' }),
    });
    assert.equal(status, 200);
    assert.equal(body.user.role, 'moderator');
  });

  test('the last admin cannot be demoted', async () => {
    const users = await asAdmin('/api/admin/users');
    const admin = users.body.users.find((u) => u.username === 'tomo');
    const { status, body } = await asAdmin(`/api/admin/users/${admin.id}`, {
      method: 'PATCH',
      body: json({ role: 'user' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'self_modification');
  });

  test('uploading a chapter writes pages and bumps the config', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 40, height: 60, channels: 3, background: '#334455' },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.set('lang', 'pl');
    form.set('number', '1');
    form.set('title', 'Rozdział testowy');
    form.set('description', 'Testowy opis');
    form.append('pages', new Blob([png], { type: 'image/png' }), 'page-01.png');
    form.append('pages', new Blob([png], { type: 'image/png' }), 'page-02.png');

    const { status, body } = await asAdmin('/api/admin/chapters', { method: 'POST', body: form });
    assert.equal(status, 201);
    assert.equal(body.chapter.pages, 2);

    const config = await asAdmin('/api/content/config');
    assert.equal(config.body.languages.pl.chapters, 1);

    const chapter = await asAdmin('/api/content/chapters/pl/1');
    assert.equal(chapter.body.pages.length, 2);
    assert.match(chapter.body.pages[0], /page0\.webp$/);
  });

  test('a chapter can be deleted again', async () => {
    const { status } = await asAdmin('/api/admin/chapters/pl/1', { method: 'DELETE' });
    assert.equal(status, 200);

    const config = await asAdmin('/api/content/config');
    assert.equal(config.body.languages.pl.chapters, 0);
  });

  test('updates can be created and removed', async () => {
    const created = await asAdmin('/api/admin/updates', {
      method: 'POST',
      body: json({ lang: 'en', date: '2026-09-12', body: 'Chapter 2 is live.' }),
    });
    assert.equal(created.status, 201);

    const list = await asAdmin('/api/content/updates?lang=en');
    assert.equal(list.body.updates.length, 1);
    assert.equal(list.body.updates[0].body, 'Chapter 2 is live.');

    const removed = await asAdmin(`/api/admin/updates/en/${created.body.update.id}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);
  });

  test('a malformed update date is refused', async () => {
    const { status, body } = await asAdmin('/api/admin/updates', {
      method: 'POST',
      body: json({ lang: 'en', date: 'yesterday', body: 'Nope.' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad_date');
  });

  test('path traversal in a language is refused', async () => {
    const { status } = await asAdmin('/api/admin/chapters/..%2F..%2Fetc/1', { method: 'DELETE' });
    assert.ok(status === 400 || status === 404, `expected 400/404, got ${status}`);
  });
});

describe('email and identity', () => {
  test('/me reports the features that are actually configured', async () => {
    const client = makeClient();
    const { body } = await client('/api/auth/me');
    // Neither RESEND_API_KEY nor a Google client is set in the test environment,
    // so both must read false rather than being assumed on.
    assert.equal(body.googleSignIn, false);
    assert.equal(body.emailVerification, false);
  });

  test('an account can be created with an email and starts unverified', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'mailer-one',
        password: 'a-long-enough-password',
        email: 'Mailer.One@Example.COM',
      }),
    });
    assert.equal(status, 201);
    assert.equal(body.user.emailVerified, false);
    // Addresses are stored lowercased so lookups and uniqueness agree.
    assert.equal(body.user.email, 'mailer.one@example.com');
    // No mail provider is configured, so nothing was claimed to have been sent.
    assert.equal(body.verification.status, 'not_configured');
  });

  test('a malformed email is refused', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'mailer-bad', password: 'a-long-enough-password', email: 'nope' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_failed');
  });

  test('an address nobody has confirmed does not block a second signup', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'mailer-two',
        password: 'a-long-enough-password',
        email: 'MAILER.ONE@example.com',
      }),
    });
    // mailer-one typed this address and never proved it was theirs, so it is
    // still up for grabs. The account is created without it -- proving
    // ownership is what would attach it.
    assert.equal(status, 201);
    assert.equal(body.user.email, null);
    assert.equal(body.verification.claiming, true);
  });

  test('registering without an email still works', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'no-mail', password: 'a-long-enough-password' }),
    });
    assert.equal(status, 201);
    assert.equal(body.user.email, null);
    assert.equal(body.verification.status, 'no_email');
  });

  test('changing the address needs a session', async () => {
    const client = makeClient();
    const { status } = await client('/api/auth/email', {
      method: 'PUT',
      body: json({ email: 'someone@example.com' }),
    });
    assert.equal(status, 401);
  });

  test('the owner can set an address, and it lands unverified', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'setter', password: 'a-long-enough-password' }),
    });

    const { status, body } = await client('/api/auth/email', {
      method: 'PUT',
      body: json({ email: 'setter@example.com' }),
    });
    assert.equal(status, 200);
    assert.equal(body.user.email, 'setter@example.com');
    assert.equal(body.user.emailVerified, false);
  });

  test('an unconfirmed address is claimable, but is not taken until proven', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'claimer', password: 'a-long-enough-password' }),
    });

    const { status, body } = await client('/api/auth/email', {
      method: 'PUT',
      body: json({ email: 'setter@example.com' }),
    });

    assert.equal(status, 200);
    assert.equal(body.verification.claiming, true);
    // Crucially the address is NOT moved yet. Typing somebody else's address
    // must never take it from them on its own.
    assert.equal(body.user.email, null);
  });

  test('a confirmed address is refused outright', async () => {
    const { markEmailVerified, findByUsername } = await import('../services/users.js');
    markEmailVerified(findByUsername('setter').id);

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'latecomer', password: 'a-long-enough-password' }),
    });

    const { status, body } = await client('/api/auth/email', {
      method: 'PUT',
      body: json({ email: 'setter@example.com' }),
    });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'email_taken');
  });

  test('a forgotten-password request never reveals whether an account exists', async () => {
    const client = makeClient();
    const known = await client('/api/auth/password/forgot', {
      method: 'POST',
      body: json({ email: 'setter@example.com' }),
    });
    const unknown = await client('/api/auth/password/forgot', {
      method: 'POST',
      body: json({ email: 'nobody-at-all@example.com' }),
    });
    const malformed = await client('/api/auth/password/forgot', {
      method: 'POST',
      body: json({ email: 'not-an-email' }),
    });

    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(malformed.status, 200);
    // The point of the test: the three replies are byte-identical, so the
    // endpoint cannot be used to find out which addresses have accounts.
    assert.deepEqual(known.body, unknown.body);
    assert.deepEqual(known.body, malformed.body);
  });

  test('a bogus reset link is reported invalid and refuses to set a password', async () => {
    const client = makeClient();
    const check = await client('/api/auth/password/reset?token=nope-nope-nope-nope-nope');
    assert.equal(check.body.valid, false);

    const attempt = await client('/api/auth/password/reset', {
      method: 'POST',
      body: json({ token: 'nope-nope-nope-nope-nope', password: 'a-long-enough-password' }),
    });
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.error.code, 'invalid_token');
  });

  test('a bogus verification link redirects as a failure rather than erroring', async () => {
    const client = makeClient();
    const { status, location } = await client('/api/auth/verify?token=not-a-real-token-at-all');
    assert.equal(status, 302);
    assert.match(location, /verified=0/);
  });

  test('resending needs an address on the account', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'resender', password: 'a-long-enough-password' }),
    });

    const { status, body } = await client('/api/auth/verify/resend', { method: 'POST' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'no_email');
  });

  test('Google sign-in reports itself unconfigured rather than half-working', async () => {
    const client = makeClient();
    const { status, body } = await client('/api/auth/google');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'google_not_configured');
  });
});

describe('the verification gate on commenting', () => {
  test('an unverified account is refused, and told why', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('requireVerifiedEmail', true, null);

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'gated-user', password: 'a-long-enough-password' }),
    });

    const { status, body } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Let me in please.' }),
    });

    assert.equal(status, 403);
    assert.equal(body.error.code, 'email_not_verified');

    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });

  test('a verified account posts normally', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    const { markEmailVerified, findByUsername, setEmail } = await import('../services/users.js');
    setSetting('requireVerifiedEmail', true, null);

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'verified-user', password: 'a-long-enough-password' }),
    });

    const user = findByUsername('verified-user');
    setEmail(user.id, 'verified-user@example.com');
    markEmailVerified(user.id);

    const { status } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'I confirmed my address.' }),
    });
    assert.equal(status, 201);

    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });

  test('a moderator is never locked out by the gate', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    const { findByUsername, setRole } = await import('../services/users.js');
    setSetting('requireVerifiedEmail', true, null);

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'gated-mod', password: 'a-long-enough-password' }),
    });
    setRole(findByUsername('gated-mod').id, 'moderator');

    const { status } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Moderating without an address.' }),
    });
    assert.equal(status, 201);

    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });

  test('a user sees their own comments, pending ones included', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'feed-user', password: 'a-long-enough-password' }),
    });
    await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'First thing I wrote.' }),
    });
    await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Second thing I wrote.' }),
    });

    const { status, body } = await client('/api/comments/mine');
    assert.equal(status, 200);
    assert.equal(body.total, 2);
    // Newest first, so the profile reads like a timeline.
    assert.match(body.comments[0].body, /Second thing/);
  });

  test('the feed needs a session', async () => {
    const client = makeClient();
    const { status } = await client('/api/comments/mine');
    assert.equal(status, 401);
  });
});

describe('runtime settings', () => {
  const admin = makeClient();

  test('only an admin can read them', async () => {
    const stranger = makeClient();
    await stranger('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'settings-nobody', password: 'a-long-enough-password' }),
    });
    const { status } = await stranger('/api/admin/settings');
    assert.equal(status, 403);
  });

  test('they report where their value came from', async () => {
    const { findByUsername, setRole } = await import('../services/users.js');
    await admin('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'settings-admin', password: 'a-long-enough-password' }),
    });
    setRole(findByUsername('settings-admin').id, 'admin');

    const { status, body } = await admin('/api/admin/settings');
    assert.equal(status, 200);
    // Nothing has been overridden yet, so every value still traces to the env.
    assert.equal(body.settings.moderationQueue.source, 'environment');
  });

  test('changing one sticks and is marked as an admin override', async () => {
    const { body } = await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ moderationQueue: false }),
    });
    assert.equal(body.settings.moderationQueue.value, false);
    assert.equal(body.settings.moderationQueue.source, 'admin');
  });

  test('with the queue off a comment goes straight live', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'straight-through', password: 'a-long-enough-password' }),
    });
    const { status, body } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Should appear immediately.' }),
    });
    assert.equal(status, 201);
    assert.equal(body.pending, false);

    await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ moderationQueue: true }),
    });
  });

  test('a flagged comment is still held even with the queue off', async () => {
    await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ moderationQueue: false }),
    });

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'flagged-through', password: 'a-long-enough-password' }),
    });
    const { body } = await client('/api/comments', {
      method: 'POST',
      body: json({
        lang: 'en',
        chapter: 1,
        body: 'BUY CHEAP FOLLOWERS NOW!!! http://spam.example http://spam2.example',
      }),
    });
    assert.equal(body.pending, true);

    await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ moderationQueue: true }),
    });
  });

  test('an unknown key is refused rather than silently stored', async () => {
    const { status, body } = await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ notARealSetting: true }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'unknown_setting');
  });

  test('a boolean setting refuses a non-boolean', async () => {
    const { status, body } = await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ moderationQueue: 'yes please' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_failed');
  });
});
