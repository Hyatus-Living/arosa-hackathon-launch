// The beta page's motion: the contour backdrop and helix in the hero, the helix behind the learning
// loop, scroll-in reveals, counting figures and the theme switch. The page reads complete without it:
// every figure is in the HTML at its final value and nothing is hidden until this script opts in.
import { mountHelixRibbon } from './helix-ribbon.js';
import { mountContours } from './contour-shader.js';

const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));

// The text a counting figure shows at progress p (0..1) of its count: {to, prefix, suffix, decimals}.
export function countText({ to, prefix = '', suffix = '', decimals = 0 }, p) {
  const value = to * easeOutExpo(Math.min(Math.max(p, 0), 1));
  const shown = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${prefix}${shown}${suffix}`;
}

const doc = globalThis.document;
if (doc) {
  const html = doc.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // Theme: the day view by default, a saved choice wins.
  const themeBtn = doc.getElementById('theme');
  const painters = [];
  const syncTheme = () => {
    const dark = html.classList.contains('dark');
    themeBtn.querySelector('.sun').toggleAttribute('hidden', dark);
    themeBtn.querySelector('.moon').toggleAttribute('hidden', !dark);
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to the day view' : 'Switch to the night view');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1a1a' : '#f9f9f9');
    painters.forEach((p) => p.refreshColors());
  };
  themeBtn.addEventListener('click', () => {
    html.classList.toggle('dark');
    try { localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light'; } catch (e) {}
    syncTheme();
  });

  const nav = doc.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Backdrops. Without WebGL2 the hero keeps the helix on the plain page background.
  const contours = [mountContours(doc.querySelector('.opening-contours')), mountContours(doc.querySelector('.data-contours'))];
  if (contours[0]) painters.push(...contours.filter(Boolean));
  else html.classList.add('no-webgl');
  painters.push(mountHelixRibbon(doc.querySelector('.opening-helix')));
  painters.push(mountHelixRibbon(doc.querySelector('.loop-helix'), { strands: 18, tilt: -8, sway: 64, sparks: 5, gap: 5.6 }));
  syncTheme();

  // Reveals and counts run once, as each block enters the viewport. With reduced motion the page
  // stays exactly as written.
  if (!reduced.matches && 'IntersectionObserver' in globalThis) {
    const count = (el) => {
      const spec = { to: Number(el.dataset.count), prefix: el.dataset.prefix, suffix: el.dataset.suffix, decimals: Number(el.dataset.decimals || 0) };
      const final = el.textContent;
      const ms = Number(el.dataset.ms || 1600);
      const begin = performance.now();
      const step = (now) => {
        const p = (now - begin) / ms;
        el.textContent = p >= 1 ? final : countText(spec, p);
        if (p < 1) requestAnimationFrame(step);
      };
      el.textContent = countText(spec, 0);
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
    doc.querySelectorAll('.rise').forEach((el) => watch.observe(el));
  }
}
