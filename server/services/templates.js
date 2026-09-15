import config from '../config.js';

/**
 * Turning blocks into an email.
 *
 * Email clients are not browsers. Gmail strips <style> blocks it dislikes,
 * Outlook renders through Word, and flexbox and grid are simply absent in both
 * -- so the layout here is nested tables with inline styles, which is ugly and
 * is also the only thing that survives. Every colour is literal for the same
 * reason: a CSS variable resolves to nothing in an inbox.
 */

const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const INK = '#2c1e00';
const MUTED = '#6f5a34';
const PAPER = '#fffdf8';
const BACKDROP = '#f3ece0';
const ACCENT = '#8a6d1f';

/** Only http(s) links survive. `javascript:` in an href is not a link. */
function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw).toString();
  } catch {
    return null;
  }
}

/**
 * The inline formatting a text block may carry.
 *
 * Everything is escaped first and the marks are applied to the escaped text, so
 * a block can never introduce markup of its own. It is a short list on purpose:
 * the author gets bold, italic and links, and no way to hand an inbox a script
 * tag even by accident.
 */
function inline(text) {
  let out = escapeHTML(text);
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const url = safeUrl(href);
    return url
      ? `<a href="${escapeHTML(url)}" style="color:${ACCENT};text-decoration:underline;">${label}</a>`
      : whole;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

const row = (content) => `<tr><td style="padding:0 28px;">${content}</td></tr>`;

const BLOCKS = {
  heading: (block) =>
    row(
      `<h2 style="margin:26px 0 8px;font:600 20px/1.3 Georgia,'Times New Roman',serif;color:${INK};">${escapeHTML(
        block.text
      )}</h2>`
    ),

  text: (block) =>
    row(
      String(block.text || '')
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim())
        .map(
          (paragraph) =>
            `<p style="margin:0 0 14px;font:400 16px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">${inline(
              paragraph.trim()
            ).replace(/\n/g, '<br>')}</p>`
        )
        .join('')
    ),

  /**
   * An image, optionally a link. Width is set as an attribute as well as in
   * the style, because Outlook reads the attribute and ignores the style; and
   * the alt text matters more than usual, since most clients hide images until
   * the reader asks for them.
   */
  image: (block) => {
    const src = safeUrl(block.src) || (block.src?.startsWith('/') ? absolute(block.src) : null);
    if (!src) return '';
    const img =
      `<img src="${escapeHTML(src)}" alt="${escapeHTML(block.alt || '')}" width="540" ` +
      `style="display:block;width:100%;max-width:540px;height:auto;border-radius:8px;border:0;">`;
    const href = safeUrl(block.href);
    return row(
      `<div style="margin:0 0 16px;">${href ? `<a href="${escapeHTML(href)}">${img}</a>` : img}</div>`
    );
  },

  /**
   * A link that looks like a button. It is a table cell with a background
   * rather than a styled <a>, because Outlook will not paint padding or a
   * background on an inline element.
   */
  button: (block) => {
    const href = safeUrl(block.href);
    if (!href || !block.label) return '';
    return row(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;">
         <tr><td align="center" bgcolor="${ACCENT}" style="border-radius:8px;">
           <a href="${escapeHTML(href)}"
              style="display:inline-block;padding:12px 26px;font:600 15px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#fffdf8;text-decoration:none;">
             ${escapeHTML(block.label)}
           </a>
         </td></tr>
       </table>`
    );
  },

  divider: () =>
    row(`<div style="border-top:1px solid #e2d8c2;margin:22px 0;line-height:0;">&nbsp;</div>`),

  chapter: (block) => {
    const href = absolute(`/#reader?lang=${block.lang || 'en'}&chapter=${block.number}&page=0`);
    return row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
              style="margin:6px 0 20px;background:${BACKDROP};border-radius:10px;">
         <tr><td style="padding:18px 20px;">
           <p style="margin:0 0 4px;font:600 12px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">
             Chapter ${escapeHTML(block.number)}
           </p>
           <p style="margin:0 0 12px;font:600 18px/1.3 Georgia,'Times New Roman',serif;color:${INK};">
             ${escapeHTML(block.title || '')}
           </p>
           <a href="${escapeHTML(href)}" style="font:600 15px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${ACCENT};">
             Read it &rarr;
           </a>
         </td></tr>
       </table>`
    );
  },
};

const absolute = (path) => `${config.publicOrigin}${path}`;

// --- plain text ------------------------------------------------------------

/**
 * The text half is written, not stripped from the HTML.
 *
 * Some people read in plain text, some clients show it, and spam filters treat
 * a message with no text part as a small red flag -- so it is worth being a
 * real alternative rather than tag soup with the tags removed.
 */
const TEXT = {
  heading: (b) => `\n${b.text}\n${'-'.repeat(Math.min(40, String(b.text || '').length))}`,
  text: (b) =>
    String(b.text || '')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2'),
  image: (b) => (b.alt ? `[image: ${b.alt}]` : ''),
  button: (b) => (b.href ? `${b.label}: ${b.href}` : ''),
  divider: () => '\n---\n',
  chapter: (b) =>
    `Chapter ${b.number}: ${b.title || ''}\n${absolute(
      `/#reader?lang=${b.lang || 'en'}&chapter=${b.number}&page=0`
    )}`,
};

export function renderBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return {
    html: list.map((block) => BLOCKS[block.type]?.(block) || '').join(''),
    text: list
      .map((block) => TEXT[block.type]?.(block) || '')
      .filter(Boolean)
      .join('\n\n'),
  };
}

// --- the wrapper -----------------------------------------------------------

export function shell({ title, bodyHtml, bodyText, unsubscribe, unsubscribeLabel }) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHTML(title)}</title></head>
<body style="margin:0;padding:0;background:${BACKDROP};">
  <!-- Shown by most clients under the subject line, and if it is not set they
       help themselves to the first words of the body instead. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHTML(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:${BACKDROP};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:600px;background:${PAPER};border-radius:14px;overflow:hidden;">
        <tr><td style="padding:26px 28px 6px;">
          <p style="margin:0;font:600 19px/1 Georgia,'Times New Roman',serif;color:${INK};">The Jewels</p>
        </td></tr>
        ${bodyHtml}
        <tr><td style="padding:22px 28px 28px;">
          <p style="margin:18px 0 0;border-top:1px solid #e2d8c2;padding-top:16px;font:400 12px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${MUTED};">
            ${escapeHTML(unsubscribeLabel || 'You are getting this because you asked to.')}
            <a href="${escapeHTML(unsubscribe)}" style="color:${MUTED};">Unsubscribe</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `The Jewels\n\n${bodyText}\n\n---\n${
    unsubscribeLabel || 'You are getting this because you asked to.'
  }\nUnsubscribe: ${unsubscribe}`;

  return { html, text };
}

// --- the two messages ------------------------------------------------------

export function releaseEmail({ displayName, lang, chapter, unsubscribe }) {
  const body = renderBlocks([
    { type: 'text', text: `${displayName ? `${displayName}, a` : 'A'} new chapter is out.` },
    { type: 'chapter', lang, number: chapter.number, title: chapter.title },
    ...(chapter.description ? [{ type: 'text', text: chapter.description }] : []),
  ]);

  return {
    subject: `Chapter ${chapter.number} — ${chapter.title}`,
    ...shell({
      title: `Chapter ${chapter.number} is out`,
      bodyHtml: body.html,
      bodyText: body.text,
      unsubscribe,
      unsubscribeLabel: 'You asked to hear when a new chapter goes up.',
    }),
  };
}

export function newsletterEmail({ subject, blocks, unsubscribe }) {
  const body = renderBlocks(blocks);
  return {
    subject,
    ...shell({
      title: subject,
      bodyHtml: body.html,
      bodyText: body.text,
      unsubscribe,
      unsubscribeLabel: 'You subscribed to the newsletter.',
    }),
  };
}

export { escapeHTML, safeUrl };
