import { Router } from 'express';
import { z } from 'zod';
import config, { absoluteUrl, googleEnabled, mailEnabled } from '../config.js';
import { getSetting } from '../services/settings.js';
import { audit } from '../db.js';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { authLimiter } from '../middleware/security.js';
import { attachUser, requireAuth, sessionCookieOptions } from '../middleware/auth.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email.js';
import {
  USERNAME_RE,
  EMAIL_RE,
  MIN_PASSWORD_LENGTH,
  consumeOAuthState,
  countUsers,
  createEmailToken,
  createOAuthState,
  createSession,
  createUser,
  destroySession,
  findByEmail,
  findByGoogleSub,
  findById,
  findByUsername,
  linkGoogle,
  markEmailVerified,
  latestPendingAddress,
  normaliseEmail,
  peekEmailToken,
  redeemEmailToken,
  redeemResetToken,
  setPassword,
  destroyAllSessionsForUser,
  verifiedHolderOf,
  setEmail,
  suggestUsername,
  toPrivateUser,
  verifyPassword,
} from '../services/users.js';

const router = Router();

const credentials = z.object({
  username: z
    .string()
    .trim()
    .regex(USERNAME_RE, '3–24 characters: letters, numbers, underscore or hyphen.'),
  password: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters.`),
  displayName: z.string().trim().min(1).max(40).optional(),
  email: z
    .string()
    .trim()
    .max(254)
    .regex(EMAIL_RE, 'That does not look like an email address.')
    .optional()
    .or(z.literal('')),
});

const parse = (schema, payload) => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest('validation_failed', issue.message, {
      field: issue.path.join('.') || undefined,
    });
  }
  return result.data;
};

/** Who am I? Cheap, cacheable-by-nobody, used on every page load. */
router.get(
  '/me',
  asyncRoute(async (req, res) => {
    const full = req.user ? findById(req.user.id) : null;
    res.json({
      user: full ? toPrivateUser(full) : null,
      registrationOpen: getSetting('allowRegistration'),
      moderationQueue: getSetting('moderationQueue'),
      requireVerifiedEmail: getSetting('requireVerifiedEmail'),
      // The sign-in page hides what is not configured rather than offering a
      // button that would only ever return an error.
      googleSignIn: googleEnabled(),
      emailVerification: mailEnabled(),
    });
  })
);

router.post(
  '/register',
  authLimiter,
  asyncRoute(async (req, res) => {
    if (!getSetting('allowRegistration')) {
      throw ApiError.forbidden('registration_closed', 'New sign-ups are currently closed.');
    }

    const { username, password, displayName, email } = parse(credentials, req.body);
    const address = normaliseEmail(email);

    if (findByUsername(username)) {
      throw ApiError.conflict('username_taken', 'That username is already taken.');
    }
    // Only a confirmed holder blocks the address. One sitting unclaimed on an
    // account that never confirmed it is up for grabs by whoever proves
    // ownership, so it is left off this account until the link is opened.
    if (address && verifiedHolderOf(address)) {
      throw ApiError.conflict('email_taken', 'That email is already on another account.');
    }
    const contested = Boolean(address) && Boolean(findByEmail(address));

    // The very first account to exist becomes the administrator, so a fresh
    // deployment is usable without shell access.
    const role = countUsers() === 0 ? 'admin' : 'user';

    const user = await createUser({
      username,
      password,
      displayName,
      role,
      email: contested ? null : address,
    });
    const token = createSession(user.id, req.get('user-agent'));
    res.cookie(config.sessionCookieName, token, sessionCookieOptions());

    audit(user.id, 'user.register', 'user', user.id, { role, email: Boolean(address) });

    const verification = await startVerification(user, address);
    res.status(201).json({ user: toPrivateUser(findById(user.id)), verification });
  })
);

router.post(
  '/login',
  authLimiter,
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      throw ApiError.badRequest('validation_failed', 'Username and password are required.');
    }

    const user = findByUsername(username);
    const ok = await verifyPassword(user, password);

    if (!ok) {
      throw ApiError.unauthorized('invalid_credentials', 'That username or password is not right.');
    }
    if (user.status === 'banned') {
      throw ApiError.forbidden('account_banned', 'This account has been suspended.');
    }

    const token = createSession(user.id, req.get('user-agent'));
    res.cookie(config.sessionCookieName, token, sessionCookieOptions());
    res.json({ user: toPrivateUser(user) });
  })
);

router.post(
  '/logout',
  asyncRoute(async (req, res) => {
    if (req.sessionToken) destroySession(req.sessionToken);
    res.clearCookie(config.sessionCookieName, { ...sessionCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  })
);

router.post(
  '/password',
  requireAuth,
  authLimiter,
  asyncRoute(async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const nextPassword = String(req.body?.newPassword || '');

    if (nextPassword.length < MIN_PASSWORD_LENGTH) {
      throw ApiError.badRequest(
        'validation_failed',
        `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      );
    }

    const { setPassword, destroyAllSessionsForUser, findById } =
      await import('../services/users.js');
    const row = findById(req.user.id);
    if (!(await verifyPassword(row, currentPassword))) {
      throw ApiError.unauthorized('invalid_credentials', 'Your current password is not right.');
    }

    await setPassword(req.user.id, nextPassword);
    destroyAllSessionsForUser(req.user.id);

    const token = createSession(req.user.id, req.get('user-agent'));
    res.cookie(config.sessionCookieName, token, sessionCookieOptions());
    audit(req.user.id, 'user.password_changed', 'user', req.user.id);
    res.json({ ok: true });
  })
);

