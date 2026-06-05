# Design System — hoga-ops

**Created:** 2026-05-20 via `/design-consultation`
**Project:** hoga-ops — Korean stock orderbook + trade replay analysis tool
**Approved mockup (at 1.0× base intent):** `docs/superpowers/designs/2026-05-20-replay-viewer.html`

## Product Context

- **What this is:** Single-user local desktop tool that captures Korean stock orderbook + trade replay data from `hogaplay.com` and exposes it for analysis through a browser frontend.
- **Who it's for:** The single user (analyst/researcher) running the tool on their own machine. No external audience.
- **Space/industry:** Financial market microstructure analysis — KRX cash equities, orderbook replay.
- **Project type:** Local desktop web app, analyst workstation.
- **Memorable thing:** "A trading desk that feels modern, not 1990s — information density that stays readable."

## Scale Factor

The design system has a **single density dial** at `:root font-size`.

| Term | Meaning |
|---|---|
| **Base intent (1.0×)** | The pixel target captured in token rem values, calibrated against a 16px root. Reflects the original 2026-05-20 design intent. |
| **Default density (1.25×)** | What the app renders at browser zoom 100%. `:root { font-size: 20px }` lifts every rem-based token by 1.25×. |
| **Scale dial** | The `:root font-size` declaration in `frontend/src/styles/tokens.css`. Changing it shifts all CSS sizing uniformly. |

**Scope of the dial:**
- ✅ CSS-rendered chrome — fonts, spacing, layout widths, line-heights (all rem-based).
- ❌ `lightweight-charts` canvas — text and bar spacing live in `frontend/src/util/chartScale.ts` as static constants. Must be updated alongside the dial.
- ❌ 1px borders, hairlines, small radii (2–6px), chart canvas internal coordinates — stay in px to protect anti-aliasing and pixel-grid sharpness.

**Future density modes (backlog):** A user-facing toggle (Compact 1.0× / Comfortable 1.25× / Cozy 1.4×) would set `:root font-size` via `[data-density="..."]` and require `chartScale.ts` values updated in lockstep. Not in scope today.

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian × Modern Professional ("Modern Trading Lab")
- **Decoration level:** Minimal-intentional — typography does the work. Single accent color. No patterns, textures, gradients, or decorative blobs.
- **Mood:** Serious. Information-first. The product should feel like a precision tool, not a SaaS dashboard. Closer in spirit to Linear than to a Y Combinator startup landing page.
- **Reference points:** TradingView (chart syntax), Linear (UI restraint), Vercel (typography), Bloomberg (data density — but without the 1990s color palette).
- **Density posture:** Ships at a comfortable density (1.25× of base intent) that approaches typical-SaaS sizing. The original 1.0× intent (`denser than typical SaaS`, Bloomberg-leaning) is preserved in the token system and reachable through a future Compact density toggle. The product DNA is "Linear-like restraint" at the chosen density, not "must always be small."

## Typography

- **Display / Hero / Brand:** Geist Sans 600 — bold but neutral, distinctive without being decorative.
- **Body / UI labels:** Geist Sans 400–500 — same family as Display for visual continuity.
- **UI / Labels:** Same as body. Small-caps section headers use 10.5px / 600 weight / `0.08em` letter-spacing / uppercase.
- **Data / Tables / All numbers:** Geist Mono 400–500 — must use `font-variant-numeric: tabular-nums`. Every numeric value in the product is monospace for column alignment.
- **Code (future, if any):** Geist Mono — same as data, no second mono.

- **Loading strategy:** Google Fonts CDN in v1 (`@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap')`). Self-host as v1+1 if network latency becomes annoying on cold start.

- **Scale (rem-based, single dial at `:root font-size`):**

<!-- BEGIN AUTO: tokens-typography -->
| Token | Base intent (1.0×) | Rendered @ default (1.25×) | Use |
|---|---|---|---|
| `badge` | 8.5px | 10.625px | Hierarchical badges (e.g., SymbolSearch market tag) |
| `xs` | 10.5px | 13.125px | Small-caps labels, badges |
| `sm` | 11.5px | 14.375px | Table rows, secondary mono values |
| `base` | 13px | 16.25px | Body / UI default |
| `md` | 14px | 17.5px | Section / page headings |
| `lg` | 16px | 20px | Brand text |
| `xl` | 22px | 27.5px | Current price (price strip) |
| `2xl` | 32px | 40px | Future hero numerics |
<!-- END AUTO: tokens-typography -->

## Color

