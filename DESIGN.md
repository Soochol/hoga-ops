# Design System — hoga-ops

**Created:** 2026-05-20 via `/design-consultation`
**Project:** hoga-ops — Korean stock orderbook + trade replay analysis tool
**Approved mockup (original, at 1.0× base intent):** `docs/superpowers/designs/2026-05-20-replay-viewer.html`
**Approved commercial themes (2026-07-08):** `docs/superpowers/designs/2026-07-08-commercial-terminal.html` (Obsidian, dark) · `docs/superpowers/designs/2026-07-08-commercial-ledger.html` (Ledger, light)

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
| **Default density (1.125×)** | What the app renders at browser zoom 100%. `:root { font-size: 18px }` lifts every rem-based token by 1.125×. |
| **Scale dial** | The `:root font-size` declaration in `frontend/src/styles/tokens.css`. Changing it shifts all CSS sizing uniformly. |

**Scope of the dial:**
- ✅ CSS-rendered chrome — fonts, spacing, layout widths, line-heights (all rem-based).
- ❌ `lightweight-charts` canvas — text and bar spacing live in `frontend/src/util/chartScale.ts` as static constants. Must be updated alongside the dial.
- ❌ 1px borders, hairlines, small radii (2–6px), chart canvas internal coordinates — stay in px to protect anti-aliasing and pixel-grid sharpness.

**Future density modes (backlog):** A user-facing toggle (Compact 1.0× / Comfortable 1.125× / Cozy 1.25×) would set `:root font-size` via `[data-density="..."]`; `chartScale.ts` now derives from `RENDERED_ROOT_PX` (design-tokens.ts) but charts read it at mount, so a runtime toggle still needs a chart remount. Not in scope today.

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian × Modern Professional ("Quiet Trading Terminal")
- **Decoration level:** Minimal-intentional — typography does the work. Single accent color. No patterns, textures, gradients, or decorative blobs.
- **Mood:** Serious. Information-first. The product should feel like a precision tool, not a SaaS dashboard. Closer in spirit to Linear than to a Y Combinator startup landing page.
- **Reference points:** TradingView (chart syntax), Linear (UI restraint), Vercel (typography), Bloomberg (data density — but without the 1990s color palette).
- **Density posture:** Ships at a comfortable density (1.125× of base intent), a notch denser than typical-SaaS sizing (was 1.25× until 2026-07-15). The original 1.0× intent (`denser than typical SaaS`, Bloomberg-leaning) is preserved in the token system and reachable through a future Compact density toggle. The product DNA is "Linear-like restraint" at the chosen density, not "must always be small."

## Typography

- **Display / Hero / Brand:** IBM Plex Sans KR 600 — bold but neutral, distinctive without being decorative. Carries Latin + Hangul in one family (no separate Korean fallback needed).
- **Body / UI labels:** IBM Plex Sans KR 400–500 — same family as Display for visual continuity.
- **UI / Labels:** Same as body. Small-caps section headers use 10.5px / 600 weight / `0.08em` letter-spacing / uppercase.
- **Data / Tables / All numbers:** IBM Plex Mono 400–500 — must use `font-variant-numeric: tabular-nums`. Every numeric value in the product is monospace for column alignment.
- **Code (future, if any):** IBM Plex Mono — same as data, no second mono.

- **Font tokens:** `--font-ui` / `--font-mono` (theme-independent, defined on the base block in `tokens.css`; Tailwind `font-ui`/`font-sans`/`font-mono` resolve to them). Stacks fall back through `Pretendard` → system before generic. **Do not reference a font family by name in a component** — always go through the token.
- **Loading strategy:** Google Fonts via `<link>` in `index.html` (preconnect + render-blocking stylesheet), `IBM+Plex+Sans+KR` + `IBM+Plex+Mono`. Self-host as v1+1 if network latency becomes annoying on cold start.
- **History:** v1 speced Geist Sans/Mono but the `--font-ui`/`--font-mono` tokens were never defined, so the app silently rendered in the browser serif default (Times). Fixed 2026-07-08 by defining the tokens and switching to IBM Plex (Hangul coverage + a single vendor for sans+mono).

- **Scale (rem-based, single dial at `:root font-size`):**