/**
 * Issues a verification link and mails it.
 *
 * Never throws: an account with no address, or a mail provider having a bad
 * afternoon, must not turn a successful registration into a failure. The return
 * value tells the caller what actually happened so the UI can be honest about it.
 */
async function startVerification(user, addressOverride = null) {
  // `addressOverride` carries a claim: an address that is not on the account
  // yet because somebody else is holding it unconfirmed. The link is still sent
  // there, and redeeming it is what moves the address across.
  const address = normaliseEmail(addressOverride) || user.email;
  if (!address) return { status: 'no_email', claiming: false };

  const claiming = address !== user.email;
  if (!mailEnabled()) return { status: 'not_configured', claiming };

  const token = createEmailToken(user.id, address, 'verify');
  const link = absoluteUrl(`/api/auth/verify?token=${encodeURIComponent(token)}`);
  const result = await sendVerificationEmail({
    to: address,
    displayName: user.display_name,
    link,
  });

  return { status: result.sent ? 'sent' : 'send_failed', claiming };
}

/**
 * Redeems a verification link.
 *
 * A GET the user reaches by clicking in their mail client, so it answers with a
 * redirect into the app rather than JSON. Every failure lands on the same
 * screen: the reasons are not usefully distinguishable to the person, and
 * spelling them out would tell a stranger whether a token existed.
 */
router.get(
  '/verify',
  asyncRoute(async (req, res) => {
    const result = redeemEmailToken(String(req.query.token || ''));
    if (result) {
      audit(result.user.id, 'user.email_verified', 'user', result.user.id, {
        claimedFrom: result.displaced.length ? result.displaced : undefined,
      });
    }
    res.redirect(302, absoluteUrl(`/#profile?verified=${result ? '1' : '0'}`));
  })
);

router.post(
  '/verify/resend',
  requireAuth,
  authLimiter,
  asyncRoute(async (req, res) => {
    const user = findById(req.user.id);
    const address = user.email || latestPendingAddress(user.id);

    if (!address) {
      throw ApiError.badRequest('no_email', 'Add an email address first.');
    }
    if (user.email === address && user.email_verified_at) {
      return res.json({ status: 'already_verified' });
    }
    const verification = await startVerification(user, address);
    res.json(verification);
  })
);

/** Set or change the address on the signed-in account. */
router.put(
  '/email',
  requireAuth,
  authLimiter,
  asyncRoute(async (req, res) => {
    const address = normaliseEmail(req.body?.email);
    if (!address || !EMAIL_RE.test(address)) {
      throw ApiError.badRequest('validation_failed', 'That does not look like an email address.', {
        field: 'email',
      });
    }

    const confirmedHolder = verifiedHolderOf(address);
    if (confirmedHolder && confirmedHolder.id !== req.user.id) {
      throw ApiError.conflict('email_taken', 'That email is already on another account.');
    }

    const holder = findByEmail(address);
    const contested = Boolean(holder) && holder.id !== req.user.id;

    // A contested address is not written to the account. The link is sent to it
    // and redeeming that link is what moves it -- so typing somebody else's
    // address never takes it from them on its own.
    if (!contested) {
      setEmail(req.user.id, address);
      audit(req.user.id, 'user.email_changed', 'user', req.user.id);
    }

    const verification = await startVerification(findById(req.user.id), address);
    res.json({ user: toPrivateUser(findById(req.user.id)), verification });
  })
);

// --- forgotten passwords ---------------------------------------------------

/**
 * Starts a password reset.
 *
 * Always answers the same way. Saying whether an address has an account turns
 * this endpoint into a way of testing which of your users exist, and the person
 * who legitimately forgot their password learns nothing extra from being told.
 */
router.post(
  '/password/forgot',
  authLimiter,
  asyncRoute(async (req, res) => {
    // Whether mail is configured is a property of the deployment, so it is
    // settled before anything about the submitted address is looked at --
    // otherwise the reply would differ between a known and an unknown address.
    if (!mailEnabled()) return res.json({ status: 'not_configured' });

    const address = normaliseEmail(req.body?.email);
    const answer = { status: 'sent' };
    if (!address || !EMAIL_RE.test(address)) return res.json(answer);

    const user = verifiedHolderOf(address);
    // Unconfirmed addresses are deliberately excluded: anyone can type an
    // address they do not own, and a reset link sent to one would be a way of
    // taking over an account by having typed its owner's address first.
    if (!user) return res.json(answer);

    const token = createEmailToken(user.id, address, 'reset');
    await sendPasswordResetEmail({
      to: address,
      displayName: user.display_name,
      link: absoluteUrl(`/#reset?token=${encodeURIComponent(token)}`),
    });
    audit(user.id, 'user.password_reset_requested', 'user', user.id);
    res.json(answer);
  })
);

