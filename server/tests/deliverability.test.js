import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDeliverable, suggestDomain } from '../services/deliverability.js';

/**
 * The DNS half of this is deliberately not exercised here.
 *
 * A test that needs a live resolver fails on an aeroplane and, worse, fails in
 * whatever CI runner happens to block outbound DNS -- and a red suite nobody
 * trusts is worse than a thinner one. What is covered is everything decided
 * before a lookup happens, which is where the typos live, plus the promise that
 * matters most: a resolver that misbehaves must never block a sign-up.
 */

test('the common providers are recognised as themselves', () => {
  for (const good of ['gmail.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'tomojw.com']) {
    assert.equal(suggestDomain(good), null, `${good} should not be "corrected"`);
  }
});

test('near misses on the big providers are caught', () => {
  const cases = [
    ['gmial.com', 'gmail.com'],
    ['gmai.com', 'gmail.com'],
    ['gmail.con', 'gmail.com'],
    ['gmail.co', 'gmail.com'],
    ['hotmial.com', 'hotmail.com'],
    ['hotmail.co', 'hotmail.com'],
    ['outlok.com', 'outlook.com'],
    ['yaho.com', 'yahoo.com'],
    ['iclould.com', 'icloud.com'],
    ['tomojw.co', 'tomojw.com'],
  ];
  for (const [typo, meant] of cases) {
    assert.equal(suggestDomain(typo), meant, `${typo} should suggest ${meant}`);
  }
});

test('an unrelated domain is not mistaken for a typo', () => {
  // The cost of a false positive is high: it refuses a real address and tells
  // the person their own email is wrong. Nothing here is within two edits of a
  // listed provider.
  for (const real of [
    'anthropic.com',
    'proton.me',
    'fastmail.com',
    'company-mail.co.uk',
    'nic.ad.jp',
    'riseup.net',
  ]) {
    assert.equal(suggestDomain(real), null, `${real} should be left alone`);
  }
});

test('addresses that are not addresses are refused without a lookup', async () => {
  for (const bad of ['', 'not-an-email', 'reader@', '@gmail.com', 'reader@localhost', 'a@b']) {
    const verdict = await checkDeliverable(bad);
    assert.equal(verdict.ok, false, `${bad || '(empty)'} should be refused`);
    assert.equal(verdict.reason, 'malformed');
  }
});

test('a typo is caught before any DNS lookup is attempted', async () => {
  // Proven by the clock: a real lookup cannot finish in under a millisecond,
  // and "gmail.co" resolves perfectly well, so only an early return explains
  // both the verdict and the speed.
  const started = process.hrtime.bigint();
  const verdict = await checkDeliverable('reader@gmail.co');
  const microseconds = Number(process.hrtime.bigint() - started) / 1000;

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'likely_typo');
  assert.equal(verdict.suggestion, 'gmail.com');
  assert.ok(microseconds < 2000, `took ${microseconds}µs, which means it hit the network`);
});

test('a resolver that cannot answer lets the sign-up through', async (t) => {
  // The whole point of the check is to save a credit. Spending one is a far
  // smaller harm than refusing somebody an account because our DNS was slow,
  // so every inconclusive answer has to come back ok.
  const dns = await import('node:dns');
  const original = dns.promises.resolveMx;

  for (const failure of [
    Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }),
    Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('server failure'), { code: 'SERVFAIL' }),
  ]) {
    dns.promises.resolveMx = async () => {
      throw failure;
    };
    const verdict = await checkDeliverable(`reader@some-domain-${Math.random()}.example`);
    assert.equal(verdict.ok, true, `${failure.code} should not block a sign-up`);
  }

  dns.promises.resolveMx = original;
  t.diagnostic('resolver restored');
});
