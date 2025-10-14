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

  let modeActions = { next: null, prev: null };

  function createNavButtons(onPrev, onNext) {
    const nav = document.createElement('div');
    nav.className = 'navbtns';
    nav.innerHTML = `
      <button type="button" id="prev-btn" class="navbtnL" data-sound="paper-flip">
        <img src="images/button-book.svg" alt="Previous">
      </button>
      <button type="button" id="next-btn" class="navbtnR" data-sound="paper-flip">
        <img src="images/button-book.svg" alt="Next">
      </button>`;

    const prev = nav.querySelector('#prev-btn');
    const next = nav.querySelector('#next-btn');

    if (onPrev) {
      prev.addEventListener('click', onPrev);
    }

    if (onNext) {
      next.addEventListener('click', onNext);
    }

    return { nav, prev, next };
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
      modeActions = { next: null, prev: null };

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

        const pages = bookInner.querySelectorAll('.front, .back');

        function getFlipIndexFromPage(targetPage) {
          if (targetPage <= 0) return -2;
          return Math.floor((targetPage - 1) / 2) * 2;
        }

        let flipPointer = Math.max(0, Math.min(totalPages - 1, currentReadingPage));

        function updateFlipState() {
          const flipIndex = getFlipIndexFromPage(flipPointer);
          pages.forEach(p => p.classList.remove('fliped'));

          if (flipIndex >= 0) {
            for (let i = 0; i <= flipIndex; i += 2) {
              pages.forEach(p => {
                const index = parseInt(p.dataset.index, 10);
                if (index === i || index === i + 1) {
                  p.classList.add('fliped');
                }
              });
            }
          }

          const book = document.querySelector('.book-inner');
          const atStart = flipIndex < 0;
          const finalFlipIndex = getFlipIndexFromPage(totalPages - 1);
          const atEnd = flipIndex >= finalFlipIndex;
          const isInMiddle = !atEnd && !atStart;

          book.classList.toggle('shifted', isInMiddle);
          book.classList.toggle('center', atEnd && !atStart);

          setCurrentPage(flipPointer);
        }

        const goNext = () => {
          if (flipPointer < totalPages - 1) {
            flipPointer += 1;
            playFlipSound();
            updateFlipState();
          }
        };

        const goPrev = () => {
          if (flipPointer > 0) {
            flipPointer -= 1;
            playFlipSound();
            updateFlipState();
          }
        };

        const { nav } = createNavButtons(goPrev, goNext);
        document.querySelector('.reader-wrapper')?.appendChild(nav);
        modeActions = { next: goNext, prev: goPrev };

        updateFlipState();



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

        const goNext = () => {
          if (currentReadingPage < totalPages - 1) {
            const nextPage = currentReadingPage + 1;
            const target = scrollInner.querySelector(`[data-index="${nextPage}"]`);
            if (target) {
              playFlipSound();
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            setCurrentPage(nextPage);
          }
        };

        const goPrev = () => {
          if (currentReadingPage > 0) {
            const prevPage = currentReadingPage - 1;
            const target = scrollInner.querySelector(`[data-index="${prevPage}"]`);
            if (target) {
              playFlipSound();
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            setCurrentPage(prevPage);
          }
        };

        const { nav } = createNavButtons(goPrev, goNext);
        document.querySelector('.reader-wrapper')?.appendChild(nav);
        modeActions = { next: goNext, prev: goPrev };

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

        const goNext = () => {
          if (currentReadingPage < totalPages - 1) {
            playFlipSound();
            currentReadingPage++;
            updateCardView();
          }
        };

        const goPrev = () => {
          if (currentReadingPage > 0) {
            playFlipSound();
            currentReadingPage--;
            updateCardView();
          }
        };

        const { nav } = createNavButtons(goPrev, goNext);
        document.querySelector('.reader-wrapper')?.appendChild(nav);
        modeActions = { next: goNext, prev: goPrev };

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
          if (modeActions.next) {
            e.preventDefault();
            modeActions.next();
          }
        } else if (e.key === 'ArrowLeft') {
          if (modeActions.prev) {
            e.preventDefault();
            modeActions.prev();
          }
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
