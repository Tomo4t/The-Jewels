import config, { mailEnabled } from '../config.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 8000;

const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/**
 * Send one message through Resend.
 *
 * Delivery is best-effort by design: email is a side channel here, not a gate
 * on anything, so a provider outage must never turn into a failed sign-up. The
 * caller gets a boolean and decides what to tell the user.
 */
async function send({ to, subject, html, text }) {
  if (!mailEnabled()) return { sent: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.mail.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: config.mail.from, to: [to], subject, html, text }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[email] ${res.status} from Resend: ${detail.slice(0, 300)}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.warn(`[email] send failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    return { sent: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** The one message the site sends. Plain text mirrors the HTML exactly. */
export function sendVerificationEmail({ to, displayName, link }) {
  const name = displayName || 'there';
  const hours = config.mail.verifyTtlHours;

  const text = [
    `Hi ${name},`,
    '',
    'Confirm this address to get the verified marker on your comments at The Jewels:',
    '',
    link,
    '',
    `The link works for ${hours} hours. If you did not create an account, ignore this — nothing happens until the link is opened.`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#fdf9ef;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c1e00">
  <div style="max-width:34rem;margin:0 auto;background:#fffdf8;border:1px solid #e0d5bd;border-radius:12px;padding:28px">
    <p style="margin:0 0 1rem">Hi ${escapeHTML(name)},</p>
    <p style="margin:0 0 1.4rem">Confirm this address to get the verified marker on your comments at The&nbsp;Jewels.</p>
    <p style="margin:0 0 1.4rem">
      <a href="${escapeHTML(link)}"
         style="display:inline-block;background:#d4af37;color:#2c1e00;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px">
        Confirm my email
      </a>
    </p>
    <p style="margin:0 0 1rem;font-size:.9rem;color:#7a5f30">
      Or paste this into your browser:<br>
      <span style="word-break:break-all">${escapeHTML(link)}</span>
    </p>
    <p style="margin:0;font-size:.9rem;color:#7a5f30">
      The link works for ${hours} hours. If you did not create an account, ignore this —
      nothing happens until the link is opened.
    </p>
  </div>
</body></html>`;

  return send({ to, subject: 'Confirm your email · The Jewels', html, text });
}

export default { sendVerificationEmail };
