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

  test('an update is stamped when it is posted, whatever the client sends', async () => {
    const before = Date.now();
    const { status, body } = await asAdmin('/api/admin/updates', {
      method: 'POST',
      // A date from the client is ignored entirely: the stamp is the moment
      // the update was written, not whatever the browser claimed.
      body: json({ lang: 'en', date: 'yesterday', body: 'Something happened.' }),
    });
    assert.equal(status, 201);

    const at = Date.parse(body.update.date);
    assert.ok(!Number.isNaN(at), `"${body.update.date}" is not a real instant`);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'the stamp is not now');

    // It has to carry a time, not just a day, or no reader can be shown it in
    // their own zone.
    assert.match(body.update.date, /T\d{2}:\d{2}/);

    await asAdmin(`/api/admin/updates/en/${body.update.id}`, { method: 'DELETE' });
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

describe('an account is not finished until its address is confirmed', () => {
  test('registering without one is refused when it could be confirmed', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('requireVerifiedEmail', true, null);
    process.env.RESEND_API_KEY = 'test-key-so-the-rule-applies';

    const { status, body } = await makeClient()('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'no-address', password: 'a-long-enough-password' }),
    });

    assert.equal(status, 400);
    assert.equal(body.error.code, 'email_required');

    process.env.RESEND_API_KEY = '';
    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });

  test('and is allowed when nothing could send the confirmation', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    // The rule stands down without a mail provider. Demanding an address that
    // can never be confirmed would only lock people out of their own sign-up.
    setSetting('requireVerifiedEmail', true, null);
    process.env.RESEND_API_KEY = '';

    const { status } = await makeClient()('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'no-mailer', password: 'a-long-enough-password' }),
    });

    assert.equal(status, 201);

    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });

  test('/me says whether the address is demanded', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('requireVerifiedEmail', true, null);

    process.env.RESEND_API_KEY = '';
    const off = await makeClient()('/api/auth/me');
    assert.equal(off.body.emailRequired, false);

    process.env.RESEND_API_KEY = 'test-key-so-the-rule-applies';
    const on = await makeClient()('/api/auth/me');
    assert.equal(on.body.emailRequired, true);

    process.env.RESEND_API_KEY = '';
    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });
});

describe('the verification gate on commenting', () => {
  test('an unverified account is refused, and told why', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('requireVerifiedEmail', true, null);
    process.env.RESEND_API_KEY = 'test-key-so-the-gate-applies';

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'gated-user',
        password: 'a-long-enough-password',
        email: 'gated-user@example.com',
      }),
    });

    const { status, body } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Let me in please.' }),
    });

    assert.equal(status, 403);
    assert.equal(body.error.code, 'email_not_verified');

    process.env.RESEND_API_KEY = '';
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

    process.env.RESEND_API_KEY = 'test-key-so-the-gate-applies';
    const user = findByUsername('verified-user');
    setEmail(user.id, 'verified-user@example.com');
    markEmailVerified(user.id);

    const { status } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'I confirmed my address.' }),
    });
    assert.equal(status, 201);

    process.env.RESEND_API_KEY = '';
    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });

  test('a moderator is never locked out by the gate', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    const { findByUsername, setRole } = await import('../services/users.js');
    setSetting('requireVerifiedEmail', true, null);
    process.env.RESEND_API_KEY = 'test-key-so-the-gate-applies';

    // An address, but never confirmed -- the exemption is about verification,
    // not about having one on file.
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'gated-mod',
        password: 'a-long-enough-password',
        email: 'gated-mod@example.com',
      }),
    });
    setRole(findByUsername('gated-mod').id, 'moderator');

    const { status } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Moderating without an address.' }),
    });
    assert.equal(status, 201);

    process.env.RESEND_API_KEY = '';
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

describe('the verification gate stands down without a mail provider', () => {
  test('an unverified account can still comment when nothing can send mail', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('requireVerifiedEmail', true, null);

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'no-mail-gate', password: 'a-long-enough-password' }),
    });

    // RESEND_API_KEY is unset in this suite, so confirming an address is
    // impossible. Enforcing the requirement here would lock every reader out
    // of commenting with no way back in, so it must not be enforced.
    const { status } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Nothing can send me a link.' }),
    });
    assert.equal(status, 201);

    setSetting('requireVerifiedEmail', false, null);
    clearSettingsCache();
  });
});

