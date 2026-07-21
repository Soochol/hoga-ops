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
  | `--bg` | `#121216` | `#FDFCF8` | App background — 양 테마 모두 `--bg-card` 와 동일 톤(배경 통일, 2026-07-15 #636 다크 · #637 라이트). 카드 분리=4px gap+`--shadow-panel`(양 테마, borderless — feature-route 카드도 테두리 없음, 2026-07-15 통일; 라이트는 옅은 shadow 로 경계가 다크보다 약함) |
  | `--bg-card` | `#121216` | `#FDFCF8` | Panes, cards, toolbars |
  | `--bg-subtle` | `#0E0E11` | `#F2EFE7` | 우측 패널 크롬(RightRail·드로어 RailShell)·설정/지표 nav, dropdown/sticky headers, recessed rows (`TopNav` 헤더·`/study` 워크스페이스 탭 바·`/live` price strip 은 `--bg` 로 통일 — 여기서 제외; `/live` 멀티 탭은 ADR-0113 으로 제거됨) |
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
  - Top-level: **column** shell (2026-07-15) — `grid-template-columns: 1fr var(--rail-w)` plus an optional `var(--watchlist-panel-w)` before the rail when a right-rail panel is open. The **right panel (drawer + fixed rail) spans full viewport height** (top to bottom). The left column is a 3-row stack `grid-template-rows: var(--h-top-nav) minmax(0, 1fr) auto` (TopNav / page content / bottom market-index bar; bottom row `auto` collapses to 0 when the bar has no data). The top header therefore spans only the left column's width — it **yields the top-right corner to the full-height right panel**. The explicit row contract keeps content from growing the row (or the `/live` chart) past the viewport. TopNav itself is borderless `--bg` (see below) so the header merges into the page content; chrome tone (`--bg-subtle`) survives only on the right panel.
  - Main: `grid-template-rows: 40px 60px 52px 1fr` (tabs + toolbar + price strip + workarea) for Replay Viewer; stub pages have only the workarea row.
- **Replay Viewer workarea:** `grid-template-columns: 1fr 12px <sidebarPx>` (chart + splitter + Cursor Sidebar). `--sidebar-w` seeds the default `sidebarPx`; runtime width and the collapsed flag are owned by `frontend/src/state/replayLayout.ts` and persisted to `localStorage['replay.layout']`. When collapsed, the grid collapses to `1fr` and a floating right-edge handle plus a Toolbar toggle let the user re-expand. Double-click on the splitter reads the *current* token value via `getComputedStyle`, so future density-mode changes reseed automatically. Trade-off captured in ADR-0022.
- **Chart stage:** `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill).
- **Max content width:** No cap. App fills the viewport (desktop-only).
- Dense tool panels use one outer surface with internal dividers; avoid nested cards inside sidebars, drawers, modals, and detail panels. (Exception: `/live`·`/study` 상세 지표 카드는 승인된 예외 — Migration Status 참조.)
- **Border radius:**
  - `sm` 2px (rarely used)
  - `md` 4px (presets, small buttons)
  - `lg` 6px (cards, inputs, buttons, dropdowns — the default)
  - `full` 50% (status dots, avatars)

### Page shell (feature routes)

Every feature route except the chart workspace follows one shell:

- **Outer padding:** wrap the route in `<PageContainer>` (`frontend/src/layout/PageContainer.tsx`) — the single source of the page padding token (`p-md`). Never hardcode `p-4`/`p-8` at the page root.
- **Content framing:** primary content sits in `bg-bg-card` cards (`PanelCard`). Multi-pane pages (master-detail, splitter) use one card per pane; single-content pages use one card. Never nest cards. **Feature-route cards are `borderless` in both themes (2026-07-15, 통일 결정):** `/heatmap`·`/screener`·`/inventory`·`/capture` 카드는 `PanelCard borderless` 로 테두리 없이 `--bg-card` + `--shadow-panel` 만으로 배경과 분리 — `/live` 차트 패널과 동일 크롬(부유 카드 모델을 feature route 전반으로 확장). 내부 헤더/스트립 밴드도 `bg-subtle`→`bg-card`, 구분선 `border-strong`→`border` 로 평탄화(live `WorkspaceToolbar` = `bg-card` + `border-b border-border` 와 동형). **Ledger(라이트) tradeoff:** 라이트는 `--bg`=`--bg-card` + 옅은 shadow 라 카드 경계가 다크보다 약하게 읽힌다 — 이전엔 이 때문에 Ledger feature 카드의 `--border` 를 유지했으나, `/live`·`/study` 워크스페이스와의 전면 통일을 위해 **사용자 결정으로 borderless 채택**(라이트에서도 shadow+gap 의존). `--border` 는 이제 카드 프레임이 아니라 카드 **내부** 구분선(`border-b`/`border-t border-border`)·입력·테이블 등에만 쓴다.
- **Floating-card workspace (`/live` + `/study`, 통일 2026-07-15):** both `/live` and `/study` use the **same 부유 카드 모델** — no outer frame border; the chart pane and detail pane are two separate cards (`bg-bg-card` + `rounded` + `shadow-panel`, borderless) floating on a `--bg` field with a **4px gap**. Chrome above the field (`/live` 종목명 스트립 / `/study` 탭 바 + 헤더 행 — `/live` 멀티 탭은 ADR-0113 으로 제거) is full-bleed `--bg`. Separation is carried by **gap + `shadow-panel`** (다크는 톤 스텝 0이라 shadow 단독, 라이트는 옅은 shadow). `/study` 는 이전엔 단일 `PanelCard`(border) 안 flush 패널(`--bg-card`↔`--bg-subtle` 톤 스텝)이었으나 `/live` 와 동일 모델로 전환 — 바깥 `PanelCard` 프레임 제거, 상세 aside `bg-subtle`→`bg-card` 카드화, 탭 바·헤더 `--bg` 화. 상태 화면(빈/로딩/에러)은 `PageContainer`+`PanelCard` 유지(전환 점프 방지). Rationale: 원래 차트↔상세 17px 이음매의 1px 선 3개가 소음이라 "분리는 톤+간격이 담당" 규칙(#610~613)을 적용, 나아가 두 워크스페이스의 레이어 모델을 하나로 통일. 스플리터 리사이즈 라인은 평상시 숨김·호버/드래그 시 `--accent` 노출(`/live`).
- **No redundant page title:** the active top menu item is the page label, so a page never repeats its own name. Pages expose a *title-less* control bar (search / counts / actions) at the top of their card. (See the `/live` header: search only, with the active symbol shown in the status bar below.)
- **Full-bleed exception:** only the chart workspace (`/live`) is full-bleed (no `PageContainer`, no card) — the chart must fill the viewport. Its sidebar still uses `--bg-card` to match other panels.

### Migration Status

Quiet Trading Terminal migration completed across app shell, route surfaces, rail drawers, live dialogs, and dense data panels. Nested-card chrome is prohibited in sidebars, drawers, modals, and detail panels; use `DataSection` dividers inside a single outer surface. **Exception — `/live`·`/study` 상세 지표 카드 (2026-07-15, 사용자 요청):** 각 지표(10호가·거래원·매물대·프로그램·잠정투자자)는 이제 개별 **독립 카드**로 렌더한다. **카드 크롬**은 `/study` 가 이미 쓰던 `PanelCard` 와 동일하다(`bg-bg-card` + `border` + `rounded-lg` + `shadow-panel`) — 이 부분만 두 화면이 일치. **aside 배경 톤은 아직 다르다**: `/live` 는 솔리드 `bg-bg-subtle`, `/study` 는 `bg-bg-subtle/40`(향후 통일 여지). 드래그 재배열(ADR-0114)의 이동 단위가 카드로 명확해지도록 "플랫 섹션"(단일 표면+DataSection 구분선)을 카드화한 것. 카드 사이는 8px 여백. 드래그 시 잡은 카드는 `DragOverlay` 고정 크기 클론으로 뜨고 원래 슬롯은 opacity 0 placeholder(가변 높이 reflow 흔들림 제거), 놓을 위치엔 `bg-accent` 삽입선. 접기·높이 리사이저는 제거(2026-07-15, 카드는 내용 높이). **카드별 스크롤 컨테이너(`overflow-auto/scroll`)는 여전히 금지** — 스크롤은 패널 레벨(`overflow-hidden` clip 자체는 허용, 다만 현재는 붙이지 않음).

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
- Overflow (unlimited tabs; `ChartTabBar` — now /study only, /live tabs removed by ADR-0113):
  single row, horizontal scroll with hidden scrollbar.
  Affordances are mandatory when overflowing — 28px edge fade mask on the scrollable side(s),
  vertical wheel → horizontal scroll, `‹ ›` scroll arrows (visible only toward the overflowing
  side, page by ~60% viewport), interactive `…` window markers and a `+N` hidden-count chip
  (`--tint-selection` bg, `--accent` text) that both open the searchable tab list dialog.
  Keyboard: `[` / `]` cycles tabs with wraparound on /study. Never wrap to a
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
- **Right drawer** (`ModalShell side='right'`, ADR-0116): full-height right-anchored variant of the same shell — lighter dim (`bg-black/30` vs the center modal's `bg-black/50`), `border-l` instead of the rounded card border, 150ms ease-out slide-in. Purpose: **immediate-apply settings stay visible against the live chart** — the left ~520px of chart remains readable behind the dim, so a toggle's effect is seen in place. Used by the `/live` 보조지표(IndicatorPanel) and 설정(LiveSettingsModal) drawers, which share width (`760px`) and master-detail nav (`240px`) via `frontend/src/live/workspaceDrawer.ts` constants — the two drawers must not shift when the user switches between the toolbar buttons, so consume the constants rather than restating the classes.
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
| 2026-07-15 | 차트 pane 구분선 완화 + 상세패널 겹친 이음매 정리 (#635) | 토스식 "구분선 최소" 평가에서 나온 두 최대 소음. pane 구분선 다크 `#63636f`→`#3a3a42`(Δ~80→~35)·라이트 `#9a917c`→`#bcb4a0` — 이전 값은 `fg-dimmer` 수준의 화면 최강 선이라 규칙 위반(DESIGN.md 기록 `#44444F`와도 드리프트). 상세패널은 카드 `border-t` 제거로 이음매 2선→1선(리사이저선만). |
| 2026-07-15 | **Obsidian `--bg` #060608 → #121216 (= `--bg-card`, 배경 통일)** — 위 심도 강화 결정 되돌림 (#636) | 토스 레퍼런스 기준 "배경색 통일" 평가. 카드를 슬랩처럼 띄우던 톤 스텝이 차트↔호가 gutter 를 어두운 골로 만들어 화면이 쪼개져 읽힘. 사용자 A/B(현재/중간/통일 스크린샷)로 통일(Level B) 확정 — `--bg`=`--bg-card` 로 gutter 소멸, 분리는 4px gap + `--shadow-panel`(카드 가장자리 옅은 다크 헤일로)만 담당. `--bg-subtle`/`--bg-input` 불변이라 nav·탭 활성/비활성·입력 크롬 어포던스 보존. Obsidian 전용(/live·/heatmap). "분리는 톤+간격"의 극단(톤 스텝 0). |
| 2026-07-15 | **Ledger `--bg` #F6F4EE → #FDFCF8 (= `--bg-card`, 배경 통일)** — 다크와 대칭 (#637) | 라이트도 같은 방식으로 통일. 다크 워크스페이스(borderless, gap+shadow 의존)와 달리 **Ledger feature-route 카드는 `--border` 를 유지**하므로 톤 스텝 0에서도 카드 경계가 보존됨(/study·/screener A/B 확인 — 카드 border 로 분리, 뭉개짐 없음). 원래 Δ~11 로 작아 효과는 다크보다 subtle. `--bg-subtle`/`--bg-input` 불변. |
| 2026-07-15 | 하단 시장지표 바(MarketIndexBar) `bg-subtle`+`border-t` → `--bg` borderless | 상단 TopNav 와 대칭 — 하단 바도 `border-t` 제거 + `bg-subtle`→`bg`(=`--bg`) 로 메인 콘텐츠와 완전 통합. 이제 왼쪽 스택(헤더 → 페이지 → 하단 바)이 위→아래 끊김 없는 단일 `--bg` 면이 되고, 크롬 톤(`--bg-subtle`)은 우측 패널(레일·드로어)에만 남는다. 지수 항목 사이 세로 구분선(`w-px bg-border`)은 콘텐츠 내부 구분이라 유지. |
| 2026-07-15 | 앱 셸 열 기반 재구성 — 우측 패널 full-height + 헤더 콘텐츠 통합 | 앱 셸을 행 기반(헤더 전체너비 / 콘텐츠 / 하단바 전체너비)에서 **열 기반**(왼쪽 스택 `1fr` \| 우측 패널: 드로어 + `var(--rail-w)` 레일)으로 전환 — 우측 패널(드로어+레일)이 화면 상단~하단 **full-height** 열로 서고, 헤더는 우측 패널 위 코너를 양보(main 너비만 차지). 왼쪽 스택은 3행(TopNav / 페이지 / 하단 시장지표 바). 오버레이(토스트·설정 모달)는 `fixed`라 열 배치 무영향. 추가로 TopNav `border-b` 제거 + `bg-subtle`→`bg`(=`--bg`) 로 헤더를 메인 콘텐츠와 완전 통합("분리는 톤+간격" 확장 — 화면 왼쪽은 위→아래 단일 `--bg` 면, 크롬 톤은 우측 패널에만). 헤더 검색창(LiveSymbolSearch 트리거)은 헤더가 좁아질 때(드로어 열림) `min-w-0`+`truncate` 로 두 줄 줄바꿈 대신 한 줄 말줄임. |
| 2026-07-15 | `/study` 워크스페이스 → `/live` 부유 카드 모델로 통일 | `/study` 는 단일 `PanelCard`(border) 안 flush 패널 모델이라 `/live`(필드 위 부유 카드 2장)와 레이어 구조가 달랐음. 바깥 `PanelCard` 프레임 제거 → 차트·상세를 각각 `bg-card`+`rounded`+`shadow-panel` 카드로 만들어 `--bg` 필드 위 4px gap 으로 부유. 탭 바(`ChartTabBar` `background="var(--bg)"`)·헤더 행을 `--bg` full-bleed 크롬으로(WorkspaceHeader→plain --bg div, 상세 aside `bg-subtle`→`bg-card`). 상태 화면(빈/로딩/에러)은 `PageContainer`+`PanelCard` 유지(활성↔상태 전환 점프 방지). 다크(톤 스텝 0=shadow 단독)·라이트(옅은 shadow) A/B 확인. |
| 2026-07-15 | `/live` 종목명 스트립(LiveStatusBar) `--bg-subtle` → `--bg` + 워크스페이스 탭 바 배경 파라미터화 (배경 통일 확장) | 통일된 배경 위에서 종목명 스트립만 `--bg-subtle`(크림/골)로 남아 아래 차트 카드와 톤이 어긋나 보임. 페이지 배경(=워크에어리어)과 동일 톤으로 당겨 스트립+차트를 한 콘텐츠 존으로 통합(`/live` 멀티 탭은 ADR-0113 #641 로 제거되어 탭 바 없음). 공용 `ChartTabBar` 에 `background` prop 신설(기본 `--bg-subtle`) — `/study` 워크스페이스 탭 바가 `--bg` 를 넘겨받아 부유 카드 크롬과 통일(아래 `/study` 항목). 탭 어포던스는 거터 톤 대비에서 **테두리(`--border`)+활성 탭 accent 상단바/테두리**로 이관(비활성=흰 바 위 아웃라인 칩, 활성=accent). `--bg-subtle` 은 TopNav·드로어·설정 nav 크롬 전용으로 축소(워크스페이스 탭 바·price strip 용도 제거). 라이트/다크 A/B 확인. |
| 2026-07-15 | `/heatmap` 카드 → `/live` 패널과 배경·크롬 통일 (borderless) | 기준=`/live` 차트 패널: `--bg-card`(=`--bg`) + `--shadow-panel`, 테두리 없음. `/heatmap` 카드는 유일하게 1px `--border` 링 + 어두운 헤더 밴드(`bg-subtle` + `border-strong`)를 달고 있어 두 다크 표면이 어긋나 보임(둘 다 Obsidian). `PanelCard` 에 additive `borderless` prop 신설 → `/heatmap` 의 두 `PanelCard`(본문·상태 shell)만 opt-in(테두리 제거, 나머지 카드 크롬 유지). 내부 헤더 + `SectorTempStrip` 밴드는 `bg-subtle`→`bg-card`, 구분선 `border-strong`→`border` 로 평탄화(live `WorkspaceToolbar` = `bg-card`+`border-b border` 와 동형). **Ledger feature-route 카드의 `--border` 유지 규칙은 불변** — `/heatmap` 은 Obsidian 전용이라 라이트에서 카드가 배경에 녹는 리스크 없음. 실측: 카드 `border 0px`·헤더 `bg #121216`·구분선 `#232329`(live 패널과 동일). |
| 2026-07-15 | `/screener`·`/inventory`·`/capture` 카드도 borderless (feature-route 전면 통일) | 위 `/heatmap` 통일을 나머지 feature route 로 확장. 이 3페이지는 `/heatmap` 과 달리 기본 `auto` 에서 **Ledger(라이트)** 표면이라, 직전 "Ledger 카드는 `--border` 유지" 규칙과 정면 충돌 — 라이트에서 `--bg`=`--bg-card` + 옅은 shadow 라 테두리를 지우면 카드 경계가 약해진다. **사용자가 라이트 tradeoff 를 명시적으로 수용**하고 `/live`·`/study` 워크스페이스와의 전면 통일을 택함 → 8개 `PanelCard`(screener 3·inventory 3·capture 2) 모두 `borderless`. 이로써 이전 "Ledger 카드 `--border` 유지" 규칙은 폐지되고 `--border` 는 카드 내부 구분선·입력·테이블 전용이 된다. 각 페이지 테스트(`toHaveClass('border')`→`not.toHaveClass`)·DESIGN.md Content framing 규칙 갱신. |
| 2026-07-16 | `/live` 보조지표·설정을 중앙 모달 → **우측 드로어**(`ModalShell side='right'`, ADR-0116)로 전환 + 크롬 상수화 | 두 패널 모두 즉시 적용(저장 버튼 없음)인데 1040×820 중앙 모달이 차트를 덮어 효과를 볼 수 없던 모순 해소 — 드로어(760px)는 좌측 ~520px 차트를 가벼운 딤(`bg-black/30`) 너머로 남긴다. 보조지표↔설정 전환 시 패널이 흔들리지 않도록 폭·nav(240px 마스터-디테일)를 `frontend/src/live/workspaceDrawer.ts` 상수로 강제(copy-paste 드리프트 방지, PR #670·#671 코드리뷰 후속). Center modal 은 확인 다이얼로그(ConfirmModal) 등 짧은 상호작용 전용으로 존속. |
| 2026-07-21 | **호가창 잔량 증감 뱃지 = KRX 컨벤션(증가 `--price-up` 빨강 / 감소 `--price-down` 파랑)** — 차트 오버레이의 teal/fuchsia 와 의도적 분기 (사용자 승인) | 잔량 증감 색은 원래 teal/fuchsia 한 쌍을 세 표면(차트 오버레이·`/live` BookPanel·`/study` OrderbookTable)이 공유했다. 그 색조의 근거는 **레이어 겹침** — 차트에선 잔량 증감과 호가 히트맵(빨강·파랑)이 같은 셀에 동시에 켜져 색이 충돌하면 판독 불가다. 호가창 뱃지엔 겹치는 레이어가 없어 그 제약이 성립하지 않고, 증감은 `--price-*` 의 정의("positive delta = red")에 그대로 들어맞는 시장 데이터라 KRX 컨벤션이 더 직관적이다. 뱃지 2곳만 `priceDirClass()` 로 전환하고 차트 오버레이 기본색(`DEPTH_DELTA_DEFAULT_*`)은 불변 — **두 표면의 색이 다른 것은 버그가 아니라 이 결정이다.** 뱃지는 막대 바깥쪽 끝에 붙어 같은 색 막대(ask 파랑 28% / bid 빨강 28%) 위에 얹히는 경우가 생기지만, 막대가 저알파라 솔리드 텍스트가 읽힌다(장중 실화면 확인). |

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
