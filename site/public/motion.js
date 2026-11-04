// witharosa.ai home: the opening's contour backdrop and helix, scroll-in reveals and the counting
// figures. Loaded as a module beside site.js; the page reads complete without it, with every figure
// in the HTML at its final value and nothing hidden until this script opts in.
import { mountHelixRibbon } from '/helix-ribbon.js';
import { mountContours } from '/contour-shader.js';

const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
const html = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// Backdrops, repainted when site.js flips the night view on <html>. Without WebGL2 the opening keeps
// the helix on the plain page background.
const painters = [mountContours(document.querySelector('.opening-contours')), mountHelixRibbon(document.querySelector('.opening-helix'))].filter(Boolean);
new MutationObserver(() => painters.forEach((p) => p.refreshColors())).observe(html, { attributeFilter: ['class'] });

if (!reduced.matches && 'IntersectionObserver' in globalThis) {
  const count = (el) => {
    const to = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    const final = el.textContent;
    const begin = performance.now();
    const step = (now) => {
      const p = (now - begin) / 1600;
      el.textContent = p >= 1 ? final : `${Math.round(to * easeOutExpo(p)).toLocaleString('en-US')}${suffix}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      watch.unobserve(entry.target);
      entry.target.classList.add('in');
      entry.target.querySelectorAll('[data-count]').forEach(count);
    }
  }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
  html.classList.add('motion');
  document.querySelectorAll('.rise, .bars').forEach((el) => watch.observe(el));
}