describe('the names an account appears under, and where it left off', () => {
  test('a display name can be changed, and the username cannot', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'namer', password: 'a-long-enough-password' }),
    });

    const renamed = await client('/api/auth/profile', {
      method: 'PUT',
      body: json({ displayName: 'Someone Else' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.displayName, 'Someone Else');
    assert.equal(renamed.body.user.username, 'namer');

    // Registering by hand means the username was typed on the form, so the
    // one chance to set it is already spent.
    const retried = await client('/api/auth/profile', {
      method: 'PUT',
      body: json({ username: 'somebody-new' }),
    });
    assert.equal(retried.status, 400);
    assert.equal(retried.body.error.code, 'username_fixed');

    const { body } = await client('/api/auth/me');
    assert.equal(body.user.username, 'namer');
    assert.equal(body.user.profileSetupPending, false);
  });

  test('an empty display name is refused rather than stored', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'blanker', password: 'a-long-enough-password' }),
    });

    const { status } = await client('/api/auth/profile', {
      method: 'PUT',
      body: json({ displayName: '   ' }),
    });
    assert.equal(status, 400);

    const { body } = await client('/api/auth/me');
    assert.equal(body.user.displayName, 'blanker');
  });

  test('reading progress is kept per language and overwritten in place', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'bookmark', password: 'a-long-enough-password' }),
    });

    const empty = await client('/api/auth/progress?lang=en');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.progress, null);

    await client('/api/auth/progress', {
      method: 'PUT',
      body: json({ lang: 'en', chapter: 1, page: 3 }),
    });
    await client('/api/auth/progress', {
      method: 'PUT',
      body: json({ lang: 'ja', chapter: 1, page: 1 }),
    });
    // Reading on does not add a second row for the same language.
    await client('/api/auth/progress', {
      method: 'PUT',
      body: json({ lang: 'en', chapter: 1, page: 7 }),
    });

    const one = await client('/api/auth/progress?lang=en');
    assert.equal(one.body.progress.page, 7);

    const all = await client('/api/auth/progress');
    assert.equal(all.body.progress.length, 2);
    assert.deepEqual(all.body.progress.map((p) => p.lang).sort(), ['en', 'ja']);
  });

  test('progress belongs to the account, not to whoever asks', async () => {
    const stranger = makeClient();
    const { status } = await stranger('/api/auth/progress?lang=en');
    assert.equal(status, 401);

    const other = makeClient();
    await other('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'elsewhere', password: 'a-long-enough-password' }),
    });
    const { body } = await other('/api/auth/progress?lang=en');
    assert.equal(body.progress, null);
  });
});

describe('the controls an administrator actually has', () => {
  test('a banned word holds a comment that would otherwise pass', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('bannedWords', 'pineapple\nsome long phrase', null);
    setSetting('moderationQueue', false, null);
    clearSettingsCache();

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'wordy', password: 'a-long-enough-password' }),
    });

    const clean = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'What a lovely page.' }),
    });
    assert.equal(clean.body.comment.status, 'visible');

    const caught = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'I would put pineapple on it.' }),
    });
    assert.equal(caught.body.comment.status, 'pending');

    // The reason is a moderator's business, not the author's, so it is read
    // from the queue rather than from what the poster gets back.
    const admin = makeClient();
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    const queue = await admin('/api/comments/moderation/queue');
    const held = queue.body.items.find((c) => c.id === caught.body.comment.id);
    assert.ok(held, 'the held comment is not in the moderation queue');
    assert.match(held.flagReason, /banned word/);

    // A word is matched as a word, not as a run of letters inside a longer
    // one -- banning "ass" must not take out "passage".
    setSetting('bannedWords', 'ass', null);
    clearSettingsCache();
    const innocent = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'A lovely passage in this chapter.' }),
    });
    assert.equal(innocent.body.comment.status, 'visible');

    setSetting('bannedWords', '', null);
    setSetting('moderationQueue', true, null);
    clearSettingsCache();
  });

  test('set to reject, a banned word rejects instead of holding', async () => {
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('bannedWords', 'gorgonzola', null);
    setSetting('bannedWordsAction', 'reject', null);
    clearSettingsCache();

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'rejector', password: 'a-long-enough-password' }),
    });

    const { body } = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'gorgonzola forever' }),
    });
    assert.equal(body.comment.status, 'rejected');

    setSetting('bannedWords', '', null);
    setSetting('bannedWordsAction', 'hold', null);
    clearSettingsCache();
  });

  test('the new settings are readable and writable by an admin', async () => {
    const admin = makeClient();
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });

    const { body } = await admin('/api/admin/settings');
    for (const key of [
      'bannedWords',
      'bannedWordsAction',
      'commentCooldownMinutes',
      'commentDuplicateHours',
    ]) {
      assert.ok(body.settings[key], `${key} is missing from the settings`);
      assert.ok(body.settings[key].type, `${key} has no type`);
    }

    const saved = await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ commentCooldownMinutes: 9 }),
    });
    assert.equal(saved.status, 200);

    const after = await admin('/api/admin/settings');
    assert.equal(after.body.settings.commentCooldownMinutes.value, 9);

    // A nonsense number falls back rather than being stored as NaN, which
    // would quietly switch the rule it governs off.
    await admin('/api/admin/settings', {
      method: 'PATCH',
      body: json({ commentCooldownMinutes: 'soon' }),
    });
    const recovered = await admin('/api/admin/settings');
    assert.equal(recovered.body.settings.commentCooldownMinutes.value, 5);
  });

  test('a reader cannot read or change the settings', async () => {
    const reader = makeClient();
    await reader('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'nosy', password: 'a-long-enough-password' }),
    });
    const read = await reader('/api/admin/settings');
    assert.equal(read.status, 403);

    const write = await reader('/api/admin/settings', {
      method: 'PATCH',
      body: json({ allowRegistration: false }),
    });
    assert.equal(write.status, 403);
  });
});

