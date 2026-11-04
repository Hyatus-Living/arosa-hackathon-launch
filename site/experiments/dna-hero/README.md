# Helix ribbon and stat ticker

Both pieces are live on witharosa.ai and mounted by `site/public/motion.js`: the helix ribbon in the
hero, and the stat ticker under it, fed by `/api/public/stats` (see docs/arosa-deployment.md). This
page previews them with fixed sample values.

Preview: `python3 -m http.server -d site 4317`, then open
`http://127.0.0.1:4317/experiments/dna-hero/`. Query flags: `?theme=light`, `?reference` (comparison colors),
`?clean` (hide the copy), `?ticker` (scroll to the band).

## Helix ribbon (`site/public/helix-ribbon.js`)

A 2D canvas of thin strands coiling around a swaying centerline, tilted across the hero.

```js
import { mountHelixRibbon } from './helix-ribbon.js';
const ribbon = mountHelixRibbon(canvas, { tilt: -28, strands: 24 }); // any DEFAULTS key
ribbon.refreshColors(); // after a theme switch
```

- Colors come from CSS on the canvas: `--ribbon-from`, `--ribbon-to`, `--ribbon-spark`
  (comma-separated list). The demo points them at the theme tokens (`--line` to `--ink-muted`,
  streaks in `--accent`), so a theme switch only needs `refreshColors()`.
- Pauses off screen, caps the pixel ratio (1.5 on small screens), and draws one still frame under
  `prefers-reduced-motion`. `renderAt(seconds)` draws a fixed frame for posters.

## Stat ticker (`site/public/stat-ticker.js`, `stat-ticker.css`)

A titled band whose counters scroll in a loop and roll their digits when a value changes.

```js
import { mountStatTicker } from './stat-ticker.js';
const ticker = mountStatTicker(element, {
  title: 'Arosa at work',
  stats: [{ label: 'Listings screened', value: 15719 }],
  loop: 40,
});
ticker.set(0, 15730); // a fresh real count rolls the digits
```

- Monochrome: figures in `--ink` on hairline chips, with `--success` only on the live dot by the
  title. `--ticker-number`, `--ticker-pill` and `--ticker-pill-line` tint the chips if wanted.
- Hover or keyboard focus glides the scroll to a stop. Reduced motion shows one static row.
- Values change only through `set()`; nothing counts up on its own.
