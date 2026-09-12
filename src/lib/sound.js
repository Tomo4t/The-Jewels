import { read, write, KEYS } from './store.js';

/**
 * Small pooled sound player.
 *
 * The old site created a `new Audio()` on every click, which leaked objects and
 * made rapid page-flipping stutter. Clips are loaded once and cloned only when
 * one is still playing.
 */

const CLIPS = {
  click: '/audio/click.mp3',
  slide: '/audio/slide.mp3',
  flip: '/audio/paper-flip.mp3',
  open: '/audio/OpenChapter.mp3',
  ui: '/audio/button-ui.mp3',
  notify: '/audio/tap-notification.mp3',
};

const VOLUME = { click: 0.3, slide: 0.3, flip: 0.3, open: 0.4, ui: 0.3, notify: 0.3 };

const pool = new Map();

export const soundEnabled = () => read(KEYS.sound, 'on') !== 'off';

export function setSoundEnabled(enabled) {
  write(KEYS.sound, enabled ? 'on' : 'off');
}

export function toggleSound() {
  const next = !soundEnabled();
  setSoundEnabled(next);
  return next;
}

export function play(name) {
  if (!soundEnabled()) return;
  const src = CLIPS[name];
  if (!src) return;

  try {
    let audio = pool.get(name);
    if (!audio) {
      audio = new Audio(src);
      audio.preload = 'auto';
      audio.volume = VOLUME[name] ?? 0.3;
      pool.set(name, audio);
    }

    if (audio.paused || audio.ended) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      // Already playing — overlap with a throwaway clone.
      const clone = audio.cloneNode();
      clone.volume = audio.volume;
      clone.play().catch(() => {});
    }
  } catch {
    /* autoplay policy or a missing file; silence is an acceptable outcome */
  }
}

/** Plays a click for any button carrying data-sound, delegated once globally. */
export function bindGlobalSounds() {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const trigger = event.target.closest('[data-sound]');
      if (trigger) play(trigger.dataset.sound || 'click');
    },
    { passive: true }
  );
}
