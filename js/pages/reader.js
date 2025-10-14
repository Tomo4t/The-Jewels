export default async function renderReaderPage(params = {}) {
  const lang = params.lang || localStorage.getItem('language') || 'en';
  const chapter = Number(params.chapter || localStorage.getItem('chapter') || 1);
  const page = Number(params.page || 0);

  localStorage.setItem('language', lang);
  localStorage.setItem('chapter', chapter);

  const meta = await fetch(`chapters/${lang}/chapter${chapter}/meta.json`)
    .then(r => r.ok ? r.json() : Promise.reject('meta.json failed'));

  const totalPages = meta.pages;
  const savedMode = localStorage.getItem('readerMode') || 'flip';

  let currentReadingPage = page;

  function setCurrentPage(p) {
    currentReadingPage = Math.max(0, Math.min(totalPages - 1, p));
    localStorage.setItem(`lastRead-${lang}`, JSON.stringify({ chapter, page: currentReadingPage }));
  }

  function playFlipSound() {
    if (localStorage.getItem('sound') === 'off') return;

    const sfx = new Audio('audio/paper-flip.mp3');
    sfx.volume = 0.3;
    sfx.play().catch(() => {});
  }

  function createNavButtons() {
    const nav = document.createElement('div');
    nav.className = 'navbtns';
    nav.innerHTML = `
      <button type="button" id="prev-btn" class="navbtnL" data-sound="paper-flip">
        <img src="images/button-book.svg" alt="Previous">
      </button>
      <button type="button" id="next-btn" class="navbtnR" data-sound="paper-flip">
        <img src="images/button-book.svg" alt="Next">
      </button>`;

    return {
      nav,
      prev: nav.querySelector('#prev-btn'),
      next: nav.querySelector('#next-btn')
    };
  }

  if (window.readerKeydownHandler) {
    document.removeEventListener('keydown', window.readerKeydownHandler);
    window.readerKeydownHandler = null;
  }

  window.renderComicPages = function (mode = savedMode) {
    const bookEl = document.getElementById('book');
    if (!bookEl) return;

    bookEl.classList.add('fade-out');
    setTimeout(() => {
      bookEl.innerHTML = '';
      document.querySelector('.navbtns')?.remove();
      bookEl.dataset.mode = mode;
      localStorage.setItem('readerMode', mode);

      if (mode === 'flip') {
        const bookInner = document.createElement('div');
        bookInner.className = 'book-inner';
        bookInner.id = 'book-inner';

        let sortfront = totalPages;
        let sortback = 1;

        for (let i = 0; i < totalPages; i++) {
          const type = i % 2 === 0 ? 'front' : 'back';
          const z = type === 'front' ? sortfront-- : sortback++;
          bookInner.innerHTML += `
            <div class="${type}" data-index="${i}" style="z-index: ${z};">
              <img src="chapters/${lang}/chapter${chapter}/page${i}.jpg" alt="Page ${i}" class="page-iner">
            </div>`;
        }

        bookEl.appendChild(bookInner);

        const { nav, prev, next } = createNavButtons();
        document.querySelector('.reader-wrapper')?.appendChild(nav);

        let currentFlipIndex = currentReadingPage === 0 ? -2 : Math.floor(currentReadingPage / 2) * 2;
        const pages = bookInner.querySelectorAll('.front, .back');

        function updateFlipState() {
          pages.forEach(p => p.classList.remove('fliped'));
          for (let i = 0; i <= currentFlipIndex; i += 2) {
            pages.forEach(p => {
              const index = parseInt(p.dataset.index);
              if (index === i || index === i + 1) {
                p.classList.add('fliped');
              }
            });
          }

          const book = document.querySelector('.book-inner');
          const inStart = currentFlipIndex <= -2;
          const atEnd = currentFlipIndex >= totalPages - 2;
          const isInMiddle = !atEnd && !inStart;

          book.classList.toggle('shifted', isInMiddle);
          book.classList.toggle('center', atEnd && !inStart);

          setCurrentPage(currentFlipIndex + 1);
        }

        updateFlipState();

        next?.addEventListener('click', () => {
          if (currentFlipIndex + 2 < totalPages) {
            playFlipSound();
            currentFlipIndex += 2;
            updateFlipState();
          }
        });

        prev?.addEventListener('click', () => {
          if (currentFlipIndex >= 0) {
            playFlipSound();
            currentFlipIndex -= 2;
            updateFlipState();
          }
        });



      } else if (mode === 'scroll') {
        const scrollInner = document.createElement('div');
        scrollInner.className = 'Wepcomic-inner';
        scrollInner.id = 'Wepcomic-inner';

        for (let i = 0; i < totalPages; i++) {
          scrollInner.innerHTML += `
            <div class="page-scroll" data-index="${i}">
              <img src="chapters/${lang}/chapter${chapter}/page${i}.jpg" alt="Page ${i}" class="page-iner">
            </div>`;
        }

        bookEl.appendChild(scrollInner);

        const { nav, prev, next } = createNavButtons();
        document.querySelector('.reader-wrapper')?.appendChild(nav);

        setTimeout(() => {
          const target = scrollInner.querySelector(`[data-index="${currentReadingPage}"]`);
          if (target) target.scrollIntoView({ behavior: 'instant' });
        }, 0);

        scrollInner.addEventListener('scroll', () => {
          const children = Array.from(scrollInner.children);
          const top = scrollInner.scrollTop;

          let closest = 0;
          let minDiff = Infinity;
          children.forEach((el, i) => {
            const diff = Math.abs(el.offsetTop - top);
            if (diff < minDiff) {
              minDiff = diff;
              closest = i;
            }
          });
          currentReadingPage = closest;
          setCurrentPage(closest);
        });

        next?.addEventListener('click', () => {
          if (currentReadingPage < totalPages - 1) {
            currentReadingPage += 1;
            const target = scrollInner.querySelector(`[data-index="${currentReadingPage}"]`);
            if (target) {
              playFlipSound();
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            setCurrentPage(currentReadingPage);
          }
        });

        prev?.addEventListener('click', () => {
          if (currentReadingPage > 0) {
            currentReadingPage -= 1;
            const target = scrollInner.querySelector(`[data-index="${currentReadingPage}"]`);
            if (target) {
              playFlipSound();
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            setCurrentPage(currentReadingPage);
          }
        });

     } else if (mode === 'card') {
        const cardInner = document.createElement('div');
        cardInner.className = 'card-inner';
        cardInner.id = 'card-inner';

        for (let i = 0; i < totalPages; i++) {
          cardInner.innerHTML += `
            <div class="card-page" data-index="${i}">
              <img src="chapters/${lang}/chapter${chapter}/page${i}.jpg" alt="Page ${i}" class="page-iner">
            </div>`;
        }

        bookEl.appendChild(cardInner);

        const { nav, prev, next } = createNavButtons();
        document.querySelector('.reader-wrapper')?.appendChild(nav);

        const pages = cardInner.querySelectorAll('.card-page');

        function updateCardView() {
          pages.forEach((p, i) => {
            p.classList.remove('show', 'hide-left', 'hide-right');
            if (i === currentReadingPage) {
              p.classList.add('show');
            } else if (i < currentReadingPage) {
              p.classList.add('hide-left');
            } else {
              p.classList.add('hide-right');
            }
          });

          setCurrentPage(currentReadingPage);
        }

        updateCardView();

        next?.addEventListener('click', () => {
          if (currentReadingPage < totalPages - 1) {
            playFlipSound();
            currentReadingPage++;
            updateCardView();
          }
        });

        prev?.addEventListener('click', () => {
          if (currentReadingPage > 0) {
            playFlipSound();
            currentReadingPage--;
            updateCardView();
          }
        });

      }


      document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
      const modeId = mode === 'flip' ? 'comic' : mode;
      document.getElementById(`mode-${modeId}`)?.classList.add('active');

      setTimeout(() => {
        bookEl.classList.remove('fade-out');
        bookEl.classList.add('fade-in');
        setTimeout(() => bookEl.classList.remove('fade-in'), 200);
      }, 10);
    }, 150);
  };

  setTimeout(() => {
    document.querySelectorAll('.page-iner').forEach(img => {
      let lastTap = 0;
      img.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap < 300) {
          if (!document.fullscreenElement) {
            img.requestFullscreen?.();
          } else {
            document.exitFullscreen?.();
          }
        }
        lastTap = now;
      });
    });

    const handleKeydown = (e) => {
      if (e.repeat) return;

      const mode = document.getElementById('book')?.dataset.mode;
      if (!mode) return;

      if (mode === 'flip' || mode === 'card' || mode === 'scroll') {
        if (e.key === 'ArrowRight') {
          document.getElementById('next-btn')?.click();
        } else if (e.key === 'ArrowLeft') {
          document.getElementById('prev-btn')?.click();
        }
      }
    };

    document.addEventListener('keydown', handleKeydown);
    window.readerKeydownHandler = handleKeydown;
  }, 0);

  return `
  <div class="reader-wrapper">
    <div class="reader-toggle fade-in" >
      <button id="mode-comic" class="mode-btn ${savedMode === 'flip' ? 'active' : ''}" title="Comic Book Mode">
        <img src="images/open-page.svg" alt="Comic Mode" />
      </button>
      <button id="mode-scroll" class="mode-btn ${savedMode === 'scroll' ? 'active' : ''}" title="Webcomic Scroll Mode">
        <img src="images/scroll.svg" alt="Scroll Mode" />
      </button>
      <button id="mode-card" class="mode-btn ${savedMode === 'card' ? 'active' : ''}" title="Flip Card Mode">
        <img src="images/card.svg" alt="Card Mode" />
      </button>
    </div>
    <div class="book" id="book" data-mode="${savedMode}"></div>
  </div>
`;

}