<!-- BEGIN AUTO: tokens-typography -->
| Token | Base intent (1.0×) | Rendered @ default (1.125×) | Use |
|---|---|---|---|
| `badge` | 8.5px | 9.563px | Hierarchical badges (e.g., SymbolSearch market tag) |
| `xs` | 10.5px | 11.813px | Small-caps labels, badges |
| `sm` | 11.5px | 12.938px | Table rows, secondary mono values |
| `base` | 13px | 14.625px | Body / UI default |
| `md` | 14px | 15.75px | Section / page headings |
| `lg` | 16px | 18px | Brand text |
| `xl` | 22px | 24.75px | Current price (price strip) |
| `2xl` | 32px | 36px | Future hero numerics |
<!-- END AUTO: tokens-typography -->

## Color

- **Approach:** Restrained. Single UI accent per theme. Three mutually-exclusive color categories for UI state, status semantic, and price direction. Two commercial themes share one token contract (see below) — components never branch on theme, they only read tokens.
- **Themes (dual, selectable):** the app ships two full palettes behind `<html data-theme>`:
  - **Obsidian** (dark, default) — warm graphite surfaces + brass accent. The trading-terminal / live surfaces.
  - **Ledger** (light) — ivory paper surfaces + banker's-green accent. The review/research surfaces.
  - The **preference** (`obsidian` / `ledger` / `auto`) lives in `state/themePrefs.ts` (localStorage `ui.themePreference.v1`); `auto` maps `/live` + `/heatmap` → Obsidian and everything else → Ledger via `effectiveTheme(pref, pathname)`. `App.tsx` writes the resolved theme to `data-theme`; `index.html` sets it inline before first paint (FOUC + wrong-theme chart cache guard).
  - **Selectors:** `:root, [data-theme='dark'], [data-theme='obsidian']` carry the Obsidian palette + the scale dial + font + all size/spacing/layout tokens; `[data-theme='ledger']` overrides **colors only** (density and typography are theme-independent). The Ledger block sits *outside* the base block so `npm run gen:tokens` never touches it.

  | Token | Obsidian (dark) | Ledger (light) | Use |
  |---|---|---|---|
  | `--bg` | `#060608` | `#F6F4EE` | App background — 카드와의 명도차가 패널 분리의 1차 수단 (2026-07-15 심도 강화) |
  | `--bg-card` | `#121216` | `#FDFCF8` | Panes, cards, toolbars |
  | `--bg-subtle` | `#0E0E11` | `#F2EFE7` | Nav, price strip, dropdown headers |
  | `--bg-input` | `#101014` | `#FDFCF8` | Inputs, comboboxes, default tab |
  | `--bg-input-hover` | `#1A1A20` | `#F0EDE4` | Hover state |
  | `--border` | `#232329` | `#E4E0D3` | Default borders, dividers |
  | `--border-strong` | `#33333C` | `#C9C3B2` | Active borders, vertical dividers |
  | `--chart-pane-divider` | `#3a3a42` | `#bcb4a0` | Chart pane separators only (lightweight-charts `layout.panes`); `--border-strong` 근처 톤으로 pane 경계는 남기되 소음은 억제(2026-07-15 완화 — 이전 다크 `#63636f`/라이트 `#9a917c`는 화면 최강 선이라 "분리는 톤+간격" 규칙과 충돌) |
  | `--fg` | `#ECECF1` | `#1E2732` | Primary text |
  | `--fg-dim` | `#9A9AA8` | `#5C6673` | Secondary text, dim labels |
  | `--fg-dimmer` | `#63636F` | `#8B94A0` | Tertiary text, disabled |
  | `--accent` | `#F0B429` (brass) | `#1F6F54` (green) | UI states only (buttons, focus, crosshair, active tab, primary CTAs) |
  | `--success` | `#2FBF71` | `#1F8A50` | UI 상태 semantic — 캡처 완료, 양호 상태, 체크리스트 done |
  | `--error` | `#F25C7A` | `#C13B52` | UI 상태 semantic — 실패, 에러 메시지, 비정상 상태 |
  | `--price-up` | `#F04452` | `#C4322E` | 시장 데이터 — 상승, 매수, KRX 빨강 컨벤션 |
  | `--price-down` | `#3485FA` | `#1E5FC1` | 시장 데이터 — 하락, 매도, KRX 파랑 컨벤션 |
  | `--grid` | `#1B1B21` | `#ECE8DC` | Chart grid lines, table row borders |
  | `--heat-hi` | `#F0B429` | `#1F6F54` | Heatmap high intensity (accent ramp) |
  | `--shadow` | `0 4px 12px rgba(0,0,0,0.5)` | `0 2px 8px rgba(30,39,50,0.12)` | Popover / tooltip elevation |
  | `--shadow-overlay` | `0 8px 24px rgba(0,0,0,0.4)` | `0 8px 24px rgba(30,39,50,0.16)` | Dropdowns, menus, small dialogs |
  | `--shadow-panel` | `0 18px 60px rgba(0,0,0,0.35)` | `0 2px 8px rgba(30,39,50,0.12)` | Page-level panes/cards (workarea, PageShell) |
  | `--shadow-modal` | `0 24px 80px rgba(0,0,0,0.45)` | `0 16px 48px rgba(30,39,50,0.2)` | Full-size modals (settings, indicators, search palette) |

