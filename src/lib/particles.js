import { prefersReducedMotion } from './dom.js';

/**
 * Background particles.
 *
 * Differences from the original: the animation loop can be stopped, it pauses
 * when the tab is hidden, the canvas honours devicePixelRatio so it is not
 * blurry, resize is debounced, and the whole effect is skipped entirely for
 * anyone who asked for reduced motion.
 */
export function initParticles(options = {}) {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return () => {};

  if (prefersReducedMotion()) {
    canvas.hidden = true;
    return () => {};
  }

  const settings = {
    count: 60,
    minSize: 1,
    maxSize: 3,
    color: 'rgba(255, 255, 255, 0.3)',
    speed: 0.6,
    ...options,
  };

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return () => {};

  let particles = [];
  let frame = null;
  let running = false;
  let resizeTimer = null;

  const sizeCanvas = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { innerWidth: w, innerHeight: h } = window;
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(h * ratio);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const seed = () => {
    const { innerWidth: w, innerHeight: h } = window;
    // Fewer particles on small screens; a phone does not need sixty of them.
    const count = Math.round(settings.count * Math.min(1, (w * h) / (1440 * 900)));
    particles = Array.from({ length: Math.max(12, count) }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: settings.minSize + Math.random() * (settings.maxSize - settings.minSize),
      dx: (Math.random() - 0.5) * settings.speed,
      dy: (Math.random() - 0.5) * settings.speed,
    }));
  };

  const tick = () => {
    const { innerWidth: w, innerHeight: h } = window;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = settings.color;

    for (const p of particles) {
      p.x += p.dx;
      p.y += p.dy;
      if (p.x < 0) p.x = w;
      else if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      else if (p.y > h) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    frame = requestAnimationFrame(tick);
  };

  const start = () => {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
  };

  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      sizeCanvas();
      seed();
    }, 150);
  };

  const onVisibility = () => (document.hidden ? stop() : start());

  sizeCanvas();
  seed();
  start();

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stop();
    window.clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
