# 0012 — Design tokens have a single TypeScript source

**Status:** accepted (2026-05-22)

## Decision

Size, spacing, layout, and radius tokens for the frontend live in **one**
TypeScript file — `frontend/src/styles/design-tokens.ts`. A generator
(`frontend/scripts/gen-tokens.ts`, invoked via `npm run gen:tokens`)
emits three downstream artifacts from this source:

1. `frontend/src/styles/tokens.generated.ts` — Tailwind `theme.extend`
   payload (imported by `tailwind.config.ts`).
2. `frontend/src/styles/tokens.css` (size + radius + layout sections,
   between BEGIN/END AUTO-GENERATED markers) — CSS custom properties
   for the browser.
3. `DESIGN.md` (typography and spacing tables, between marker comments) —
   human-readable design-system documentation.

Color tokens, font-family tokens, and the `:root font-size` scale dial
remain hand-edited in `tokens.css` and `tailwind.config.ts`. They do not
flow through `design-tokens.ts`.

The generator validates each `SIZE_TOKEN` against `rem × 16 ≈ baseIntentPx`
and aborts on drift. It also validates that token names obey a fixed
naming-prefix convention (`text-`, `space-`, `h-`, `-w`, `-min-w`,
`radius-`) so future tokens cannot be silently miscategorized.

Generated artifacts are committed to git. CI verifies they match the
output of `npm run gen:tokens` (TODO when CI exists).

## Why

- **Locality.** Adding or renaming a size token used to touch three files:
  `tokens.css`, `tailwind.config.ts`, and `DESIGN.md`. The 2026-05-22
  scale-up work (~17 components migrated) repeatedly tripped on this:
  one file edited, another forgotten; `--row-*-h` vs `--h-*` naming
  drift; off-by-one normalization (`borderRadius: 6 → rounded-md` when
  `rounded-lg` was intended). All three classes of mistake were caught
  only by human reviewers. A single source removes them by construction.
- **Test surface aligned with the interface.** The previous
  `tokens.test.ts` read `tokens.css` from disk via `node:fs` and asserted
  with regex — a brittle test against the wrong layer, and the source of
  ESM `__dirname` plumbing noise. The deepened version asserts directly
  against the TypeScript registry (`SIZE_TOKENS['text-base'].rem === 0.8125`)
  with strong types catching name typos at compile time.
- **Deletion test.** Imagine deleting `design-tokens.ts`. The duplicated
  information would re-appear across three files, each with their own
  drift potential. The module is earning its keep — it is not a
  pass-through.

## Why color tokens are NOT in the registry

Three reasons, in order of weight:

1. Colors do not participate in the density dial. They have no `rem` /
   `baseIntentPx` shape; they have `{ hex, rgba }`. Merging them would
   force a union type that bloats every consumer's switch statement.
2. Colors already have a single source (`tokens.css` color sections),
   used by both browser CSS and by `util/tokens.ts`'s runtime CSS-var
   resolver that bridges to `lightweight-charts` canvas color strings.
   Moving them would either break that bridge or duplicate the values.
3. The design system intentionally treats color and size as separate
   concerns — DESIGN.md's "Color" and "Spacing" sections are organized
   around this split. Maintaining the split in code keeps the
   documentation honest.

## Why radius tokens use a separate shape (`FixedPxToken`)

Radii (2/4/6px and 9999px for circles) are intentionally absolute
px — they do not scale with the density dial. ADR-0011 spelled this
out: sub-pixel radii blur on standard displays. The `FIXED_PX_TOKENS`
shape `{ px, usage }` captures this without forcing them through a
`rem` field they don't need. The generator emits them into `tokens.css`
with the comment `intentionally fixed px — see ADR-0011`.

## Consequences worth flagging for future readers

- **`tokens.css` and `tokens.generated.ts` are generated.** A header
  comment (`AUTO-GENERATED — do not edit`) marks both. Editing them by
  hand will be overwritten on the next `npm run gen:tokens`. The
  color/font-family/scale-dial sections of `tokens.css` (outside the
  BEGIN/END AUTO-GENERATED markers) remain hand-edited.
- **Adding a new size token requires one edit.** Add an entry to
  `SIZE_TOKENS` in `design-tokens.ts`, then `npm run gen:tokens`, then
  commit both the source and the generated outputs.
- **The naming convention is load-bearing.** A token named, say,
  `'panel-h'` (not `'h-panel'`) fails the generator's classification
  step. This is intentional — the prefix is what tells the generator
  which Tailwind utility group to put it in.
- **Drift validation is exact.** `Math.abs(rem * 16 - baseIntentPx) <
  0.001` — tightening past this is brittle for floating-point reasons,
  loosening past this hides real drift.
- **DESIGN.md layout-token table not yet auto-generated.** The
  generator has the code path but the markers
  (`<!-- BEGIN AUTO: tokens-layout -->`) aren't placed in `DESIGN.md`
  yet. Add them when a layout-token reference table is welcome in the
  document — until then the generator skips that section with a warning
  rather than failing.

## What changed

- `frontend/src/styles/design-tokens.ts` (new) — single source.
- `frontend/scripts/gen-tokens.ts` (new) — generator.
- `frontend/src/styles/tokens.generated.ts` (new, generated) — Tailwind
  theme payload.
- `frontend/src/styles/tokens.css` — size/radius/layout sections rewritten
  between BEGIN/END markers; color/font-family/scale-dial sections
  preserved.
- `frontend/tailwind.config.ts` — spreads `TAILWIND_THEME` from the
  generated module; manual size/spacing/layout entries removed.
- `frontend/tests/unit/tokens.test.ts` — rewritten to assert against the
  TypeScript registry directly (no more `node:fs` reads).
- `frontend/package.json` — adds `gen:tokens` script (`node --experimental-strip-types`).
- `DESIGN.md` — typography and spacing tables wrapped in marker pairs and
  rewritten by the generator.

## Source spec

This decision was reached during a `/improve-codebase-architecture`
grilling session on 2026-05-22, immediately after the default-density
shift work (ADR-0011). The grilling decisions:

- D1 — Build-time script (chosen over runtime / vite plugin / drift-only).
- D2 — Generation scope includes CSS + Tailwind + DESIGN.md (chosen over
  CSS+Tailwind only, or DESIGN.md done manually).
- D3 — Token entry shape `{ rem, baseIntentPx, usage }` (chosen over
  minimal-value-only or explicit-everything-metadata).
- D4 — One-time sweep + tokens.test.ts full rewrite + generated files
  committed to git.
- D6 — Radius tokens get a separate `FixedPxToken` shape inside the same
  source file.
- D7 — Generator validates `rem × 16 ≈ baseIntentPx` drift.
- D8 — Generator emits a TypeScript module (typed) rather than JSON.
