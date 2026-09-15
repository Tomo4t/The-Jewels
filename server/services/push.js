import webpush from 'web-push';
import db, { audit } from '../db.js';
import config from '../config.js';

/**
 * Browser push.
 *
 * Free to send at any volume, which is the whole appeal next to email: a
 * thousand readers cost the same as one. The catch is reach. On iPhone a push
 * subscription only exists once the reader has added the site to their home
 * screen, so the switch in the interface has to say that rather than quietly
 * doing nothing for everybody on Safari.
 *
 * Keys are a pair: the public half goes to the browser, the private half signs
 * each message so the push service knows the site sent it. Losing them means
 * every existing subscription is dead, which is why they live in the
 * environment rather than being generated on boot.
 */

export const pushConfigured = () => Boolean(config.push.publicKey && config.push.privateKey);

let ready = false;

function configure() {
  if (ready || !pushConfigured()) return pushConfigured();
  webpush.setVapidDetails(
    config.push.subject || `mailto:noreply@${new URL(config.publicOrigin).hostname}`,
    config.push.publicKey,
    config.push.privateKey
  );
  ready = true;
  return true;
}

// --- subscriptions ---------------------------------------------------------

export function saveSubscription(userId, subscription) {
  const endpoint = String(subscription?.endpoint || '');
  const p256dh = String(subscription?.keys?.p256dh || '');
  const auth = String(subscription?.keys?.auth || '');
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    throw new Error('That is not a usable push subscription.');
  }

  // A browser hands out the same endpoint again when it re-subscribes, and it
  // can move between accounts on a shared device -- so the endpoint is the key
  // and the owner is overwritten.
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
                                         p256dh = excluded.p256dh,
                                         auth = excluded.auth,
                                         failures = 0`
  ).run(endpoint, userId, p256dh, auth);
  audit(userId, 'push.subscribed', 'user', userId);
  return subscriptionCount(userId);
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || ''));
}

export function removeAllFor(userId) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
}

export const subscriptionCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;

// --- sending ---------------------------------------------------------------

const forget = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
const countFailure = db.prepare(
  'UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?'
);

/**
 * Sends to every device this reader has registered.
 *
 * A 404 or 410 from the push service is definitive: that subscription is gone
 * for good, and the row is deleted rather than retried forever. Anything else
 * is counted, and a subscription that has failed repeatedly is dropped too --
 * an endpoint that has not worked in a long time is not going to start.
 */
export async function pushToUser(userId, payload) {
  if (!configure()) return { sent: 0 };

  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  const body = JSON.stringify(payload);
  let sent = 0;

  for (const row of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { TTL: 60 * 60 * 24 }
      );
      sent += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) forget.run(row.endpoint);
      else {
        countFailure.run(row.endpoint);
        if (row.failures >= 5) forget.run(row.endpoint);
      }
    }
  }
  return { sent };
}

export const pushSummary = () => ({
  configured: pushConfigured(),
  publicKey: config.push.publicKey || null,
  devices: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,
});
