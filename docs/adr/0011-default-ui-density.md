# 0011 — Default UI density is 1.25× base intent

**Status:** accepted (2026-05-22)

## Decision

The hoga-ops frontend ships with a default density of **1.25×** of the
original `DESIGN.md` pixel intent. This is implemented as a single CSS
dial — `:root { font-size: 20px }` in `frontend/src/styles/tokens.css` —
that scales every rem-based token (typography, spacing, layout widths)
uniformly. `lightweight-charts` canvas options live in
`frontend/src/util/chartScale.ts` as static constants outside the dial
and must be updated alongside any future density change.

User-facing density toggles (Compact / Comfortable / Cozy) are not built;
the architecture supports them but the UI is deferred.

## Why

- **Lived experience.** The 1.0× density that the original DESIGN.md
  encoded (body text 13px, `--space-md` 12px, "comfortable-tight") was
  consistently judged too dense in actual analyst use. Browser zoom 125%
  produced a visibly better experience.
- **Single-user tool.** With one user, shipping a sensible default is
  more valuable than building density chrome. The toggle UI is dead code
  until there is a second user to disagree with the default.
- **Single dial keeps the option open.** Centralizing scale on
  `:root font-size` means a future toggle is a one-line CSS variable
  change (plus a `chartScale.ts` sync) rather than a system-wide
  refactor.

## Why the chart is separate from the dial

`lightweight-charts` renders to `<canvas>` and does not inherit CSS
sizing. Three options were considered:

1. Make `chartScale.ts` read `:root font-size` and scale dynamically.
2. Define a `--chart-font-size` CSS variable consumed by
   `chartScale.ts` via the `util/tokens.ts` pattern.
3. Keep `chartScale.ts` as static constants and update them alongside
   any CSS dial change.

Option 3 won on simplicity grounds. Options 1 and 2 add a chart
re-creation / `applyOptions` mechanism that only pays for itself when
a density toggle UI exists. Until that day, static constants are
truthful: "the chart is at the current default density; if you change
the dial, update this file too."

## What changes

- `frontend/src/styles/tokens.css` lifts `:root font-size` to 20px;
  `--space-*` tokens converted to rem; new layout tokens (`--nav-w`,
  `--sidebar-w`, `--h-tab`, etc.) added; new `--text-badge` token
  added for hierarchical badges.
- `frontend/tailwind.config.ts` registers the new utilities
  (`w-sidebar`, `h-tab`, `min-w-combobox`, `text-badge`, etc.).
- `frontend/src/util/chartScale.ts` (new) holds chart options.
- ~17 component files migrated from hardcoded px / Tailwind arbitrary
  values to token-based classes. Off-grid hardcodes classified as
  intentional design difference (preserved via dedicated token, e.g.,
  `--h-tab-secondary` for the 2px-shorter TabStrip secondary button)
  or drift (normalized to design value).
- `DESIGN.md` gains a `## Scale Factor` section explaining the dial
  mechanism, scope, and future-density hook. Aesthetic Direction
  gains a "Density posture" bullet reconciling the original
  "denser than typical SaaS" intent with the new shipped default.
  Typography and Spacing token tables adopt a 2-column "Base intent /
  Rendered @ default" structure. Components section receives a
  disclaimer reframing existing px values as 1.0× base intent.
- `docs/superpowers/designs/2026-05-20-replay-viewer.html` gets a
  top-of-file comment block labeling it as 1.0× reference.

## Consequences worth flagging for future readers

- **The mockup is no longer "what the app currently looks like".** It is
  the 1.0× base-intent reference. To see current rendering, run the dev
  server or read DESIGN.md's "Rendered @ default" columns.
- **Adding a density toggle UI requires touching both CSS and chart.**
  The Scope-of-the-dial limitation is intentional; do not paper over
  it by silently changing `chartScale.ts` to read CSS variables — that
  is a separate, larger decision (see "Why the chart is separate").
- **Future component additions** should reference design tokens
  exclusively. The verification grep
  (`text-\[ | w-\[[0-9] | h-\[[0-9] | style=\{\{`) finds violations.
  Run before merging UI changes.
- **OS font preference does not affect us.** `:root font-size: 20px` is
  an absolute value, not `em`/percent. Users who scale their OS fonts
  for accessibility get no relief from us today; consider switching to
  `em`-based dial if accessibility surfaces.

## Source spec

`docs/superpowers/specs/2026-05-22-default-ui-scale-up-design.md`
