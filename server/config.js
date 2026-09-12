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

  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  moderationQueue: bool(process.env.MODERATION_QUEUE, true),

  anthropicApiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
  moderationModel: (process.env.MODERATION_MODEL || 'claude-haiku-4-5').trim(),

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
