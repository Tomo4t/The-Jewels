import { Router } from 'express';
import { z } from 'zod';
import config from '../config.js';
import { audit } from '../db.js';
import { ApiError, asyncRoute } from '../middleware/errors.js';
import { authLimiter } from '../middleware/security.js';
import { attachUser, requireAuth, sessionCookieOptions } from '../middleware/auth.js';
import {
  USERNAME_RE,
  MIN_PASSWORD_LENGTH,
  countUsers,
  createSession,
  createUser,
  destroySession,
  findByUsername,
  toPublicUser,
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
    res.json({
      user: req.user,
      registrationOpen: config.allowRegistration,
      moderationQueue: config.moderationQueue,
    });
  })
);

router.post(
  '/register',
  authLimiter,
  asyncRoute(async (req, res) => {
    if (!config.allowRegistration) {
      throw ApiError.forbidden('registration_closed', 'New sign-ups are currently closed.');
    }

    const { username, password, displayName } = parse(credentials, req.body);

    if (findByUsername(username)) {
      throw ApiError.conflict('username_taken', 'That username is already taken.');
    }

    // The very first account to exist becomes the administrator, so a fresh
    // deployment is usable without shell access.
    const role = countUsers() === 0 ? 'admin' : 'user';

    const user = await createUser({ username, password, displayName, role });
    const token = createSession(user.id, req.get('user-agent'));
    res.cookie(config.sessionCookieName, token, sessionCookieOptions());

    audit(user.id, 'user.register', 'user', user.id, { role });
    res.status(201).json({ user: toPublicUser(user) });
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
    res.json({ user: toPublicUser(user) });
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

export { attachUser };
export default router;
