import { loadConfig } from '../configLoader.js';
import { loadChapterMeta } from '../chapterLoader.js';

function getChaptersPerRow() {
  const width = window.innerWidth;
  if (width >= 1200) return 5;
  if (width >= 900) return 4;
  if (width >= 600) return 3;
  return 2;
}

export default async function renderChapters() {
  const lang = localStorage.getItem('language') || 'en';
  const config = await loadConfig();
  
  const count = config[lang];

  const perRow = getChaptersPerRow();
  let html = `<div class="chapters-fade-wrap" style="opacity: 0;"> <div class="chapters-shelf-container">`;

  for (let i = 1; i <= count; i += perRow) {
    html += `<div class="shelf-row" >`;

    for (let j = i; j < i + perRow && j <= count; j++) {
      const meta = await loadChapterMeta(lang, j);
  const title = meta?.title || `Chapter ${j}`;
       html += `
  <a class="chapter-box" href="#reader?lang=${lang}&chapter=${j}&page=0">
    <img src="chapters/${lang}/chapter${j}/page0.jpg" alt="Chapter ${title}">
    <span class="chapter-label">${title}</span>
  </a>`;

    }

    html += `</div><div class="shelf-line"></div>`;
    
  }

  setTimeout(() => {
    const wrap = document.querySelector('.chapters-fade-wrap');
    if (wrap) wrap.classList.add('fade-in');
  }, 0);



  html += `</div> </div>`;
  return html;
}