- **Elevation rule:** components never hardcode `rgba(0,0,0,…)` box-shadows — always one of the four shadow tokens (Tailwind: `shadow-overlay`/`shadow-panel`/`shadow-modal`). Obsidian elevates with deep dark halos; Ledger elevates with faint ink-tinted paper shadows. A dark-tuned shadow reused on Ledger turns the ivory gaps between cards into grey trenches and visually deadens the main surface (fixed 2026-07-12).

- **Discipline rule:** Three mutually-exclusive color categories.
  - **UI state** (`--accent` — brass on Obsidian, green on Ledger): buttons, focus rings, active tabs, crosshair, primary CTAs. Never for data.
  - **Status semantic** (`--success`/`--error`): system feedback — capture complete/failed, error banners, calendar cell state, status dots. Never for market data.
  - **Price direction** (`--price-up`/`--price-down`): KRX convention — red = up/buy/positive delta, blue = down/sell/negative delta. Never for UI state or status.
  - This three-way separation prevents the "is this red because it failed, or because it's up?" ambiguity.

- **Tint backgrounds (alpha-tinted chip / hover):** each tracks its base color per theme — read the token, don't hardcode the rgba. Values below are the Obsidian defaults; `[data-theme='ledger']` redefines them against the Ledger accent/status/price colors.
  - `--tint-selection` — active nav, active tab, primary hover (tracks `--accent`)
  - `--tint-success` / `--tint-error` — completion / error chip background
  - `--tint-success-border` / `--tint-error-border` — banner/chip borders
  - `--tint-price-up` / `--tint-price-down` — buy/sell depth bar, market chip (tracks `--price-*`)

- **Semantic (banners / toasts):** read the token (values vary per theme).
  - Success: `--success`
  - Error: `--error`
  - Warning: `--warn`
  - Info: `--accent`

- **Price-direction heat ramp (히트맵 보드 전용):** `--price-up`/`--price-down` 을 |등락률| 비례
  가변 알파로 쓴다. **행 등락은 칩 배경이 아니라 `priceDirClass()` 텍스트 색 + 부호**로 표현한다
  (배경 워시 없음, `▲▼` 없음 — 색약 보조는 색+부호 2중; 우측 패널 `QuoteChange` 와 동일 컨벤션).
  **헤더 밴드는 `heatHeaderBg()`**(선형 램프, max α 0.5, 그룹 평균 등락 기준)로 틴트한다.
  `heatHeaderBg` 의 `linear-gradient(0deg, heat, heat)` 는 동색 2-stop 합성 idiom(시각상 단색)이라
  위 "no gradients"(장식 한정) 규율과 무충돌 — 기능적 gradient 선례 = depth bar.

- **Price-direction candle glyph (관심맵 행 전용):** `frontend/src/heatmap/CandleGlyph.tsx` 가
  당일 시·고·저·종을 1봉으로 그린다(고-저 심지 + 시-종 몸통). 색 = **종가 vs 시가**(strict):
  종가>시가 양봉 `--price-up`(적)·종가<시가 음봉 `--price-down`(청)·도지 `--fg-dim`. 이는
  *당일 시가 대비* 흐름으로 *전일대비* 등락칩(`change_pct`)과 다른 기준(다른 시간창). 가격
  방향 카테고리 준수(새 색 없음) — `heat.ts` 배경 확장의 캔들 버전.

