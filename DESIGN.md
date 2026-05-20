# Design System — hoga-ops

**Created:** 2026-05-20 via `/design-consultation`
**Project:** hoga-ops — Korean stock orderbook + trade replay analysis tool
**Approved mockup:** `docs/superpowers/designs/2026-05-20-replay-viewer.html`

## Product Context

- **What this is:** Single-user local desktop tool that captures Korean stock orderbook + trade replay data from `hogaplay.com` and exposes it for analysis through a browser frontend.
- **Who it's for:** The single user (analyst/researcher) running the tool on their own machine. No external audience.
- **Space/industry:** Financial market microstructure analysis — KRX cash equities, orderbook replay.
- **Project type:** Local desktop web app, analyst workstation.
- **Memorable thing:** "A trading desk that feels modern, not 1990s — information density that stays readable."

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian × Modern Professional ("Modern Trading Lab")
- **Decoration level:** Minimal-intentional — typography does the work. Single accent color. No patterns, textures, gradients, or decorative blobs.
- **Mood:** Serious. Information-first. The product should feel like a precision tool, not a SaaS dashboard. Closer in spirit to Linear than to a Y Combinator startup landing page.
- **Reference points:** TradingView (chart syntax), Linear (UI restraint), Vercel (typography), Bloomberg (data density — but without the 1990s color palette).

## Typography

- **Display / Hero / Brand:** Geist Sans 600 — bold but neutral, distinctive without being decorative.
- **Body / UI labels:** Geist Sans 400–500 — same family as Display for visual continuity.
- **UI / Labels:** Same as body. Small-caps section headers use 10.5px / 600 weight / `0.08em` letter-spacing / uppercase.
- **Data / Tables / All numbers:** Geist Mono 400–500 — must use `font-variant-numeric: tabular-nums`. Every numeric value in the product is monospace for column alignment.
- **Code (future, if any):** Geist Mono — same as data, no second mono.

- **Loading strategy:** Google Fonts CDN in v1 (`@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap')`). Self-host as v1+1 if network latency becomes annoying on cold start.

- **Scale (rem-based, root 16px):**
  | Token | px | Use |
  |---|---|---|
  | `xs` | 10–10.5 | Small-caps labels, badges |
  | `sm` | 11–11.5 | Table rows, secondary mono values |
  | `base` | 13 | Body / UI default |
  | `md` | 14 | Section / page headings |
  | `lg` | 16 | Brand text |
  | `xl` | 22 | Current price (price strip) |
  | `2xl` | 32 | Future hero numerics (if added) |

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

- **Base unit:** 4px
- **Density:** Comfortable-tight. Denser than typical SaaS, looser than Bloomberg.
- **Scale:**

  | Token | px | Use |
  |---|---|---|
  | `2xs` | 2 | Hairline gaps |
  | `xs` | 4 | Pane gap, tight stacking |
  | `sm` | 8 | Card padding inside, gap between sidebar cards |
  | `md` | 12 | Card padding default |
  | `lg` | 16 | Section spacing, nav item padding |
  | `xl` | 24 | Major section dividers |
  | `2xl` | 32 | (rarely used) |
  | `3xl` | 48 | (rarely used) |

- **Card padding:** 12–14px standard. Sidebar cards 12px. Pane bodies 4–6px (info density priority).
- **Pane gap:** 8px between chart panes.
- **Sidebar width:** 320px fixed.
- **Nav width:** 210px fixed.

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
