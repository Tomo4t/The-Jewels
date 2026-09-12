# The Jewels

A multilingual webcomic reader with accounts, threaded comments, moderation and
an admin panel for publishing chapters.

- **Frontend** — vanilla JavaScript modules, bundled by Vite. No framework.
- **Backend** — Express 5 serving both the API and the built site from one origin.
- **Database** — SQLite (accounts, sessions, comments, audit log).
- **Content** — chapters and updates are plain files on disk, so the site can
  still be served by any static host if the server is ever taken away.

Languages: English, 日本語, Polski, Español, Français.

---

## Quick start

```bash
npm install
cp .env.example .env          # then edit it — SESSION_SECRET is required in production
npm run build                 # build the frontend into dist/
npm start                     # http://localhost:3000
```

The **first account you register becomes the administrator**, so open the site,
sign up, and you have access to `/admin`. To create or recover an admin from the
command line instead:

```bash
npm run seed:admin -- --username tomo --password "a long password"
```

### Development

```bash
npm run dev
```

Runs the API on `:3000` and Vite with hot reload on `:5173`, proxying `/api` and
`/content` through to the server. Use `http://localhost:5173` while developing.

| Command              | What it does                       |
| -------------------- | ---------------------------------- |
| `npm run dev`        | API + Vite dev server together     |
| `npm run build`      | Build the frontend into `dist/`    |
| `npm start`          | Run the production server          |
| `npm test`           | API integration tests (28 of them) |
| `npm run lint`       | ESLint over the whole project      |
| `npm run format`     | Prettier                           |
| `npm run seed:admin` | Create or promote an administrator |

---

## Configuration

Everything lives in `.env` — see `.env.example` for the annotated list.

| Variable             | Default                 | Notes                                             |
| -------------------- | ----------------------- | ------------------------------------------------- |
| `PORT`               | `3000`                  |                                                   |
| `PUBLIC_ORIGIN`      | `http://localhost:3000` | Must be `https://` in production                  |
| `SESSION_SECRET`     | —                       | **Required in production.** 32+ random characters |
| `DATABASE_PATH`      | `./data/jewels.db`      |                                                   |
| `CONTENT_DIR`        | `./content`             | Where chapters and updates are read and written   |
| `ALLOW_REGISTRATION` | `true`                  | `false` closes public sign-ups                    |
| `MODERATION_QUEUE`   | `true`                  | `false` publishes comments immediately            |
| `ANTHROPIC_API_KEY`  | _empty_                 | Optional — enables the AI moderation pass         |
| `MODERATION_MODEL`   | `claude-haiku-4-5`      |                                                   |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Deployment

### Railway (recommended — no server administration)

Railway builds straight from the `Dockerfile` and gives the service a public
HTTPS URL. `railway.json` already sets the builder and the health check.

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app), create a project from the repo.
3. Add a **Volume** to the service with mount path **`/data`**. This is the
   single most important step — it holds the database and every uploaded
   chapter. Without it, both are wiped on every redeploy.
4. Set one variable: `SESSION_SECRET`. Everything else has a sensible default,
   and `PUBLIC_ORIGIN` is detected from Railway's own domain.
5. Generate a public domain for the service and open it.
6. Register — the first account becomes the administrator.

Hobby is the cheapest plan that keeps a service always on with a volume.

### Docker anywhere else

```bash
cp .env.example .env    # set SESSION_SECRET
docker compose up -d --build
```

One named volume, `jewels-data`, is mounted at `/data` and holds both the
database and the uploaded chapters. **Back it up.** Uploaded chapters are not in
git; only the baseline content committed to the repo is.

Put it behind a reverse proxy that terminates TLS (Caddy, nginx, or a platform
that does it for you). The app sets `trust proxy`, so the client address and
scheme come through correctly for rate limiting and secure cookies.

### Bare Node

`npm ci && npm run build && npm start` behind the same kind of proxy, with a
process manager such as systemd or pm2.

### First boot

On a fresh volume the server copies the chapters committed to the repo into
`CONTENT_DIR` once, then leaves it alone forever. A redeploy never overwrites
content you have uploaded.

