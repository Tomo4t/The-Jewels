import 'dotenv/config';
import { resolve, isAbsolute } from 'node:path';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const abs = (value, fallback) => {
  const raw = value && String(value).trim() ? String(value).trim() : fallback;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
};

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Hosting platforms expose the service's public hostname. Using it saves the
 * operator from having to paste the URL back into the environment after the
 * first deploy — and getting it wrong would silently disable Secure cookies.
 */
const platformOrigin = () => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_HOSTNAME;
  return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
};

export const config = {
  isProduction,
  port: int(process.env.PORT, 3000),
  publicOrigin: (
    process.env.PUBLIC_ORIGIN ||
    platformOrigin() ||
    `http://localhost:${int(process.env.PORT, 3000)}`
  )
    .trim()
    .replace(/\/+$/, ''),

  databasePath: abs(process.env.DATABASE_PATH, './data/jewels.db'),
  contentDir: abs(process.env.CONTENT_DIR, './content'),
  // Read-only copy of the chapters committed to the repo. When CONTENT_DIR
  // points at a fresh, empty volume, this is what gets copied in on first boot.
  contentBaselineDir: abs(process.env.CONTENT_BASELINE_DIR, './content-baseline'),
  distDir: abs(process.env.DIST_DIR, './dist'),

  sessionSecret: process.env.SESSION_SECRET || '',
  sessionCookieName: 'jewels_session',
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),

  // Attempts allowed per 15 minutes on the credential endpoints. Configurable so
  // the test suite can exercise those routes freely without tripping it.
  authRateLimit: int(process.env.AUTH_RATE_LIMIT, 20),

  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  moderationQueue: bool(process.env.MODERATION_QUEUE, true),
  // Starting default only; an administrator can change this at runtime and the
  // stored value wins from then on.
  requireVerifiedEmail: bool(process.env.REQUIRE_VERIFIED_EMAIL, true),

  anthropicApiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
  moderationModel: (process.env.MODERATION_MODEL || 'claude-haiku-4-5').trim(),

  // Outbound email. Without a key nothing is sent and verification simply never
  // starts -- accounts still work, they just stay unverified.
  mail: {
    resendApiKey: (process.env.RESEND_API_KEY || '').trim(),
    from: (process.env.MAIL_FROM || 'The Jewels <onboarding@resend.dev>').trim(),
    verifyTtlHours: int(process.env.EMAIL_VERIFY_TTL_HOURS, 48),
    // Reset links are far more dangerous than verification links if they leak
    // from an inbox, so they live for hours rather than days.
    resetTtlHours: int(process.env.PASSWORD_RESET_TTL_HOURS, 2),
  },

  // Google sign-in. Without both halves the button stays hidden and the routes
  // report that it is not configured, rather than half-working.
  google: {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  },

  // Content rules
  languages: ['en', 'ja', 'pl', 'es', 'fr'],
  defaultLanguage: 'en',
  comment: {
    maxLength: 2000,
    minLength: 2,
    maxDepth: 1, // one level of replies
    editWindowMinutes: int(process.env.COMMENT_EDIT_WINDOW_MINUTES, 30),
  },
  upload: {
    maxFileBytes: int(process.env.UPLOAD_MAX_FILE_MB, 15) * 1024 * 1024,
    maxFiles: int(process.env.UPLOAD_MAX_FILES, 120),
    allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
  },
};

/** True when outbound email is configured well enough to send anything. */
export const mailEnabled = () => Boolean(config.mail.resendApiKey);

/** True when both halves of the Google OAuth client are present. */
export const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);

/** Absolute URL on the public site. */
export const absoluteUrl = (path) =>
  `${config.publicOrigin.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

/**
 * Origins the API will accept state-changing requests from.
 *
 * `publicOrigin` is the canonical site address, but a Railway service also keeps
 * answering on its `*.up.railway.app` hostname after a custom domain is attached,
 * and `EXTRA_ORIGINS` lets an operator allow a staging host without a redeploy of
 * the whole config. All three are normalised the same way.
 */
const normaliseOrigin = (value) => value.trim().replace(/\/+$/, '');

export const allowedOrigins = new Set(
  [
    config.publicOrigin,
    platformOrigin(),
    `http://localhost:${config.port}`,
    ...(process.env.EXTRA_ORIGINS || '').split(',').map(normaliseOrigin),
  ]
    .map(normaliseOrigin)
    .filter(Boolean)
);

/**
 * Fail fast on misconfiguration rather than booting something insecure.
 */
export function validateConfig() {
  const problems = [];

  if (config.isProduction) {
    if (!config.sessionSecret || config.sessionSecret.length < 32) {
      problems.push(
        'SESSION_SECRET must be set to at least 32 characters in production. ' +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
      );
    }
    if (config.sessionSecret === 'change-me-to-a-long-random-string') {
      problems.push('SESSION_SECRET is still the example value from .env.example.');
    }
    const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(
      config.publicOrigin
    );
    if (config.publicOrigin.startsWith('http://') && !isLocalOrigin) {
      problems.push(
        'PUBLIC_ORIGIN should use https:// in production so session cookies are secure.'
      );
    }
  }

  if (problems.length) {
    throw new Error(`Configuration error:\n  - ${problems.join('\n  - ')}`);
  }
}

export default config;
