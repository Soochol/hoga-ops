/**
 * design-tokens.ts — single source of truth for hoga-ops size + radius tokens.
 *
 * This file is hand-edited. To propagate changes:
 *   npm run gen:tokens
 * That command updates:
 *   - frontend/src/styles/tokens.generated.ts  (Tailwind theme.extend)
 *   - frontend/src/styles/tokens.css           (CSS size + radius sections)
 *   - DESIGN.md                                (typography / spacing / layout tables)
 *
 * Color tokens are NOT here. They live in tokens.css directly because
 * (a) they don't participate in the scale dial, (b) their shape ({ hex, rgba })
 * differs from size tokens, and (c) the design system intentionally treats
 * color as a separate concern from density.
 *
 * Two token shapes:
 *   - SIZE_TOKENS    — { rem, baseIntentPx, usage }
 *                     CSS emits as `<name>: <rem>rem;`. Scales with :root font-size.
 *                     Generator validates rem * 16 ≈ baseIntentPx (drift check).
 *   - FIXED_PX_TOKENS — { px, usage }
 *                     CSS emits as `<name>: <px>px;`. Does NOT scale with the dial
 *                     (per ADR-0011: small radii stay px to protect anti-aliasing).
 *
 * Naming-prefix → category mapping (enforced by the generator):
 *   text-*                  → typography  (Tailwind fontSize)
 *   space-*                 → spacing     (Tailwind spacing)
 *   h-*                     → layout-h    (Tailwind height)
 *   *-w, *-min-w            → layout-w    (Tailwind width / minWidth)
 *   radius-*                → fixed-px    (Tailwind borderRadius)
 *
 * Tokens that don't match any prefix fail the generator's name-check.
 */

/**
 * Rendered root font-size (px) at default density — MUST mirror the scale
 * dial (`:root { font-size }`) in tokens.css. The generator uses it for
 * "rendered @ default" comments/tables; `util/chartScale.ts` derives the
 * canvas font/offset from it (lightweight-charts can't read CSS rem).
 * 18px = 1.125× of the 16px base intent (2026-07-15, was 20px = 1.25×).
 */
export const RENDERED_ROOT_PX = 18;

export type SizeToken = Readonly<{
  /** rem value emitted into CSS. Single source of truth for size. */
  rem: number;
  /** Original pixel intent at 1.0× density (16px root). Documents design intent. */
  baseIntentPx: number;
  /** Short human-readable purpose. Powers the DESIGN.md table's "Use" column. */
  usage: string;
}>;

export type FixedPxToken = Readonly<{
  /** Absolute pixel value emitted into CSS. Does not scale with the dial. */
  px: number;
  /** Short human-readable purpose. */
  usage: string;
}>;

export const SIZE_TOKENS = {
  // ── typography ────────────────────────────────────────────────
  // `text-badge` sits below text-xs to preserve hierarchy on micro-labels
  // like the SymbolSearch market tag (KOSPI/KOSDAQ). 8.5px base intent.
  'text-badge': { rem: 0.53125, baseIntentPx: 8.5, usage: 'Hierarchical badges (e.g., SymbolSearch market tag)' },
  'text-xs':    { rem: 0.65625, baseIntentPx: 10.5, usage: 'Small-caps labels, badges' },
  'text-sm':    { rem: 0.71875, baseIntentPx: 11.5, usage: 'Table rows, secondary mono values' },
  'text-base':  { rem: 0.8125,  baseIntentPx: 13,   usage: 'Body / UI default' },
  'text-md':    { rem: 0.875,   baseIntentPx: 14,   usage: 'Section / page headings' },
  'text-lg':    { rem: 1,       baseIntentPx: 16,   usage: 'Brand text' },
  'text-xl':    { rem: 1.375,   baseIntentPx: 22,   usage: 'Current price (price strip)' },
  'text-2xl':   { rem: 2,       baseIntentPx: 32,   usage: 'Future hero numerics' },

  // ── spacing (4px base intent unit) ─────────────────────────────
  'space-2xs':  { rem: 0.125,   baseIntentPx: 2,    usage: 'Hairline gaps' },
  'space-xs':   { rem: 0.25,    baseIntentPx: 4,    usage: 'Pane gap, tight stacking' },
  'space-sm':   { rem: 0.5,     baseIntentPx: 8,    usage: 'Card padding inside, gap between sidebar cards' },
  'space-md':   { rem: 0.75,    baseIntentPx: 12,   usage: 'Card padding default' },
  'space-lg':   { rem: 1,       baseIntentPx: 16,   usage: 'Section spacing, nav item padding' },
  'space-xl':   { rem: 1.5,     baseIntentPx: 24,   usage: 'Major section dividers' },
  'space-2xl':  { rem: 2,       baseIntentPx: 32,   usage: '(rarely used)' },
  'space-3xl':  { rem: 3,       baseIntentPx: 48,   usage: '(rarely used)' },

  // ── layout — heights ──────────────────────────────────────────
  'h-tab':              { rem: 2,       baseIntentPx: 32, usage: 'Tab strip main tab height' },
  'h-tab-secondary':    { rem: 1.875,   baseIntentPx: 30, usage: 'Secondary action button — intentionally 2px shorter than main tab' },
  'h-toolbar':          { rem: 3.75,    baseIntentPx: 60, usage: 'Replay-page toolbar row' },
  'h-pricestrip':       { rem: 3.25,    baseIntentPx: 52, usage: 'Current-price strip below toolbar' },
  'h-orderbook-row':    { rem: 1.375,   baseIntentPx: 22, usage: 'Single row in the orderbook table' },
  'h-capture-row':      { rem: 2.25,    baseIntentPx: 36, usage: 'Single row in the capture queue' },
  'h-live-header':      { rem: 2,       baseIntentPx: 32, usage: 'Live page header row' },
  'h-top-nav':          { rem: 2,       baseIntentPx: 32, usage: 'Global top navigation row' },

  // ── layout — widths ───────────────────────────────────────────
  'sidebar-w':          { rem: 20,      baseIntentPx: 320, usage: 'Cursor sidebar on the right of replay viewer' },
  'combobox-min-w':     { rem: 13.75,   baseIntentPx: 220, usage: 'Stock combobox trigger minimum width' },
  'dropdown-min-w':     { rem: 20,      baseIntentPx: 320, usage: 'Combobox / search dropdown minimum width' },
  'watchlist-panel-w':  { rem: 17.5,    baseIntentPx: 280, usage: 'Global Watchlist Panel (Right Rail) width' },
  'rail-w':             { rem: 3,       baseIntentPx: 48,  usage: 'Right Rail icon column width (fixed)' },
} as const satisfies Record<string, SizeToken>;

export const FIXED_PX_TOKENS = {
  // Radii intentionally stay in absolute px (ADR-0011). They do not scale with
  // the density dial — sub-pixel radii blur on standard displays and small
  // radii visually changing is more disruptive than helpful.
  'radius-sm':   { px: 2,    usage: 'Rarely used' },
  'radius-md':   { px: 4,    usage: 'Presets, small buttons' },
  'radius-lg':   { px: 6,    usage: 'Cards, inputs, buttons (default)' },
  'radius-full': { px: 9999, usage: 'Status dots, avatars' },
} as const satisfies Record<string, FixedPxToken>;

/**
 * Type-level export of all token names. Component code that wants to refer
 * to a token by name in a type-safe way can use this union.
 */
export type SizeTokenName = keyof typeof SIZE_TOKENS;
export type FixedPxTokenName = keyof typeof FIXED_PX_TOKENS;
export type TokenName = SizeTokenName | FixedPxTokenName;