- **Heatmap 폴더 surface 예외 (관심맵 보드 전용):** 신문형 멀티칼럼 고밀도 보드라 폴더 블록은
  `--bg-card` 카드(채움+테두리+라운드) 대신 **투명·평면**으로 둔다 — 그룹 경계는 헤더 밴드 +
  `--border-strong` 좌측 스파인(`border-l-2`) + 여백으로 잡는다. **헤더 밴드는 그룹 평균 등락 비례
  히트 틴트(`heatHeaderBg`, 선형 램프 max α 0.5)를 진다**; 폴더명은 `text-fg`, 평균값은 평면
  `text-fg-dim` 숫자. α 상향 금지(`text-fg-dim` 평균값의 틴트 밴드 위 대비 보호 — 원래 근거였던
  미분류명 `text-fg-dim` 분기는 ADR-0112 로 미분류가 폐지되며 소멸). 이 예외는
  **히트맵 폴더 한정**이며 드로어·차트·툴바 등 다른 카드는 `--bg-card` 유지.

- **Canvas theme reactivity:** `lightweight-charts` paints to a `<canvas>` and cannot read `var(--…)`, so chart colors resolve through `util/tokens.ts`. Use **`resolveTokensThemed(spec)`** (never the raw `resolveTokens` at module load) inside the projection/render function so a chart built under a different theme reads the live values. Projectors that embed color in cached per-point data (candle, volume, quoteTotals) carry the theme in their cache key; colors applied at series-options level use a thunk (`options: () => …`) resolved at `addSeries` time. `LiveChartRoot`'s `viewKey` includes the theme as a forward-safety net (a theme swap already coincides with an unmount in the shipped UX).

- **Known limitation — MA / peak / drawing default colors:** the moving-average palette (`liveIndicatorsPersistence.ts`), peak-wall defaults, and drawing-tool colors are **user-selectable and persisted as hex in localStorage**, not theme tokens — so they do NOT change with the theme. The stock default MA-120 was white (`#F8FAFC`, invisible on Ledger); `--ma-5` is toned to `#334155` for the token consumers, but a user's persisted white stays white until they change it in the MA style picker. Accepted trade-off (user colors are user colors); revisit with a per-theme migration if it bites.

- **Both themes only:** there is no "system/OS" mode and no third theme. `data-theme` is exactly `obsidian` or `ledger` at runtime (the legacy `dark` alias maps to Obsidian).

## Spacing

- **Base unit:** 4px (base intent); 4.5px (rendered @ default density)
- **Density:** Comfortable at default density (1.125×) — capable of reaching Bloomberg-density via a future Compact mode (1.0× = base intent). Density is a spectrum, not a fixed point. The token system holds both; default rendering picks one.
- **Scale (rem-based, single dial):**

<!-- BEGIN AUTO: tokens-spacing -->
| Token | Base intent (1.0×) | Rendered @ default (1.125×) | Use |
|---|---|---|---|
| `2xs` | 2px | 2.25px | Hairline gaps |
| `xs` | 4px | 4.5px | Pane gap, tight stacking |
| `sm` | 8px | 9px | Card padding inside, gap between sidebar cards |
| `md` | 12px | 13.5px | Card padding default |
| `lg` | 16px | 18px | Section spacing, nav item padding |
| `xl` | 24px | 27px | Major section dividers |
| `2xl` | 32px | 36px | (rarely used) |
| `3xl` | 48px | 54px | (rarely used) |
<!-- END AUTO: tokens-spacing -->

- **Card padding:** 12–14px standard. Sidebar cards 12px. Pane bodies 4–6px (info density priority) (base intent — rendered ×1.125 at default density).
- **Pane gap:** 8px between chart panes (base intent — rendered ×1.125 at default density).
- **Sidebar width:** 320px base intent / 360px rendered (token: --sidebar-w).
- **Top nav height:** 32px base intent / 36px rendered (token: --h-top-nav).

## Layout

- **Approach:** Grid-disciplined hybrid — strict grid for the app shell, looser composition inside chart panes.
- **App shell:**
  - Top-level: rows `var(--h-top-nav) minmax(0, 1fr)` (minimal top menu + content); content columns are `1fr var(--rail-w)` plus an optional `var(--watchlist-panel-w)` before the rail when a right-rail panel is open. The explicit content row contract keeps panel content from growing the row (or the `/live` chart) past the viewport.
  - Main: `grid-template-rows: 40px 60px 52px 1fr` (tabs + toolbar + price strip + workarea) for Replay Viewer; stub pages have only the workarea row.
