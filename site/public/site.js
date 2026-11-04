// witharosa.ai: the page's chrome, the product windows and the live totals. Everything renders in a
// usable state without this script; the script adds the theme toggle, the reveals, the windows (the
// app's own views on example data) and the totals strip.
(() => {
  const html = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) html.classList.add('no-motion');

  // Theme: the day view by default, the saved choice wins.
  const themeBtn = document.getElementById('theme');
  const syncTheme = () => {
    const dark = html.classList.contains('dark');
    themeBtn.querySelector('.sun').toggleAttribute('hidden', dark);
    themeBtn.querySelector('.moon').toggleAttribute('hidden', !dark);
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to the day view' : 'Switch to the night view');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1a1a' : '#f9f9f9');
  };
  themeBtn.addEventListener('click', () => {
    html.classList.toggle('dark');
    try { localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light'; } catch (e) {}
    syncTheme();
  });
  syncTheme();

  // Nav
  const nav = document.getElementById('nav'), burger = document.getElementById('burger');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, {passive: true}); onScroll();
  burger.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
  });
  document.getElementById('menu').addEventListener('click', e => { if (e.target.closest('a')) { nav.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); burger.focus(); } });

  // Reveal on scroll, from an already visible default when motion is off.
  const inView = (el, threshold, cb) => {
    if (reduced || !('IntersectionObserver' in window)) { cb(true); return; }
    const io = new IntersectionObserver(([e]) => cb(e.isIntersecting), {threshold});
    io.observe(el);
  };
  document.querySelectorAll('.reveal').forEach(el => inView(el, 0.05, on => { if (on) el.classList.add('in'); }));
  // Anything already on screen when the page settles is shown regardless of observer timing.
  const settle = () => document.querySelectorAll('.reveal').forEach(el => { const r = el.getBoundingClientRect(); if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('in'); });
  window.addEventListener('load', () => setTimeout(settle, 250)); window.addEventListener('hashchange', () => setTimeout(settle, 250)); setTimeout(settle, 1200);

  // ─── Product windows (the home page only) ───────────────────────────────
  // Each is one of the app's own views on example data in an iframe under /demo. A frame loads once
  // the page has loaded and the frame comes within a short scroll of the screen, so the opening pulls
  // none of the app; an action in one window carries on in the next.
  const frames = Object.fromEntries([...document.querySelectorAll('iframe[data-embed]')].map(f => [f.dataset.embed, f]));
  const load = f => { if (!f.src) f.src = f.dataset.src; };
  const ready = new Map();
  const whenReady = name => {
    if (!ready.has(name)) { let done; ready.set(name, Object.assign(new Promise(r => (done = r)), {done})); }
    return ready.get(name);
  };
  const post = async (name, type, data = {}) => {
    load(frames[name]);
    await whenReady(name);
    frames[name].contentWindow.postMessage({arosa: type, ...data}, location.origin);
  };
  const goTo = el => el.scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'start'});
  const titled = address => document.querySelectorAll('[data-site-title]').forEach(t => { t.textContent = address; });
  const near = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { near.unobserve(e.target); load(e.target); } }), {rootMargin: '200px 0px'});
  const watchFrames = () => Object.values(frames).forEach(f => near.observe(f));
  if (document.readyState === 'complete') watchFrames(); else window.addEventListener('load', watchFrames, {once: true});
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data?.arosa) return;
    const name = Object.keys(frames).find(k => frames[k].contentWindow === event.source);
    if (!name) return;
    const {arosa: type, id, address, height} = event.data;
    if (type === 'ready') whenReady(name).done();
    // A growing window takes the height of its page, from the finished height it reserves, and never
    // shrinks, so the page below it does not move while its example runs.
    if (type === 'height' && frames[name].hasAttribute('data-grow')) frames[name].style.height = `${Math.max(Math.ceil(height), frames[name].offsetHeight)}px`;
    if (type === 'underwrite') { titled(address); goTo(frames.underwrite.closest('figure')); void post('underwrite', 'site', {id, start: true}); void post('building', 'site', {id}); }
    if (type === 'building') { titled(address); goTo(frames.building.closest('figure')); void post('building', 'site', {id}); void post('underwrite', 'site', {id}); }
  });
  // The underwriting starts its example the first time its window is well in view.
  if (frames.underwrite) new IntersectionObserver(([e], io) => { if (!e.isIntersecting) return; io.disconnect(); void post('underwrite', 'visible'); }, {threshold: 0.4}).observe(frames.underwrite);

  // ─── Live totals (the home page only) ───────────────────────────────────
  // Real totals from the app (/api/public/stats, proxied same-origin by Firebase Hosting), read once the page has
  // loaded and again every five minutes while the tab is open. The row is removed if they cannot load.
  const stats = document.getElementById('stats');
  if (stats) {
    const STATS = [['listingsScreened', 'Listings screened'], ['lotsMatched', 'NYC lots matched'], ['sourcesCited', 'Sources cited'], ['researchRuns', 'Research runs']];
    const read = async () => {
      const response = await fetch('/api/public/stats', {headers: {accept: 'application/json'}});
      if (!response.ok) throw new Error('Stats are unavailable.');
      return response.json();
    };
    const start = async () => {
      const [{mountStatTicker}, first] = await Promise.all([import('/stat-ticker.js'), read()]);
      const ticker = mountStatTicker(stats, {title: 'Arosa at work', stats: STATS.map(([key, label]) => ({label, value: first[key]}))});
      setInterval(() => { if (!document.hidden) read().then(next => STATS.forEach(([key], i) => ticker.set(i, next[key]))).catch(() => {}); }, 300000);
    };
    const begin = () => start().catch(() => { stats.hidden = true; });
    if (document.readyState === 'complete') begin(); else window.addEventListener('load', begin, {once: true});
  }
  document.getElementById('year').textContent = String(new Date().getFullYear());
})();