---

## Publishing content

Everything happens in `/admin`.

**Chapters.** Pick a language and chapter number, give it a title, then drag the
page images in. They are ordered by filename and can be dragged to reorder.
On publish each page is re-encoded to WebP at up to 1800px wide, written to
`content/chapters/<lang>/chapter<n>/`, and `config.json` is rebuilt from what is
actually on disk. Uploads land in a staging directory and are only swapped in
once every page has processed, so a failure halfway through cannot leave a
half-published chapter.

**Updates.** A date and a message per language, stored as
`content/updates/<lang>/<n>.txt` — the same format the site has always used.

---

## Accounts, comments and moderation

Three roles:

| Role        | Can                                                                  |
| ----------- | -------------------------------------------------------------------- |
| `user`      | Comment, reply, edit and delete their own comments                   |
| `moderator` | Everything above, plus the moderation queue and deleting any comment |
| `admin`     | Everything, plus chapters, updates and user management               |

Comments nest one level deep. Authors can edit their own for 30 minutes
(`COMMENT_EDIT_WINDOW_MINUTES`). Deleting is a soft delete so replies keep their
place in the thread.

### Automatic flagging

Every comment is screened before it becomes visible. Nothing is ever
auto-deleted or auto-rejected — the worst outcome is that a comment waits in the
moderation queue with a reason attached.

**Stage 1 — rule-based.** Always on, no key or network needed. Scores link
density, shouting, repeated characters, invisible characters, repetitive text,
known commercial-spam phrases, posting velocity, duplicate posts, and brand-new
accounts posting links.

**Stage 2 — Claude.** Only runs if `ANTHROPIC_API_KEY` is set. Each comment gets
a moderation pass returning a severity and categories. The comment text is
passed as data inside delimiters and the model is told to ignore instructions
inside it. The call has an 8-second timeout and **fails open** — if the API is
down or slow, stage 1 still applies and the comment section keeps working.

Anything scoring 0.4 or higher goes to the queue. With `MODERATION_QUEUE=true`
everything goes to the queue regardless.

---

## Project layout

```
server/            Express API
  app.js             app construction (importable by tests)
  index.js           listens
  config.js          env parsing + fail-fast validation
  db.js              SQLite schema, pruning, audit log
  middleware/        auth, errors, rate limiting, origin checks
  routes/            auth, content, comments, admin
  services/          users, comments, content, moderation
  tests/             integration tests
src/                 Frontend
  main.js            bootstrap
  router.js          hash router
  lib/               api client, i18n, session, theme, sound, storage, particles
  components/        navbar, comments, toast
  pages/             home, chapters, reader, contact, auth, 404
  admin/             admin panel
  i18n/              en, ja, pl, es, fr
  styles/            tokens.css first, then base and per-page sheets
content/             Chapters, updates, config.json (server reads and writes)
public/              Static assets copied as-is (images, audio, favicon)
```

### Why the filesystem holds the content

Chapters and updates stay as ordinary files rather than database rows. That
keeps published content cacheable, git-friendly and portable: the frontend falls
back to reading `/content` directly when the API cannot be reached, so the comic
still reads on a plain static host. Only accounts and comments — the things that
genuinely cannot be static — live in SQLite.

---

## Security notes

- Passwords hashed with bcrypt (cost 12).
- Session tokens are random; only their SHA-256 is stored, so a leaked database
  cannot be replayed as live sessions. Cookies are `httpOnly` + `SameSite=Strict`,
  and `Secure` whenever `PUBLIC_ORIGIN` is `https://`.
- Mutating requests are origin-checked; rate limits apply to auth, comments and
  uploads.
- A strict Content Security Policy with no `unsafe-inline` for scripts — which is
  why the anti-flash theme script is a separate file, `public/theme-init.js`.
- Uploads are type- and size-checked, re-encoded through sharp (which strips
  metadata), and every write path is checked to stay inside `CONTENT_DIR`.
- Moderation and admin actions are recorded in an audit log.
- `npm audit --omit=dev` reports zero vulnerabilities.
