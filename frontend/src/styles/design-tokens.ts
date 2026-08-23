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
 * 16px = 1.0× of the 16px base intent — the "Compact" density DESIGN.md had
 * parked in its backlog (2026-08-07; was 18px = 1.125× since 2026-07-15, and
 * 20px = 1.25× before that). At 1.0× the rendered px equals `baseIntentPx`,
 * so the two columns of the typography table now coincide.
 */
export const RENDERED_ROOT_PX = 16;

/**
 * Font stack for `<canvas>` surfaces — lightweight-charts axis/legend text and
 * the chart drawing labels. Canvas cannot read CSS custom properties, so the
 * stack is spelled out here instead of going through `var(--font-ui)`.
 *
 * MUST mirror `--font-ui` in tokens.css. One constant, two consumers
 * (`util/chartScale.ts`, `chart/drawing/render.ts`) so they cannot drift —
 * before 2026-07-21 they held three different hardcoded stacks between them and
 * the library default, and none matched the app.
 *
 * Caveat: canvas 2D has no `font-feature-settings` equivalent, so canvas digits
 * are Pretendard's *proportional* figures — `tnum` reaches DOM surfaces only.
 * Axis labels are right-aligned in their own column, so this costs alignment
 * between stacked labels, not within a row.
 */
export const CANVAS_FONT_STACK =
  "'Pretendard Variable', Pretendard, ui-sans-serif, system-ui, sans-serif";

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
  /**
   * Marks the rung that the *bare* utility resolves to (`rounded`, no suffix).
   * Exactly one radius token may set it — the generator enforces that.
   *
   * Why this exists: without a `DEFAULT` key Tailwind keeps its own built-in
   * value for the bare utility, and that value is **rem-based**. `rounded` was
   * therefore the single most-used radius in the app (143 call sites) *and* the
   * only one outside the token system — rendering 4.5px at the then-18px dial
   * and moving with it, which ADR-0011 exists to prevent. A hole in the map is not
   * a neutral omission; the framework fills it.
   */
  isDefault?: true;
}>;

export const SIZE_TOKENS = {
  // ── typography ────────────────────────────────────────────────
  // `text-badge` sits below text-xs to preserve hierarchy on micro-labels
  // like the SymbolSearch market tag (KOSPI/KOSDAQ). 8.5px base intent.
  'text-badge': { rem: 0.53125, baseIntentPx: 8.5, usage: 'Hierarchical badges (e.g., SymbolSearch market tag)' },
  // badge 와 xs 사이의 공백을 메우는 밀집 크롬 마이크로 라벨. 이 구간에 토큰이 없어
  // 10px·10.5px 하드코딩 39곳이 밀도 다이얼을 이탈해 있었다(2026-08-04 토큰화 스윕에서
  // 신설). 신설 당시 다이얼은 1.125× 라 badge 9.56 / 2xs 10.125 / xs 11.81px 로 렌더됐고
  // 하드코딩 10px 과 시각 등가였다 — 그 등가는 **그때 밀도의 성질**이다. 2026-08-07 에
  // 다이얼이 1.0× 로 내려가 지금은 8.5 / 9 / 10.5px 다. 세 토큰의 **간격 비율**은 rem
  // 이 보존하므로 위계는 그대로다.
  'text-2xs':   { rem: 0.5625,  baseIntentPx: 9,   usage: 'Dense chrome micro-labels (창 크롬 서브라벨·상태 칩)' },
  'text-xs':    { rem: 0.65625, baseIntentPx: 10.5, usage: 'Small-caps labels, badges' },
  'text-sm':    { rem: 0.71875, baseIntentPx: 11.5, usage: 'Table rows, secondary data values' },
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
  'h-toolbar':          { rem: 2,       baseIntentPx: 32, usage: 'Workspace toolbar row — ui/WorkspaceShell.tsx WorkspaceToolbar, 소비처는 /live 의 WorkspaceLiveToolbar. 밀도 개편(2026-07-23) 60→32, 한 줄 버튼 행' },
  'list-row-min-h':     { rem: 1.5625,  baseIntentPx: 25, usage: 'Shared list row min-height — watchlist/ranking/screener-result rows align (25px @ the 1.0× dial; was ≈28px at 1.125×, which is the watchlist row it was matched to). Heatmap rows opt out for max density.' },
  'list-group-header-min-h': { rem: 1.8125, baseIntentPx: 29, usage: 'Shared list group-header min-height — watchlist/heatmap group headers align (29px @ the 1.0× dial; was ≈32px at 1.125×)' },
  'h-capture-row':      { rem: 2.25,    baseIntentPx: 36, usage: 'Single row in the capture queue' },
  // 이름과 달리 /live 는 이 밴드를 쓴 적이 없다(LiveStatusBar 폐지). 마지막 소비처는
  // /study 의 헤더였고 그마저 min-h-12(3rem)를 얹어 실효 높이가 이 토큰이 아니라
  // 48px 였다 — 즉 이 값은 **한 번도 화면을 정한 적이 없다**. 2026-08-23 그 페이지와
  // 함께 소비처가 0 이 됐다.
  'h-live-header':      { rem: 2,       baseIntentPx: 32, usage: '⚠ 소비처 0 — 유일한 소비자 WorkspaceHeader 가 /study 와 함께 삭제됐다(2026-08-23). 토큰 제거는 디자인 시스템 패스에서(DESIGN.md 소관이라 코드 삭제와 함께 처리하지 않았다).' },
  'h-top-nav':          { rem: 2,       baseIntentPx: 32, usage: 'Global top navigation row' },
  'h-bottom-bar':       { rem: 1.5,     baseIntentPx: 24, usage: 'Global market-index bottom bar row' },

  // ── layout — widths ───────────────────────────────────────────
  'sidebar-w':          { rem: 20,      baseIntentPx: 320, usage: '/inventory master-detail 좌열 폭 (pages/Inventory.tsx)' },
  'dropdown-min-w':     { rem: 20,      baseIntentPx: 320, usage: 'Combobox / search dropdown minimum width' },
  'watchlist-panel-w':  { rem: 17.5,    baseIntentPx: 280, usage: 'Global Watchlist Panel (Right Rail) width' },
  'rail-w':             { rem: 3,       baseIntentPx: 48,  usage: 'Right Rail icon column width (fixed)' },
  'app-floor-min-w':    { rem: 59,      baseIntentPx: 944, usage: 'App shell responsive floor — below this the shell stops compressing and scrolls horizontally' },
  'app-floor-min-h':    { rem: 39,      baseIntentPx: 624, usage: 'App shell vertical floor — /live windows scale with the canvas, so the canvas needs a readable height floor (ADR-0122)' },
} as const satisfies Record<string, SizeToken>;