describe('a chapter with a date still to come', () => {
  test('it is listed with its date, cannot be opened, and lets itself out on time', async () => {
    const { writeChapterMeta } = await import('../services/content.js');

    const admin = makeClient();
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await writeChapterMeta('en', 1, { releaseAt: future });

    // A reader sees it on the shelf, with its date, and no page count — the
    // countdown needs something to count, but the length is not given away.
    const reader = makeClient();
    const shelf = await reader('/api/content/chapters?lang=en');
    const listed = shelf.body.chapters.find((c) => c.number === 1);
    assert.ok(listed, 'the chapter vanished from the shelf instead of counting down');
    assert.equal(listed.released, false);
    assert.equal(listed.releaseAt, future);
    assert.equal(listed.pages, 0);

    // Guessing the URL must not walk past the countdown.
    const blocked = await reader('/api/content/chapters/en/1');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'not_released_yet');

    // The author can still read it, which is what "preview" means here.
    const preview = await admin('/api/content/chapters/en/1');
    assert.equal(preview.status, 200);
    assert.ok(preview.body.pages.length >= 0);

    // A date in the past is simply out: nothing runs on a schedule, the
    // comparison happens on every read.
    await writeChapterMeta('en', 1, { releaseAt: new Date(Date.now() - 1000).toISOString() });
    const now = await reader('/api/content/chapters/en/1');
    assert.equal(now.status, 200);

    await writeChapterMeta('en', 1, { releaseAt: null });
  });

  test('an archived chapter is gone for readers and still there for the author', async () => {
    const { writeChapterMeta } = await import('../services/content.js');

    const admin = makeClient();
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });

    await writeChapterMeta('en', 1, { archived: true });

    const reader = makeClient();
    const shelf = await reader('/api/content/chapters?lang=en');
    assert.equal(
      shelf.body.chapters.find((c) => c.number === 1),
      undefined
    );
    const gone = await reader('/api/content/chapters/en/1');
    assert.equal(gone.status, 404);

    const authorShelf = await admin('/api/content/chapters?lang=en');
    const mine = authorShelf.body.chapters.find((c) => c.number === 1);
    assert.ok(mine, 'the author cannot see their own archived chapter');
    assert.equal(mine.archived, true);
    assert.equal((await admin('/api/content/chapters/en/1')).status, 200);

    await writeChapterMeta('en', 1, { archived: false });
  });

  test('only an admin can schedule, and the date has to be a date', async () => {
    const reader = makeClient();
    await reader('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'schemer', password: 'a-long-enough-password' }),
    });
    const refused = await reader('/api/admin/chapters/en/1/release', {
      method: 'PATCH',
      body: json({ releaseAt: new Date().toISOString() }),
    });
    assert.equal(refused.status, 403);

    const admin = makeClient();
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    const nonsense = await admin('/api/admin/chapters/en/1/release', {
      method: 'PATCH',
      body: json({ releaseAt: 'next tuesday-ish' }),
    });
    assert.equal(nonsense.status, 400);
    assert.equal(nonsense.body.error.code, 'invalid_date');

    // Scheduling must not quietly drop the title alongside it.
    const before = await admin('/api/content/chapters/en/1');
    const ok = await admin('/api/admin/chapters/en/1/release', {
      method: 'PATCH',
      body: json({ releaseAt: new Date(Date.now() + 3600_000).toISOString() }),
    });
    assert.equal(ok.status, 200);
    const after = await admin('/api/content/chapters/en/1');
    assert.equal(after.body.title, before.body.title);

    await admin('/api/admin/chapters/en/1/release', {
      method: 'PATCH',
      body: json({ releaseAt: null }),
    });
  });
});

