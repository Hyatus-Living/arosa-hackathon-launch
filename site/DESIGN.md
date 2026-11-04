# witharosa.ai design contract

Inherits the HyatusOS marketing contract (gpt-guest-mono-repo/hyatus.ai/DESIGN.md): monochrome and
flat. The day view is the default here; a saved night view in `localStorage.theme` wins.

- Palette: OKLCH only. The `--mono` ramp (0.985 to 0.145, chroma 0) feeds the semantic tokens
  `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--ink`, `--ink-muted`, `--ink-faint`, `--line`,
  `--accent`, `--accent-ink`. The accent is near-black in light and near-white in dark, reserved for
  primary actions, key figures, live indicators and focus. No brand hue, no gradients, no halos.
- Type: Geist for everything, headings at weight 500 with tracking -0.02em to -0.03em and
  `text-wrap: balance`; Geist Mono only for data labels, times, window chrome and counters.
- Surfaces: product windows are `--surface` with a hairline `--line` border and 12 to 16px radii;
  the hero window is the only shadowed element. Elevation in dark comes from lighter surfaces.
- Motion: ease-out-expo (`cubic-bezier(0.16, 1, 0.3, 1)`), entrances from an already visible
  default, reduced motion collapses every loop to its resting state.
- Copy: the product's own language; claims come from PRODUCT.md and the app's documentation.
  Curated figures are starting points to verify, never determinations.
- Product windows: the app's own views (`public/demo`, built on `public/app`) on example data, framed
  in the window chrome with a chip that says they are examples. Inside a window the app's own design
  rules apply, so state color appears there exactly as in the app; the page around it stays monochrome.
