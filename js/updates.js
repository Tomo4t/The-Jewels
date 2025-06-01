let updates = [];
let currentIndex = 0;
let configLoaded = false;
let updateConfig = { count: 1, folder: 'updates' };

export async function loadUpdates(maxUpdates = null, lang = 'en') {
  const box = document.getElementById('updates-text');
  updates = [];
  currentIndex = 0;

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

  for (let i = count; i >= 1; i--) {
    try {
      const res = await fetch(`${folder}/${lang}/${i}.txt`);
      if (res.ok) {
        const text = await res.text();
        updates.push(text.trim());
      }
    } catch {}
  }

  if (updates.length > 0) {
    showUpdate(currentIndex);
  } else if (box) {
    box.textContent = 'No updates found.';
  }

  document.getElementById('update-prev')?.addEventListener('click', () => {
    if (currentIndex > 0) {
      currentIndex--;
      showUpdate(currentIndex);
      
    }
  });

  document.getElementById('update-next')?.addEventListener('click', () => {
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

  const update = updates[index];

  box.classList.add('fade-out');
  setTimeout(() => {
    if (update.includes('\n')) {
      const [date, ...messageLines] = update.split('\n');
      const message = messageLines.join('\n');

      box.innerHTML = `
        <div class="update-date">${formatDate(date)}</div>
        <div class="update-message">${message}</div>
      `;
    } else {
      box.textContent = update;
    }

    box.classList.remove('fade-out');

    if (counter) {
      counter.textContent = `${index + 1} / ${updates.length}`;
    }

    // ✅ Hide/show arrows without moving them
    prev.classList.toggle('visible', index > 0);
    next.classList.toggle('visible', index < updates.length - 1);

  }, 200);
}

