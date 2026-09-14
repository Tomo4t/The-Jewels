import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeArchive, walk } from '../services/archive.js';

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function scratch() {
  return mkdtemp(join(tmpdir(), 'jewels-backup-test-'));
}

test('the archive round-trips through real tar, byte for byte', async (t) => {
  const dir = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const src = join(dir, 'src');
  await mkdir(join(src, 'en/chapter-01'), { recursive: true });
  await mkdir(join(src, 'ja/chapter-01'), { recursive: true });

  const files = {
    // 513 bytes forces the 512-byte block padding to be right; a length that
    // lands exactly on a block boundary would not catch an off-by-one there.
    'en/chapter-01/page0.jpg': randomBytes(513),
    'en/chapter-01/page1.jpg': Buffer.alloc(0),
    'en/meta.json': Buffer.from('{"title":"Chapter One"}'),
    'ja/chapter-01/ページ-01.jpg': randomBytes(4096),
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(src, name), body);

  const names = await walk(src);
  assert.equal(names.length, 4, 'walk found every file');

  const archive = join(dir, 'out.tar.gz');
  const size = await writeArchive(
    archive,
    names.map((name) => ({ path: join(src, name), name: `jewels-backup/${name}` }))
  );
  assert.ok(size > 0);

  const out = join(dir, 'out');
  await mkdir(out, { recursive: true });
  // Real tar, not our own reader: an archive only this code can read is not a
  // backup, it is a hostage.
  execFileSync('tar', ['xzf', archive, '-C', out]);

  for (const [name, body] of Object.entries(files)) {
    const restored = await readFile(join(out, 'jewels-backup', name));
    assert.equal(sha(restored), sha(body), `${name} came back unchanged`);
  }
});

test('a path too long for ustar is still archived', async (t) => {
  const dir = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const deep = Array.from({ length: 9 }, (_, i) => `very-long-directory-name-${i}`).join('/');
  const src = join(dir, 'src');
  await mkdir(join(src, deep), { recursive: true });
  const body = Buffer.from('still here');
  await writeFile(join(src, deep, 'buried.txt'), body);

  const archive = join(dir, 'long.tar.gz');
  const names = await walk(src);
  assert.ok(`jewels-backup/${names[0]}`.length > 256, 'the path really does exceed the ustar limit');

  await writeArchive(
    archive,
    names.map((name) => ({ path: join(src, name), name: `jewels-backup/${name}` }))
  );

  const out = join(dir, 'out');
  await mkdir(out, { recursive: true });
  execFileSync('tar', ['xzf', archive, '-C', out]);
  const restored = await readFile(join(out, 'jewels-backup', names[0]));
  assert.equal(restored.toString(), body.toString());
});

test('a backup of a live database restores to a working database', async (t) => {
  const dir = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // WAL, as the real database runs. Copying the file by hand in this mode is
  // exactly the mistake this test exists to rule out: the committed rows can
  // live in the -wal sidecar, so a plain file copy restores a database that is
  // missing them, or is corrupt outright.
  const livePath = join(dir, 'live.db');
  const live = new Database(livePath);
  live.pragma('journal_mode = WAL');
  live.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, note TEXT)');
  const add = live.prepare('INSERT INTO users (username, note) VALUES (?, ?)');
  for (let i = 0; i < 500; i += 1) add.run(`reader-${i}`, randomBytes(40).toString('hex'));

  const expected = live.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const sample = live.prepare('SELECT * FROM users WHERE id = 250').get();

  // Snapshot while the database is still open and being written to.
  const snapshot = join(dir, 'snapshot.db');
  const writing = setInterval(() => add.run(`late-${Date.now()}`, 'x'), 1);
  await live.backup(snapshot);
  clearInterval(writing);

  const archive = join(dir, 'db.tar.gz');
  await writeArchive(archive, [{ path: snapshot, name: 'jewels-backup/jewels.db' }]);

  const out = join(dir, 'out');
  await mkdir(out, { recursive: true });
  execFileSync('tar', ['xzf', archive, '-C', out]);

  const restored = new Database(join(out, 'jewels-backup', 'jewels.db'), { readonly: true });
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  const count = restored.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  assert.ok(count >= expected, `restored ${count} rows, expected at least ${expected}`);
  assert.deepEqual(restored.prepare('SELECT * FROM users WHERE id = 250').get(), sample);

  restored.close();
  live.close();
});

test('two runs over unchanged files produce identical archives', async (t) => {
  const dir = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const src = join(dir, 'src');
  await mkdir(join(src, 'b'), { recursive: true });
  await writeFile(join(src, 'b/two.txt'), 'two');
  await writeFile(join(src, 'a.txt'), 'one');

  const names = await walk(src);
  // Sorted, so the archive does not churn just because the filesystem handed
  // the directory back in a different order.
  assert.deepEqual(names, ['a.txt', 'b/two.txt']);

  const entries = names.map((name) => ({ path: join(src, name), name }));
  await writeArchive(join(dir, 'one.tar.gz'), entries);
  await writeArchive(join(dir, 'two.tar.gz'), entries);

  assert.equal(
    sha(await readFile(join(dir, 'one.tar.gz'))),
    sha(await readFile(join(dir, 'two.tar.gz')))
  );
});

test('walk returns nothing for a content directory that does not exist yet', async () => {
  assert.deepEqual(await walk(join(tmpdir(), 'jewels-nope-' + Date.now())), []);
});