- **Replay Viewer workarea:** `grid-template-columns: 1fr 12px <sidebarPx>` (chart + splitter + Cursor Sidebar). `--sidebar-w` seeds the default `sidebarPx`; runtime width and the collapsed flag are owned by `frontend/src/state/replayLayout.ts` and persisted to `localStorage['replay.layout']`. When collapsed, the grid collapses to `1fr` and a floating right-edge handle plus a Toolbar toggle let the user re-expand. Double-click on the splitter reads the *current* token value via `getComputedStyle`, so future density-mode changes reseed automatically. Trade-off captured in ADR-0022.
- **Chart stage:** `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill).
- **Max content width:** No cap. App fills the viewport (desktop-only).
- Dense tool panels use one outer surface with internal dividers; avoid nested cards inside sidebars, drawers, modals, and detail panels.
- **Border radius:**
  - `sm` 2px (rarely used)
  - `md` 4px (presets, small buttons)
  - `lg` 6px (cards, inputs, buttons, dropdowns — the default)
  - `full` 50% (status dots, avatars)

### Page shell (feature routes)

Every feature route except the chart workspace follows one shell:

- **Outer padding:** wrap the route in `<PageContainer>` (`frontend/src/layout/PageContainer.tsx`) — the single source of the page padding token (`p-md`). Never hardcode `p-4`/`p-8` at the page root.
- **Content framing:** primary content sits in `bg-bg-card border rounded-lg` cards. Multi-pane pages (master-detail, splitter) use one card per pane; single-content pages use one card. Never nest cards.
- **Borderless workspace panes (A안, 2026-07-15):** the `/live` chart + detail panes and the `/study` chart + detail panes drop their `1px` card/`border-l` borders — separation is carried by the `--bg`↔`--bg-card` tone step + gap + `shadow-panel` (`/live`, two cards with a 4px gap) or the `--bg-card`↔`--bg-subtle` tone step (`/study`, one card, flush panes). Rationale: the 17px seam between chart and detail stacked three 1px lines (card border + splitter line + card border), reading as visual noise. The splitter's resize line is now hidden by default and revealed in `--accent` only on hover/drag. This is the "분리는 톤+간격이 담당" rule (see #610~613 change log) applied to the pane seam, not just the card interior.
- **No redundant page title:** the active top menu item is the page label, so a page never repeats its own name. Pages expose a *title-less* control bar (search / counts / actions) at the top of their card. (See the `/live` header: search only, with the active symbol shown in the status bar below.)
- **Full-bleed exception:** only the chart workspace (`/live`) is full-bleed (no `PageContainer`, no card) — the chart must fill the viewport. Its sidebar still uses `--bg-card` to match other panels.

### Migration Status

Quiet Trading Terminal migration completed across app shell, route surfaces, rail drawers, live dialogs, and dense data panels. Nested-card chrome is prohibited in sidebars, drawers, modals, and detail panels; use `DataSection` dividers inside a single outer surface.

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
> Default rendering = × 1.125. See [Scale Factor](#scale-factor).

### Tabs (Replay Viewer page)
- Height: 32px
- Active: `--bg-card` background, 2px teal top accent, no bottom border
- Inactive: `--bg-input` background, dim text, full border
- Hover: `--bg-input-hover`
- Close X: 18px × 18px, opacity 0 by default, 1 on hover
- Status dot: 6px circle, `--success` solid (loaded), `--accent` pulsing (loading), `--fg-dimmer` outline (empty)
- Overflow (unlimited tabs, ADR-0069): single row, horizontal scroll with hidden scrollbar.
  Affordances are mandatory when overflowing — 28px edge fade mask on the scrollable side(s),
  vertical wheel → horizontal scroll, `‹ ›` scroll arrows (visible only toward the overflowing
  side, page by ~60% viewport), interactive `…` window markers and a `+N` hidden-count chip
  (`--tint-selection` bg, `--accent` text) that both open the searchable tab list dialog.
  Keyboard: `[` / `]` cycles tabs with wraparound on both /live and /study. Never wrap to a
  second row, never shrink tab width below label legibility.

### Combobox (stock selector)
- Min width: 220px
- Border-radius: 6px
- Open state: teal border
- Dropdown shadow: `var(--shadow-overlay)`
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
- Text: `--accent-fg` (`#07100f`, dark bg color)
- Padding: 9px × 18px
- Font: 13px / 600 weight Geist Sans
- Hover: filter brightness 1.1

