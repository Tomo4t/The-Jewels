import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The browser half of the site has no test runner of its own, and that gap has
 * already cost twice: a translation key that was never added shows up as raw
 * "admin.news.sendToAll" on the page, and a window.confirm that the browser had
 * decided to suppress turned the "send the newsletter" button into one that did
 * nothing at all and explained nothing.
 *
 * Neither needs a browser to catch. Both are visible in the source, so they are
 * checked here, in the suite that already runs.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANGUAGES = ['en', 'fr', 'es', 'ja', 'pl'];

const load = (code) =>
  JSON.parse(fs.readFileSync(path.join(root, 'src/i18n', `${code}.json`), 'utf8'));

function flatten(value, prefix = '') {
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child))
      out.push(...flatten(child, `${prefix}${key}.`));
    else out.push(`${prefix}${key}`);
  }
  return out;
}

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'i18n') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return files;
}

test('every language defines exactly the same keys', () => {
  const english = flatten(load('en')).sort();
  for (const code of LANGUAGES.slice(1)) {
    const other = flatten(load(code)).sort();
    assert.deepEqual(
      other.filter((key) => !english.includes(key)),
      [],
      `${code}.json has keys English does not`
    );
    assert.deepEqual(
      english.filter((key) => !other.includes(key)),
      [],
      `${code}.json is missing keys English has`
    );
  }
});

test('every key the interface asks for actually exists', () => {
  // Only literal t('some.key') calls. A key built at runtime -- t(`kind_${x}`)
  // -- cannot be resolved from the source, so it is left to the eye.
  const pattern = /\bt\(\s*'([^']+)'/g;
  const dictionaries = Object.fromEntries(LANGUAGES.map((code) => [code, load(code)]));
  const missing = [];

  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, key] of source.matchAll(pattern)) {
      for (const code of LANGUAGES) {
        const value = key
          .split('.')
          .reduce((node, part) => (node ? node[part] : undefined), dictionaries[code]);
        if (typeof value !== 'string') {
          missing.push(`${path.relative(root, file)} asks for ${key}, missing from ${code}.json`);
        }
      }
    }
  }

  assert.deepEqual(missing, []);
});

test('nothing asks a question through the browser any more', () => {
  // window.confirm and window.prompt are suppressible: Chrome offers "prevent
  // this page from creating additional dialogs" and remembers it, and a
  // suppressed confirm returns false. Anything guarded by one silently stops
  // happening. confirmDialog and chooseDialog in src/components/modal.js ask in
  // the page instead.
  const offenders = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, name] of source.matchAll(/\bwindow\.(confirm|prompt|alert)\s*\(/g)) {
      offenders.push(`${path.relative(root, file)} calls window.${name}()`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no handler reads event.currentTarget after awaiting', () => {
  // Dispatch is over by the time an async handler resumes, so currentTarget is
  // null and the line throws where nobody is looking -- which is how buttons
  // end up disabled for good. Capture the element before the first await.
  const offenders = [];
  for (const file of sourceFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let awaited = false;
    let depth = null;
    lines.forEach((line, index) => {
      if (/addEventListener\(\s*'[^']+',\s*async/.test(line)) {
        awaited = false;
        depth = 0;
      }
      if (depth === null) return;
      depth += (line.match(/[({[]/g) || []).length - (line.match(/[)}\]]/g) || []).length;
      if (awaited && /event\.currentTarget/.test(line)) {
        offenders.push(`${path.relative(root, file)}:${index + 1}`);
      }
      if (/\bawait\b/.test(line)) awaited = true;
      if (depth <= 0) depth = null;
    });
  }
  assert.deepEqual(offenders, []);
});