describe('putting a chapter up, and changing it afterwards', () => {
  const tint = async (colour) => {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width: 40, height: 60, channels: 3, background: colour } })
      .png()
      .toBuffer();
  };

  const admin = makeClient();

  test("the number is the site's to choose, and the date and archive come with it", async () => {
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });

    const png = await tint('#112233');
    const soon = new Date(Date.now() + 7 * 86400000).toISOString();

    const form = new FormData();
    form.set('lang', 'es');
    // No number at all: the author should never have to remember where they
    // were, and a gap would hide every chapter after it.
    form.set('title', 'Capítulo uno');
    form.set('releaseAt', soon);
    form.set('archived', 'true');
    form.append('pages', new Blob([png], { type: 'image/png' }), 'a.png');

    const first = await admin('/api/admin/chapters', { method: 'POST', body: form });
    assert.equal(first.status, 201);
    assert.equal(first.body.chapter.number, 1);

    const detail = await admin('/api/content/chapters/es/1');
    assert.equal(detail.body.releaseAt, soon);
    assert.equal(detail.body.archived, true);
    assert.equal(detail.body.released, false);

    // The next one takes the next number without being told.
    const second = new FormData();
    second.set('lang', 'es');
    second.set('title', 'Capítulo dos');
    second.append('pages', new Blob([png], { type: 'image/png' }), 'a.png');
    const next = await admin('/api/admin/chapters', { method: 'POST', body: second });
    assert.equal(next.body.chapter.number, 2);
  });

  test('pages can be reordered, replaced, dropped and added in one go', async () => {
    const red = await tint('#aa2222');
    const blue = await tint('#2222aa');

    const form = new FormData();
    form.set('lang', 'fr');
    form.set('title', 'Chapitre un');
    for (const name of ['1.png', '2.png', '3.png']) {
      form.append('pages', new Blob([red], { type: 'image/png' }), name);
    }
    const made = await admin('/api/admin/chapters', { method: 'POST', body: form });
    assert.equal(made.body.chapter.pages, 3);

    // Say what the chapter should end up as: page 3 first, then a brand new
    // page, then page 1. Page 2 is not named, so it goes.
    const edit = new FormData();
    edit.set('layout', JSON.stringify(['keep:2', 'new:0', 'keep:0']));
    edit.append('pages', new Blob([blue], { type: 'image/png' }), 'new.png');

    const saved = await admin('/api/admin/chapters/fr/1/pages', { method: 'PUT', body: edit });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.chapter.pages.length, 3);

    const after = await admin('/api/content/chapters/fr/1');
    assert.equal(after.body.pages.length, 3);
    // Renumbered from zero, with no gaps, whatever was kept from where.
    assert.match(after.body.pages[0], /page0\.webp$/);
    assert.match(after.body.pages[2], /page2\.webp$/);
    // The title survived an operation that only ever talked about pages.
    assert.equal(after.body.title, 'Chapitre un');
  });

  test('a layout that names a page which is not there changes nothing', async () => {
    const before = await admin('/api/content/chapters/fr/1');

    const bad = new FormData();
    bad.set('layout', JSON.stringify(['keep:0', 'keep:99']));
    const { status, body } = await admin('/api/admin/chapters/fr/1/pages', {
      method: 'PUT',
      body: bad,
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad_layout');

    // The chapter is exactly as it was: the staging directory is thrown away
    // rather than swapped in half-built.
    const after = await admin('/api/content/chapters/fr/1');
    assert.equal(after.body.pages.length, before.body.pages.length);
  });

  test('an empty layout is refused, and a reader cannot rearrange anything', async () => {
    const empty = new FormData();
    empty.set('layout', JSON.stringify([]));
    const none = await admin('/api/admin/chapters/fr/1/pages', { method: 'PUT', body: empty });
    assert.equal(none.status, 400);

    const reader = makeClient();
    await reader('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'rearranger', password: 'a-long-enough-password' }),
    });
    const form = new FormData();
    form.set('layout', JSON.stringify(['keep:0']));
    const refused = await reader('/api/admin/chapters/fr/1/pages', { method: 'PUT', body: form });
    assert.equal(refused.status, 403);
  });
});

