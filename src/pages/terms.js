import { escapeHTML } from '../lib/dom.js';
import { t, formatDate } from '../lib/i18n.js';

/**
 * Terms of use.
 *
 * English only for the same reason as the privacy notice: the headings and the
 * page furniture localise, the terms themselves do not.
 */

const UPDATED = '2026-09-14';

const SECTIONS = [
  {
    id: 'comic',
    heading: 'The comic',
    html: `
      <p>
        The Jewels, its story and its artwork belong to their author. Read it,
        link to it, tell people about it. Do not republish the pages somewhere
        else, sell them, or pass them off as your own.
      </p>
      <p>
        Fan art and fan translations are welcome. Credit the comic and link back
        to it.
      </p>
    `,
  },
  {
    id: 'account',
    heading: 'Your account',
    html: `
      <p>
        One account per person. Keep your password to yourself — anything done
        with your account is treated as done by you.
      </p>
      <p>
        Give a real email address. You will need to confirm it before the account
        is finished, and it is the only way to get back in if you forget your
        password.
      </p>
    `,
  },
  {
    id: 'comments',
    heading: 'Comments',
    html: `
      <p>
        Be decent. Comments may be held for approval before they appear, and a
        moderator may reject or remove anything abusive, hateful, threatening,
        sexual, spam, or posted to harass another reader. Doing it repeatedly
        loses you the account.
      </p>
      <p>
        Spoilers belong behind a warning. Nobody wants chapter forty in the
        replies to chapter three.
      </p>
      <p>
        What you write stays yours. By posting it you allow the site to show it
        alongside the chapter it was written on.
      </p>
    `,
  },
  {
    id: 'guarantees',
    heading: 'No guarantees',
    html: `
      <p>
        This is one person's comic site, not a company. It may go down, lose
        data, change, or stop. It is provided as it is, without warranty of any
        kind, and the author is not liable for anything that follows from using
        it.
      </p>
    `,
  },
  {
    id: 'changes',
    heading: 'Changes',
    html: `
      <p>
        These terms may change. When something material changes, the date at the
        top of this page changes with it.
      </p>
    `,
  },
];

export const title = () => t('legal.terms.title');

export function render() {
  return `
    <article class="legal-page">
      <header class="legal-head">
        <h1>${escapeHTML(t('legal.terms.title'))}</h1>
        <p class="legal-meta">
          <span>${escapeHTML(t('legal.updated', { date: formatDate(UPDATED) }))}</span>
          <span class="legal-lang-note">${escapeHTML(t('legal.englishOnly'))}</span>
        </p>
      </header>

      ${SECTIONS.map(
        (section) => `
          <section class="legal-section" id="terms-${section.id}">
            <h2>${section.heading}</h2>
            ${section.html}
          </section>`
      ).join('')}

      <nav class="legal-foot">
        <a href="#privacy" data-sound="ui">${escapeHTML(t('legal.privacy.title'))}</a>
        <a href="#contact" data-sound="ui">${escapeHTML(t('nav.contact'))}</a>
      </nav>
    </article>
  `;
}

export default { render, title };
