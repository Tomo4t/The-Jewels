import { escapeHTML } from '../lib/dom.js';
import { t, formatDate } from '../lib/i18n.js';

/**
 * Privacy notice.
 *
 * The body is deliberately written in English only: a half-translated privacy
 * notice is worse than an untranslated one, so the headings and the page
 * furniture localise and a line at the top says the rest does not.
 *
 * Everything below describes what the code actually does. If the code changes,
 * change this too — see server/db.js for the schema, server/routes/auth.js for
 * what is stored at sign-up, and server/services/email.js for what is sent.
 */

const UPDATED = '2026-09-14';

const SECTIONS = [
  {
    id: 'short',
    heading: 'The short version',
    html: `
      <p>
        The Jewels is one person's comic site. It is not funded by advertising and
        it does not profile its readers. Nothing here is sold, shared for money,
        or handed to advertisers — there are no advertisements on the site at all.
      </p>
      <p>
        You can read the whole comic without an account, and without the site
        keeping anything about you.
      </p>
    `,
  },
  {
    id: 'no-account',
    heading: 'If you never make an account',
    html: `
      <p>
        The site stores nothing about you. There is no analytics service on the
        page, no advertising network, and no tracking cookie.
      </p>
      <p>
        Your language, theme, reading mode and sound choices are kept in your own
        browser's storage. They never leave your device and the site never
        receives them.
      </p>
      <p>
        Two things still happen that are worth naming. The server that hosts the
        site sees the ordinary request information every web server sees — your
        IP address, the page you asked for and your browser's identification
        string — as part of delivering the page. And the site loads its typefaces
        from Google Fonts, so Google's font servers see your IP address when a
        page loads.
      </p>
    `,
  },
  {
    id: 'account',
    heading: 'If you make an account',
    html: `
      <p>The site stores:</p>
      <ul>
        <li>the username and display name you chose;</li>
        <li>your email address, and whether you have confirmed it;</li>
        <li>
          your password, hashed with bcrypt. The site never holds the password
          itself and cannot tell you or anyone else what it is;
        </li>
        <li>
          when the account was created, and whether it is an ordinary account, a
          moderator or an administrator;
        </li>
        <li>
          if you signed in with Google: the account identifier Google gives the
          site, plus the name and email address on that Google account. Nothing
          else — no contacts, no Drive, no calendar, no access to your Google
          account beyond confirming who you are.
        </li>
      </ul>
    `,
  },
  {
    id: 'session',
    heading: 'While you are signed in',
    html: `
      <p>
        Signing in creates a session record holding a hashed form of your session
        cookie and your browser's identification string. It expires on its own,
        and signing out deletes it immediately.
      </p>
    `,
  },
  {
    id: 'comments',
    heading: 'When you post a comment',
    html: `
      <p>
        The site stores what you wrote, which chapter and language you wrote it
        on, when you wrote it, and whether it is published, waiting for approval
        or rejected.
      </p>
    `,
  },
  {
    id: 'email',
    heading: 'Confirming an address, resetting a password',
    html: `
      <p>
        The site stores a hashed, single-use token — never the link itself.
        Confirmation links expire after 48 hours and password-reset links after
        two. Redeeming one deletes it.
      </p>
      <p>
        The site also keeps a short record of account actions — registering,
        changing an email address, a moderator approving or rejecting a comment —
        so there is a trail if something is ever disputed.
      </p>
    `,
  },
  {
    id: 'others',
    heading: 'Who else is involved',
    html: `
      <ul>
        <li>
          <strong>Resend</strong> delivers confirmation and password-reset email.
          They handle your address and the contents of those messages.
        </li>
        <li>
          <strong>Google</strong>, only if you choose to sign in with Google, and
          only for the sign-in itself. Google Fonts also serves the site's
          typefaces to every reader.
        </li>
        <li><strong>Railway</strong> hosts the site and its database.</li>
        <li>
          <strong>Porkbun</strong> runs the domain and forwards tomojw.com to
          www.tomojw.com.
        </li>
      </ul>
      <p>Each of them has its own privacy policy covering what it does with that.</p>
    `,
  },
  {
    id: 'visible',
    heading: 'What other readers can see',
    html: `
      <p>
        Your display name, and any comment of yours that has been published.
        Nothing else. Your email address is never shown to anyone but you, and
        neither is anything about what you have read.
      </p>
    `,
  },
  {
    id: 'control',
    heading: 'Changing or removing it',
    html: `
      <p>
        You can change your display name, email address and password on your
        account page, and edit or delete your own comments there.
      </p>
      <p>
        To have an account and its comments removed entirely, ask through the
        <a href="#contact" data-sound="ui">contact page</a> and it will be done.
      </p>
    `,
  },
  {
    id: 'cookies',
    heading: 'Cookies',
    html: `
      <p>
        One cookie, for your session, set only when you sign in. No advertising
        cookies and no analytics cookies. Everything else — language, theme,
        reading mode, sound — lives in your browser's own storage and is never
        transmitted.
      </p>
    `,
  },
  {
    id: 'children',
    heading: 'Younger readers',
    html: `
      <p>
        The site is not aimed at children and does not knowingly keep information
        about anyone under 13. If an account like that turns up, ask through the
        contact page and it will be removed.
      </p>
    `,
  },
];

export const title = () => t('legal.privacy.title');

export function render() {
  return `
    <article class="legal-page">
      <header class="legal-head">
        <h1>${escapeHTML(t('legal.privacy.title'))}</h1>
        <p class="legal-meta">
          <span>${escapeHTML(t('legal.updated', { date: formatDate(UPDATED) }))}</span>
          <span class="legal-lang-note">${escapeHTML(t('legal.englishOnly'))}</span>
        </p>
      </header>

      ${SECTIONS.map(
        (section) => `
          <section class="legal-section" id="privacy-${section.id}">
            <h2>${section.heading}</h2>
            ${section.html}
          </section>`
      ).join('')}

      <nav class="legal-foot">
        <a href="#terms" data-sound="ui">${escapeHTML(t('legal.terms.title'))}</a>
        <a href="#contact" data-sound="ui">${escapeHTML(t('nav.contact'))}</a>
      </nav>
    </article>
  `;
}

export default { render, title };
