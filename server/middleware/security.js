import rateLimit from 'express-rate-limit';
import config, { allowedOrigins } from '../config.js';
import { ApiError } from './errors.js';

/**
 * Same-origin guard for state-changing requests.
 *
 * The session cookie is SameSite=Strict, which already blocks cross-site form
 * posts; this rejects anything whose Origin header disagrees with the site, so
 * a stray CORS-enabled client cannot drive the API either.
 */
export function requireSameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (!origin) {
    // Non-browser clients (curl, tests) send no Origin. The cookie policy still
    // protects real browsers, so allow these through.
    next();
    return;
  }

  const allowed = new Set(allowedOrigins);
  if (!config.isProduction) {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }

  if (!allowed.has(origin.replace(/\/+$/, ''))) {
    next(ApiError.forbidden('bad_origin', 'Request origin is not allowed.'));
    return;
  }
  next();
}

const limiter = (windowMs, max, code, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, code, message)),
  });

/** Brute-force protection on credential endpoints. */
export const authLimiter = limiter(
  15 * 60 * 1000,
  20,
  'auth_rate_limited',
  'Too many attempts. Please wait a few minutes and try again.'
);

/** Stops comment flooding independently of the per-user velocity check. */
export const commentLimiter = limiter(
  10 * 60 * 1000,
  30,
  'comment_rate_limited',
  'You are posting too quickly. Please slow down.'
);

/** Uploads are expensive; keep them bounded even for admins. */
export const uploadLimiter = limiter(
  60 * 60 * 1000,
  60,
  'upload_rate_limited',
  'Too many uploads in the last hour.'
);

/** A generous ceiling for everything else. */
export const generalLimiter = limiter(
  15 * 60 * 1000,
  1000,
  'rate_limited',
  'Too many requests. Please slow down.'
);