### Orderbook table row
- Height: 22px
- Mono 11.5px
- Right side bar gradient (depth visualization): `--tint-price-up` for bid side, `--tint-price-down` for ask side (10% alpha; the underlying token names encode KRX convention — red for buy/up, blue for sell/down).
- Mid spread row: subtle bg, small-caps teal label

### Watchlist group header (관심종목 패널)
- 구조: `[chevron ▼(펼침)/▶(접힘), 좌측] [그룹명 + 개수 인라인] ··· [⋯ hover 메뉴, 우측]`
- 그룹명: `sm`/600 — 종목명(`xs`/400)보다 크고 굵게. 색은 `--fg-dim` 유지(크기·굵기만으로 위계).
- 개수: `xs` `--fg-dimmer`, **mono 금지** — 우측 정렬 mono 숫자는 종목 행의 가격 컬럼과
  같은 x에 떨어져 행으로 오독되므로 라벨 옆 인라인 고정. (`--fg-dimmer`/드로어 배경 대비
  ≈3.9:1로 WCAG AA(4.5:1) 미달 — 3차 텍스트로 의도된 트레이드오프, 개수는 라벨 버튼
  aria-label에 포함되어 AT에는 전달됨.)
- sticky `top-0` + `--bg-subtle` 배경 — 드로어(RailDrawer, 크롬 표면이라 `--bg-subtle`)와
  동일색이라 평시엔 투명처럼 보이고 스크롤 시에만 행을 가린다.