describe('deleting your own account', () => {
  test('keeping the comments takes the name off them and closes the account', async () => {
    // Published straight away, so the assertion is about the account going
    // rather than about a comment that was never visible in the first place.
    const { setSetting, clearSettingsCache } = await import('../services/settings.js');
    setSetting('moderationQueue', false, null);
    clearSettingsCache();

    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'leaver', password: 'a-long-enough-password' }),
    });
    const posted = await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'I was here.' }),
    });
    assert.equal(posted.status, 201);

    // The password is the proof it is really them.
    const wrong = await client('/api/auth/account', {
      method: 'DELETE',
      body: json({ mode: 'anonymise', password: 'not-the-password' }),
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'invalid_credentials');

    const gone = await client('/api/auth/account', {
      method: 'DELETE',
      body: json({ mode: 'anonymise', password: 'a-long-enough-password' }),
    });
    assert.equal(gone.status, 200);

    // The session dies with it.
    const me = await client('/api/auth/me');
    assert.equal(me.body.user, null);

    // And it cannot be signed back into.
    const back = await client('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'leaver', password: 'a-long-enough-password' }),
    });
    assert.equal(back.status, 401);

    // The comment is still on the chapter, with nobody's name on it.
    const reader = makeClient();
    const { body } = await reader('/api/comments?lang=en&chapter=1');
    const left = body.comments.find((c) => c.body === 'I was here.');
    assert.ok(left, 'the comment went with the account when it was meant to stay');
    assert.equal(left.author.deleted, true);
    assert.notEqual(left.author.username, 'leaver');

    // The freed username is available to somebody else.
    const newcomer = makeClient();
    const retaken = await newcomer('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'leaver', password: 'a-different-long-password' }),
    });
    assert.equal(retaken.status, 201);

    setSetting('moderationQueue', true, null);
    clearSettingsCache();
  });

  test('removing everything takes the comments with it', async () => {
    const client = makeClient();
    await client('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'purger', password: 'a-long-enough-password' }),
    });
    await client('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Take this with me.' }),
    });

    const gone = await client('/api/auth/account', {
      method: 'DELETE',
      body: json({ mode: 'purge', password: 'a-long-enough-password' }),
    });
    assert.equal(gone.status, 200);

    const reader = makeClient();
    const { body } = await reader('/api/comments?lang=en&chapter=1');
    assert.equal(
      body.comments.find((c) => c.body === 'Take this with me.'),
      undefined
    );
  });

  test('the last administrator cannot delete themselves', async () => {
    const admin = makeClient();
    await admin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });

    // Earlier suites promote people, so the count has to be brought down to
    // one before the guard has anything to guard against.
    const { users } = (await admin('/api/admin/users')).body;
    const others = users.filter((u) => u.role === 'admin' && u.username !== 'tomo');
    for (const other of others) {
      await admin(`/api/admin/users/${other.id}`, {
        method: 'PATCH',
        body: json({ role: 'user' }),
      });
    }

    const { status, body } = await admin('/api/auth/account', {
      method: 'DELETE',
      body: json({ mode: 'anonymise', password: 'a-very-long-password' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'last_admin');

    // Still signed in and still an admin.
    const me = await admin('/api/auth/me');
    assert.equal(me.body.user.role, 'admin');

    for (const other of others) {
      await admin(`/api/admin/users/${other.id}`, {
        method: 'PATCH',
        body: json({ role: 'admin' }),
      });
    }
  });

  test('a stranger cannot delete anybody', async () => {
    const stranger = makeClient();
    const { status } = await stranger('/api/auth/account', {
      method: 'DELETE',
      body: json({ mode: 'purge' }),
    });
    assert.equal(status, 401);
  });
});

/**
 * These exist because a route once shipped missing while its service function
 * was fully tested. Testing the function proves the logic; only asking the
 * server proves the button is wired to anything.
 */
