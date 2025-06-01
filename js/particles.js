export function initParticles({
  count = 50,
  minSize = 2,
  maxSize = 4,
  color = 'rgba(255,255,255,0.3)',
  speed = 0.5
} = {}) {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) {
    console.warn('particle-canvas not found');
    return;
  }

  const ctx = canvas.getContext('2d');
  let particles = [];

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function createParticles() {
    particles = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: minSize + Math.random() * (maxSize - minSize),
        dx: (Math.random() - 0.5) * speed,
        dy: (Math.random() - 0.5) * speed
      });
    }
    console.log(`✅ Created ${particles.length} particles`);
  }

  function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.x += p.dx;
      p.y += p.dy;

      // wrap around screen
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    requestAnimationFrame(animateParticles);
  }

  createParticles();
  animateParticles();
}
