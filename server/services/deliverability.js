import { promises as dns } from 'node:dns';

/**
 * Is there any point sending to this address?
 *
 * Every message costs a credit with the mail provider, and the two commonest
 * reasons one is wasted are a mistyped domain ("gmial.com") and a domain that
 * simply cannot receive mail. Both are visible from DNS before a single send,
 * and catching them here also gives the person a far better error than silence
 * followed by a link that never arrives.
 *
 * What this CANNOT do is tell you whether the mailbox exists. Asking the mail
 * server directly -- connecting and offering the address -- is unreliable
 * (most servers accept anything and bounce later) and a good way to get the
 * sending IP blocked. So the promise here is narrow and honest: the domain is
 * real and something is listening for its mail.
 */

const TIMEOUT_MS = 4000;

// Domains typed a hundred times a day are the ones that get typed wrong.
const COMMON = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'yandex.com',
  'tomojw.com',
];

/** Levenshtein, bounded: anything past `limit` edits away is not a typo. */
function distance(a, b, limit = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/** The well-known domain this one was probably meant to be, if any. */
export function suggestDomain(domain) {
  if (COMMON.includes(domain)) return null;
  let best = null;
  let bestScore = 3;
  for (const known of COMMON) {
    const score = distance(domain, known);
    if (score < bestScore) {
      bestScore = score;
      best = known;
    }
  }
  return bestScore <= 2 ? best : null;
}

// Domains repeat constantly -- a hundred readers on gmail.com is one lookup.
const cache = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

const withTimeout = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), TIMEOUT_MS)),
  ]);

/**
 * Can this domain take mail at all?
 *
 * An MX record is the normal answer. Its absence is not proof of nothing: the
 * mail RFCs say a domain with only an address record still accepts mail there,
 * and a few small domains rely on exactly that -- so the A/AAAA fallback is
 * required, not a nicety.
 */
async function domainAcceptsMail(domain) {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  let result;
  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    // A single "." host is the explicit null MX of RFC 7505: this domain is
    // saying, in so many words, that it accepts no mail.
    const usable = mx.filter((record) => record.exchange && record.exchange !== '.');
    result = usable.length ? { ok: true } : { ok: false, reason: 'no_mail_server' };
  } catch (err) {
    if (err.message === 'dns_timeout') {
      // Fail open. A slow resolver is our problem, not the reader's, and
      // refusing a sign-up over it would be far worse than one wasted credit.
      return { ok: true, unchecked: true };
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      try {
        await withTimeout(dns.resolve(domain));
        result = { ok: true };
      } catch (fallback) {
        result =
          fallback.code === 'ENOTFOUND' || fallback.code === 'ENODATA'
            ? { ok: false, reason: 'no_such_domain' }
            : { ok: true, unchecked: true };
      }
    } else {
      result = { ok: true, unchecked: true };
    }
  }

  if (!result.unchecked) cache.set(domain, { at: Date.now(), result });
  return result;
}

/**
 * The whole check. Returns { ok } or { ok: false, reason, suggestion }.
 * `reason` is for the caller to turn into a message; `suggestion` is the
 * domain the person probably meant.
 */
export async function checkDeliverable(address) {
  const at = String(address || '').lastIndexOf('@');
  if (at < 1) return { ok: false, reason: 'malformed' };

  const domain = address.slice(at + 1).toLowerCase();
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || !domain.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }

  // A near-miss on a domain that does exist is still almost certainly a typo:
  // "gmail.co" resolves perfectly well and is not where anyone meant to be
  // reached. So the suggestion is checked before the DNS answer is trusted.
  const suggestion = suggestDomain(domain);
  if (suggestion) return { ok: false, reason: 'likely_typo', suggestion };

  const result = await domainAcceptsMail(domain);
  return result.ok
    ? { ok: true, unchecked: result.unchecked }
    : { ok: false, reason: result.reason };
}

/** Test seam: lets the suite run without touching a real resolver. */
export const _cache = cache;