- **Approach:** Restrained. Single UI accent (teal). Three mutually-exclusive color categories for UI state, status semantic, and price direction.
- **Palette (dark mode only — v1 has no light mode):**

  | Token | Hex | Use |
  |---|---|---|
  | `--bg` | `#0E0E14` | App background |
  | `--bg-card` | `#13131C` | Panes, cards, toolbars |
  | `--bg-subtle` | `#0A0A12` | Nav, price strip, dropdown headers |
  | `--bg-input` | `#1A1A26` | Inputs, comboboxes, default tab |
  | `--bg-input-hover` | `#22222F` | Hover state |
  | `--border` | `#1F1F2A` | Default borders, dividers |
  | `--border-strong` | `#2A2A38` | Active borders, vertical dividers |
  | `--fg` | `#E2E8F0` | Primary text |
  | `--fg-dim` | `#94A3B8` | Secondary text, dim labels |
  | `--fg-dimmer` | `#64748B` | Tertiary text, disabled |
  | `--accent` | `#14B8A6` | Teal — UI states only (buttons, focus, crosshair, active tab, primary CTAs) |
  | `--success` | `#22C55E` | UI 상태 semantic — 캡처 완료, 양호 상태, 체크리스트 done |
  | `--error` | `#F43F5E` | UI 상태 semantic — 실패, 에러 메시지, 비정상 상태 |
  | `--price-up` | `#DC2626` | 시장 데이터 — 상승, 매수, KRX 빨강 컨벤션 |
  | `--price-down` | `#2563EB` | 시장 데이터 — 하락, 매도, KRX 파랑 컨벤션 |
  | `--grid` | `#1A1A26` | Chart grid lines, table row borders |
  | `--heat-lo` | `#0E1A1A` | Heatmap low intensity (depth intensity pane) |
  | `--heat-hi` | `#14B8A6` | Heatmap high intensity (teal ramp) |

- **Discipline rule:** Three mutually-exclusive color categories.
  - **UI state** (teal `--accent`): buttons, focus rings, active tabs, crosshair, primary CTAs. Never for data.
  - **Status semantic** (`--success`/`--error`): system feedback — capture complete/failed, error banners, calendar cell state, status dots. Never for market data.
  - **Price direction** (`--price-up`/`--price-down`): KRX convention — red = up/buy/positive delta, blue = down/sell/negative delta. Never for UI state or status.
  - This three-way separation prevents the "is this red because it failed, or because it's up?" ambiguity.

- **Tint backgrounds (alpha-tinted chip / hover):**
  - Selection tint: `rgba(20,184,166,0.12)` — active nav, active tab, primary hover
  - Success tint: `rgba(34,197,94,0.10)` — completion chip background
  - Error tint: `rgba(244,63,94,0.10)` — error chip background
  - Success border: `rgba(34,197,94,0.30)` — `--tint-success-border` (banner/chip borders)
  - Error border: `rgba(244,63,94,0.30)` — `--tint-error-border` (banner/chip borders)
  - Price-up tint: `rgba(220,38,38,0.10)` — buy depth bar, positive market chip
  - Price-down tint: `rgba(37,99,235,0.10)` — sell depth bar, negative market chip

