import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import config, { validateConfig } from './config.js';
import { ensureContentSeeded } from './services/bootstrap.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { generalLimiter, requireSameOrigin } from './middleware/security.js';
import authRoutes from './routes/auth.js';
import contentRoutes from './routes/content.js';
import commentRoutes from './routes/comments.js';
import adminRoutes from './routes/admin.js';
import notifyRoutes from './routes/notify.js';
import newsletterRoutes from './routes/newsletter.js';

validateConfig();

// Must run before any route reads content: a freshly mounted volume is empty.
const seeding = ensureContentSeeded();
if (seeding.seeded) console.log(`[content] ${seeding.reason}`);

const app = express();

// Behind a reverse proxy (Caddy, nginx, Fly, Railway) so rate limiting and
// secure cookies see the real client address and scheme.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // i.ytimg.com is for the newsletter preview only: a video block sends
        // the real YouTube thumbnail, and the preview has to show what the
        // email will show.
        imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com'],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.publicOrigin.startsWith('https://') ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use(attachUser);

// --- API ------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.use('/api', generalLimiter, requireSameOrigin);
app.use('/api/auth', authRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notify', notifyRoutes);
app.use('/api/admin/newsletters', newsletterRoutes);

// --- published content ----------------------------------------------------
// Chapter images and update files. Served with a long cache because uploads
// always write new chapter directories rather than overwriting existing pages.

app.use(
  '/content',
  express.static(config.contentDir, {
    index: false,
    dotfiles: 'ignore',
    maxAge: '7d',
    setHeaders: (res, path) => {
      // config.json changes on every publish, so it must not be cached hard.
      if (path.endsWith('config.json')) res.setHeader('Cache-Control', 'public, max-age=30');
    },
  })
);

// --- frontend -------------------------------------------------------------

const hasBuild = existsSync(join(config.distDir, 'index.html'));

if (hasBuild) {
  app.use(
    express.static(config.distDir, {
      index: false,
      maxAge: '1y',
      setHeaders: (res, path) => {
        // A year is right for hashed asset names, where a change means a new
        // name. It is wrong for everything shipped under a fixed name, because
        // a year is how long a browser would keep serving the old one.
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
          return;
        }
        // The service worker is the worst case: it decides how push behaves and
        // is fetched by its own fixed name, so a cached copy pins that
        // behaviour long after the file changed. theme-init runs before paint
        // and sets the theme, so a stale copy is visible immediately.
        if (/\/(sw|theme-init)\.js$/.test(path)) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  app.get('/admin', (_req, res) => res.sendFile(join(config.distDir, 'admin.html')));
  app.head('/admin', (_req, res) => res.sendFile(join(config.distDir, 'admin.html')));

  // SPA fallback: anything that is not an API or content path renders the app.
  // HEAD is included so health checks and crawlers do not get a 404.
  app.use((req, res, next) => {
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (!readOnly || req.path.startsWith('/api/') || req.path.startsWith('/content/')) {
      next();
      return;
    }
    res.sendFile(join(config.distDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('The frontend has not been built yet.\n\nRun:  npm run build\n');
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

export const frontendIsBuilt = hasBuild;
export default app;
