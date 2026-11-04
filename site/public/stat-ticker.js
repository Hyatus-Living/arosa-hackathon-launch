// Stat ticker: a titled band whose counters scroll past in a loop and roll their digits when a value
// changes. Styles live in stat-ticker.css. Values only change through set(), from real data.
//
// mountStatTicker(element, {
//   title: 'Arosa at work',
//   stats: [{ label: 'Listings screened', value: 15719 }, ...],
//   loop: 40, // seconds for one full pass
// })

const ROLL_MS = 700;
const format = (n) => n.toLocaleString('en-US');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// One rendered copy of a number. Cells are kept right to left, so a new leading digit is added
// without disturbing the ones already showing.
function rollingNumber(pill, animate) {
  const spoken = el('span', 'ticker-sr');
  const digits = el('span', 'ticker-digits');
  digits.setAttribute('aria-hidden', 'true');
  pill.append(spoken, digits);
  const cells = [];

  function roll(cell, d) {
    const { strip } = cell;
    if (!animate) {
      strip.style.transform = `translateY(-${d}em)`;
      cell.at = d;
      return;
    }
    // Continue from wherever the strip is now, folded back into the first 0-9 run, and always
    // roll forward: the strip holds 0-9 twice, so 9 to 0 moves down to the second 0.
    const height = cell.box.offsetHeight || 1;
    const now = -new DOMMatrixReadOnly(getComputedStyle(strip).transform).m42 / height;
    const from = now % 10;
    strip.style.transition = 'none';
    strip.style.transform = `translateY(-${from}em)`;
    strip.offsetHeight; // commit the fold before rolling on
    const to = d >= from ? d : d + 10;
    strip.style.transition = `transform ${ROLL_MS}ms var(--ticker-ease)`;
    strip.style.transform = `translateY(-${to}em)`;
    cell.at = d;
  }

  return function render(value) {
    const text = format(value);
    spoken.textContent = text;
    for (let i = 0; i < text.length; i++) {
      const ch = text[text.length - 1 - i];
      const isDigit = ch >= '0' && ch <= '9';
      let cell = cells[i];
      if (!cell) {
        cell = isDigit ? { box: el('span', 'ticker-digit'), at: -1 } : { box: el('span', 'ticker-sep', ch) };
        if (isDigit) {
          cell.strip = el('span', 'ticker-strip', '01234567890123456789');
          cell.box.append(cell.strip);
        }
        cells.push(cell);
        digits.prepend(cell.box);
      }
      if (isDigit && cell.at !== Number(ch)) roll(cell, Number(ch));
    }
  };
}

export function mountStatTicker(root, { title, stats, loop = 40 }) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const values = stats.map((s) => s.value);
  const renderers = stats.map(() => []);

  root.classList.add('ticker');
  root.toggleAttribute('data-still', still);
  const view = el('div', 'ticker-window');
  const heading = el('span', 'ticker-title');
  const live = el('span', 'ticker-live');
  live.setAttribute('aria-hidden', 'true');
  heading.append(live, title);
  root.replaceChildren(heading, el('span', 'ticker-rule'), view);
  root.children[1].setAttribute('aria-hidden', 'true');
  const track = el('div', 'ticker-track');
  view.append(track);

  function addSet(hidden) {
    const set = el('div', 'ticker-set');
    if (hidden) set.setAttribute('aria-hidden', 'true');
    stats.forEach((s, i) => {
      const pill = el('span', 'ticker-pill');
      const item = el('span', 'ticker-stat');
      item.append(el('span', 'ticker-label', s.label), pill);
      set.append(item);
      const render = rollingNumber(pill, !still);
      render(values[i]);
      renderers[i].push(render);
    });
    track.append(set);
    return set;
  }

  const set = (i, value) => {
    values[i] = value;
    renderers[i].forEach((render) => render(value));
  };

  const first = addSet(false);
  if (still) return { set, destroy() {} };

  view.setAttribute('role', 'marquee');
  view.setAttribute('aria-label', `${title}, focus to pause`);
  view.tabIndex = 0;

  // Repeat the set until one copy is wider than the window, then double it so -50% loops seamlessly.
  let copies = 1;
  while (first.offsetWidth * copies < view.offsetWidth && copies < 8) {
    addSet(true);
    copies++;
  }
  for (let c = 0; c < copies; c++) addSet(true);

  const pass = track.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-50%)' }], {
    duration: loop * 1000 * copies,
    iterations: Infinity,
  });

  // Hover or focus glides the loop to a stop and back rather than freezing it.
  let want = 1;
  let easing = 0;
  let last = 0;
  const glide = (now) => {
    const dt = last ? now - last : 16;
    last = now;
    const rate = pass.playbackRate + (want - pass.playbackRate) * (1 - Math.exp(-dt / 200));
    pass.playbackRate = Math.abs(want - rate) < 0.01 ? want : rate;
    easing = pass.playbackRate === want ? 0 : requestAnimationFrame(glide);
    if (!easing) last = 0;
  };
  const steer = () => {
    want = view.matches(':hover') || view.matches(':focus-visible') ? 0 : 1;
    if (!easing) easing = requestAnimationFrame(glide);
  };
  for (const type of ['pointerenter', 'pointerleave', 'focus', 'blur']) view.addEventListener(type, steer);

  return {
    // push a real value from outside, e.g. a live count from the app
    set,
    destroy() {
      pass.cancel();
    },
  };
}
