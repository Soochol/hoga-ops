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

- **Approach:** Restrained. Single UI accent (teal). Up/down semantic colors reserved for data values only.
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
  | `--up` | `#22C55E` | Up prices, buy quantities, positive deltas (data only) |
  | `--down` | `#F43F5E` | Down prices, sell quantities, negative deltas (data only) |
  | `--grid` | `#1A1A26` | Chart grid lines, table row borders |
  | `--heat-lo` | `#0E1A1A` | Heatmap low intensity (depth intensity pane) |
  | `--heat-hi` | `#14B8A6` | Heatmap high intensity (teal ramp) |
  | `--ratio-ask` | `#3B82F6` | Ratio pane — ask-heavy fill/line (above 0 baseline). Distinct from `--down` which encodes price direction; this encodes order-book pressure (KRX convention). |

- **Discipline rule:** Teal is for UI state, never for data. Up/down semantic colors are for data values, never for UI chrome. This separation prevents confusion ("is this teal cell up? down? selected?").

- **Tint backgrounds (for chip / hover states):**
  - Selection tint: `rgba(20,184,166,0.12)` (active nav, active tab, primary hover)
  - Up tint: `rgba(34,197,94,0.10)` (positive delta chip background)
  - Down tint: `rgba(244,63,94,0.10)` (negative delta chip background)

- **Semantic (for future banners / toasts):**
  - Success: reuse `--up`
  - Error: reuse `--down`
  - Warning: `#F59E0B` (amber — not yet used)
  - Info: reuse `--accent`

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
- **Replay Viewer workarea:** `grid-template-columns: 1fr 320px` (chart + sidebar).
- **Chart stage:** `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill).
- **Max content width:** No cap. App fills the viewport (desktop-only).
- **Border radius:**
  - `sm` 2px (rarely used)
  - `md` 4px (presets, small buttons)
  - `lg` 6px (cards, inputs, buttons, dropdowns — the default)
  - `full` 50% (status dots, avatars)

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
- Status dot: 6px circle, `--up` solid (loaded), `--accent` pulsing (loading), `--fg-dimmer` outline (empty)
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
- Right side bar gradient (depth visualization): 18% alpha of side color
- Mid spread row: subtle bg, small-caps teal label

### Status dot (general)
- 6px circle, glow via `box-shadow` for active states only

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-20 | Created design system via `/design-consultation` | Captures the Modern Trading Lab direction approved via the Variant B mockup. |
| 2026-05-20 | Geist Sans + Geist Mono over Inter + JetBrains Mono | Equal readability, slightly more distinctive, same vendor (Vercel). Avoids the Inter convergence trap without changing the design feel. |
| 2026-05-20 | Single teal accent, strictly separated from up/down semantic | Prevents data-vs-UI color confusion. Teal is "the system speaking"; green/rose is "the market speaking". |
| 2026-05-20 | Compressed multi-day time axis (no overnight gap) | Screen density over chronological accuracy; matches TradingView's convention for analyzing across sessions. |
| 2026-05-20 | Tab status pulse dot | Multi-tab async state needs to be visible. One small animation is worth the tradeoff. |
| 2026-05-20 | Monospace 100% for numbers | Tabular-nums is required for orderbook column alignment. Two-font cost (~50 KB extra) is negligible on localhost. |
