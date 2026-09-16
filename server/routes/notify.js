import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { findById } from '../services/users.js';
import {
  KINDS,
  mailLanguages,
  preferencesFor,
  readUnsubscribeToken,
  setMailLanguages,
  setPreference,
} from '../services/notifications.js';
import {
  pushConfigured,
  pushSummary,
  removeAllFor,
  removeSubscription,
  saveSubscription,
  subscriptionCount,
} from '../services/push.js';
import config from '../config.js';

const router = Router();

const state = (userId) => ({
  preferences: preferencesFor(userId),
  languages: mailLanguages(userId),
  allLanguages: config.languages,
  push: {
    configured: pushConfigured(),
    publicKey: pushConfigured() ? pushSummary().publicKey : null,
    devices: subscriptionCount(userId),
  },
});

router.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => res.json(state(req.user.id)))
);

/**
 * Turning a notification on or off.
 *
 * A confirmed address is required to turn anything on -- not merely an address
 * on the account. An unconfirmed one may belong to somebody else entirely, and
 * signing that person up for mail they never asked for is exactly how a domain
 * ends up in spam folders.
 */
router.put(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = z.object({ kind: z.enum(KINDS), on: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('invalid', 'That is not a setting.');

    const { kind, on } = parsed.data;
    const user = findById(req.user.id);

    if (on && !(user?.email && user.email_verified_at)) {
      throw ApiError.badRequest(
        'email_not_confirmed',
        'Confirm your email address first, then you can turn this on.',
        { field: 'email' }
      );
    }

    setPreference(req.user.id, kind, on);
    res.json(state(req.user.id));
  })
);

/**
 * Which languages this reader wants mail about.
 *
 * Deliberately not gated on a confirmed address the way the switches above are.
 * This narrows what somebody receives rather than starting anything, so there
 * is nobody to protect from it -- and a reader halfway through confirming
 * should still be able to say "French only" before the first mail arrives.
 */
router.put(
  '/languages',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ languages: z.array(z.string().max(8)).max(20) })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('invalid', 'That is not a language list.');

    setMailLanguages(req.user.id, parsed.data.languages);
    res.json(state(req.user.id));
  })
);

/**
 * Leaving, from a link in an email.
 *
 * No sign-in, by design: somebody unsubscribing is often reading an old message
 * on a device they were never signed in on, and making them log in first is how
 * you get marked as spam instead. The token is signed, so it proves who sent it
 * without anybody having to prove who they are.
 *
 * POST exists because Gmail and Outlook show their own one-click unsubscribe
 * button when a message carries the List-Unsubscribe headers, and they press it
 * with a POST that no human ever sees.
 */
const unsubscribe = (req, res) => {
  const claim = readUnsubscribeToken(req.query.token || req.body?.token);
  if (claim) setPreference(claim.userId, claim.kind, false, claim.userId);

  if (req.method === 'POST') {
    res.status(claim ? 200 : 400).json({ ok: Boolean(claim) });
    return;
  }
  res.redirect(
    302,
    `${config.publicOrigin}/#profile?unsubscribed=${claim ? claim.kind : 'failed'}`
  );
};

router.get(
  '/unsubscribe',
  asyncRoute(async (req, res) => unsubscribe(req, res))
);
router.post(
  '/unsubscribe',
  asyncRoute(async (req, res) => unsubscribe(req, res))
);

// --- push ------------------------------------------------------------------

router.post(
  '/push',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!pushConfigured()) {
      throw ApiError.badRequest('push_not_configured', 'Push notifications are not set up.');
    }
    try {
      saveSubscription(req.user.id, req.body?.subscription);
    } catch (err) {
      throw ApiError.badRequest('invalid_subscription', err.message);
    }
    res.json(state(req.user.id));
  })
);

router.delete(
  '/push',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.body?.endpoint) removeSubscription(req.body.endpoint);
    else removeAllFor(req.user.id);
    res.json(state(req.user.id));
  })
);

export default router;