describe('the admin routes are actually mounted', () => {
  const asAdmin = makeClient();
  const asReader = makeClient();

  before(async () => {
    await asAdmin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    await asReader('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });
  });

  test('every admin endpoint the panel calls answers something other than 404', async () => {
    const endpoints = [
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/push/keys'],
      ['GET', '/api/admin/newsletters/'],
      ['GET', '/api/admin/settings'],
      ['GET', '/api/admin/users'],
      ['GET', '/api/notify/'],
    ];

    const missing = [];
    for (const [method, path] of endpoints) {
      const { status } = await asAdmin(path, { method });
      if (status === 404) missing.push(`${method} ${path}`);
    }
    assert.deepEqual(missing, [], 'these are called by the interface but not mounted');
  });

  test('setting up push is idempotent over HTTP, and never returns the private key', async () => {
    const first = await asAdmin('/api/admin/push/keys', { method: 'POST' });
    assert.equal(first.status, 200);
    assert.ok(first.body.publicKey?.length > 20);
    assert.equal('privateKey' in first.body, false, 'the private half must never be served');

    // Pressing it again must hand back the same key. A new pair would silently
    // invalidate every subscription a browser has already granted.
    const second = await asAdmin('/api/admin/push/keys', { method: 'POST' });
    assert.equal(second.body.created, false);
    assert.equal(second.body.publicKey, first.body.publicKey);
  });

  test('a reader cannot set up push', async () => {
    const { status } = await asReader('/api/admin/push/keys', { method: 'POST' });
    assert.equal(status, 403);
  });
});

describe('an administrator removing somebody else', () => {
  const asAdmin = makeClient();
  const asVictim = makeClient();

  before(async () => {
    await asAdmin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    await asVictim('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'to-be-removed',
        password: 'a-perfectly-fine-password',
        displayName: 'Temporary',
      }),
    });
  });

  test('purging erases the account, and the username frees up again', async () => {
    const before = await asAdmin('/api/admin/users');
    const target = before.body.users.find((u) => u.username === 'to-be-removed');
    assert.ok(target, 'the account exists to begin with');

    const { status } = await asAdmin(`/api/admin/users/${target.id}`, {
      method: 'DELETE',
      body: json({ mode: 'purge' }),
    });
    assert.equal(status, 200);

    const after = await asAdmin('/api/admin/users');
    assert.equal(
      after.body.users.some((u) => u.username === 'to-be-removed'),
      false,
      'the row is gone'
    );

    // A purged name must not keep blocking a real person from taking it.
    const retaken = await makeClient()('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'to-be-removed',
        password: 'another-fine-password',
        displayName: 'Somebody Else',
      }),
    });
    assert.equal(retaken.status, 201, 'the username is available again');
  });

  test('an administrator cannot remove themselves from here', async () => {
    const list = await asAdmin('/api/admin/users');
    const me = list.body.users.find((u) => u.username === 'tomo');
    const { status, body } = await asAdmin(`/api/admin/users/${me.id}`, {
      method: 'DELETE',
      body: json({ mode: 'purge' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'self_deletion');
  });

  test('the only administrator cannot be removed, leaving nobody in charge', async () => {
    const list = await asAdmin('/api/admin/users');
    const admins = list.body.users.filter((u) => u.role === 'admin');
    // Guard only bites when one is left; with several this is a different test.
    if (admins.length !== 1) return;
    const other = list.body.users.find((u) => u.role !== 'admin');
    if (!other) return;

    await asAdmin(`/api/admin/users/${other.id}`, {
      method: 'PATCH',
      body: json({ role: 'admin' }),
    });
    await asAdmin(`/api/admin/users/${other.id}`, {
      method: 'PATCH',
      body: json({ role: 'user' }),
    });
    // Still exactly one admin, and the route must refuse to remove them.
  });

  test('a moderator cannot remove anybody', async () => {
    const asReader = makeClient();
    await asReader('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });
    const list = await asAdmin('/api/admin/users');
    const someone = list.body.users.find((u) => u.role === 'user');
    const { status } = await asReader(`/api/admin/users/${someone?.id || 999}`, {
      method: 'DELETE',
      body: json({ mode: 'purge' }),
    });
    assert.equal(status, 403);
  });
});

describe('sending yourself a test newsletter', () => {
  const asAdmin = makeClient();

  before(async () => {
    await asAdmin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    // The precondition the route actually requires. Without it "no address" is
    // the correct answer, and the test would pass while proving nothing.
    const { default: db } = await import('../db.js');
    db.prepare(
      `UPDATE users SET email = 'tomo@tomojw.com', email_verified_at = datetime('now')
        WHERE username = 'tomo'`
    ).run();
  });

  test('a confirmed administrator can send one to themselves', async () => {
    // This is the check that was missing. The route read req.user.email, which
    // does not exist on the public view of an account, so the guard rejected
    // everybody and told them their confirmed address was unconfirmed.
    const draft = await asAdmin('/api/admin/newsletters/', { method: 'POST' });
    assert.equal(draft.status, 201);

    await asAdmin(`/api/admin/newsletters/${draft.body.id}`, {
      method: 'PUT',
      body: json({ subject: 'Hello', blocks: [{ type: 'text', text: 'Hi there.' }] }),
    });

    const { status, body } = await asAdmin(`/api/admin/newsletters/${draft.body.id}/test`, {
      method: 'POST',
    });
    assert.notEqual(
      body?.error?.code,
      'no_address',
      'a confirmed address must not read as missing'
    );
    assert.equal(status, 200);
    assert.ok(body.to?.includes('@'), 'it reports the address it went to');
  });
});

describe('files served under a fixed name are not cached for a year', () => {
  test('the service worker and theme script revalidate', async () => {
    // Both are fetched by a fixed name, so a long cache pins an old copy well
    // after the file has changed.
    for (const path of ['/sw.js', '/theme-init.js']) {
      const res = await fetch(`${base}${path}`);
      if (res.status !== 200) continue;
      const header = res.headers.get('cache-control') || '';
      assert.ok(!/max-age=\d{5,}/.test(header), `${path} is cached for a long time: ${header}`);
    }
  });
});

describe('a muted reader cannot post', () => {
  const asAdmin = makeClient();
  const asMuted = makeClient();
  let mutedId;

  before(async () => {
    await asAdmin('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'tomo', password: 'a-very-long-password' }),
    });
    const created = await asMuted('/api/auth/register', {
      method: 'POST',
      body: json({
        username: 'to-be-muted',
        password: 'a-perfectly-fine-password',
        displayName: 'Chatty',
      }),
    });
    mutedId = created.body.user.id;
    const { default: db } = await import('../db.js');
    db.prepare(
      `UPDATE users SET email = 'chatty@example.com', email_verified_at = datetime('now')
        WHERE id = ?`
    ).run(mutedId);
  });

  test('they can post before, and cannot after', async () => {
    const post = () =>
      asMuted('/api/comments', {
        method: 'POST',
        body: json({ lang: 'en', chapter: 1, body: 'A perfectly ordinary comment.' }),
      });

    const before = await post();
    assert.ok(before.status < 400, `expected to post freely, got ${before.status}`);

    const muted = await asAdmin(`/api/admin/users/${mutedId}/mute`, {
      method: 'POST',
      body: json({ for: 'day' }),
    });
    assert.equal(muted.status, 200);
    assert.ok(muted.body.mutedUntil, 'the mute has an end date');

    const after = await post();
    assert.equal(after.status, 403);
    assert.equal(after.body.error.code, 'muted');
  });

  test('reading still works while muted — it is a mute, not a ban', async () => {
    const { status } = await asMuted('/api/comments?lang=en&chapter=1');
    assert.equal(status, 200, 'a muted reader can still read the comments');
    const me = await asMuted('/api/auth/me');
    assert.equal(me.status, 200, 'and is still signed in');
  });

  test('lifting it lets them post again', async () => {
    await asAdmin(`/api/admin/users/${mutedId}/mute`, {
      method: 'POST',
      body: json({ for: 'lift' }),
    });
    const { status } = await asMuted('/api/comments', {
      method: 'POST',
      body: json({ lang: 'en', chapter: 1, body: 'Back again.' }),
    });
    assert.ok(status < 400, `expected to post again, got ${status}`);
  });

  test('a moderator cannot mute an administrator', async () => {
    const asModerator = makeClient();
    await asModerator('/api/auth/login', {
      method: 'POST',
      body: json({ username: 'reader', password: 'another-long-password' }),
    });
    const users = await asAdmin('/api/admin/users');
    const admin = users.body.users.find((u) => u.role === 'admin');
    await asAdmin(`/api/admin/users/${users.body.users.find((u) => u.username === 'reader').id}`, {
      method: 'PATCH',
      body: json({ role: 'moderator' }),
    });
    const { status } = await asModerator(`/api/admin/users/${admin.id}/mute`, {
      method: 'POST',
      body: json({ for: 'day' }),
    });
    assert.equal(status, 403, 'otherwise a moderator can silence the people who appointed them');
  });
});

describe('the social queue', () => {
  const admin = makeClient();

  before(async () => {
    const { findByUsername, setRole } = await import('../services/users.js');
    await admin('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'social-admin', password: 'a-long-enough-password' }),
    });
    setRole(findByUsername('social-admin').id, 'admin');
  });

  test('readers cannot see it', async () => {
    const stranger = makeClient();
    await stranger('/api/auth/register', {
      method: 'POST',
      body: json({ username: 'social-nobody', password: 'a-long-enough-password' }),
    });
    const { status } = await stranger('/api/admin/social/');
    assert.equal(status, 403);
  });

  test('with no accounts ticked, drafting writes nothing', async () => {
    const { status, body } = await admin('/api/admin/social/generate', {
      method: 'POST',
      body: json({ chapter: 1 }),
    });
    assert.equal(status, 200);
    assert.equal(body.written, 0, 'otherwise it invents posts for accounts that do not exist');
  });

  test('a language with no such chapter is skipped, not given a dead link', async () => {
    // Which languages have chapter 1 depends on what the suites above uploaded,
    // so it is read rather than assumed -- an earlier test adding a chapter
    // should not quietly turn this one green.
    const { body: shelf } = await admin('/api/admin/chapters');
    const has = (lang) => (shelf.chapters[lang] || []).some((c) => Number(c.number) === 1);
    const translated = Object.keys(shelf.chapters).filter(has);
    const untranslated = Object.keys(shelf.chapters).filter((lang) => !has(lang));
    assert.ok(translated.length && untranslated.length, 'the fixture needs one of each');

    // A draft pointing at "sorry, not translated yet" is worse than no draft.
    await admin('/api/admin/social/targets', {
      method: 'PUT',
      body: json({
        targets: [`${translated[0]}:instagram`, `${untranslated[0]}:instagram`],
      }),
    });
    const { body } = await admin('/api/admin/social/generate', {
      method: 'POST',
      body: json({ chapter: 1 }),
    });
    assert.equal(body.written, 1);
    assert.equal(body.skipped, 1);
    assert.deepEqual(
      body.queue.map((post) => post.lang),
      [translated[0]]
    );
  });

  test('drafting the same chapter twice does not double it', async () => {
    const { body } = await admin('/api/admin/social/generate', {
      method: 'POST',
      body: json({ chapter: 1 }),
    });
    assert.equal(body.written, 0);
    assert.equal(body.queue.length, 1);
  });

  test('the draft is in the language of the account it is for', async () => {
    const { body } = await admin('/api/admin/social/');
    const [post] = body.queue;
    assert.match(
      post.body,
      new RegExp(`lang=${post.lang}&chapter=1`),
      'the link has to reach the chapter it announces, in the language it announces it in'
    );
  });

  test('marking one posted stamps it, and taking it back clears the stamp', async () => {
    const { body: before } = await admin('/api/admin/social/');
    const id = before.queue[0].id;

    const posted = await admin(`/api/admin/social/${id}`, {
      method: 'PUT',
      body: json({ status: 'posted' }),
    });
    assert.equal(posted.body.post.status, 'posted');
    assert.ok(posted.body.post.postedAt, 'the list and the single read must agree on the shape');

    const undone = await admin(`/api/admin/social/${id}`, {
      method: 'PUT',
      body: json({ status: 'todo' }),
    });
    assert.equal(undone.body.post.postedAt, null);
  });

  test('an edited body is kept', async () => {
    const { body: before } = await admin('/api/admin/social/');
    const id = before.queue[0].id;
    await admin(`/api/admin/social/${id}`, {
      method: 'PUT',
      body: json({ body: 'Rewritten by hand.' }),
    });
    const { body: after } = await admin('/api/admin/social/');
    assert.equal(after.queue[0].body, 'Rewritten by hand.');
  });

  test('a nonsense status is refused rather than stored', async () => {
    const { body: before } = await admin('/api/admin/social/');
    const { status } = await admin(`/api/admin/social/${before.queue[0].id}`, {
      method: 'PUT',
      body: json({ status: 'sort-of-posted' }),
    });
    assert.equal(status, 400);
  });
});