- 종목 행(QuoteRow) 종목명은 `xs` — 가격(`sm` mono)이 1차 콘텐츠, 종목명은 식별자.
- 종목 행 들여쓰기: 관심종목 패널에서만 `pl-10`(50px) — 그룹명 첫 글자(≈46px)보다
  오른쪽에서 시작해 부모-자식 위계를 들여쓰기로도 표현(`QuoteRow indented`).
  그룹 없는 스크리너는 평면 목록이라 미적용(기본 `pl-md`).

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
| 2026-05-23 | Adopted KRX market convention (up=red `#DC2626`, down=blue `#2563EB`) | Single-user Korean analyst — Western up=green is counter-intuitive. Renamed `--up`/`--down` → `--success`/`--error` to disambiguate status semantic from price direction; introduced `--price-up`/`--price-down`. Removed `--ratio-ask` (folded into `--price-down`). All chart series now hide both `priceLineVisible` and `lastValueVisible` — analysts read latest values via crosshair. |
| 2026-05-30 | Global Right Rail (fixed; single 관심 item, heart icon) replaces the `/live` ★ watchlist drawer; the chevron `»`/`«` and the 관심 item both show/hide the Watchlist Panel; chrome state in a dedicated `rightRail` store (ADR-0052) | Watchlist reachable from every page. Rail does not collapse — only the panel opens. Active state = tint bg + neutral text (no triple-teal, matches the app-shell active state). `--rail-w` added via `design-tokens.ts` (ADR-0012). |
| 2026-06-08 | 관심종목 그룹 헤더 위계: 크기 교환(그룹 sm/600, 종목명 xs) + 개수 인라인 + chevron 좌측 ▼/▶ + sticky | 그룹·종목이 같은 "좌 텍스트 + 우 mono 숫자" 패턴으로 오독되던 문제. 디자인 컴패니언 4안 비교로 색 추가 없는 A안 선택 — 틸 라벨은 색상 규율(UI 상태 전용) 이탈로 기각. |
| 2026-07-08 | 미정의 `--font-ui`/`--font-mono` 정의 + Geist→IBM Plex 전환 | 토큰이 정의된 적 없어 앱 전체가 Times(세리프)로 렌더링되던 P0. IBM Plex Sans KR 은 한글까지 한 패밀리로 커버, Plex Mono 로 tabular-nums 유지. |
| 2026-07-08 | 상업화 듀얼 테마 Obsidian(다크)/Ledger(라이트) 도입 — 기존 틸 다크는 Obsidian 으로 교체 | 판매 가능한 프로 룩 요구. 틸+단일 형광은 생성형 기본값이라 차별성 없음 → 브래스/장부초록으로 아이덴티티 확보. 색 규율(UI/상태/시세 3분류)은 양 테마 계승. `[data-theme]` 계약 + 라우트별 auto. |
| 2026-07-08 | 차트 색을 `resolveTokensThemed` 지연 해석으로 전환 (모듈 상수 박제 제거) | canvas 가 var() 를 못 받아 모듈 로드 시점 색을 박제 → 부트 테마에 고정되던 결함. 프로젝터 캐시에 테마 키, 시리즈 옵션 thunk 화로 테마 전환 대응. |
| 2026-07-15 | 기본 밀도 1.25×(20px) → 1.125×(18px) 하향 + `RENDERED_ROOT_PX` SSOT 신설 | 사용자 A/B(16/18/20px 스크린샷)로 18px 확정 — 기본 글씨가 크다는 체감 해소, 밀도 DNA 회복. 다이얼 값을 design-tokens.ts `RENDERED_ROOT_PX` 로 승격해 생성기 주석·표와 chartScale.ts 캔버스 상수가 모두 파생(하드코딩 ×20 제거). |
| 2026-07-15 | Obsidian `--bg` #0A0A0C → #060608 심도 강화 | 배경↔카드 명도차(Δ~8)가 너무 옅어 패널이 한 덩어리로 읽힘. 다크에서 1px 보더 강화는 반복 실패(#610~613) — 분리는 톤+간격이 담당한다는 규칙 확정. 카드 크롬(`--bg-card`+border+radius+gap) 자체는 기존 구조 유지. |
| 2026-07-15 | 전역 하단 시장지표 바(MarketIndexBar) 신설 — 앱 셸 3행(auto) | 대표지수 현재지수+전일대비 스트립(KIS FHPUP02100000, 백엔드 20s TTL 코얼레스 + last-good). 색 규율: 등락=가격 방향(priceDirClass 색+부호), 라벨=fg-dim, 값=mono fg. 데이터 없으면(자격증명 부재) 행이 0으로 접혀 빈 띠가 남지 않는다. 지수 클릭=해당 /live 탭 열기. |
| 2026-07-15 | `/live`·`/study` 워크스페이스 pane 보더 제거(A안) — 차트↔상세 경계선 폐지 | 차트와 상세 사이 17px 이음매에 1px 선 3개(카드 보더 + 스플리터 라인 + 카드 보더)가 겹쳐 지저분하게 읽힘. "분리는 톤+간격" 규칙(#610~613)을 pane 이음매에도 적용: `/live`는 두 카드 보더 제거(톤+4px gap+shadow-panel 유지), `/study`는 `border-l` 제거+상세 배경 `bg-subtle/40`→`bg-subtle` 승격(한 카드 내 톤 스텝). 스플리터 리사이즈 라인은 평상시 숨김, 호버/드래그 시 `--accent`로만 노출. |

## App-shell & live tokens (ADR-0039, ADR-0052)

Layout and source-identity tokens beyond the core scale. The Right Rail tokens (ADR-0052) are app-shell-wide (every route); the live tokens are `/live`-scoped. These layout widths/heights live in `design-tokens.ts` `SIZE_TOKENS` (ADR-0012); this hand-maintained table mirrors them for reference (no auto-marker yet):

| Token | Base intent (1.0×) | Rendered @ default (1.125×) | Use |
|---|---|---|---|
| `--rail-w` | 48px | 54px | Right Rail icon column width (app shell, all routes; fixed — does not collapse) |
| `--watchlist-panel-w` | 280px | 315px | Watchlist Panel width — opened from the Right Rail (global) |
| `--h-top-nav` | 32px | 36px | Global top navigation row |
| `--h-live-header` | 32px | 36px | Live page header row (page title) |
| `--h-bottom-bar` | 24px | 27px | Global market-index bottom bar row (하단 시장지표 스트립; 데이터 없으면 행 자체가 접힘) |

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
- **Layout grid for `/live`**: 4-row grid mirroring `/replay`'s PriceStrip pattern — header (32/36px) + status bar (52/58.5px) + toolbar (60/67.5px) + workarea (1fr).
