/**
 * API client.
 *
 * Every content read has a static fallback: if the Express API cannot be
 * reached, the same information is assembled from the plain files under
 * /content. That keeps the reader working on a static host (or if the server
 * is down) — only accounts and comments need the API to exist.
 */

let apiReachable = null;

export class ApiError extends Error {
  constructor(status, code, message, details, { fromApi = true } = {}) {
    super(message || code || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    // False when the response did not carry this API's error envelope — i.e.
    // something other than our server answered (a static host's 404 page, a
    // proxy error page). Those are outages, not API rejections.
    this.fromApi = fromApi;
  }
}

async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
  const options = { method, credentials: 'same-origin', signal, headers: {} };

  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);
  apiReachable = true;

  if (raw) return response;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code || 'request_failed',
      error?.message || `Request failed (${response.status}).`,
      error?.details,
      { fromApi: !!error }
    );
  }

  return payload;
}

/** Runs an API call, falling back to static files when the server is absent. */
async function withFallback(apiCall, staticCall) {
  if (apiReachable === false) return staticCall();
  try {
    return await apiCall();
  } catch (err) {
    // A genuine answer from our API (validation error, not found, forbidden)
    // is a real result and must surface. Anything else — a network failure, or
    // a 404 page from a static host that has no API at all — means there is no
    // server here, so read the same content from the static files instead.
    if (err instanceof ApiError && err.fromApi) throw err;
    apiReachable = false;
    return staticCall();
  }
}

export const isApiAvailable = () => apiReachable !== false;

// --- static fallbacks -----------------------------------------------------

const fetchJSON = async (url) => {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};

async function staticConfig() {
  const cfg = await fetchJSON('/content/config.json');
  return { ...cfg, availableLanguages: Object.keys(cfg.languages || {}) };
}

async function staticChapters(lang) {
  const cfg = await staticConfig();
  const count = cfg.languages?.[lang]?.chapters || 0;
  const chapters = [];

  for (let n = 1; n <= count; n += 1) {
    try {
      const meta = await fetchJSON(`/content/chapters/${lang}/chapter${n}/meta.json`);
      const ext = meta.ext || 'jpg';
      chapters.push({
        number: n,
        title: meta.title || `Chapter ${n}`,
        description: meta.description || '',
        pages: Number(meta.pages) || 0,
        publishedAt: meta.publishedAt || null,
        cover: `/content/chapters/${lang}/chapter${n}/page0.${ext}`,
      });
    } catch {
      break;
    }
  }
  return { lang, chapters };
}

async function staticChapter(lang, number) {
  const meta = await fetchJSON(`/content/chapters/${lang}/chapter${number}/meta.json`);
  const ext = meta.ext || 'jpg';
  const total = Number(meta.pages) || 0;
  return {
    lang,
    number,
    title: meta.title || `Chapter ${number}`,
    description: meta.description || '',
    publishedAt: meta.publishedAt || null,
    pages: Array.from(
      { length: total },
      (_, i) => `/content/chapters/${lang}/chapter${number}/page${i}.${ext}`
    ),
    commentCount: 0,
  };
}

async function staticUpdates(lang) {
  const cfg = await staticConfig();
  const count = cfg.languages?.[lang]?.updates || 0;
  const updates = [];

  for (let i = 1; i <= count; i += 1) {
    try {
      const res = await fetch(`/content/updates/${lang}/${i}.txt`, { cache: 'no-cache' });
      if (!res.ok) continue;
      const raw = (await res.text()).replace(/\r\n/g, '\n').trim();
      if (!raw) continue;
      const [date = '', ...rest] = raw.split('\n');
      updates.push({ id: i, date: date.trim(), body: rest.join('\n').trim() });
    } catch {
      /* skip a missing file */
    }
  }

  return { lang, updates: updates.sort((a, b) => b.id - a.id) };
}

// --- public surface -------------------------------------------------------

export const api = {
  // content
  config: () =>
    withFallback(
      () => request('/api/content/config'),
      () => staticConfig()
    ),

  chapters: (lang) =>
    withFallback(
      () => request(`/api/content/chapters?lang=${encodeURIComponent(lang)}`),
      () => staticChapters(lang)
    ),

  chapter: (lang, number) =>
    withFallback(
      () => request(`/api/content/chapters/${encodeURIComponent(lang)}/${Number(number)}`),
      () => staticChapter(lang, number)
    ),

  updates: (lang) =>
    withFallback(
      () => request(`/api/content/updates?lang=${encodeURIComponent(lang)}`),
      () => staticUpdates(lang)
    ),

  // session
  me: () => request('/api/auth/me'),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: { username, password } }),
  register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // comments
  comments: (lang, chapter) =>
    request(`/api/comments?lang=${encodeURIComponent(lang)}&chapter=${Number(chapter)}`),
  postComment: (payload) => request('/api/comments', { method: 'POST', body: payload }),
  editComment: (id, body) =>
    request(`/api/comments/${Number(id)}`, { method: 'PATCH', body: { body } }),
  deleteComment: (id) => request(`/api/comments/${Number(id)}`, { method: 'DELETE' }),

  // moderation + admin
  moderationQueue: () => request('/api/comments/moderation/queue'),
  moderate: (id, action) =>
    request(`/api/comments/${Number(id)}/moderate`, { method: 'POST', body: { action } }),
  adminChapters: () => request('/api/admin/chapters'),
  adminUploadChapter: (formData) =>
    request('/api/admin/chapters', { method: 'POST', body: formData }),
  adminDeleteChapter: (lang, number) =>
    request(`/api/admin/chapters/${encodeURIComponent(lang)}/${Number(number)}`, {
      method: 'DELETE',
    }),
  adminUpdates: () => request('/api/admin/updates'),
  adminSaveUpdate: (payload) => request('/api/admin/updates', { method: 'POST', body: payload }),
  adminDeleteUpdate: (lang, id) =>
    request(`/api/admin/updates/${encodeURIComponent(lang)}/${Number(id)}`, { method: 'DELETE' }),
  adminUsers: () => request('/api/admin/users'),
  adminUpdateUser: (id, payload) =>
    request(`/api/admin/users/${Number(id)}`, { method: 'PATCH', body: payload }),
};

export default api;
