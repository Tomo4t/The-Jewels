import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import config from '../config.js';
import { getSecret, setSecret } from './secrets.js';

/**
 * Just enough Google Drive to put a backup somewhere safe.
 *
 * The scope is `drive.file`, deliberately: it grants access only to files this
 * application itself created. The site can list and delete its own backups and
 * nothing else in the Drive it is connected to -- so the worst an attacker with
 * the stored token could do is read or remove the backups, not read everything
 * else in there.
 *
 * The refresh token is obtained through the admin panel and kept in the
 * database rather than an environment variable, so nobody has to copy a
 * credential between two web consoles by hand.
 */

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const REFRESH_TOKEN_KEY = 'drive.refresh_token';
export const FOLDER_KEY = 'drive.folder_id';

/** Credentials come from the environment; the token is earned at runtime. */
export function driveConfigured() {
  return Boolean(config.googleDrive.clientId && config.googleDrive.clientSecret);
}

export function driveConnected() {
  return Boolean(getSecret(REFRESH_TOKEN_KEY));
}

export const redirectUri = () => `${config.publicOrigin}/api/admin/drive/callback`;

export function consentUrl(state) {
  const url = new URL(AUTH);
  url.searchParams.set('client_id', config.googleDrive.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  // offline + consent is what actually returns a refresh token. Without
  // `prompt=consent` Google gives one only on the very first authorisation, so
  // reconnecting later would hand back an access token and nothing durable.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

async function googleJSON(url, init, what) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* Google answers with HTML on some failures; the text is the message */
  }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error_description || body?.error || text;
    throw new Error(`${what} failed (${response.status}): ${String(detail).slice(0, 300)}`);
  }
  return body;
}

/** Trades the one-time code from the consent screen for a lasting refresh token. */
export async function exchangeCode(code) {
  const body = await googleJSON(
    TOKEN,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleDrive.clientId,
        client_secret: config.googleDrive.clientSecret,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    },
    'Google sign-in'
  );

  if (!body.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove the site from your Google ' +
        'account permissions and connect again.'
    );
  }
  setSecret(REFRESH_TOKEN_KEY, body.refresh_token);
  return body.refresh_token;
}

// Access tokens last an hour. Held in memory only: a restart just fetches
// another one, and it is never worth writing a short-lived secret to disk.
let cached = { token: '', expiresAt: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const refresh = getSecret(REFRESH_TOKEN_KEY);
  if (!refresh) throw new Error('Google Drive is not connected.');

  const body = await googleJSON(
    TOKEN,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refresh,
        client_id: config.googleDrive.clientId,
        client_secret: config.googleDrive.clientSecret,
        grant_type: 'refresh_token',
      }),
    },
    'Google token refresh'
  );

  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return cached.token;
}

/** Forgets the connection -- used when Google rejects the stored token. */
export function disconnect() {
  cached = { token: '', expiresAt: 0 };
  setSecret(REFRESH_TOKEN_KEY, '');
}

const auth = async () => ({ authorization: `Bearer ${await accessToken()}` });

/**
 * The folder backups go into, created once and remembered.
 *
 * Under `drive.file` the application cannot see a folder somebody else made, so
 * it makes its own. It lands at the top level of the connected Drive and can be
 * moved anywhere afterwards -- Drive keeps the id.
 */
export async function backupFolder() {
  const remembered = getSecret(FOLDER_KEY);
  if (remembered) {
    try {
      const found = await googleJSON(
        `${FILES}/${remembered}?fields=id,trashed`,
        { headers: await auth() },
        'Drive folder lookup'
      );
      if (!found.trashed) return remembered;
    } catch {
      // Deleted, or belongs to a Drive we are no longer connected to. Fall
      // through and make a new one rather than failing every backup forever.
    }
  }

  const created = await googleJSON(
    `${FILES}?fields=id`,
    {
      method: 'POST',
      headers: { ...(await auth()), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'The Jewels backups',
        mimeType: 'application/vnd.google-apps.folder',
      }),
    },
    'Drive folder creation'
  );
  setSecret(FOLDER_KEY, created.id);
  return created.id;
}

/**
 * Uploads a file with a resumable session.
 *
 * Multipart would be fewer round trips, but Google caps it at 5MB and a chapter
 * archive passes that the moment there is a real comic in it.
 */
export async function upload(path, name, mimeType = 'application/gzip') {
  const parent = await backupFolder();
  const size = (await stat(path)).size;

  const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,name,size`, {
    method: 'POST',
    headers: {
      ...(await auth()),
      'content-type': 'application/json',
      'x-upload-content-type': mimeType,
      'x-upload-content-length': String(size),
    },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  if (!start.ok) {
    throw new Error(`Drive upload could not start (${start.status}): ${await start.text()}`);
  }

  const session = start.headers.get('location');
  if (!session) throw new Error('Drive did not return an upload session.');

  const sent = await fetch(session, {
    method: 'PUT',
    headers: { 'content-type': mimeType, 'content-length': String(size) },
    body: createReadStream(path),
    duplex: 'half',
  });
  if (!sent.ok) {
    throw new Error(`Drive upload failed (${sent.status}): ${(await sent.text()).slice(0, 300)}`);
  }
  return sent.json();
}

/** Backups already in the folder, newest first. */
export async function list() {
  const parent = await backupFolder();
  const query = encodeURIComponent(`'${parent}' in parents and trashed = false`);
  const body = await googleJSON(
    `${FILES}?q=${query}&orderBy=createdTime desc&pageSize=100` +
      '&fields=files(id,name,size,createdTime)',
    { headers: await auth() },
    'Drive listing'
  );
  return body.files || [];
}

export async function remove(id) {
  const response = await fetch(`${FILES}/${id}`, { method: 'DELETE', headers: await auth() });
  // 404 means somebody deleted it by hand, which is the state we wanted anyway.
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not delete an old backup (${response.status}).`);
  }
}

/** Who we are connected to, for the admin panel. */
export async function account() {
  const body = await googleJSON(
    'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)',
    { headers: await auth() },
    'Drive account lookup'
  );
  return body.user || null;
}