- **Semantic (banners / toasts):**
  - Success: `--success` (#22C55E)
  - Error: `--error` (#F43F5E)
  - Warning: `--warn` (#F59E0B, amber)
  - Info: `--accent` (teal)

- **Dark mode:** Only mode in v1. Light mode is out of scope.

## Spacing

- **Base unit:** 4px (base intent); 5px (rendered @ default density)
- **Density:** Comfortable at default density (1.25×) — capable of reaching Bloomberg-density via a future Compact mode (1.0× = base intent). Density is a spectrum, not a fixed point. The token system holds both; default rendering picks one.
- **Scale (rem-based, single dial):**

<!-- BEGIN AUTO: tokens-spacing -->
| Token | Base intent (1.0×) | Rendered @ default (1.25×) | Use |
|---|---|---|---|
| `2xs` | 2px | 2.5px | Hairline gaps |
| `xs` | 4px | 5px | Pane gap, tight stacking |
| `sm` | 8px | 10px | Card padding inside, gap between sidebar cards |
| `md` | 12px | 15px | Card padding default |
| `lg` | 16px | 20px | Section spacing, nav item padding |
| `xl` | 24px | 30px | Major section dividers |
| `2xl` | 32px | 40px | (rarely used) |
| `3xl` | 48px | 60px | (rarely used) |
<!-- END AUTO: tokens-spacing -->

- **Card padding:** 12–14px standard. Sidebar cards 12px. Pane bodies 4–6px (info density priority) (base intent — rendered ×1.25 at default density).
- **Pane gap:** 8px between chart panes (base intent — rendered ×1.25 at default density).
- **Sidebar width:** 320px base intent / 400px rendered (token: --sidebar-w).
- **Nav width:** 210px base intent / 262.5px rendered (token: --nav-w).

## Layout

- **Approach:** Grid-disciplined hybrid — strict grid for the app shell, looser composition inside chart panes.
- **App shell:**
  - Top-level: `grid-template-columns: 210px 1fr` (nav + main).
  - Main: `grid-template-rows: 40px 60px 52px 1fr` (tabs + toolbar + price strip + workarea) for Replay Viewer; stub pages have only the workarea row.
- **Replay Viewer workarea:** `grid-template-columns: 1fr 12px <sidebarPx>` (chart + splitter + Cursor Sidebar). `--sidebar-w` seeds the default `sidebarPx`; runtime width and the collapsed flag are owned by `frontend/src/state/replayLayout.ts` and persisted to `localStorage['replay.layout']`. When collapsed, the grid collapses to `1fr` and a floating right-edge handle plus a Toolbar toggle let the user re-expand. Double-click on the splitter reads the *current* token value via `getComputedStyle`, so future density-mode changes reseed automatically. Trade-off captured in ADR-0022.
- **Chart stage:** `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill).
- **Max content width:** No cap. App fills the viewport (desktop-only).
- **Border radius:**
  - `sm` 2px (rarely used)
  - `md` 4px (presets, small buttons)
  - `lg` 6px (cards, inputs, buttons, dropdowns — the default)
  - `full` 50% (status dots, avatars)

### Page shell (feature routes)

Every feature route except the chart workspace follows one shell:

- **Outer padding:** wrap the route in `<PageContainer>` (`frontend/src/layout/PageContainer.tsx`) — the single source of the page padding token (`p-md`). Never hardcode `p-4`/`p-8` at the page root.
- **Content framing:** primary content sits in `bg-bg-card border rounded-lg` cards. Multi-pane pages (master-detail, splitter) use one card per pane; single-content pages use one card. Never nest cards.
- **No redundant page title:** the left nav is the page label, so a page never repeats its own name. Pages expose a *title-less* control bar (search / counts / actions) at the top of their card. (See the `/live` header: search only, with the active symbol shown in the status bar below.)
- **Full-bleed exception:** only the chart workspace (`/live`) is full-bleed (no `PageContainer`, no card) — the chart must fill the viewport. Its sidebar still uses `--bg-card` to match other panels.

## Motion

- **Approach:** Minimal-functional. Only motion that aids comprehension.
- **Easing:**
  - Enter: `ease-out`
  - Exit: `ease-in`
  - State transitions (hover, focus, active): `ease-in-out`
- **Duration:**
  - Micro (hover, focus ring): 80ms
  - Short (most transitions: tab switch, dropdown open, chip toggle): 150ms
  - Medium (page nav, modal): 250ms
  - Long (entrance animation if needed): 400ms — rare
- **Animated elements:**
  - Tab loading status dot: 1.5s ease-in-out infinite pulse (opacity 1↔0.3)
  - Cursor indicator dot: subtle teal glow, no animation
  - Crosshair on chart: instant move (no transition), 30ms debounce on data fetch
- **What we do NOT animate:** chart pane resizes, sidebar updates, value changes (numbers snap, no tween — analysts want exact values not gradients).

## Components — Design Tokens for Specific Patterns

> **Scale note:** All px values in this section are **1.0× base intent**.
> Default rendering = × 1.25. See [Scale Factor](#scale-factor).

### Tabs (Replay Viewer page)
- Height: 32px
- Active: `--bg-card` background, 2px teal top accent, no bottom border
- Inactive: `--bg-input` background, dim text, full border
- Hover: `--bg-input-hover`
- Close X: 18px × 18px, opacity 0 by default, 1 on hover
- Status dot: 6px circle, `--success` solid (loaded), `--accent` pulsing (loading), `--fg-dimmer` outline (empty)
- Soft cap: 8 tabs (shown as `N / 8 open`)

### Combobox (stock selector)
- Min width: 220px
- Border-radius: 6px
- Open state: teal border
- Dropdown shadow: `0 8px 24px rgba(0,0,0,0.4)`
- Search input inside dropdown: transparent background, mono font, no border

### Date field
- Same style as combobox but narrower
- Calendar icon left (14px, dim)
- `→` arrow between from/to fields (`--fg-dim`)

### Presets (range pill group)
- Container: `--bg-input` with 2px padding
- Each preset: 7px × 12px padding, mono small-caps text
- Active: teal background, dark text

### Primary CTA (Load button)
- Background: `--accent`
- Text: `--accent-fg` (`#0A0A12`, dark bg color)
- Padding: 9px × 18px
- Font: 13px / 600 weight Geist Sans
- Hover: filter brightness 1.1

### Orderbook table row
- Height: 22px
- Mono 11.5px
- Right side bar gradient (depth visualization): `--tint-price-up` for bid side, `--tint-price-down` for ask side (10% alpha; the underlying token names encode KRX convention — red for buy/up, blue for sell/down).
- Mid spread row: subtle bg, small-caps teal label

### Status dot (general)
- 6px circle, glow via `box-shadow` for active states only

### Modals & popovers — dismissal contract
Two layers, each with one shared owner. Use them; do **not** hand-roll a dismiss `useEffect`.
- **Center modal** (full-screen backdrop, fixed-position card): wrap in `ModalShell` (`frontend/src/ui/ModalShell.tsx`) — it owns the backdrop, Escape + backdrop-click dismiss, the canon card, and the title + ✕ header.
- **Anchored popover / dropdown** (floats next to a trigger): use `useDismissablePopover` (`frontend/src/util/useDismissablePopover.ts`) for the outside-click + Escape contract, plus `clampToViewport` for edge safety.
- A copied `addEventListener('mousedown'|'keydown')` is how this drifts (one site on `document`, another on `window`; one forgets Escape) — the helpers concentrate the contract so it can't.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-20 | Created design system via `/design-consultation` | Captures the Modern Trading Lab direction approved via the Variant B mockup. |
| 2026-05-20 | Geist Sans + Geist Mono over Inter + JetBrains Mono | Equal readability, slightly more distinctive, same vendor (Vercel). Avoids the Inter convergence trap without changing the design feel. |
| 2026-05-20 | Single teal accent, strictly separated from up/down semantic | Prevents data-vs-UI color confusion. Teal is "the system speaking"; green/rose is "the market speaking". |
| 2026-05-20 | Compressed multi-day time axis (no overnight gap) | Screen density over chronological accuracy; matches TradingView's convention for analyzing across sessions. |
| 2026-05-20 | Tab status pulse dot | Multi-tab async state needs to be visible. One small animation is worth the tradeoff. |
| 2026-05-20 | Monospace 100% for numbers | Tabular-nums is required for orderbook column alignment. Two-font cost (~50 KB extra) is negligible on localhost. |

## App-shell & live tokens (ADR-0039, ADR-0052)

Layout and source-identity tokens beyond the core scale. The Right Rail tokens (ADR-0052) are app-shell-wide (every route); the live tokens are `/live`-scoped. These layout widths/heights live in `design-tokens.ts` `SIZE_TOKENS` (ADR-0012); this hand-maintained table mirrors them for reference (no auto-marker yet):

| Token | Base intent (1.0×) | Rendered @ default (1.25×) | Use |
|---|---|---|---|
| `--rail-w` | 48px | 60px | Right Rail icon column width (app shell, all routes; fixed — does not collapse) |
| `--watchlist-panel-w` | 280px | 350px | Watchlist Panel width — opened from the Right Rail (global) |
| `--h-live-header` | 32px | 40px | Live page header row (page title) |

**Source identity chips** — neither UI state nor status nor price direction, but data provenance.
A fourth category limited to identifying which capture source rendered a given segment.

| Token | Value | Use |
|---|---|---|
| `--source-hogaplay-bg` | `var(--bg-card)` | hogaplay-sourced segment chip background |
| `--source-hogaplay-border` | `var(--fg-dimmer)` | hogaplay-sourced segment chip border |
| `--source-kis-live-bg` | `color-mix(in srgb, var(--accent) 12%, var(--bg-card))` | kis_live-sourced segment chip background |
| `--source-kis-live-border` | `var(--accent)` | kis_live-sourced segment chip border |

## Copy tone (Stage 9)

- **Domain identifiers** (`hogaplay`, `kis_live`, `cycle_lag_ms`, `EGW00201`): English lowercase, code-style (monospace where appropriate). Never localized.
- **User-facing messages**: Korean natural-language sentences. No trailing periods. Actions are nominalized ("재발급" not "재발급하기").
- **Status labels** (LiveStatusBar pills, banner badges): Korean single words ("장 외", "대기 중", "준비됨").
- **Layout grid for `/live`**: 4-row grid mirroring `/replay`'s PriceStrip pattern — header (32/40px) + status bar (52/65px) + toolbar (60/75px) + workarea (1fr).
| 2026-05-23 | Adopted KRX market convention (up=red `#DC2626`, down=blue `#2563EB`) | Single-user Korean analyst — Western up=green is counter-intuitive. Renamed `--up`/`--down` → `--success`/`--error` to disambiguate status semantic from price direction; introduced `--price-up`/`--price-down`. Removed `--ratio-ask` (folded into `--price-down`). All chart series now hide both `priceLineVisible` and `lastValueVisible` — analysts read latest values via crosshair. |
| 2026-05-30 | Global Right Rail (fixed; single 관심 item, heart icon) replaces the `/live` ★ watchlist drawer; the chevron `»`/`«` and the 관심 item both show/hide the Watchlist Panel; chrome state in a dedicated `rightRail` store (ADR-0052) | Watchlist reachable from every page. Rail does not collapse — only the panel opens. Active state = tint bg + neutral text (no triple-teal, matches LeftNav). `--rail-w` added via `design-tokens.ts` (ADR-0012). |