/** Lets the reset page tell a live link from a dead one before asking for a password. */
router.get(
  '/password/reset',
  asyncRoute(async (req, res) => {
    const row = peekEmailToken(String(req.query.token || ''), 'reset');
    res.json({ valid: Boolean(row) });
  })
);

router.post(
  '/password/reset',
  authLimiter,
  asyncRoute(async (req, res) => {
    const nextPassword = String(req.body?.password || '');
    if (nextPassword.length < MIN_PASSWORD_LENGTH) {
      throw ApiError.badRequest(
        'validation_failed',
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        { field: 'password' }
      );
    }

    const user = redeemResetToken(String(req.body?.token || ''));
    if (!user) {
      throw ApiError.badRequest('invalid_token', 'That reset link is invalid or has expired.');
    }

    await setPassword(user.id, nextPassword);
    // Anyone already signed in as this account is signed out: if the reset was
    // needed because somebody else had got in, leaving their session alive
    // would defeat the point.
    destroyAllSessionsForUser(user.id);
    audit(user.id, 'user.password_reset', 'user', user.id);

    const token = createSession(user.id, req.get('user-agent'));
    res.cookie(config.sessionCookieName, token, sessionCookieOptions());
    res.json({ user: toPrivateUser(findById(user.id)) });
  })
);

// --- Google sign-in -------------------------------------------------------

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REDIRECT = () => absoluteUrl('/api/auth/google/callback');

const requireGoogle = () => {
  if (!googleEnabled()) {
    throw ApiError.badRequest('google_not_configured', 'Google sign-in is not set up.');
  }
};

router.get(
  '/google',
  authLimiter,
  asyncRoute(async (req, res) => {
    requireGoogle();
    const state = createOAuthState(typeof req.query.next === 'string' ? req.query.next : null);

    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', GOOGLE_REDIRECT());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(302, url.toString());
  })
);

/**
 * Reads the claims out of an ID token.
 *
 * The token arrived over TLS straight from Google's token endpoint, in exchange
 * for our client secret, so the transport already establishes provenance and
 * Google's own guidance allows skipping signature verification on this path.
 * The registered claims are still checked, because those guard against a token
 * minted for a different application or one that has expired.
 */
function claimsFromIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const issuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!issuers.includes(claims.iss)) return null;
  if (claims.aud !== config.google.clientId) return null;
  if (!claims.exp || claims.exp * 1000 <= Date.now()) return null;
  if (!claims.sub) return null;
  return claims;
}

router.get(
  '/google/callback',
  authLimiter,
  asyncRoute(async (req, res) => {
    requireGoogle();

    const fail = (reason) => res.redirect(302, absoluteUrl(`/#signin?google=${reason}`));

    // The user pressed Cancel on Google's consent screen.
    if (req.query.error) return fail('cancelled');

    const stateRow = consumeOAuthState(String(req.query.state || ''));
    if (!stateRow) return fail('expired');

    const code = String(req.query.code || '');
    if (!code) return fail('failed');

    let tokens;
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: GOOGLE_REDIRECT(),
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!tokenRes.ok) {
        console.warn(`[google] token exchange returned ${tokenRes.status}`);
        return fail('failed');
      }
      tokens = await tokenRes.json();
    } catch (err) {
      console.warn(`[google] token exchange failed: ${err.message}`);
      return fail('failed');
    }

    const claims = claimsFromIdToken(tokens.id_token);
    if (!claims) return fail('failed');

    const email = normaliseEmail(claims.email);
    const emailVerified = Boolean(claims.email_verified) && Boolean(email);

    // 1. Known Google identity.
    let user = findByGoogleSub(claims.sub);

    // 2. An existing local account with the same address. Only ever linked when
    //    Google says it verified that address -- otherwise anyone could claim
    //    someone else's account by signing up to Google with their email.
    if (!user && emailVerified) {
      const byEmail = findByEmail(email);
      if (byEmail) {
        user = linkGoogle(byEmail.id, claims.sub);
        if (!byEmail.email_verified_at) markEmailVerified(byEmail.id);
        audit(user.id, 'user.google_linked', 'user', user.id);
      }
    }

    // 3. Nobody yet: make an account. It has no password, so it can only ever
    //    be reached back through Google.
    if (!user) {
      if (!getSetting('allowRegistration')) return fail('registration_closed');
      const username = suggestUsername(claims.name || (email ? email.split('@')[0] : ''));
      const role = countUsers() === 0 ? 'admin' : 'user';
      user = await createUser({
        username,
        password: null,
        displayName: claims.name || username,
        role,
        email: emailVerified ? email : null,
        emailVerified,
        googleSub: claims.sub,
      });
      audit(user.id, 'user.register', 'user', user.id, { role, via: 'google' });
    }

    if (user.status === 'banned') return fail('banned');

    const token = createSession(user.id, req.get('user-agent'));
    res.cookie(config.sessionCookieName, token, sessionCookieOptions());
    res.redirect(302, absoluteUrl(stateRow.redirect_to || '/#home'));
  })
);

export { attachUser };
export default router;
