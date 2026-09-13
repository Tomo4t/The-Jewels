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

/**
 * Instances per clip.
 *
 * Two reasons this is more than one. A clip that is still playing cannot be
 * restarted without cutting itself off, and building a replacement on the spot
 * is exactly the cost this pool exists to avoid -- so fast page-flipping
 * borrows the next idle instance instead.
 */
const VOICES = 3;

/** name -> array of preloaded HTMLAudioElement */
const pool = new Map();
let warmed = false;

/**
 * Builds and loads every clip up front.
 *
 * Previously the first play of a sound constructed its Audio and waited on the
 * network, so the first page turn of a session fired its noise long after the
 * page had already moved. Browsers refuse to load audio before a user gesture,
 * so this runs on the first one and every play after it is instant.
 */
export function warmSounds() {
  if (warmed) return;
  warmed = true;

  for (const [name, src] of Object.entries(CLIPS)) {
    const voices = [];
    for (let i = 0; i < VOICES; i += 1) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      audio.volume = VOLUME[name] ?? 0.3;
      try {
        audio.load();
      } catch {
        /* a browser that refuses to preload still plays on demand */
      }
      voices.push(audio);
    }
    pool.set(name, voices);
  }
}

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
    if (!warmed) warmSounds();
    const voices = pool.get(name);
    if (!voices || !voices.length) return;

    // The first idle voice, or the oldest one restarted if every voice is busy.
    // Nothing is constructed here, which is what keeps the sound on the action.
    const voice = voices.find((a) => a.paused || a.ended) || voices[0];
    voice.currentTime = 0;
    voice.play().catch(() => {});
  } catch {
    /* autoplay policy or a missing file; silence is an acceptable outcome */
  }
}

/** Plays a click for any button carrying data-sound, delegated once globally. */
export function bindGlobalSounds() {
  // The first gesture of the session is where a browser will finally allow
  // audio to load, so every clip is fetched then rather than on first use.
  const warmOnce = () => {
    warmSounds();
    document.removeEventListener('pointerdown', warmOnce);
    document.removeEventListener('keydown', warmOnce);
  };
  document.addEventListener('pointerdown', warmOnce, { passive: true, once: false });
  document.addEventListener('keydown', warmOnce, { passive: true, once: false });

  document.addEventListener(
    'pointerdown',
    (event) => {
      const trigger = event.target.closest('[data-sound]');
      if (trigger) play(trigger.dataset.sound || 'click');
    },
    { passive: true }
  );
}
