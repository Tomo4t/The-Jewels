import { escapeHTML } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

const SOCIALS = [
  { name: 'Instagram', href: 'https://instagram.com/Tomo_4t', icon: 'instagram.svg' },
  { name: 'Twitter', href: 'https://twitter.com/Tomo_4t', icon: 'twitter.svg' },
  { name: 'YouTube', href: 'https://youtube.com/@Tomo_4t', icon: 'youtube.svg' },
  { name: 'VGen', href: 'https://vgen.co/Tomo_4t', icon: 'vgen.svg' },
  { name: 'Tellonym', href: 'https://tellonym.me/tomo_4t', icon: 'tellonym.svg' },
  { name: 'Twitch', href: 'https://www.twitch.tv/tomo_4t', icon: 'twitch.svg' },
];

export const title = () => t('nav.contact');

export function render() {
  return `
    <div class="contact-container">
      <h1 data-i18n="contact.title">${escapeHTML(t('contact.title'))}</h1>
      <ul class="social-grid">
        ${SOCIALS.map(
          (social) => `
            <li>
              <a href="${social.href}" target="_blank" rel="noopener noreferrer"
                 title="${social.name}" aria-label="${social.name}" data-sound="ui">
                <img src="/images/socials/${social.icon}" alt="" aria-hidden="true"
                     loading="lazy" decoding="async">
                <span class="visually-hidden">${social.name}</span>
              </a>
            </li>`
        ).join('')}
      </ul>
    </div>
  `;
}

export default { render, title };
