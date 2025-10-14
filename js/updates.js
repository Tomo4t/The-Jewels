import { getTranslation } from './i18n.js';

let updates = [];
let currentIndex = 0;
let configLoaded = false;
let updateConfig = { count: 1, folder: 'updates' };
let activeLoadToken = 0;

let clickSoundInstance = null;

function playButtonClickSound() {
  if (localStorage.getItem('sound') === 'off') return;

  if (!clickSoundInstance) {
    clickSoundInstance = new Audio('audio/click.mp3');
    clickSoundInstance.volume = 0.3;
  }

  clickSoundInstance.currentTime = 0;
  clickSoundInstance.play().catch(() => {});
}

function attachUpdateButtonSounds(...buttons) {
  buttons.forEach(button => {
    if (!button) return;
    button.addEventListener('mousedown', playButtonClickSound);
  });
}

function escapeHTML(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function loadUpdates(maxUpdates = null, lang = 'en') {
  const loadToken = ++activeLoadToken;
  const box = document.getElementById('updates-text');
  if (!box) return;

  const counter = document.getElementById('update-counter');

  box.classList.remove('fade-out');
  const loadingLabel = escapeHTML(getTranslation('updatesLoading', 'Loading updates…'));
  box.innerHTML = `<div class="update-loading">${loadingLabel}</div>`;
  if (counter) {
    counter.textContent = '0 / 0';
  }

  updates = [];
  currentIndex = 0;

  const prevButton = document.getElementById('update-prev');
  const nextButton = document.getElementById('update-next');

  if (prevButton) {
    const clone = prevButton.cloneNode(true);
    prevButton.parentNode.replaceChild(clone, prevButton);
  }

  if (nextButton) {
    const clone = nextButton.cloneNode(true);
    nextButton.parentNode.replaceChild(clone, nextButton);
  }

  document.getElementById('update-prev')?.classList.remove('visible');
  document.getElementById('update-next')?.classList.remove('visible');

  // 🔄 Load config.json once
  if (!configLoaded) {
    try {
      const res = await fetch('config.json');
      const config = await res.json();
      if (config.updates) {
        updateConfig = { ...updateConfig, ...config.updates };
      }
    } catch (err) {
      console.warn('Could not load config.json:', err);
    }
    configLoaded = true;
  }

  const count = maxUpdates ?? updateConfig.count;
  const folder = updateConfig.folder;

  const collected = [];

  for (let i = count; i >= 1; i--) {
    try {
      const res = await fetch(`${folder}/${lang}/${i}.txt`, { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        const raw = text.trim();
        if (!raw) continue;

        const normalized = raw.replace(/\r\n/g, '\n');
        const [dateLine = '', ...messageLines] = normalized.split('\n');
        const message = messageLines.join('\n').trim();

        collected.push({
          id: i,
          raw,
          date: dateLine.trim(),
          message
        });
      }
    } catch {}
  }

  if (loadToken !== activeLoadToken) {
    return;
  }

  updates = collected.sort((a, b) => b.id - a.id);

  if (updates.length > 0) {
    showUpdate(0);
  } else {
    box.textContent = getTranslation('updatesEmpty', 'No updates found.');
  }

  const prev = document.getElementById('update-prev');
  const next = document.getElementById('update-next');

  attachUpdateButtonSounds(prev, next);

  prev?.addEventListener('click', () => {
    if (loadToken !== activeLoadToken) return;
    if (currentIndex > 0) {
      currentIndex--;
      showUpdate(currentIndex);
    }
  });

  next?.addEventListener('click', () => {
    if (loadToken !== activeLoadToken) return;
    if (currentIndex < updates.length - 1) {
      currentIndex++;
      showUpdate(currentIndex);
    }
  });
}



function formatDate(dateString) {
  const lang = document.documentElement.lang || 'en';
  try {
    const date = new Date(dateString.trim());
    return date.toLocaleDateString(lang, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateString;
  }
}

function showUpdate(index) {
  const box = document.getElementById('updates-text');
  const counter = document.getElementById('update-counter');
  const prev = document.getElementById('update-prev');
  const next = document.getElementById('update-next');

  if (!box || !updates.length) return;

  currentIndex = Math.max(0, Math.min(index, updates.length - 1));

  const update = updates[currentIndex];
  if (!update) return;

  box.classList.add('fade-out');
  setTimeout(() => {
    if (update.date && update.message) {
      const messageHTML = escapeHTML(update.message)
        .split('\n')
        .map(line => line || '&nbsp;')
        .join('<br>');

      box.innerHTML = `
        <div class="update-date">${escapeHTML(formatDate(update.date))}</div>
        <div class="update-message">${messageHTML}</div>
      `;
    } else if (update.date) {
      box.innerHTML = `
        <div class="update-date">${escapeHTML(formatDate(update.date))}</div>
      `;
    } else {
      box.textContent = update.raw;
    }

    box.classList.remove('fade-out');

    if (counter) {
      counter.textContent = `${currentIndex + 1} / ${updates.length}`;
    }

    // ✅ Hide/show arrows without moving them
    if (prev) prev.classList.toggle('visible', currentIndex > 0);
    if (next) next.classList.toggle('visible', currentIndex < updates.length - 1);

  }, 200);
}