export const FIXED_PX_TOKENS = {
  // Radii intentionally stay in absolute px (ADR-0011). They do not scale with
  // the density dial — sub-pixel radii blur on standard displays and small
  // radii visually changing is more disruptive than helpful.
  // `tailwind.config.ts` 는 borderRadius 를 `extend` 가 아니라 **교체**한다(Tailwind
  // 기본 스케일의 rem 기반 xl/2xl/3xl 을 도달 불가로 만들기 위해). 교체 스케일에는
  // `none` 이 반드시 있어야 한다 — 없으면 `rounded-none`·`rounded-r-none` 이 에러가
  // 아니라 **CSS 미생성**으로 조용히 사라지고, 한쪽만 둥근 막대(BookPanel 잔량 바)가
  // 양쪽 다 둥글어진다.
  'radius-none': { px: 0,    usage: 'Explicit square corners — `rounded-none` and its per-corner variants' },
  'radius-sm':   { px: 2,    usage: 'Hairline bars, dense badges' },
  // `isDefault` → bare `rounded`. 4px (not 6) because the 143 existing bare
  // call sites were rendering at Tailwind's 4.5px: snapping to `md` moves them
  // 0.5px (visually equivalent) while snapping to `lg` would round every one of
  // them by +33%. Same reasoning as the `text-2xs` decision (2026-08-04) —
  // close the hole at the value that is already on screen, don't restyle the
  // app as a side effect of fixing a leak.
  'radius-md':   { px: 4,    usage: 'Default (bare `rounded`) — chips, small buttons, presets', isDefault: true },
  'radius-lg':   { px: 6,    usage: 'Cards, modals, inputs, larger panels' },
  'radius-full': { px: 9999, usage: 'Status dots, avatars' },
} as const satisfies Record<string, FixedPxToken>;

/**
 * Type-level export of all token names. Component code that wants to refer
 * to a token by name in a type-safe way can use this union.
 */
export type SizeTokenName = keyof typeof SIZE_TOKENS;
export type FixedPxTokenName = keyof typeof FIXED_PX_TOKENS;
export type TokenName = SizeTokenName | FixedPxTokenName;
