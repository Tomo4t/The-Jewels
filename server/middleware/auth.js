import config from '../config.js';
import { ApiError } from './errors.js';
import { resolveSession, toPublicUser } from '../services/users.js';

const ROLE_RANK = { user: 1, moderator: 2, admin: 3 };

/** Attaches req.user (or null) from the session cookie. Never throws. */
export function attachUser(req, _res, next) {
  const token = req.cookies?.[config.sessionCookieName];
  const row = token ? resolveSession(token) : null;
  req.sessionToken = token || null;
  req.userRow = row || null;
  req.user = toPublicUser(row);
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  if (req.user.status === 'banned') {
    next(ApiError.forbidden('account_banned', 'This account has been suspended.'));
    return;
  }
  next();
}

/** Route guard for a minimum role. `requireRole('moderator')` allows admins too. */
export function requireRole(minimumRole) {
  const needed = ROLE_RANK[minimumRole];
  return (req, _res, next) => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }
    if ((ROLE_RANK[req.user.role] || 0) < needed) {
      next(ApiError.forbidden());
      return;
    }
    next();
  };
}

export const isModerator = (user) => !!user && (user.role === 'moderator' || user.role === 'admin');
export const isAdmin = (user) => !!user && user.role === 'admin';

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.publicOrigin.startsWith('https://'),
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  };
}
