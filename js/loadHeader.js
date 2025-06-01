// js/loadHeader.js
import { initNavbar } from './navbar.js';
import { initParticles } from './particles.js';

fetch('index.html')
  .then(res => res.text())
  .then(html => {
    document.getElementById('header-container').innerHTML = html;
    initNavbar(); // run navbar logic AFTER injection
    initParticles(); // activate particles after header loads
  });
  


document.addEventListener('click', e => {
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  ripple.style.left = `${e.clientX - 100}px`;
  ripple.style.top = `${e.clientY - 100}px`;
  document.getElementById('bg-ripple-container')?.appendChild(ripple);
  setTimeout(() => ripple.remove(), 800);

  document.querySelectorAll('.particle-wrapper').forEach(p => {
    const rect = p.getBoundingClientRect();
    const px = rect.left + rect.width / 2;
    const py = rect.top + rect.height / 2;
    const dx = px - e.clientX;
    const dy = py - e.clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 200) {
      const push = (200 - distance) / 5;
      const angle = Math.atan2(dy, dx);
      const tx = Math.cos(angle) * push;
      const ty = Math.sin(angle) * push;
      p.style.transform = `translate(${tx}px, ${ty}px)`;
      setTimeout(() => {
        p.style.transform = 'translate(0, 0)';
      }, 300);
    }
  });
});
