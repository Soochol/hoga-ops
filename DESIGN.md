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
| **Default density (1.0×)** | What the app renders at browser zoom 100%. `:root { font-size: 16px }` — since 2026-08-07 the default *is* the base intent, so rendered px equals `baseIntentPx` and the two columns of the token tables coincide. (Was 1.125× / 18px from 2026-07-15.) |
| **Scale dial** | The `:root font-size` declaration in `frontend/src/styles/tokens.css`. Changing it shifts all CSS sizing uniformly. |

**Scope of the dial:**
- ✅ CSS-rendered chrome — fonts, spacing, layout widths, line-heights (all rem-based).
- ❌ `lightweight-charts` canvas — canvas cannot read CSS rem, so the constants live in TS. They *derive* from `RENDERED_ROOT_PX` (`util/chartScale.ts`, `chart/highLowLabelLayout.ts`) so a dial change reaches them, but charts read them at mount — a runtime toggle still needs a remount. **Two canvas constants stay deliberately pinned and do not follow the dial**: `CHART_LAYOUT_OPTIONS.fontSize` (12, see the note at that constant) and `PeakWallSegmentsPrimitive.LABEL_FONT_PX` (11). When adding a canvas text size, derive it — do not hand-compute the px.
- ❌ 1px borders, hairlines, small radii (2–6px), chart canvas internal coordinates — stay in px to protect anti-aliasing and pixel-grid sharpness.
- ❌ **고정 px 콘텐츠만 담는 레이아웃 트랙** — 트랙의 단위는 그 트랙이 보호하는 것의 단위를 따른다. 현재 사례는 하나 — `HeatmapRow` 의 캔들 글리프 열(`14px` = `CandleGlyph.W` 10 + 여유 4, 2026-08-19). rem 으로 두면 **배정만 다이얼을 따라 줄고 내용은 고정**이라 내릴수록 여유가 잠식되고(실측: `0.875rem` 은 root 16/14/12px 에서 14→12.25→10.5px), 셀이 `overflow-hidden` 이라 넘치면 **에러 없이 잘리기만 한다**. 이는 `--app-floor-min-w` 가 rem 인 이유(아래 Responsive floor)의 대우다 — 그쪽은 보호 대상이 전부 rem 기반이다. **텍스트에는 적용되지 않는다**(아래 🚫).
- 🚫 **타이포에 임의값 px 를 쓰지 않는다** (`text-[10px]` 류). 다이얼이 못 잡는 유일한
  DOM 표면이라 그 텍스트만 밀도 변경에서 낙오된다 — 2026-08-04 에 71곳이 그 상태였다
  (아래 결정로그).
  - **맞는 크기가 없으면 토큰을 신설한다.** 하드코딩은 게으름이 아니라 **스케일 공백의
    증상**인 경우가 많다. 71곳의 최대 무리(`10px`·`10.5px` 39곳)가 정확히 `badge`(9.56px
    렌더)와 `xs`(11.81px 렌더) 사이 빈 구간이었고, `text-2xs`(렌더 10.125px) 신설로
    시각 등가(±0.4px)로 흡수됐다. 공백을 놔둔 채 양옆 토큰으로 밀어내면 멀쩡한 텍스트가
    최대 +12.5% 움직인다.
  - **위계가 걸리면 근사 최단 매핑보다 위계가 우선.** 같은 파일에서 `11px`/`12px` 를
    나눠 쓰고 있었다면 그건 의도된 2단이므로 `xs`/`sm` 으로 갈라 유지한다.
  - **함정 (2026-08-07 에 성격이 바뀌었다 — 더 위험해졌다):** 1.125× 시절에는 표의
    **base-intent 열**을 px 로 박으면 렌더값과 어긋나(`xs` base 10.5px → 렌더 11.81px)
    화면에서 바로 티가 났다. 다이얼이 1.0× 가 된 지금은 **두 열이 같은 값**이라
    `text-[10.5px]` 를 박아도 오늘은 아무 증상이 없다. 규칙은 그대로다 — 다이얼이
    다시 움직이는 순간(아래 density 모드) 그 텍스트만 조용히 낙오하고, 이번엔 **직전
    화면과 비교할 근거조차 없다**. 값이 맞아 보이는 것은 우연이지 허가가 아니다.

**Future density modes (backlog):** A user-facing toggle would set `:root font-size` via `[data-density="..."]`. The app now ships at what that backlog called **Compact (1.0× / 16px)**; the remaining rungs are Comfortable (1.125× / 18px — the default until 2026-08-07) and Cozy (1.25× / 20px — the default until 2026-07-15). Both have shipped before, so the ladder is measured, not hypothetical. Blocker unchanged: canvas constants derive from `RENDERED_ROOT_PX` but charts read them at mount, so a runtime toggle needs a chart remount. Not in scope today.

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian × Modern Professional ("Quiet Trading Terminal")
- **Decoration level:** Minimal-intentional — typography does the work. Single accent color. No patterns, textures, gradients, or decorative blobs.
- **Mood:** Serious. Information-first. The product should feel like a precision tool, not a SaaS dashboard. Closer in spirit to Linear than to a Y Combinator startup landing page.
- **Reference points:** TradingView (chart syntax), Linear (UI restraint), Vercel (typography), Bloomberg (data density — but without the 1990s color palette).
- **Density posture:** Ships at **1.0× — the original base intent** (`denser than typical SaaS`, Bloomberg-leaning), reached 2026-08-07 by walking the dial down 1.25× (until 2026-07-15) → 1.125× (until 2026-08-07) → 1.0×. The looser rungs stay reachable through a future density toggle. The product DNA is "Linear-like restraint" at the chosen density, not "must always be small" — the dial is the knob for that judgement, and it has now been turned three times, so treat it as tunable rather than settled.

## Typography

**One typeface, two figure styles.** Pretendard carries Latin + Hangul, prose and data alike. There is **no monospace face in the system** — column alignment comes from tabular figures (`tnum`), not from a monospaced typeface.

- **Display / Hero / Brand:** Pretendard 600–700 — neutral geometric sans, distinctive without being decorative.
- **Body / UI labels:** Pretendard 400–500 — same family as Display for visual continuity.
- **UI / Labels:** Same as body. Small-caps section headers use 10.5px / 600 weight / uppercase, **letter-spacing `normal`** — the system does not track type.
- **Data / Tables / All numbers:** Pretendard 400–600 via the **`font-data`** utility, which carries `font-feature-settings: "tnum"` automatically. Every numeric value uses tabular figures so columns hold their grid.
- **Code (future, if any):** no face reserved. Introduce one only with an explicit decision — do not reach for `monospace`.

- **Font tokens:** `--font-ui` / `--font-data` (theme-independent, defined on the base block in `tokens.css`; Tailwind `font-ui`/`font-sans` → `--font-ui`, `font-data` → `--font-data`). Both resolve to the *same* stack — they differ only in figure style. **Do not reference a font family by name in a component** — always go through the token.
  - **Canvas surfaces** (lightweight-charts axis text, chart drawing labels) cannot read CSS custom properties. They go through `CANVAS_FONT_STACK` in `styles/design-tokens.ts` — one literal, mirroring `--font-ui`, consumed by `util/chartScale.ts` and `chart/drawing/render.ts`. Do not add a third literal. Canvas 2D has no `font-feature-settings` equivalent, so canvas digits are proportional; `tnum` reaches DOM surfaces only.
  - `CHART_LAYOUT_OPTIONS` must be spread **inside** the chart's `layout` option, not at the options root. Spreading it at the root is silently ignored by lightweight-charts — that is how the axis kept the library's default font from v1 until 2026-07-21. Guarded by a nesting assertion in `LiveChartRoot.test.tsx`.
  - `font-mono` survives in `tailwind.config.ts` as a **deprecated alias** mapped to the same value. Do not use it in new code. It is kept mapped rather than deleted so a stray `font-mono` from an unmerged branch fails safe (deleting the key would hand it Tailwind's default monospace stack, whose digits are *not* guaranteed tabular).
- **Why tnum instead of a monospace face:** measured 2026-07-21 — Pretendard's digits are proportional by default (`1` is 7px narrower than `4` at 40px) and collapse to a single uniform width under `tnum`. With `tnum` disabled on a live orderbook, 20 nine-digit prices rendered at **18 distinct widths (3.12px spread)**; with it on, **1 width (0px spread)**. Alignment is therefore a property of the feature flag, not the face — which is why `tnum` is bound to the `font-data` utility rather than left to each call site.
- **Loading strategy:** Pretendard via jsDelivr `<link>` in `index.html` (preconnect + render-blocking stylesheet), `pretendardvariable-dynamic-subset`. Dynamic subset ships per-unicode-range woff2 chunks, so a cold load fetches only the ranges on screen instead of a multi-MB Hangul file. Render-blocking is deliberate: a swap would reflow every number column.
- **History:**
  - v1 speced Geist Sans/Mono but the `--font-ui`/`--font-mono` tokens were never defined, so the app silently rendered in the browser serif default (Times). Fixed 2026-07-08 by defining the tokens and switching to IBM Plex.
  - 2026-07-21: IBM Plex Sans KR + IBM Plex Mono → Pretendard single family; `--font-mono` → `--font-data`; letter-spacing dropped to `normal` throughout. See the decision log.

- **Scale (rem-based, single dial at `:root font-size`):**

<!-- BEGIN AUTO: tokens-typography -->
| Token | Base intent (1.0×) | Rendered @ default (1×) | Use |
|---|---|---|---|
| `badge` | 8.5px | 8.5px | Hierarchical badges (e.g., SymbolSearch market tag) |
| `2xs` | 9px | 9px | Dense chrome micro-labels (창 크롬 서브라벨·상태 칩) |
| `xs` | 10.5px | 10.5px | Small-caps labels, badges |
| `sm` | 11.5px | 11.5px | Table rows, secondary data values |
| `base` | 13px | 13px | Body / UI default |
| `md` | 14px | 14px | Section / page headings |
| `lg` | 16px | 16px | Brand text |
| `xl` | 22px | 22px | Current price (price strip) |
| `2xl` | 32px | 32px | Future hero numerics |
<!-- END AUTO: tokens-typography -->

## Color

- **Approach:** Restrained. Single UI accent per theme. Three mutually-exclusive color categories for UI state, status semantic, and price direction. Two commercial themes share one token contract (see below) — components never branch on theme, they only read tokens.
- **Themes (four, selectable):** the app ships four full palettes behind `<html data-theme>`:
  - **Obsidian** (dark, default) — warm graphite surfaces + brass accent. The trading-terminal / live surfaces.
  - **Ledger** (light) — ivory paper surfaces + banker's-green accent. The review/research surfaces.
  - **Toss Light** (light, `toss-light`) — white cards on a grey floor + toss-blue accent. Benchmarked from tossinvest.com's live tokens (2026-07-22). **The default preference** (2026-08-07 사용자 결정 — `DEFAULT_THEME_PREFERENCE` in `state/themePrefs.ts`, mirrored in `index.html`). Still **never produced by `auto`** — being the default and being auto-reachable are different things. See the Toss Light/Dark note below the token table for the accent-vs-price collision it carries, which is now the *default* experience rather than opt-in.
  - **Toss Dark** (dark, `toss-dark`) — lighter cards on a near-black floor + toss-blue accent. The dark counterpart of Toss Light, benchmarked from tossinvest.com's live dark tokens (2026-07-22). **Manual-select only.**
  - The **preference** (`obsidian` / `ledger` / `toss-light` / `toss-dark` / `auto`) lives in `state/themePrefs.ts` (localStorage `ui.themePreference.v1`); `auto` maps `/live` + `/heatmap` + `/market` → Obsidian and everything else → Ledger via `effectiveTheme(pref, pathname)` (auto only ever picks Obsidian or Ledger — never a toss-* theme). `App.tsx` writes the resolved theme to `data-theme`; `index.html` sets it inline before first paint (FOUC + wrong-theme chart cache guard).
  - **Scope: the user's open browser tabs, not just one.** `subscribeToThemePreferenceStorage` (App.tsx, one subscription for every route since App is the layout route) mirrors another tab's change through the `storage` event, so a tab opened *before* the change follows without a reload — `/live` deep links open in new tabs, so stale tabs were the normal case. What travels between tabs is the **preference**, not the resolved theme: under `auto` each tab still resolves against its own pathname.
  - **Selectors:** `:root, [data-theme='dark'], [data-theme='obsidian']` carry the Obsidian palette + the scale dial + font + all size/spacing/layout tokens; `[data-theme='ledger']`, `[data-theme='toss-light']`, and `[data-theme='toss-dark']` each override **colors only** (density and typography are theme-independent). All three override blocks sit *outside* the base block so `npm run gen:tokens` never touches them.

  > Table below shows the two primary themes (Obsidian/Ledger). **Toss Light** and
  > **Toss Dark** are extra palettes; rather than widen every row, their values live
  > only in `tokens.css` (`[data-theme='toss-light']` / `[data-theme='toss-dark']`)
  > and the summary notes directly under the table.

  | Token | Obsidian (dark) | Ledger (light) | Use |
  |---|---|---|---|
  | `--bg` | `#121216` | `#FDFCF8` | App background — 양 테마 모두 `--bg-card` 와 동일 톤(배경 통일, 2026-07-15 #636 다크 · #637 라이트). 카드 분리=4px gap+`--shadow-panel`(양 테마, borderless — feature-route 카드도 테두리 없음, 2026-07-15 통일; 라이트는 옅은 shadow 로 경계가 다크보다 약함). **Toss Light 예외**: `--bg #f6f7f9` ≠ `--bg-card #ffffff` — 토스식 층 구조를 되살려 명도차로 카드를 분리한다(아래 Toss Light 노트) |
  | `--bg-card` | `#121216` | `#FDFCF8` | Panes, cards, toolbars |
  | `--bg-subtle` | `#0E0E11` | `#F2EFE7` | 설정/지표 nav, 모달 내부 recessed 박스, recessed rows. **앱 셸 크롬에는 더 이상 쓰지 않는다** — `TopNav` 헤더·하단 시장지표 바·`/study` 워크스페이스 탭 바·`/live` price strip 에 이어 **우측 패널(RightRail·드로어 RailShell·드로어 sticky 그룹헤더)까지 `--bg` 로 통일**(2026-07-29, 배경 통일 완결). 새 셸 표면에 이 토큰을 쓰기 전에 아래 결정로그를 볼 것 |
  | `--bg-legend` | `color-mix(--bg-card 70%, transparent)` | 좌동 (파생) | 차트 위 pane 레전드 전용 반투명 surface — 유일한 반투명 배경 토큰. 차트 배경이 `--bg-card` 라 빈 영역에선 안 보이고, 캔들·거래량 바 위에 겹칠 때만 최소 대비를 남긴다. `--bg-card` 파생이라 테마 전환을 자동 추종 — **테마별 rgba 하드코딩 금지**. 앱 크롬 재사용 금지 |
  | `--bg-input` | `#101014` | `#FDFCF8` | Inputs, comboboxes, default tab |
  | `--bg-input-hover` | `#1A1A20` | `#F0EDE4` | Hover state |
  | `--border` | `#232329` | `#E4E0D3` | Default borders, dividers |
  | `--border-strong` | `#33333C` | `#C9C3B2` | Active borders, vertical dividers |
  | `--chart-pane-divider` | `#3a3a42` | `#bcb4a0` | Chart pane separators only (lightweight-charts `layout.panes`); `--border-strong` 근처 톤으로 pane 경계는 남기되 소음은 억제(2026-07-15 완화 — 이전 다크 `#63636f`/라이트 `#9a917c`는 화면 최강 선이라 "분리는 톤+간격" 규칙과 충돌) |
  | `--chart-day-boundary` | `#6d6d7b` | `#8a8271` | 분봉 차트의 거래일 경계 세로 점선(`DayBoundaryPrimitive`). **`--border` 계열을 재사용하지 않는다** — 아래 접근성 절 참조. `--bg-card` 대비 3:1 이상이 이 토큰의 계약이고(다크 3.67:1 / 라이트 3.71:1), 값을 바꿀 때 그 대비를 다시 잰다. 라이트는 종이 팔레트의 **따뜻한** 축을 따른다(차가운 슬레이트 블루 `#64748B` 가 겉돌던 것을 2026-08-27 에 교정) |
  | `--fg` | `#ECECF1` | `#1E2732` | Primary text |
  | `--fg-dim` | `#9A9AA8` | `#5C6673` | Secondary text, dim labels |
  | `--fg-dimmer` | `#63636F` | `#8B94A0` | **비활성(disabled) 요소와 장식 글리프 전용.** 3차 *텍스트* 에는 쓰지 않는다 — 아래 대비 규칙 참조 |
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

- **Toss Light palette (2026-07-22, `[data-theme='toss-light']`):** a third, light,
  manual-select theme benchmarked from tossinvest.com's live design tokens. Key
  differences from Ledger (which it does NOT replace):
  - **Surfaces revive the layer step** (Ledger unifies `--bg`==`--bg-card`; Toss Light does not): `--bg #f6f7f9` (grey floor) with `--bg-card #ffffff` (white cards), so panels separate by luminance the way the reference does. `--bg-subtle`/`--bg-input-hover` `#f2f4f6`.
  - **Ink greys:** `--fg #191f28` · `--fg-dim #4e5968` · `--fg-dimmer #8b95a1`. Borders `--border #e5e8eb` · `--border-strong`/`--chart-pane-divider #d1d6db`. Day boundary `--chart-day-boundary #8b95a1` (grey500 — 3.04:1).
  - **Accent = toss blue** `#3182f6` (hover `#2272eb`, fg white). `--success #03b26c` · `--error #e42939` · `--warn #eb7300`.
  - **Price direction (KRX):** `--price-up #de2b39` (red) · `--price-down #1957c2` (blue).
  - **⚠ Sanctioned exception to the three-way color discipline — accent-vs-price blue collision:** Toss's brand accent is blue and Toss's "down" price is also blue; Toss has no "UI color ≠ price color" rule so it lets them overlap. We keep the toss-blue accent (it *is* the theme's identity) and instead push `--price-down` one tone **darker** (`#1957c2`, blue800) than the accent (`#3182f6`) so the two blues separate. accent rides SOLID-FILL contexts (buttons, active tab, focus, crosshair); down-price rides text/border. **The two blues being close is this decision, not a bug** — mirrors the pre-existing `--error`/`--price-up` both-red overlap. Not perfect on the highest-density surfaces (a blue crosshair over a blue down-candle can read close); accepted for this theme. Elevation/MA tokens reuse the Ledger paper values (both are light surfaces).

- **Toss Dark palette (2026-07-22, `[data-theme='toss-dark']`):** the dark counterpart of
  Toss Light, benchmarked from tossinvest.com's live *dark* tokens. Also manual-select only.
  - **Surfaces revive the layer step** (inverted from light): `--bg #101013` (near-black floor) with `--bg-card #17171c` (cards sit *lighter* than the floor), `--bg-subtle #0c0c0f` (chrome sunk below the floor), `--bg-input #202027` / hover `#2c2c35`.
  - **Off-white ink (NOT pure white):** `--fg #eceff5` — Toss's dark txt-primary is `rgba(242,246,255,0.9)`, deliberately avoiding `#ffffff` to cut glare. `--fg-dim #c3c3c6` (grey700) · `--fg-dimmer #7e7e87` (grey500). Day boundary `--chart-day-boundary #7e7e87` (grey500 — 4.44:1). Borders `--border #2c2c35` (grey100, kept subtle) · `--border-strong`/`--chart-pane-divider` `#4d4d59`/`#3e3f49`.
  - **Accent = toss blue** `#3182f6` (hover `#2562b9`, fg white). `--success #16bb76` · `--error #f65a68` · `--warn #fcb50c`.
  - **Price direction (KRX):** `--price-up #f5445a` (red) · `--price-down #56a3ff` (blue).
  - **⚠ Same sanctioned accent-vs-price exception, INVERTED direction:** on a dark surface a *darker* down-blue (Toss Light's fix) would sink into the background, so here `--price-down #56a3ff` is pushed **lighter** than the `#3182f6` accent instead. Separation direction is set by background luminance. Elevation/MA tokens reuse the Obsidian dark values.

- **Elevation rule:** components never hardcode `rgba(0,0,0,…)` box-shadows — always one of the four shadow tokens (Tailwind: `shadow-overlay`/`shadow-panel`/`shadow-modal`). Obsidian elevates with deep dark halos; Ledger elevates with faint ink-tinted paper shadows. A dark-tuned shadow reused on Ledger turns the ivory gaps between cards into grey trenches and visually deadens the main surface (fixed 2026-07-12).

- **Discipline rule:** Three mutually-exclusive color categories.
  - **UI state** (`--accent` — brass on Obsidian, green on Ledger): buttons, focus rings, active tabs, crosshair, primary CTAs. Never for data.
  - **Status semantic** (`--success`/`--error`): system feedback — capture complete/failed, error banners, calendar cell state, status dots. Never for market data.
  - **Price direction** (`--price-up`/`--price-down`): KRX convention — red = up/buy/positive delta, blue = down/sell/negative delta. Never for UI state or status.
  - This three-way separation prevents the "is this red because it failed, or because it's up?" ambiguity.

- **Tint backgrounds (alpha-tinted chip / hover):** each tracks its base color per theme — read the token, don't hardcode the rgba. Values below are the Obsidian defaults; `[data-theme='ledger']` redefines them against the Ledger accent/status/price colors.
  - `--tint-selection` — active nav, active tab, primary hover, **selected list rows** (tracks `--accent`)
    - **List-row selection rule:** selected rows use the background tint **only** — never add a left accent bar (`border-left: 2px solid var(--accent)` or `shadow-[inset_2px_0_0_var(--accent)]`). Inventory (`ListRow`) is the reference; all right-rail drawer rows (watchlist / heatmap / screener / ranking via `QuoteRow`, saved views) match it. Unified 2026-07-23 — do not reintroduce the accent bar.
  - `--tint-success` / `--tint-error` — completion / error chip background
  - `--tint-neutral` — 중립 칩 배경 (캡처 큐 대기/취소/건너뜀 phase 칩; 2026-08-04 신설 — rgba 하드코딩이 4테마를 못 따라가던 자리)
  - `--tint-success-border` / `--tint-error-border` — banner/chip borders
  - `--tint-price-up` / `--tint-price-down` — buy/sell depth bar, market chip (tracks `--price-*`)

- **10호가 잔량 숫자 (`--qty-ask` / `--qty-bid`, 2026-07-29):** 깊이 막대(`--bar-*`) 위에 얹히는
  잔량 **텍스트** 색. 별도 토큰인 이유는 두 가지 — (1) 막대는 알파 워시라 그 값을 텍스트에
  그대로 쓰면 대비가 무너진다, (2) 같은 행의 증감 뱃지(`priceDirClass`)와 **축이 다르다**:
  뱃지는 delta 의 부호(늘었나/줄었나), 이건 호가의 방향(매도냐/매수냐)이라 매수 잔량이 줄면
  빨간 숫자 옆에 파란 `−` 뱃지가 정상적으로 공존한다. 값은 **등락률 글자와 같은 방향색 2벌** —
  `--qty-ask: var(--price-down)`(매도 파랑) · `--qty-bid: var(--price-up)`(매수 빨강). 새 색이
  아니라 **별칭**이라 `:root` 한 곳 정의로 4개 테마가 각자 값으로 풀리고, 같은 패널 하단의
  총잔량 스트립(`text-price-down`/`text-price-up`)과도 자동으로 일치한다.
  **실측 근거(2026-07-29, tossinvest.com 주문 페이지):** 토스는 표면마다 톤 등급이 다르다 —
  종목 상세 본문 등락률 `blue600 #2272eb`/`red600 #e42939`, 우측 관심 리스트 `blue500 #3182f6`/
  `red500 #f04452`, 하단 지수바 `red700 #de2b39`. 우리 Toss Light 는 `--price-up #de2b39` /
  `--price-down #1957c2`(blue800) 로, 파랑이 한 톤 진한 것은 accent-vs-price 파랑 충돌의 승인된
  예외(위 Toss Light 항목)이지 드리프트가 아니다.

- **텍스트 대비 규칙 (2026-08-04):** **소형 텍스트에 `--fg-dimmer` 를 쓰지 않는다.** 실측
  대비가 배경 대비 **3.15:1(Obsidian) / 2.99:1(Ledger)** 로, WCAG AA 본문 기준(4.5:1)에
  못 미친다. 그리고 이 앱에서 "소형"은 예외가 아니라 기본이다 — AA 의 대형 텍스트 완화
  (18.66px bold / 24px)를 넘는 본문 토큰이 하나도 없어서 `xs`(11.8px)·`sm`(12.9px)·
  `base`(14.6px) 가 전부 *본문* 으로 판정된다. 3차 텍스트의 색은 **`--fg-dim`**
  (6.73:1 / 5.68:1, 양 테마 AA 통과)이다.
  - **`--fg-dimmer` 가 남는 자리:** (1) **비활성 요소** — WCAG 1.4.3 의 "Incidental"
    예외가 비활성 UI 컴포넌트를 대비 요구에서 빼 준다. 흐린 것이 여기서는 *기능* 이므로
    승격하면 비활성이 활성처럼 읽힌다. (2) **장식 글리프** — 창 헤더 드래그 핸들 `⠿`
    같이 텍스트가 아닌 것(`WindowFrame.tsx`). (3) `placeholder:` variant — 입력 힌트는
    별도 축이라 이번 승격 범위 밖이다. (4) 비거래일 캘린더 셀(`baseColorVarFor`) 처럼
    "선택 불가" 를 색으로 말하는 자리.
  - **"소형" 의 경계는 `base` 미만**이다 — `base`(14.6px) 가 "Body / UI default" 이므로
    `xs`(11.8px)·`sm`(12.9px) 와 그 대역의 임의값(`text-[10px]`~`text-[13px]`) 이 대상.
    2026-08-04 에 **142건 / 소스 71파일**을 승격했다. 이전에 아래 관심종목 그룹 헤더
    항목이 "≈3.9:1 로 AA 미달이지만 3차 텍스트로 의도된 트레이드오프" 라고 적어 둔
    자리도 여기 포함된다 — 그 트레이드오프는 폐기됐다.
  - **grep 만으로 판정하지 말 것.** 색이 클래스 문자열에 그대로 있지 않은 경로가 넷이고,
    2026-08-04 작업에서 넷 다 실제로 물렸다: (1) **부모-자식 분리** — 크기는 부모,
    색은 자식(`ResultTable` 정렬 헤더), (2) **멀티라인 className** — 크기와 색이 다른
    줄(같은 파일 `SortHeader`), (3) **변수·함수 반환값** — `toneClass` 삼항식
    (`WorkspaceShell`), `captureHealthPillColor()` 의 인라인 style(`.ts` 파일이라
    `*.tsx` 스캔에도 안 걸린다), (4) **임의값 문법** `text-[var(--fg-dimmer)]` —
    토큰 유틸리티가 있는데 우회한 형태(`StudyPage`·`StudyChartWindow`, 승격하며
    정규 클래스로 교정). **최종 판정은 렌더된 화면의 실측이다** — 라우트를 돌며
    `getComputedStyle` 로 대비를 계산하면 위 넷이 전부 드러난다(양 테마 0건 확인).
  - **`--border` 계열은 아직 미해결:** `--border` 1.20:1 / 1.29:1, `--border-strong`
    1.71:1 로 WCAG 1.4.11(비텍스트 3:1)에 못 미친다. 입력 필드 경계가 사실상 보이지
    않는다는 뜻이다. 텍스트 축과 별개 문제라 이번 승격에 포함하지 않았다.
    - **따라서 캔들 위에 그리는 선에 이 계열을 재사용하지 말 것.** 네 테마 실측:
      `--grid` 1.08~1.19 · `--border-strong` 1.46~2.14 · `--chart-pane-divider`
      1.46~2.01 — "테마 토큰이니 안전하다" 는 직관이 여기서 **반대로** 나온다.
      2026-08-27 에 날짜 구분선을 테마화하며 이 함정을 만났고, 전용 토큰
      (`--chart-day-boundary`, 3.04~4.44:1)을 새로 두어 피했다. 같은 상황이 오면
      기존 토큰을 고르지 말고 **전용 슬롯을 만들고 대비를 적어 둘 것**.

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

- **No OS/system mode:** there is no "system/OS" auto-follow mode. `data-theme` is exactly `obsidian`, `ledger`, `toss-light`, or `toss-dark` at runtime (the legacy `dark` alias maps to Obsidian). `auto` is a *route*-based preference (dark on `/live`·`/heatmap`, else Ledger), not an OS-preference follow, and it never resolves to a toss-* theme — both toss-* palettes are manual-select only. (History: this was "both themes only, no third theme" until 2026-07-22, when Toss Light then Toss Dark were added as explicitly manual palettes.)

## Spacing

- **Base unit:** 4px (base intent = rendered, since the dial is 1.0× as of 2026-08-07; was 4.5px rendered at 1.125×)
- **Density:** Bloomberg-leaning — the dial sits at base intent (1.0×). Density is a spectrum, not a fixed point: the token system holds the whole ladder and the dial picks a rung. Looser rungs (1.125×, 1.25×) have both shipped as defaults before.
- **Scale (rem-based, single dial):**

<!-- BEGIN AUTO: tokens-spacing -->
| Token | Base intent (1.0×) | Rendered @ default (1×) | Use |
|---|---|---|---|
| `2xs` | 2px | 2px | Hairline gaps |
| `xs` | 4px | 4px | Pane gap, tight stacking |
| `sm` | 8px | 8px | Card padding inside, gap between sidebar cards |
| `md` | 12px | 12px | Card padding default |
| `lg` | 16px | 16px | Section spacing, nav item padding |
| `xl` | 24px | 24px | Major section dividers |
| `2xl` | 32px | 32px | (rarely used) |
| `3xl` | 48px | 48px | (rarely used) |
<!-- END AUTO: tokens-spacing -->

- **Card padding:** 12–14px standard. Sidebar cards 12px. Pane bodies 4–6px (info density priority) (base intent — equals rendered at the current 1.0× dial).
- **Pane gap:** 8px between chart panes (base intent — equals rendered at the current 1.0× dial).
- **Sidebar width:** 320px base intent = 320px rendered (token: `--sidebar-w`). 유일한 소비처는 `/inventory` 의 master-detail 좌열(`pages/Inventory.tsx`) — 이름과 달리 사이드바 컴포넌트의 폭이 아니다. *(2026-07-29: `usage` 문자열이 가리키던 "replay viewer 의 Cursor Sidebar" 는 실재하지 않아 실제 소비처로 고쳤다.)*
- **Top nav height:** 32px base intent = 32px rendered (token: --h-top-nav).

## Layout

- **Approach:** Grid-disciplined hybrid — strict grid for the app shell, looser composition inside chart panes.
- **App shell:**
  - Top-level: **column** shell (2026-07-15) — `grid-template-columns: 1fr var(--rail-w)` plus an optional `var(--watchlist-panel-w)` before the rail when a right-rail panel is open. The **right panel (drawer + fixed rail) spans full viewport height** (top to bottom). The left column is a 3-row stack `grid-template-rows: var(--h-top-nav) minmax(0, 1fr) auto` (TopNav / page content / bottom market-index bar; bottom row `auto` collapses to 0 when the bar has no data). The top header therefore spans only the left column's width — it **yields the top-right corner to the full-height right panel**. The explicit row contract keeps content from growing the row (or the `/live` chart) past the viewport. TopNav itself is borderless `--bg` (see below) so the header merges into the page content. **앱 셸에는 이제 크롬 톤이 없다** — 우측 패널(레일 + 드로어 + sticky 그룹헤더)도 2026-07-29 (#911) 에 `--bg-subtle` → `--bg` 로 넘어가 셸 전체가 단일 `--bg` 면이다(`ui/RailShell.tsx` = `bg-bg`). `--bg-subtle` 는 셸 밖 recessed 표면에만 남는다: 모달 내부 박스(`CollectDialog`·`StudyViewSaveDialog`), 스크리너 조건 카드, 설정/지표 nav, 워크스페이스 창 헤더의 비포커스 톤 밴드, sticky 표 헤더(체결 열 헤더 — 거래원 합계행·잠정투자자 열 헤더는 2026-07-30 에 `--bg-card` 로 환원). *(이전 문장: "chrome tone (`--bg-subtle`) survives only on the right panel" — 2026-07-29 정정.)*
  - Main (page-content row): each route owns its own grid. **`/live`** (`frontend/src/live/LivePage.tsx`) is a **3-row** grid — `grid-template-rows: auto auto minmax(0, 1fr)` = `LiveStateBanner` (빈/에러 상태 매트릭스; 상태가 없으면 빈 `div` 로 접힌다 — `null` 을 반환하면 캔버스가 툴바 자리로 밀려 올라간다) / `WorkspaceLiveToolbar` (`--h-toolbar`) / `WorkspaceCanvas` (`1fr`). 열 축도 `minmax(0, 1fr)` 로 **명시해야 한다** — 비워두면 `grid-auto-columns: auto` 가 되고 그 트랙이 차트 캔버스의 min-content 폭에서 바닥을 쳐 `<main overflow-hidden>` 에 잘린다. 나머지 feature 라우트는 workarea 한 행뿐. (`/study` 가 2행 그리드를 갖던 항목은 ADR-0157 로 그 라우트와 함께 사라졌다.) *(History: 이 줄은 `grid-template-rows: 40px 60px 52px 1fr` (tabs + toolbar + price strip + workarea) 로 Replay Viewer 를 기술했다 — `/replay` 라우트·페이지·`state/replayLayout.ts` 는 모두 존재하지 않는다(`main.tsx` 의 라우트는 live·study·heatmap·inventory·screener·capture·settings 7개). 2026-07-29 정정.)*
- **Workspace canvas (`/live`):** 고정 grid 가 아니라 **자유 배치 창 캔버스**(ADR-0119, #706) — 창마다 프랙셔널 rect 를 갖고 자석 스냅 엔진이 배치한다. 창 사이 **2px 틈은 좌표가 아니라 렌더 인셋**이다(`frontend/src/workspace/WindowFrame.tsx` `GAP = 2`; 보이는 카드가 바깥 rect 에서 `GAP/2` 물러나 그려진다) — 스냅 좌표계는 틈에 영향받지 않으므로 간격을 바꿔도 스냅 불변식은 그대로다. *(History: 여기엔 Replay Viewer workarea `grid-template-columns: 1fr 12px <sidebarPx>` (chart + splitter + Cursor Sidebar) 와 `localStorage['replay.layout']` 기술이 있었다 — `state/replayLayout.ts` 와 `sidebar/CursorSidebar.tsx` 는 둘 다 이제 존재하지 않는다(전자는 이전에, 후자는 #916 에서 삭제). ADR-0022 의 트레이드오프는 역사로만 유효. 2026-07-29 정정.)*
- **Chart pane stack (`/live` 차트 창):** CSS grid 가 아니라 **lightweight-charts pane** 을 `setStretchFactor(spec.stretch)` 로 배분한다. 순서와 기본 stretch 는 `frontend/src/chart/paneSpecs.ts` 가 SSOT — candle 1.4 / volume 0.3 / quote-totals 0.4 / ratio 0.4 / fill-strength 0.4 / program-trade 0.35, 그리고 D 전용 투자자 pane 2개(각 0.3). 사용자 조정값(Pane Stretch, #703)이 스펙 기본값을 덮고, 높이가 모자라면 `usePaneFolding` 이 하위 pane 부터 접는다. 어떤 pane 이 뜨는지는 `paneSpecsForTimeframe.ts` 의 게이트(분봉 전용 호가 pane, D 전용 투자자 pane)가 정한다. *(History: `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill) — Replay Viewer 4-pane 시절. 2026-07-29 정정.)*
- **Max content width:** No cap. App fills the viewport (desktop-only).
- **Responsive floor (`--app-floor-min-w`, 2026-07-21):** the app has **one floor for every route**: `59rem` (944px @ the current 1.0× dial; was `57rem`/912px until 2026-08-21, and 1026px at 1.125×). **The floor is rem-based, so it moved with the 2026-08-07 dial change** — the shell now compresses ~114px further before it stops. That is the intended coupling (a denser shell needs less width), not a regression. Above it the shell compresses fluidly; below it the shell stops compressing and `#root` scrolls horizontally (`global.css`). There is **no zoom-detection code anywhere** — browser zoom *is* effective-viewport narrowing, so the width response covers zoom for free (`visualViewport.scale` branching is prohibited: it double-counts window resize vs zoom and doubles the test matrix).
  - **Why a single global value:** the floor is set by the **shell chrome every route shares**, not by page content. Content-light routes (`/settings`, `/capture`) would reflow narrower, but the chrome breaks first, so per-page floors add complexity with no gain. `App.tsx` wraps every route via `<Outlet/>`, so one declaration reaches all pages and a new route can't forget it.
    - 유도 실측(2026-07-21, **당시 밀도 1.125×**): TopNav 자연폭 939px + `--rail-w` 54px = **993px**, 토큰이 33px 여유를 더해 1026px. 이 993px 은 두 번 stale 이 됐다 — ① 2026-08-04 nav 한글화로 같은 절차 재측정 시 자연폭 **710px**(−229px)·필요폭 **764px**(`Screener` 8자 → `스크리너` 4자), ② **2026-08-07 다이얼 1.125×→1.0× 로 위 수치가 전부 옛 밀도 기준이 됐다**(크롬이 rem 기반이라 대략 ×0.889 이지만, 폰트 폭은 선형이 아니므로 추정치를 적지 않는다 — 필요하면 재측정할 것). **토큰은 그대로 57rem 을 유지한다**: 바닥은 nav 하나가 아니라 전 라우트가 공유하는 셸 크롬이 정하는데, nav 가 더 이상 병목이 아니게 됐을 뿐 *다음* 병목이 무엇인지는 측정된 바 없다. 내리려면 그 병목부터 실측할 것 — 지금 내리면 근거 없이 다른 크롬을 압축하게 된다. ③ **2026-08-21 에 nav 가 다시 병목이 됐다** — 상단바 정중앙 시계(`ClockLabel`, 138px `shrink-0`)가 들어오면서 nav 자연폭이 그만큼 늘었다. 실측(1.0×, `/browse`, 캡처 진행 중 `수집 3 · 대기 12` 상태 주입): **920px 에서 우측 클러스터가 nav 오른쪽으로 10px 넘치고 930px 에서 0**. 즉 필요 뷰포트폭 ~930px > 옛 바닥 912px 이라 **바닥에서 상태 텍스트가 레일 위로 밀려 나갔다**. 토큰을 `59rem`(944px)으로 올려 14px 여유를 둔다 — 위 규칙("내리려면 병목부터 실측")의 대우로, **올릴 때도 병목을 실측하고 올린다**. 캡처가 안 도는 평시 자연폭은 866px 이라 이 인상은 **캡처 진행 중 최악값**을 기준으로 한 것이다.
  - **Why rem, not px:** everything the floor protects (nav, rail, panel widths) is rem-based, so the floor must track the density dial — at a future Cozy 1.25× the chrome needs proportionally more room. This is why the floor is *not* on the fixed-px list (hairlines, small radii, and tracks whose content is itself fixed-px — see the dial-scope list above).
  - **Why the scroll owner is `#root`:** if the document scrolls, the shell's `100vh` and the horizontal scrollbar trigger each other (scrollbar begets scrollbar). The shell is `h-full min-w-app-floor`, never `w-screen` — `100vw` includes the vertical scrollbar width, which would make the shell wider than the viewport at every width below the floor. Guarded by `App.test.tsx`.
  - **세로 바닥 (`--app-floor-min-h`, ADR-0122):** 폭과 **대칭**으로 `39rem` (624px @ 현재 1.0× 다이얼; 1.125× 시절엔 702px). `/live` 창은 캔버스 비율로 스케일하므로 캔버스가 계속 낮아지면 호가 단수가 조용히 잘린다 — 바닥 아래에서는 높이도 동결하고 `#root` 가 세로 스크롤을 갖는다. 줌인은 양축을 함께 줄이므로 가로 바닥만으로는 반쪽이다(실측: 줌 200% 에서 폭은 여유였고 **높이가 먼저** 하한에 부딪혔다). 셸은 `min-h-app-floor min-w-app-floor` 를 함께 건다(`App.tsx`).
  - **Re-deriving the floor:** measure the chrome, don't guess. `document.querySelector('nav').firstElementChild` → set `width:max-content` → read `getBoundingClientRect().width`, add the rail. Bump the token when the nav gains items. **라벨 텍스트가 바뀔 때도 재측정 대상이다** — 항목 수가 그대로여도 폭은 움직인다(2026-08-04 한글화가 그 사례).
- Dense tool panels use one outer surface with internal dividers; avoid nested cards inside sidebars, drawers, modals, and detail panels. (Exception: `/live` 상세 지표 카드는 승인된 예외 — Migration Status 참조.)
- **Border radius:** 고정 px **폐쇄 5단**(ADR-0011 — 다이얼을 따라가지 않는다).
  `tailwind.config.ts` 가 `theme.borderRadius` 로 Tailwind 스케일을 **교체**하므로
  이 5단이 전부다 — `rounded-xl`/`2xl`/`3xl` 은 도달 불가이고, 새 단이 필요하면
  임의값(`rounded-[7px]`)이 아니라 `design-tokens.ts` 에 토큰을 추가한다.
  - `none` 0px (explicit square corners — `rounded-none` 과 코너별 변형)
  - `sm` 2px (hairline bars, dense badges)
  - `md` 4px — **bare `rounded` 가 여기로 온다** (chips, small buttons, presets)
  - `lg` 6px (cards, modals, inputs, dropdowns, larger panels)
  - `full` 50% (status dots, avatars)
  - **`DEFAULT` 키를 비워 두지 말 것.** `borderRadius` 맵에 `DEFAULT` 가 없으면
    Tailwind 가 자기 기본값(`0.25rem`)으로 채우고, 그건 **rem 기반**이라 밀도
    다이얼을 따라 움직인다 — ADR-0011 이 막으려던 바로 그 현상이다. 어느 단이
    bare 유틸을 갖는지는 `design-tokens.ts` 의 `isDefault` 플래그가 소유하고,
    생성기가 "정확히 하나" 를 강제한다. 지도의 구멍은 중립적 누락이 아니다 —
    프레임워크가 채운다.
  - **`radius-none` 을 지우지 말 것.** 스케일을 교체했으므로 스케일에 없는 키는
    에러가 아니라 **CSS 미생성**이다. `none` 이 빠지면 `rounded-none`·
    `rounded-r-none` 이 조용히 사라지고, `BookPanel` 의 한쪽만 둥근 잔량 바가
    양쪽 다 둥글어진다(무경고 시각 버그).

### Page shell (feature routes)

Every feature route except the chart workspace follows one shell:

- **Outer padding:** wrap the route in `<PageContainer>` (`frontend/src/layout/PageContainer.tsx`) — the single source of the page padding token (`p-md`). Never hardcode `p-4`/`p-8` at the page root.
- **Content framing:** primary content sits in `bg-bg-card` cards (`PanelCard`). Multi-pane pages (master-detail) use one card per pane; single-content pages use one card. Never nest cards. **레이아웃 열을 나누는 드래그 스플리터는 없다 (2026-08-07):** 마지막 소비처였던 `/capture` 가 열 트랙 고정으로 바뀌면서 `VerticalSplitter` 를 삭제했다. *(범위 주의: lightweight-charts 의 **chart pane separator** — 가격 pane ↔ 거래량/지표 pane 가로 경계 — 는 드래그 리사이즈 기능을 가진 채 **그대로 살아 있다**. 아래 "구분선 최소화" 항목의 유지하는 선 참조.)* — 판정 기준은 "리사이저로 **양쪽이** 얻는 게 있는가"이고, 폼 pane 은 달력이 `repeat(7,2rem)` 고정 트랙이라 최적폭이 하나뿐이었다(광폭에서 폼이 150px 를 빈 여백으로 들고 있었다). 같은 판정을 새 pane 에도 적용할 것: 한쪽 콘텐츠가 고정 트랙이면 리사이저 대신 `minmax()` 로 두 pane 의 하한·상한을 적는다(`frontend/src/pages/Capture.tsx` 의 주석에 실측 유도 과정이 있다). 창 크기 조정이 필요한 곳은 워크스페이스 창(`WindowFrame` 가장자리 핸들)뿐이다. **Feature-route cards are `borderless` in both themes (2026-07-15, 통일 결정):** `/heatmap`·`/screener`·`/inventory`·`/capture` 카드는 `PanelCard borderless` 로 테두리 없이 `--bg-card` + `--shadow-panel` 만으로 배경과 분리 — `/live` 차트 패널과 동일 크롬(부유 카드 모델을 feature route 전반으로 확장). 내부 헤더/스트립 밴드도 `bg-subtle`→`bg-card`, 구분선 `border-strong`→`border` 로 평탄화(live `WorkspaceToolbar` = `bg-card` + `border-b border-border` 와 동형). **Ledger(라이트) tradeoff:** 라이트는 `--bg`=`--bg-card` + 옅은 shadow 라 카드 경계가 다크보다 약하게 읽힌다 — 이전엔 이 때문에 Ledger feature 카드의 `--border` 를 유지했으나, `/live`·`/study` 워크스페이스와의 전면 통일을 위해 **사용자 결정으로 borderless 채택**(라이트에서도 shadow+gap 의존). `--border` 는 이제 카드 프레임이 아니라 카드 **내부** 구분선(`border-b`/`border-t border-border`)·입력·테이블 등에만 쓴다.
- **Floating-card workspace (`/live`, 통일 2026-07-15 · 창 모델로 승계 2026-07-22):** the workspace uses the **부유 카드 모델** — no outer frame border; cards (`bg-bg-card` + `rounded` + `shadow-panel`, borderless) float on a `--bg` field. **현재 형태**: 카드 = 워크스페이스 **창**이고, 개수·배치는 사용자가 정하며(고정된 "차트 pane + 상세 pane" 2장 구도는 없다), 틈은 **2px 렌더 인셋**이다(위 Workspace canvas 항목). 아래 문장의 "차트 pane / 상세 pane 두 카드 + 4px gap + 스플리터" 는 창 모델 이전(ADR-0119 前) 기술이며 카드 크롬 규칙을 세운 근거로만 읽는다 — `/live` 에는 스플리터가 없다(`VerticalSplitter` 는 마지막 소비처 `/capture` 와 함께 2026-08-07 삭제됐다. 창 크기는 `WindowFrame` 의 가장자리 핸들이 조정한다). Chrome above the field (`/live` 종목명 스트립 / `/study` 탭 바 + 헤더 행 — `/live` 멀티 탭은 ADR-0113 으로 제거) is full-bleed `--bg`. Separation is carried by **gap + `shadow-panel`** (다크는 톤 스텝 0이라 shadow 단독, 라이트는 옅은 shadow). `/study` 는 이전엔 단일 `PanelCard`(border) 안 flush 패널(`--bg-card`↔`--bg-subtle` 톤 스텝)이었으나 `/live` 와 동일 모델로 전환 — 바깥 `PanelCard` 프레임 제거, 상세 aside `bg-subtle`→`bg-card` 카드화, 탭 바·헤더 `--bg` 화. 상태 화면(빈/로딩/에러)은 `PageContainer`+`PanelCard` 유지(전환 점프 방지). Rationale: 원래 차트↔상세 17px 이음매의 1px 선 3개가 소음이라 "분리는 톤+간격이 담당" 규칙(#610~613)을 적용, 나아가 두 워크스페이스의 레이어 모델을 하나로 통일. *(History: 여기엔 "스플리터 리사이즈 라인은 평상시 숨김·호버/드래그 시 `--accent` 노출(`/live`)" 규칙이 있었다 — 창 가장자리 accent 바를 2026-08-09 에 삭제하면서 폐기했다. 창 크기 조정의 어포던스는 이제 `cursor-*-resize` 뿐이다. 아래 변경 이력 참조.)*
- **구분선 최소화 — "톤 밴드" (2026-07-22, /live 프로토타입 4시안 비교로 C안 채택):** 크롬
  구분선은 그리지 않는다 — "분리는 톤+간격" 규칙을 창 내부 크롬까지 확장해 명도가 담당한다.
  적용: 워크스페이스 창 헤더 = 경계선 없는 톤 밴드(비포커스 `--bg-subtle` / 포커스
  `--tint-selection`), 차트 창 툴바 밑줄·RightRail `border-l`·RailShell(드로어 좌측선·헤더/
  섹션 밑줄·트리 행 밑줄)·관심종목 행 밑줄 제거, sticky 표 헤더(체결 열 헤더)는
  `border` 대신 `--bg-subtle` 밴드 — **단 거래원 "외국계 합계" 행과 잠정투자자 열 헤더는
  예외로 창 본문과 같은 `--bg-card`**(2026-07-30 사용자 결정, 아래 결정로그),
  lightweight-charts 시간/가격 축 `borderVisible: false`
  (눈금·라벨은 유지). 10호가 내부 격자(매도↔매수 경계·총잔량 스트립)는 유지하되
  `--border-strong` → `--border` 한 단계 완화 — 호가 격자는 잔향만 남긴다. **유지하는 선:**
  기능적 테두리(입력·팝오버·드롭다운·현재가 강조 박스·활성 스파인 `border-l-2`)와 chart pane
  separator(드래그 리사이즈 기능 보유 — **lightweight-charts 의 가로 pane 경계**다.
  가격 pane ↔ 거래량/지표 pane 을 나누고 `panes.separatorColor`/`separatorHoverColor` 로
  칠한다: `LiveChartRoot.tsx`. 2026-08-07 에 삭제된 `VerticalSplitter` 와는 **다른 것**이니
  같이 지우지 말 것). 창 이음매(2px gap+그림자)는 카드 모델의 일부로 존치 —
  이음매 병합(플레이트) 시안은 기각. `--border` 는 이제 데이터 격자·입력·팝오버 전용이다.
  1차 사료: `prototype/live-divider-variants` 브랜치(4시안 스위처).
  - **나머지 라우트 확장 (2026-07-22 후속):** 같은 규칙을 feature 라우트 전반에 적용 —
    /screener 결과 패널 툴바 밑줄·"결과" `DataSection` 헤더 밑줄(`flushHeader`) 제거,
    /inventory 상세 패널 헤더 밑줄 제거·좌측 sticky 검색 밴드 `bg-bg-card`+`border-b` →
    `bg-bg-subtle` 밴드, /heatmap 폴더 헤더 `border-b border-border-strong` 제거(틴트 밴드+
    좌측 `border-l-2` 스파인이 그룹 분리)·섹터 온도 스트립 밑줄 제거, /study 메모 패널 섹션
    밑줄 제거, /capture 큐 스크롤 컨테이너 외곽 `border` 링 제거(중첩 카드 회피). **유지:**
    데이터 표 내부 격자(inventory 캡처 표·capture 큐 행·heatmap 종목 행·`DataTable*` — 전부
    이미 `--border`)와 모달 푸터·레일 드로어(RailShell 반영 완료). /study 활성 워크스페이스는
    공유 `WindowFrameCore`+공유 데이터 창 재사용으로 /live 작업에 이미 포함.
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
> Default rendering = × 1.0 as of 2026-08-07, so these px values *are* what ships
> today. That equality is a property of the current dial, not a permanent fact —
> see [Scale Factor](#scale-factor) before copying any of them into code.

<!-- 여기 `### Tabs (/study — ChartTabBar)` 스펙이 있었다. 그 컴포넌트는 ADR-0149(저장뷰
     탭 제거)로 사라졌고 페이지 자체도 ADR-0157 로 폐지됐다 — 즉 이 문서는 **존재한 적
     없는 컴포넌트의 스펙을 한동안 들고 있었다**. 앱 안에 탭 스트립을 되살리지 않는다는
     판정은 ADR-0113·0149 에 있고, 지금 「탭」은 브라우저 탭만 뜻한다. -->

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
- Font: 13px / 600 weight Pretendard (`--font-ui`; Geist Sans 는 2026-07-08 에 이미 죽은 이름이다 — 2026-07-21 전환 이후 단일 패밀리)
- Hover: filter brightness 1.1

### Orderbook table row
- Height: 22px
- Mono 11.5px
- Right side bar gradient (depth visualization): `--tint-price-up` for bid side, `--tint-price-down` for ask side (10% alpha; the underlying token names encode KRX convention — red for buy/up, blue for sell/down).
- Mid spread row: subtle bg, small-caps teal label

### Watchlist group header (관심종목 패널)
- 구조: `[chevron ▼(펼침)/▶(접힘), 좌측] [그룹명 + 개수 인라인] ··· [⋯ hover 메뉴, 우측]`
- 그룹명: `sm`/600 — 종목명(`xs`/400)보다 크고 굵게. 색은 `--fg-dim` 유지(크기·굵기만으로 위계).
- 개수: `xs` `--fg-dim`, **mono 금지** — 우측 정렬 mono 숫자는 종목 행의 가격 컬럼과
  같은 x에 떨어져 행으로 오독되므로 라벨 옆 인라인 고정. (2026-08-04 이전엔 `--fg-dimmer`
  라 드로어 배경 대비 ≈3.9:1 로 WCAG AA(4.5:1) 미달이었고 "3차 텍스트로 의도된
  트레이드오프"로 적혀 있었다 — 소형 텍스트 승격으로 폐기됐다. 개수는 라벨 버튼
  aria-label 에도 포함되어 AT 로도 전달된다.)
- sticky `top-0` + `--bg` 배경 — 드로어(RailDrawer)와 동일색이라 평시엔 투명처럼 보이고
  스크롤 시에만 행을 가린다. **드로어 배경을 바꾸면 이 헤더도 같이 바꿔야 한다**(색이
  어긋나면 평시에도 띠로 드러남). 공용 `RailGroupHeader` 외에 관심종목·히트맵이 드래그
  재정렬 때문에 헤더를 따로 구현하고 있으므로 3곳을 함께 본다.
- 종목 행(QuoteRow) 종목명은 `xs` — 가격(`sm` mono)이 1차 콘텐츠, 종목명은 식별자.
- 종목 행 들여쓰기: 아래 "우측 레일 리스트 — 종목명 좌측 정렬" 절이 결정한다. 이 절이
  관심종목 전용이었던 것은 2026-08-18 까지다.

### 우측 레일 리스트 — 종목명 좌측 정렬 (관심·히트맵·순위·스크리너)

네 리스트의 **종목명 시작 x 를 한 값으로 맞추는 계약** — `2.5rem`(40px @ 현재 1.0×
다이얼; 1.125× 시절엔 45px, 1.25× 시절엔 50px). rem 이라 다이얼을 돌려도 넷이 함께
움직인다. 이게 없으면 패널을 토글할 때 이름 열이 튄다.

경로가 **둘이고 서로 배타적**이다 (`QuoteRow` 의 여백식:
`leading != null ? 'pl-md' : indented ? 'pl-10' : 'pl-md'`).

- **관심·히트맵·스크리너**: `QuoteRow indented` → `pl-10`.
- **순위**: `leading` 순위번호 슬롯(`w-5` = 1.25rem + 행 `gap-2` = 0.5rem = 1.75rem)이
  `pl-md`(0.75rem) 위에 얹혀 같은 2.5rem 에 떨어진다. **`leading` 이 있으면 `indented`
  는 무시되므로 둘을 함께 넘기지 말 것** — 죽은 prop 이 되고, 읽는 사람은 그게 효과가
  있다고 믿는다.

**드래그 고스트도 이 계약 안에 있다.** 고스트는 자기 리스트 행의 렌더를 그대로
복제하므로(관심종목 고스트는 무동작 `trailingAction` 까지 싣는다) 관심·스크리너 고스트는
`indented` 를, 순위 고스트는 리스트 행과 같은 순위번호 슬롯(`RankSlot`)을 싣는다.
**폭만 맞추는 것으로 대신하지 말 것**: 정렬은 어느 쪽으로도 0px 이 되지만(실측), 순위
고스트에 `indented` 를 쓰면 리스트 행과 다른 분기로 같은 픽셀에 도달해 나중에 슬롯 폭이
바뀔 때 고스트만 조용히 어긋나고, 카드 안에 내용 없는 1.75rem 거터가 남는다.

근거는 두 번 바뀌었다. 출발은 **관심종목의 그룹 위계 교정**이었다 — 그룹 헤더의
chevron+라벨보다 종목명이 왼쪽에서 시작해 위계가 역전되던 것을 밀어냈다(실측 @1.0×
다이얼: 종목명이 라벨 시작보다 2px 오른쪽). 평면 목록인 스크리너로 확장하면서
(2026-08-18, #1378) 위계 근거는 사라지고 **정렬 일관성**만 남았고, 순위 드래그 고스트가
마지막 예외였던 것이 #1380 에서 닫혔다.

### Status dot (general)
- 6px circle, glow via `box-shadow` for active states only

### Error surfaces — 인라인 vs 토스트 (2026-08-04)

에러가 뜨는 자리는 **원인의 위치**가 정한다 — 표면을 새로 고를 때 두 갈래뿐이다.

- **액션 인접 인라인** (`InlineState`·폼 아래 한 줄): 사용자가 방금 누른 액션의 실패.
  실패의 맥락(입력값·버튼)이 화면에 있으므로 그 옆에서 말한다. 예: 캡처 시작 실패,
  이름 변경 실패, 조회 실패. **토스트로 옮기지 않는다** — 시선을 원인에서 떼어놓는다.
- **전역 토스트** (`ToastViewport` 호스트): 사용자 액션과 무관하게 배경에서 벌어진 일
  — 붙어 있을 화면 요소가 없다. 예: 시그널 알림, REST 불가/혼잡, 키움 풀하우스,
  배경 태스크 사망, 디스크 잠식, 그리기 전체 삭제 완료(실행취소 창구).
  호스트는 `App.tsx` 의 `ToastViewport` 에 모인다(2026-08-04 현재 6개).

판정이 애매하면 "이 에러의 원인이 지금 화면에 보이는가"로 가른다 — 보이면 인라인,
안 보이면 토스트. (2026-08-04 UI 조사 #5 의 "토스트 인프라 대비 소비처 1곳" 지적은
조사 시점 값 — 이후 #1069 등으로 배경 이벤트 호스트가 6개까지 늘었고, 남은 인라인
에러는 전부 액션 인접이라 정책상 그 자리가 맞다.)

### Destructive actions — 보호 사다리 (2026-08-04)

파괴적 액션의 안전장치는 **위험도에 비례해 4단계 중 하나**를 쓴다 — 새 표면이 임의로
다섯 번째 패턴을 만들지 않는다(2026-08-04 UI 조사에서 "4패턴 혼재로 누르기 전 예측
불가"로 지적된 것을 사다리로 명문화; 지점별 실사 결과 배치 자체는 위험도와 일치했다).

| 단계 | 패턴 | 기준 | 현행 사용처 |
|---|---|---|---|
| 1 | 즉시 실행(보호 없음) | 단건 + 재생성이 한 동작(재추가·재그리기) | 관심 1종목 제거, 히트맵 1종목 제거, 그리기 1개 삭제, 큐 1행 취소 |
| 2 | 인라인 2단(같은 자리에서 "삭제?" 재클릭 / armed 타이머) | 목록 안 반복 작업 흐름 — 모달이 흐름을 끊으면 더 나쁨 | 프리셋 삭제(`PresetMenu` pendingDelete), 캡처 Cancel All(4초 armed) |
| 3 | 삭제유예 + 실행취소 | 단건이지만 재생성 비용이 큼(사용자 저작물) | 저장뷰 삭제(`StudyViewsDrawer`) |
| 4 | `ConfirmModal(tone="destructive")` | 대량 삭제 또는 부수 효과 동반(멤버 동반 삭제·수집 중단) | 조건검색 삭제, 그리기 전체 삭제, 관심 폴더·히트맵 그룹 삭제 |

- `window.confirm` 은 금지 — 테마 밖 OS 다이얼로그라 온-브랜드 크롬이 아니고,
  테스트에서 스텁 지옥이 된다(2026-08-04 에 잔존 3곳을 `ConfirmModal` 로 전환).
- 단계를 올릴지 애매하면 "실수로 눌렀을 때 복구에 몇 동작이 드는가"로 판정한다 —
  1동작이면 1단계, 여러 동작·재입력이면 3단계 이상.

### Modals & popovers — dismissal contract
Two layers, each with one shared owner. Use them; do **not** hand-roll a dismiss `useEffect`.
- **Center modal** (full-screen backdrop, fixed-position card): wrap in `ModalShell` (`frontend/src/ui/ModalShell.tsx`) — it owns the backdrop, Escape + backdrop-click dismiss, the canon card, and the title + ✕ header. **`/live` 의 보조지표(IndicatorPanel)·설정(SettingsSections) 패널이 2026-08-21 부터 여기 속한다**(사용자 결정, 아래 결정 로그) — 둘은 폭·높이·마스터-디테일 nav 를 `frontend/src/live/workspacePanel.ts` 상수로 공유하므로 클래스를 다시 적지 말고 상수를 소비할 것. 그 동기화는 `App.test.tsx`(설정)와 `IndicatorPanel.test.tsx`(지표)가 **같은 상수를 각각 단언**해서 지킨다 — 한쪽이 하드코딩으로 이탈하면 그 테스트가 빨개진다.
- **Right drawer** (`ModalShell side='right'`, ADR-0116) — ⚠ **2026-08-21 부터 앱 소비자가 0 이다**(설정·보조지표가 중앙 모달로 옮겨갔다; 코드와 `ModalShell.test.tsx` 커버리지는 되돌릴 여지를 위해 남겼다. 새로 쓰기 전에 결정 로그를 읽을 것 — 되돌림이지 신규 선택지가 아니다): full-height right-anchored variant of the same shell — lighter dim (`bg-black/30` vs the center modal's `bg-black/50`), `border-l` instead of the rounded card border, 150ms ease-out slide-in. Purpose: **immediate-apply settings stay visible against the live chart** — the left ~520px of chart remains readable behind the dim, so a toggle's effect is seen in place. Used by the `/live` 보조지표(IndicatorPanel) and 설정(LiveSettingsModal) drawers, which share width (`760px`) and master-detail nav (`240px`) via what is now `frontend/src/live/workspacePanel.ts` (renamed 2026-08-21 — the file no longer describes a drawer) — the two panels must not shift when the user switches between the toolbar buttons, so consume the constants rather than restating the classes.
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
| 2026-05-20 | Monospace 100% for numbers | Tabular-nums is required for orderbook column alignment. Two-font cost (~50 KB extra) is negligible on localhost. **(뒤집힘 — 2026-07-21 참조)** |
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
| 2026-07-21 | **호가창 잔량 증감 뱃지 = KRX 컨벤션(증가 `--price-up` 빨강 / 감소 `--price-down` 파랑)** — 차트 오버레이의 teal/fuchsia 와 의도적 분기 (사용자 승인) | 잔량 증감 색은 원래 teal/fuchsia 한 쌍을 세 표면(차트 오버레이·`/live` BookPanel·`/study` OrderbookTable)이 공유했다. 그 색조의 근거는 **레이어 겹침** — 차트에선 잔량 증감과 호가 히트맵(빨강·파랑)이 같은 셀에 동시에 켜져 색이 충돌하면 판독 불가다. 호가창 뱃지엔 겹치는 레이어가 없어 그 제약이 성립하지 않고, 증감은 `--price-*` 의 정의("positive delta = red")에 그대로 들어맞는 시장 데이터라 KRX 컨벤션이 더 직관적이다. 뱃지 2곳만 `priceDirClass()` 로 전환하고 차트 오버레이 기본색(`DEPTH_DELTA_DEFAULT_*`)은 불변 — **두 표면의 색이 다른 것은 버그가 아니라 이 결정이다.** 뱃지는 막대 바깥쪽 끝에 붙어 같은 색 막대(ask 파랑 28% / bid 빨강 28%) 위에 얹히는 경우가 생기지만, 막대가 저알파라 솔리드 텍스트가 읽힌다(장중 실화면 확인). **2026-08-25 후기:** 대비 상대였던 차트 오버레이(단별 잔량 증감)가 제거됐다(ADR-0161) — `DEPTH_DELTA_DEFAULT_*` 도 함께 사라졌고, 이제 증감 색은 뱃지의 KRX 컨벤션 한 벌뿐이다. |
| 2026-07-22 | **Toss Dark 추가 (`[data-theme='toss-dark']`) — Toss Light 의 다크 대응** | 같은 날 추가한 Toss Light 의 다크 짝. tossinvest.com 라이브 다크 토큰(`data-wts-theme='dark'`) 실측 벤치마크. 수동 선택 전용(auto 무관). **결정 대칭**: (1) 배경 층 부활 — `--bg #101013`(near-black 바닥) ≠ `--bg-card #17171c`(더 밝은 카드), 라이트의 반대(밝은 바닥+흰 카드)를 뒤집음. (2) **accent-vs-price 파랑 충돌을 라이트와 반대 방향으로 분리** — 라이트는 하락 파랑을 accent 보다 *진하게*(#1957c2) 눌렀지만, 어두운 배경에선 진한 파랑이 묻히므로 다크는 하락을 accent(#3182f6)보다 *밝게*(#56a3ff) 띄운다. "분리 방향은 배경 명도가 정한다." (3) `--fg #eceff5` — 순백(#fff) 대신 살짝 푸른 오프화이트(토스 다크 txt-primary=rgba(242,246,255,0.9) 실측 반영, 눈부심 억제). Elevation/MA 는 Obsidian 다크값 재사용. 파일 세트는 Toss Light 와 동일(themePrefs 5-옵션, EffectiveTheme 확장, index.html, Settings, DESIGN, test). |
| 2026-07-22 | **세 번째 테마 Toss Light 추가 (`[data-theme='toss-light']`) — "no third theme" 규칙 폐지** | 사용자 요청으로 tossinvest.com 라이트 팔레트를 벤치마크(라이브 CSS 커스텀 프로퍼티 실측)해 3번째 테마로 도입. Ledger(ivory+초록)를 교체하지 않고 병존 — 수동 선택 전용(`auto` 는 여전히 Obsidian/Ledger 만). **핵심 결정 2가지**: (1) **배경 층 부활** — Ledger 는 `--bg`==`--bg-card` 통일이지만 Toss Light 는 `--bg #f6f7f9`(회색 바닥) ≠ `--bg-card #ffffff`(흰 카드)로 토스식 명도 층을 되살림. (2) **accent-vs-price 파랑 충돌의 승인된 예외** — 토스 브랜드 accent 가 파랑(#3182f6)이고 하락 시세도 파랑이라 우리 3분류 규율(UI색 ≠ 시세색)과 충돌. accent 를 초록으로 빼면 "토스다움"이 사라지므로 토스블루 accent 를 유지하고, 대신 `--price-down` 을 한 톤 진한 `#1957c2`(blue800)로 벌려 분리(accent=solid fill, down-price=text/border). 고밀도 화면에서 완벽하진 않은 트레이드오프를 수용 — 기존 `--error`/`--price-up` 양쪽 빨강 중첩 선례와 동형. 구현: tokens.css 색-only 블록(Ledger 와 동일 세트, base 밖) + themePrefs.ts 4-옵션 + index.html 부트스트랩 + Settings 세그먼트. 차트 canvas 색은 `resolveTokensThemed` 가 `data-theme` 를 캐시키로 런타임 `getComputedStyle` 해석하므로 프로젝터 코드 무변경(폴백 hex 는 테스트/SSR 전용). |
| 2026-07-21 | **타이포 전면 전환: IBM Plex Sans KR + IBM Plex Mono → Pretendard 단일 패밀리** — 모노스페이스 폐지, 숫자 정렬은 `tnum` 으로 이관, `--font-mono`→`--font-data` 리네이밍, 자간 전면 `normal` (사용자 승인, 프로토타입 A/B/C 비교) | 토스증권 타이포 시스템 벤치마크에서 출발. 토스는 **한 패밀리로 본문·숫자를 모두 처리하고 정렬은 `tnum` OpenType 피처로 얻는다** — 모노스페이스 두 번째 패밀리(~50KB)가 불필요해진다. Toss Product Sans 자체는 산돌 제작 전용 서체로 공개 배포되지 않아 사용 불가 → 동일 계열 오픈 라이선스(SIL OFL) 대체제 **Pretendard** 채택(기존 폴백 체인 2순위였음). **실측이 결정 근거**: Pretendard 숫자는 기본 프로포셔널(40px 에서 `1`=17.55px vs `4`=24.97px)이나 `tnum` 적용 시 전부 24.58px 로 균일. 실 호가창에서 대조 실험 — `tnum` OFF 시 9자리 가격 20개가 **18종 폭(편차 3.12px)** 으로 흩어지고, ON 시 **1종(편차 0px)**. 즉 정렬의 원인은 서체가 아니라 피처 플래그이므로, 개별 호출부의 `tabular-nums` 선언에 맡기지 않고 **Tailwind `fontFamily` 튜플로 `font-data` 유틸리티 자체에 `font-feature-settings:"tnum"` 를 결속**했다(구조적 안전). 이 결속이 없으면 `font-mono` 만 있고 `tabular-nums` 가 없던 80개 호출부가 타입 에러도 테스트 실패도 없이 조용히 어긋난다. `font-mono` 는 삭제하지 않고 deprecated 별칭으로 남긴다 — 키를 지우면 Tailwind 기본 모노 스택이 승계돼 등폭 보장이 사라지기 때문(fail-safe). **포기한 것**: 2026-05-20 이 세운 "데이터=기계적 텍스트" 시각적 위계. 토스는 위계를 굵기·색으로만 만들고 서체로 만들지 않으며, 사용자가 실데이터 프로토타입 3안(현행/토스식/하이브리드)을 비교한 뒤 토스식을 선택했다. |
| 2026-07-29 | **우측 패널(레일 + 6개 드로어 + sticky 그룹헤더) `--bg-subtle` → `--bg`** — 배경 통일 완결, 앱 셸에서 크롬 톤 소멸 | 2026-07-15 #636/#637 이 `--bg`=`--bg-card` 로 배경을 통일한 뒤 "크롬 톤(`--bg-subtle`)은 우측 패널에만 남는다"고 적어둔 잔여분을 정리. Obsidian 실측 = 페이지 `#121216` vs 패널 `#0E0E11` (채널당 4~5, 상대휘도 ≈1.3%), 두 면 사이 **border 없음** — 즉 이 미세한 명도차 하나가 패널의 유일한 윤곽선이었다. 사용자가 스크린샷 실측(경계 x≈910px 에서 `rgb(18,18,22)`→`rgb(14,14,17)` 로 딱 끊김)을 보고 우측 패널 전체 적용을 결정. **범위**: `RailShell.RailDrawer`(6개 드로어 공용 셸)·`RailShell.RailGroupHeader`·`RightRail` 레일·`WatchlistDrawer`/`HeatmapDrawer` 자체 sticky 그룹헤더(드래그 재정렬용 별도 구현). sticky 헤더는 "패널 배경과 동일색이어야 평시에 투명" 계약이라 **선택이 아니라 동반 필수** — 어긋나면 평시에도 띠로 드러난다. **범위 밖**(계속 `--bg-subtle`): 모달 내부 recessed 박스(`CollectDialog`·`StudyViewSaveDialog`), 스크리너 조건 카드(`ConditionRow`), 설정/지표 nav, `StudyViewsDrawer` 삭제 유예 토스트(transient 밴드 — `border-t` 로 이미 구분되고 recessed 톤이 "임시" 어포던스). **부수 효과**: `RailToolbarIconButton` active(`--bg-input` `#101014`)가 패널보다 밝음→어두움으로 극성이 뒤집히나 `border-strong` 이 어포던스를 유지한다. 톤 스텝 0이므로 `border-l` 로 경계를 되살리지 않는다(테스트가 `not.toHaveClass('border-l')` 로 고정). Toss Light/Dark 는 층 구조를 유지하는 테마지만 드로어=바닥 톤이라는 의미는 동일하게 성립. |
| 2026-07-29 | **10호가 잔량 숫자에 방향색 2벌 부여 — `--qty-ask`(매도 `--price-down` 파랑) / `--qty-bid`(매수 `--price-up` 빨강) 신설** | 그전까지 `/live`·`/study` BookPanel 의 잔량 숫자는 양쪽 다 `text-fg-dim` 한 색이라 side 정보를 색이 전혀 나르지 않았다. 색 출처는 사용자 지시로 tossinvest.com 주문 페이지 **실측** — 페이지의 `%` 텍스트를 계산색으로 그룹핑하니 세 쌍이 나왔고(본문 `#2272eb`/`#e42939`, 관심 리스트 `#3182f6`/`#f04452`, 지수바 `#de2b39`), `:root` 의 `--wts-adaptive-*` 스케일을 덤프해 본문 등락률 = **blue600/red600** 으로 등급을 확정했다. **스크린샷만으로는 어느 표면의 톤인지 구분 불가**라는 것이 이 실측의 핵심 교훈. 우리 쪽 대응 토큰은 등락률 글자를 칠하는 `--price-down`/`--price-up` 이라 거기에 별칭으로 붙였다 — Toss Light 의 파랑이 한 톤 진한 것(`#1957c2` vs `#2272eb`)은 accent-vs-price 충돌의 승인된 예외이지 드리프트가 아니다. **막대 토큰(`--bar-*`)을 재사용하지 않은 이유**: 막대는 저알파 워시(다크 28~30%)라 텍스트에 그대로 쓰면 대비가 무너진다. **뱃지 색과 축이 다르다** — 증감 뱃지는 delta 의 부호(2026-07-21 행), 잔량 숫자는 호가의 방향이라 "빨간 잔량 + 파란 −뱃지"가 정상 조합이다(테스트가 이 조합을 고정). 별칭이라 4개 테마가 각자 값으로 풀리고 같은 패널 하단 총잔량 스트립과도 자동 일치한다. |
| 2026-07-30 | **거래원 "외국계 합계" 행 `--bg-subtle` → `--bg-card` 환원** (#955 의 거래원 부분 되돌림, 사용자 결정) | #955 가 "구분선 최소화"(2026-07-22) 결정문의 "sticky 표 헤더/합계행(체결·거래원)" 문언을 따라 합계행을 `--bg-subtle` 밴드로 올렸으나, 실제 화면에서 거래원 창 안에 이 행만 배경이 다른 것이 사용자에게 이물감으로 읽혔다. 창 본문이 `--bg-card`(`DataWindow.tsx` 데이터 창 스크롤 컨테이너)이므로 합계행도 같은 값으로 되돌려 창 전체가 한 면이 된다. **`bg-` 클래스 자체는 제거하지 않는다** — 이 행은 `sticky bottom-0` 이라 배경이 투명하면 스크롤되는 거래원 행이 뒤로 비친다("패널 배경과 동일색이어야 평시에 투명" 계약, 2026-07-29 행과 동일 논리). **범위 밖**: 체결 창 열 헤더(`TradeTickTable`)는 `--bg-subtle` 밴드 유지 — 사용자 지적은 거래원 합계행 한정. 테스트가 `bg-bg-card` + `not.toHaveClass('bg-bg-subtle')` + `sticky` 를 못박는다. |
| 2026-08-04 | **소형 텍스트의 3차 색 `--fg-dimmer` → `--fg-dim` 승격 (142건/소스 71파일)** — 토큰은 비활성·장식 전용으로 축소 | 실측 대비가 **3.15:1(Obsidian) / 2.99:1(Ledger)** 로 WCAG AA 본문(4.5:1) 미달인데, **이 앱엔 AA 대형 텍스트 완화(18.66px bold/24px)를 넘는 본문 토큰이 없다** — `xs`(11.8px)·`sm`(12.9px)·`base`(14.6px) 가 전부 본문 판정이라 "3차 텍스트니까 괜찮다"가 성립하지 않았다. 게다가 DESIGN.md 는 이 미달을 관심종목 개수 **1곳만** 승인된 예외로 적어 뒀는데 실제로는 스크리너 파라미터 폼·워크스페이스 메뉴·히트맵 행·10호가 등 전면에 퍼져 **예외가 아니라 기본값**이었다. `--fg-dim` 은 6.73:1/5.68:1 로 양 테마 AA 통과. **승격 제외 4종**: (1) 비활성 요소 — WCAG 1.4.3 "Incidental" 예외가 비활성 컴포넌트를 빼 주고, 여기선 흐린 것이 *기능* 이라 올리면 비활성이 활성처럼 읽힌다, (2) 장식 글리프(`WindowFrame` 드래그 핸들 `⠿`) — 텍스트가 아니다, (3) `placeholder:` variant — 입력 힌트는 별도 축, (4) 비거래일 캘린더 셀(`baseColorVarFor`) — "선택 불가"를 색으로 말한다. **미해결로 남긴 것**: `--border` 1.20:1/1.29:1·`--border-strong` 1.71:1 이 WCAG 1.4.11(비텍스트 3:1) 미달 — 입력 경계가 사실상 안 보이지만 텍스트 축과 별개 문제다. |
| 2026-08-04 | **상단 nav + `/capture` 전면 한글화 — 앱 셸의 언어 이원화 해소** (사용자 결정: "상단 nav 를 한글로") | 상단 nav 는 100% 영어(`Live`·`Heatmap`·`Screener`…), 우측 레일은 100% 한글(`관심`·`히트맵`·`스크리너`…)이라 **같은 앱의 두 내비게이션이 언어가 갈려 있었고**, 무엇보다 `Heatmap`(상단)과 `히트맵`(레일)이 **같은 목적지를 다른 이름으로** 부르고 있었다. Copy tone 규칙상 영어는 도메인 식별자(`hogaplay`·`kis_live`·`EGW00201`) 몫이고 라우트 라벨은 거기 해당하지 않는다 → 라벨 8개를 한글로(`라이브`·`복기`·`히트맵`·`스크리너`·`옵션심리`·`보관함`·`캡처`·`설정`). **파급 2가지가 자동**: (1) `App.tsx` 의 `STATIC_ROUTE_TITLES` 가 `nav/items.ts` 에서 파생하므로 **브라우저 탭 제목이 함께 한글화**된다(별도 표 없음), (2) 반응형 바닥의 유도 근거였던 nav 자연폭 939px 이 stale 이 된다 → 재측정 710px, 토큰은 유지(위 Responsive floor 항목). 같은 규칙으로 `/capture` 도 정리 — `Symbol`/`Date Range`/`Today`/`▶ Start Capture`/`Cancel All`/`Retry Failed`/`Dismiss Done`/`Refresh & Resume`, 캘린더 범례 7개와 툴팁 11개, 월 이동 aria-label. `hogaplay`·`KIS`·`KRX` 는 도메인 식별자/고유명사라 **유지**. `Loading inventory…`/`Loading queue…` 는 로딩 어휘 최다수인 `불러오는 중` 으로 통일. e2e 셀렉터 6개 파일이 영어 문구로 버튼을 찾고 있어 함께 이관(24개 전부 통과). |
| 2026-07-30 | **잠정투자자 창 열 헤더(차수·외국인·기관·합산) `--bg-subtle` → `--bg-card`** — 위 거래원 결정의 연장(사용자 지적) | 같은 이유로 `/live` 잠정투자자 창에서도 헤더 행만 배경이 달라 보였다. 창 본문(`DataWindow.InvestorWindow` = `bg-bg-card`)과 같은 값으로 환원. **배경을 `thead`/`tr` 이 아니라 `th` 4개에 각각 주는 구조는 유지한다** — `border-collapse: collapse` 표에서는 `thead`/`tr` 에 준 배경이 sticky 헤더를 따라오지 않아 스크롤 시 행이 뒤로 비친다. 그래서 "밴드를 없앤다"가 `bg-` 클래스 삭제가 아니라 **값 일치**인 것은 거래원 합계행과 동일하다. 소비처는 `DataWindow` 하나뿐이라(`/study` 는 이 카드를 쓰지 않는다) 다른 배경 위에서 비칠 위험은 없다. 테스트가 4개 셀 각각에 `bg-bg-card` + `not bg-bg-subtle`, `thead` 에 `sticky` 를 못박는다. |
| 2026-08-04 | **`--border`/`--border-strong` 대비 인상 검토 → 현행 유지 (사용자 결정)** | 2026-08-04 UI 조사가 입력 경계 대비 미달(WCAG 1.4.11 비텍스트 3:1 기준 — strong 1.71:1 라이트/1.49:1 다크)을 지적. 입력·팝오버 전용 `--border-strong` 1단 인상안(Ledger #C9C3B2→#AFA792=2.33:1, Obsidian #33333C→#4A4A58=2.15:1)을 A/B 실측 이미지로 비교한 뒤 **현행 유지를 선택** — "분리는 톤+간격, 선은 조용하게"가 이 시스템의 방향이고(pane 구분선을 두 번 낮춘 전례), 단일 사용자 도구라 AA 준수 압력도 없다. 입력 어포던스는 배경(`--bg-input`)·포커스 accent 테두리가 담당. **재검토 트리거**: 입력을 못 찾는 실사용 불편이 실제로 관측될 때 — 그 전까지 조사 도구가 이 수치를 다시 지적해도 재론하지 않는다. |
| 2026-08-04 | **파괴적 액션 보호 사다리 명문화** (Components → Destructive actions) | 4패턴(즉시/인라인 2단/삭제유예+실행취소/ConfirmModal)이 문서 없이 혼재해 "누르기 전 예측 불가"로 지적됐다(2026-08-04 UI 조사). 지점별 실사 결과 배치 자체는 위험도와 일치 — 규칙 부재가 문제라 사다리로 명문화하고 `window.confirm` 금지를 못박았다. 판정 기준: 실수 복구에 드는 동작 수. |
| 2026-08-04 | **`text-[Npx]` 하드코딩 71곳 전량 토큰화 + `text-2xs`(base 9px) 신설** | 하드코딩 텍스트 크기는 `:root font-size` 밀도 다이얼을 이탈한다(미래 Compact/Cozy 에서 그 텍스트만 안 따라옴 — 2026-08-04 UI 조사 #4). 값 분포 실측: 10px×25·11px×20·10.5px×14·12px×6·9/9.5px×4·13px×1. badge(9.56 렌더)~xs(11.81 렌더) 사이 공백이 하드코딩의 원인이라 **`text-2xs`(base 9 → 렌더 10.125px)를 신설**해 10·10.5px 무리를 흡수(기존과 시각 등가, ±0.4px). 매핑: 9/9.5→badge · 10/10.5→2xs · 11→xs · 12/13→sm. **11↔12 는 같은 파일 3곳(타이틀바 등)에서 의도된 위계라 xs/sm 으로 분리 유지** — 근사 최단 매핑(둘 다 xs)이 아니라 위계 보존이 우선. 10↔10.5 공존 1곳은 이미 0.5px 차라 병합 무해. 도그푸딩 실측으로 12.94/11.81px 렌더 확인. |
| 2026-08-04 | **전역 `:focus-visible` 액센트 링 도입 (`global.css`)** | 색 규율은 focus ring 을 `--accent` 소유로 명시했지만 실제로는 `focus-visible` 처리가 8개 파일뿐, 나머지 표면 전부가 브라우저 기본 아웃라인이었다(계약 미이행). `/`·`[`·`]` 단축키가 있는 키보드 친화 도구라 전역 `:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }` 한 블록으로 이행. `:focus` 가 아니라 `:focus-visible` 이라 마우스 클릭에는 링이 뜨지 않는다. inset(−2px)인 이유: 드로어·리스트의 `overflow-hidden` 조상 아래에서 바깥 링은 잘린다. 자체 focus 처리(`focus:outline-none`+ring)는 유틸리티 특이도가 높아 기존 동작 유지. |
| 2026-08-07 | **`/heatmap` 섹터 온도 밴드 축약 검토 → 현행 칩 클라우드 유지 (사용자 결정)** | UI 조사가 상단 밴드의 상시 세로 점유(실측 1680×1000 기준 칩 39개 4줄 = 87px = 뷰포트 9%)를 지적. `?variant=` 프로토타입으로 3안을 실데이터 위에서 A/B — **B** 양 끝단 5+5·나머지 접기(35px) · **C** 종목 수 비례 연속 온도 띠(36px) · **D** 접힌 요약 한 줄(35px). 세 안 모두 세로 60%를 회수하지만 **현행 유지를 선택**. 프로토타입이 확정한 사실 두 가지: (1) **C 계열의 세그먼트 라벨은 원리적으로 불가능** — 39섹터를 1680px 에 나누면 세그먼트 폭 중앙값 45px·60px 이상 3개뿐이라, 지분 임계를 낮춰도 라벨이 3~4글자로 잘린다. C 를 다시 꺼낸다면 라벨을 버리고 hover/클릭 전용이어야 하며 대가는 섹터 카드 wayfinding 상실. (2) 세 안의 회수량이 사실상 동일(35~36px)해 **회수량은 변별점이 아니다** — 판정축은 "접은 것을 얼마나 자주 펼치는가"다. 전체 변형은 throwaway 브랜치 `prototype/heatmap-sector-band-2026-08-07`(커밋 `c9cee0a8`)에 1차 출처로 보존. **재검토 트리거**: 섹터 수가 크게 줄거나(≲20) 칩이 5줄 이상으로 늘어날 때 — 그 전까지 조사 도구가 이 점유율을 다시 지적해도 재론하지 않는다. |
| 2026-08-07 | **`borderRadius.DEFAULT` 누락 복구 — bare `rounded` 143곳이 토큰 밖 4.5px 였다** | `tokens.generated.ts` 가 `sm/md/lg/full` 만 주입하고 **`DEFAULT` 키를 안 냈다** → Tailwind 가 자기 기본값 `0.25rem` 으로 채웠고, root 18px 이라 **4.5px** 로 렌더됐다. 피해 둘: ① 토큰 밖 5번째 반경이 생겨 한 화면에 4px·4.5px·6px 이 공존(실측 `/screener` 버튼 28개에 (반경×높이) 조합 13종, `/heatmap` 은 4.5px 39개와 0px 40개) ② rem 기반이라 **고정 px 이어야 할 값이 밀도 다이얼을 따라 움직였다**(ADR-0011 위반 — root 22px 로 밀면 4.5→5.5px). `design-tokens.ts` 에 `isDefault` 플래그를 두고 생성기가 "정확히 하나" 를 강제하도록 해 복구. **값은 `md`(4px)** — 143곳이 이미 4.5px 로 렌더 중이라 `md` 는 0.5px(시각 등가), `lg` 는 +33%(전 화면 재스타일)다. `text-2xs` 결정(2026-08-04)과 같은 원칙: **구멍은 이미 화면에 있는 값으로 막고, 누수 수정의 부산물로 앱을 재디자인하지 않는다.** `radius-lg` 의 "(default)" 주석은 `md` 로 이관. 덤으로 값이 완전히 같던 임의값 6곳(`rounded-[4px]`×2→`md`, `rounded-[6px]`×4→`lg`)을 토큰화 — 특히 후자는 주석이 "ModalShell 반경에 맞춰"라고 적힌 채 **숫자로만 결합**돼 있었다. `rounded-xl`(13.5px, 다이얼 추종) 2곳도 함께 `lg` 로 — 종목 검색 팔레트인데, **트리거 버튼(`bg-bg-input rounded-lg`)을 눌러 열면 같은 검색 입력면이 13.5px 로 바뀌고** 결과 행은 이미 `rounded-lg` 였다(한 컴포넌트 안에서 갈림). 컨테이너도 `role="dialog"`+`shadow-modal`+`border-border-strong`+`bg-bg-card` 로 `ModalShell` 과 구조가 같은데 **앱에서 유일하게 13.5px 인 다이얼로그**였다. 실측 검증: 4개 라우트 231개 버튼에서 4.5px **0건** · root 22px 에서도 반경 불변 · **빌드 CSS 전수에 rem 기반 반경 0개**(`.rounded`→`var(--radius-md)`, `.rounded-t-md`·`sm`·`md`·`lg`·`full` 전부 토큰). 나머지 임의 반경 12곳도 최근접 토큰으로 스냅(사용자 결정): `[7px]`×5 툴바 알약 4종→`lg` · `[3px]`×2 BookPanel 배지→`sm` · `[1px]`×4 헤어라인→`sm` · `[6px]`×1→`lg`. `[3px]` 은 `sm`(2)·`md`(4) **등거리**라 위계로 갈랐다 — BookPanel 이 이미 `rounded-md` 를 쓰고 있어 배지를 `md` 로 올리면 파일 안 2단이 뭉개진다(`text-2xs` 때의 "위계 우선" 규칙). `[1px]`→`sm` 의 시각 영향은 실측했다: **2px 두께 막대에서 r=1px 와 r=2px 는 픽셀 동일**(CSS Backgrounds §5.5 — 한 변의 반경 합이 변 길이를 넘으면 비례 축소, 2+2>2 → ×0.5 → 1px). 두꺼워지는 경우(스플리터 hover `w-1`, vdist 막대)만 모서리가 1px 더 깎인다. ⚠️ 마지막 `[6px]` 1곳(`live/workspaceDrawer.ts`)은 **`--include='*.tsx'` 스캔 밖이라 1차에서 놓쳤다** — 반경/토큰 스윕은 `.ts` 까지 훑을 것(2026-08-04 `--fg-dimmer` 스윕이 같은 데 걸렸다). **영구 차단까지 완료(사용자 결정)**: `tailwind.config.ts` 에서 borderRadius 만 `extend` 밖으로 빼 **`theme.borderRadius` 로 교체**했다 — `extend` 는 Tailwind 기본 스케일과 *병합*이라 `xl`(0.75rem)·`2xl`·`3xl` 이 해석 가능한 채로 남고, 누가 한 번 쓰면 rem 누수가 재발한다(실제로 그 구멍으로 `rounded-xl` 이 검색 팔레트에 들어왔었다). 교체의 전제 조건 하나: **스케일에 없는 키는 에러가 아니라 CSS 미생성**이라 `radius-none` 토큰을 먼저 신설해야 했다 — 없으면 `rounded-none`·`rounded-r-none` 이 조용히 사라져 `BookPanel` 의 **한쪽만 둥근 잔량 바가 양쪽 다 둥글어진다**(무경고 시각 버그). 검증은 빌드로 했다: 임시 파일에 `rounded-xl`·`2xl`·`3xl` 을 **명시적으로 쓴 뒤 빌드했더니 셋 다 CSS 에 나오지 않았고**, `rounded-none`·`-r-none`·`-t-md` 는 전부 살아 토큰으로 해석됐다. 최종 실측: 전 반경 유틸이 root 18px·22px 에서 **동일**(다이얼 이탈 0), `rounded-md rounded-r-none` = TL/BL 4px·TR/BR 0px 정상. 결과적으로 앱 전체 반경이 `0 / 2 / 4 / 6 / full` **5단으로 폐쇄**됐다 — 새 단이 필요하면 임의값이 아니라 design-tokens.ts 에 추가해야 하고, 그게 이 교체의 요점이다. |
| 2026-08-07 | **테마 기본값 `auto` → `toss-light` + 첫 페인트 부트스트랩 동기 버그 수정 (사용자 결정)** | `auto` 는 테마를 **라우트마다** 고른다(`/live`·`/heatmap`·`/market`=Obsidian, 나머지=Ledger). 그래서 상단 nav 를 **한 번 누르는 것**(히트맵→스크리너)이 화면 전체를 다크↔라이트로 뒤집었다. 명시적 기본값은 라우트 분기를 통째로 없앤다 — 한 테마로 고정. `auto` 는 설정에 옵션으로 남는다. **대가는 문서화·수용**: Toss Light 의 accent 와 `--price-down` 이 둘 다 파랑이고, 실측 지각 거리 **ΔE 17.3** 으로 Ledger(80.8)·Obsidian(139.2)의 약 1/5 이다. 분리는 관례가 떠받친다 — accent 는 솔리드 채움(버튼·활성탭·포커스·크로스헤어), 하락색은 텍스트·테두리. 이 충돌이 이제 옵트인이 아니라 **기본 경험**이므로 두 토큰을 건드리기 전에 위 Toss Light 노트를 볼 것. 함께 고친 **기존 버그**: `index.html` 부트스트랩이 `effectiveTheme` 와 이미 어긋나 있었다 — `OBSIDIAN_ROUTE_PREFIXES` 가 `/market` 을 얻었는데 부트스트랩 목록은 안 따라가서, `auto` 로 `/market` 에 진입하면 **ledger 로 칠했다가 obsidian 으로 뒤집혔다**(그 블록이 막으려던 FOUC·잘못된 테마 차트 캐시 그 자체). 기존 테스트도 `/market` 을 단언하지 않아 **커버리지 구멍이 드리프트 위치와 정확히 일치**했다. 부트스트랩은 모듈 그래프보다 먼저 돌아야 하므로 복제를 없앨 수 없다 → **`themePrefs.test.ts` 가 `index.html?raw` 를 파싱해 기본값·라우트 맵·허용 선호값 3가지를 대조**하고 이탈하면 실패한다. 가드는 4가지 이탈 시나리오로 역실험해 전부 잡는 것을 확인했다(첫 시도는 3항 연산자 기본값을 놓쳐 통과했다 — **통과하는 가드는 아무것도 증명하지 않는다**). **재검토 트리거**: 장중 `/live` 10호가에서 파란 크로스헤어가 파란 하락 잔량 위에 겹쳐 읽기 어려우면 — 장 마감 상태라 그 표면은 이번에 확인하지 못했다. |
| 2026-08-07 | **`/live` 툴바에 거래소 선택기 신설 — 트리거가 현재 값 + 세션 창을 인다 (`거래소 통합 08:00–20:00`), 팝오버로 선택 (사용자 결정)** | venue 상태(`live.venue.v1`)는 이미 전역이었고 관심종목·히트맵·타이틀바가 읽고 있었는데, **변경 수단이 설정 모달 → 데이터 소스 → 거래소 라디오 하나뿐**이라 클릭 4번 깊이에 묻혀 있었다. `?variant=` 4변형을 실데이터 위에서 A/B — **A** 현행 · **B** 툴바 상시 세그먼트 `KRX│NXT│통합` · **C** 요약 pill + 팝오버 · **D** TopNav 전역 배지 + `V` 키. **판정 C**(조합 요구 없음). 프로토타입이 확정한 사실: (1) **판정축은 클릭 수가 아니라 "세션 창이 고르기 전에 보이는가"** 다 — 전환의 실제 비용은 x축이 09:00–15:30 → 08:00–20:00 으로 리플로우되고 NXT 호가 공백 경고가 붙는 **뷰 전체의 교체**이고, 그걸 미리 알리는 정도가 C(선택지마다 병기) > B(`title` 툴팁뿐) > D(없음) 로 갈렸다. (2) **툴바에 앵커되는 팝오버는 body 포털이어야 한다** — `WorkspaceToolbar` 의 `backdrop-blur` 가 `position: fixed` 의 컨테이닝 블록 겸 스택 컨텍스트를 만들어 `left/top` 이 툴바 기준으로 잡히고 `z-50` 도 툴바 안에서만 유효하다(**DOM 엔 있는데 화면엔 없음**; absolute 는 애초에 `overflow-x-auto` 에 잘린다). (3) 포털 패널은 `useDismissablePopover` 의 anchor-contains 예외 밖이라 `onMouseDown` 전파를 끊어야 한다 — 안 끊으면 mousedown 이 먼저 닫아 그 버튼의 click 이 영영 안 온다. **차트 창 헤더는 후보에서 제외**(#759 결정 1 — 앱 전역 값을 창 헤더에 두면 "이 창의 설정" 으로 읽힌다). 설정 모달의 「거래소」 라디오는 **유지** — `DataSourceDetail` 이 /study 도 렌더하고 거기엔 이 툴바가 없다. 전체 변형은 throwaway 브랜치 `prototype/live-venue-control-2026-08-07`(커밋 `2d6932e6`)에 1차 출처로 보존. **재검토 트리거**: 거래소가 4개 이상으로 늘거나, 툴바 폭이 좁아져 pill 라벨의 세션 창이 잘릴 때. |
| 2026-08-07 | **기본 밀도 1.125×(18px) → 1.0×(16px) — 백로그의 "Compact" 도달 (사용자 요청: 전체 UI 폰트 1–2px 축소, 안 A 선택)** | 요청은 "폰트"였고 대안 두 개를 제시했다 — **A** 다이얼 하향(폰트+간격+레이아웃 동시 −11%) · **B** `text-*` 토큰만 축소(글자만 작아지고 여백 유지 → 더 헐거워짐). 사용자가 A 선택. 다이얼 한 값으로 끝난 이유는 2026-08-04 스윕이 `text-[Npx]` 하드코딩 71곳을 전량 토큰화해 뒀기 때문이다 — **다이얼 밖으로 새는 타이포가 0곳**이라 `RENDERED_ROOT_PX` 18→16 + `npm run gen:tokens` 로 전 표면이 따라왔다(본문 14.63→13 · 표 행 12.94→11.5 · 헤딩 15.75→14 · 마이크로라벨 10.13→9). 도그푸딩 실측으로 root 16px·토큰 8개 전부 base intent 일치 확인. **부수 변경 3건**: ① `rightOffset` 이 다이얼 파생이라 14→12 bars(차트 우측 여백), ② 반응형 바닥이 rem 이라 1026→912px(셸이 114px 더 압축된 뒤 멈춤 — 밀도가 낮아졌으니 의도된 결합), ③ 헤더 접힘 임계 재측정(아래). **다이얼을 내리면 "px 를 손으로 박은 자리" 가 전부 드러난다** — 이번에 셋이 걸렸다: (1) `HIGHLOW_FONT_PX = 11.8` 은 `--text-xs × 18` 을 손계산한 캔버스 상수라 다이얼을 따라가지 못했다 → 파생식으로 교체, (2) 차트 헤더 접힘 임계(424·258·303·202·104)는 전부 1.125× 실측 px 라 그대로 두면 **라벨이 들어갈 폭에서도 접히는 무성 회귀** → `/browse` 로 #905 절차 재측정, (3) `chartScale.test.ts` 의 `not.toBe(round(12 × DENSITY))` 는 DENSITY=1 에서 핀 값 12 와 파생값 12 가 붕괴해 **항상 빨간 단언**이 됐다 → 밀도 조건 뒤로 물려 다이얼이 1 이 아닐 때 자동 부활(가드 red-check 실측 완료). **재측정이 stale 상수 하나를 덤으로 잡았다**: 2단계 임계 주석의 "213px" 는 **2버튼 시절 값**이었다(git 확정 — 213 을 쓴 #763 이 저장·수집 버튼을 더한 #767 의 조상). #767 은 1단계만 344→424 로 고치고 2단계는 방치했다 — *바로 그 실수를 경고하는 문장을 같은 파일에 쓰면서*. 무증상이었던 이유는 임계 258 이 4버튼 실요구 254.25 위 3.75px 여유로 **우연히** 살아 있었기 때문이다. 새 실측(1.0× / 30분 라벨): `/live` 펴짐 382 → 임계 **384**, 1단계접힘 235 → **240**; `/study` 272 / 185 / 98. 절차 검증은 **옛 밀도 동시 측정**으로 했다 — 같은 방법을 root 18px 로 돌리니 414.25 / 300.75 / 201.75 / 104.25 가 나와 기록된 415 / 303 / 202 / 104 를 1px 안에서 재현했다. **비례 환산은 쓰지 않았다**: 실측 비율이 0.904 로 ×0.889 와 달라 환산했으면 6px 틀렸을 값이고, 이 파일은 이미 3px 차로 무성 잘림을 낸 전례를 갖고 있다. **함정 하나가 새로 생겼다(문서화함)**: 1.0× 에서는 토큰 표의 base-intent 열과 렌더 열이 **같은 값**이라, `text-[10.5px]` 같은 하드코딩이 오늘은 아무 증상을 안 낸다. 1.125× 시절엔 즉시 어긋나 보이던 실수가 이제 **다이얼이 다시 움직일 때까지 잠복**한다 — 규칙(임의값 px 금지)은 그대로지만 근거가 "값이 다르다" 에서 "값이 같아 보이는 건 우연이다" 로 바뀌었다. 비선형 지점 하나는 남겨 두고 경고를 달았다: `/heatmap` 캔들 셀은 배정(rem)이 줄어도 분자의 `CandleGlyph` 폭이 고정 px 라 여유가 4px→2.39px 로 잠식됐다(실측 30.39 ⊃ 10+2+16=28). `overflow-hidden` 이라 넘쳐도 조용히 잘리므로, **다음 한 칸을 내리려면 여기부터 실측**해야 한다. |
| 2026-08-14 | **시간외 10호가 창 — 격자는 10단 그대로, 채워지는 행만 줄인다 (사용자 결정)** | 15:30 이후 KRX-only 종목의 호가가 얼어붙는 문제에 두 소스를 붙이면서 생긴 표시 결정이다. 벤더가 주는 것이 시간대마다 달라 **화면이 세 모습**을 갖는다: 정규장 10단 · 15:40–16:00 은 사다리 없이 **총잔량 두 개만**(WS `0E`) · 16:00–18:00 은 **5단**(REST `ka10087`). 후보는 **A** 시간외엔 격자를 5단으로 접기(창 높이가 줄고 두 시각이 안 섞임) · **B** 10단 격자 유지하고 중앙 쪽 5행만 채우기. **사용자 선택 B** — 레이아웃이 시간대마다 흔들리지 않는 쪽. 대가는 B 의 알려진 약점이다: **빈 5행이 "데이터 결손"으로 읽힐 수 있다.** 그래서 하단 총잔량 스트립의 조건부 라벨(`시간외` / `시간외 단일가`)이 **장식이 아니라 그 모호함을 해소하는 유일한 장치**가 된다 — 라벨 없이 값만 갈아끼우면 안 된다. 15:40–16:00 모드에는 함정이 하나 더 있다: 사다리는 15:30 정규장 마지막 스냅샷이고 총잔량만 시간외 값이라 **둘의 합이 안 맞는 것이 정상**이다(출처와 시각이 다르다). 구현상 5단은 10칸으로 zero-pad 해서 넣는다 — 정규장에서 짧은 book 이 오는 경로와 같아 격자 로직은 무변경이다. 근거·실측은 `docs/research/2026-08-14-kiwoom-after-hours-orderbook-sources.md`. **재검토 트리거**: 벤더가 시간외 단일가 호가를 5단 넘게 주기 시작하거나, 빈 5행을 결손으로 오해한 문의가 실제로 나올 때. |
| 2026-08-09 | **워크스페이스 창 가장자리 accent 바 삭제 — 리사이즈 어포던스를 커서로만 남긴다 (사용자 결정)** | `WindowFrame` 코어의 변(edge) 핸들 안에 있던 2px `bg-accent` 막대(평상시 `opacity-0`, 호버 시 `opacity-80`)를 없앴다. 이로써 **2026-07-15 에 세운 "스플리터 리사이즈 라인은 평상시 숨김, 호버/드래그 시 `--accent` 로만 노출" 규칙이 폐기**된다(위 본문에 History 주석으로 남김). 계기: 사용자가 `/live` 차트 창 가장자리의 색 선을 시각 소음으로 지목했다. **기능은 불변** — 8방향 히트박스(모서리 12×12, 변 8px)와 `cursor-*-resize` 가 그대로라 리사이즈·스냅 동작은 같고, 사라진 것은 "여기를 잡을 수 있다" 를 **미리** 알려주던 힌트뿐이다. 어포던스가 커서에만 남는 설계의 비용은 **처음 보는 사람에게 기능이 은폐된다**는 것이고, 이 앱은 단일 사용자라 그 비용이 사실상 0 이라는 판단이다 — 다중 사용자 표면에 같은 패턴을 복사하지 말 것. 바가 없어져 변·모서리 핸들이 동형이 됐으므로 `EDGE_HANDLES`/`CORNER_HANDLES` 두 배열을 `RESIZE_HANDLES` 하나로 합쳤다(`bar` 필드와 `group/handle` 유틸리티도 함께 소멸). **범위 주의**: 이 파일은 코어라 `/live` 와 `/study` 창에 **동시 적용**된다. 창 **이동** 중 뜨는 `WorkspaceCanvas` 의 2px accent 스냅 정렬선은 **남긴다** — 리사이즈가 아니라 정렬 피드백이라 축이 다르다. |
| 2026-08-18 | **프로그램 순매수 pane 에 값 레전드 행 추가 + 축 최신값 칩 끄기 — 2026-05-23 규칙으로 복귀 (사용자 결정)** | 이 pane 만 `lastValueVisible: true` 라 규칙에서 벗어나 있었는데, 조사해 보니 **규칙의 전제가 여기서만 깨져 있었다**: 근거인 "analysts read latest values via crosshair" 가 성립하려면 크로스헤어로 값을 읽을 수 있어야 하는데, 프로그램은 `LEGEND_CELL_PANES` 밖이라 레전드 값 행이 꺼져 있었고 그 필터는 **크로스헤어 유무와 무관하게 행 자체를 거른다**(실측: 크로스헤어를 올려도 레전드에 뜨는 것은 OHLC·이동평균선·거래량 셋뿐). 축 칩은 그 구멍을 메우던 것이었다. 그래서 **구멍 쪽을 막았다** — 화이트리스트에 `program-trade` 를 넣어 레전드 행을 되살리고 축 칩을 껐다. 2026-07-22 에 전 pane 을 숨긴 결정의 동기는 **캔들 pane** 의 밀집도였고(MA·flag 칩 6줄), 자기 pane 에 홀로 그려지는 cells 행은 부수 피해였다 — 2026-08-04 의 거래량·총잔량 복원과 같은 성격의 연장이다. **둘 다 켜는 안은 기각**: 축 칩은 SSE 재투영을 따라 거의 실시간이고 레전드 latest 는 캔들 epoch 주기라, 장중에 같은 시리즈가 서로 다른 두 숫자로 보인다(레전드 5,100억 / 축 5,128억). **대가**: 커서를 올리지 않은 상태의 값이 epoch 주기(≈캔들 1개)만큼 stale 해진다 — 거래량 누적이 2026-08-04 부터 이미 같은 상태이고, 정확한 지금-값은 크로스헤어로 읽는다는 규칙 그대로다. idle 실시간이 필요해지면 `dataEpoch` 에 호가 번들을 넣지 말 것(P1 이 제거한 틱당 O(N) 리드백이 부활한다) — 원시값 타겟 구독(`LiveCurrentPriceLine` 패턴)이 기록된 경로다. **남은 비대칭**: 호가비·체결강도·투자자는 여전히 레전드가 없다. 이들은 축 칩도 없어 "크로스헤어로만" 이 일관되게 성립하므로 이번 범위 밖이다. |
| 2026-08-21 | **설정·보조지표 패널을 우측 드로어 → 중앙 모달로 되돌림 (사용자 결정)** — `live/workspaceDrawer.ts` → `workspacePanel.ts` 리네이밍 동반 | 2026-07-16 항목(중앙 모달 → 우측 드로어)을 **뒤집는다**. 그때의 폐기 사유는 "즉시 적용인데 1040×820 중앙 모달이 차트를 덮어 효과를 볼 수 없다" 였으므로, 되돌리기 전에 **시안 4종을 실데이터(삼성전자 1분봉·1600×1000) 위에서 A/B** 했다 — 현행 드로어 · **A 중앙 모달** · B 중앙 비모달 플로팅(딤 없음, 차트 클릭 가능) · B+ B와 드래그. **판정 A**(사용자). 프로토타입이 확정한 실측: (1) **딤은 눈이 아니라 픽셀로 갈린다** — 흰 배경 255 기준 드로어 178 / 모달 127 / 비모달 255 였는데, 축소된 스크린샷에서는 A 와 B 가 거의 같아 보였다. (2) **"뒤쪽 차트를 만질 수 있는가"의 결정적 측정은 `elementFromPoint`** 다 — B 에서만 `CANVAS` 를 반환하고 드로어·모달은 백드롭 div 를 반환한다. 바깥클릭 닫힘도 **양방향**으로 쟀다(드로어·모달 닫힘 ↔ B 안 닫힘) — 한 방향만 봤으면 "항상 안 닫힘" 하드코딩도 통과했다. **수용한 비용**: 딤 50% 가 차트를 덮고 바깥클릭이 패널을 닫는다(= 2026-07-16 이 지적한 그 성질). **흡수한 비용**: 보조지표 nav 16항목의 요구 높이가 실측 903px 인데 드로어는 풀하이트라 그냥 보였다 — 중앙 카드는 높이를 스스로 정해야 하므로 `h-[min(960px,86vh)]` 로 두어 **세로 ~1120px 이상 화면에서는 스크롤이 사라지고** 그 아래에서만 클램프된다(고정 px 하나면 큰 화면의 여유를 못 쓰고, vh 하나면 초대형 화면에서 카드가 쓸데없이 길어진다). 설정 패널은 8항목이라 애초에 스크롤이 없다. **가드의 비대칭을 이번에 메웠다**: 배치를 통째로 바꿨는데 빨개진 것은 `App.test.tsx` 2건뿐이었고 **지표 패널 쪽에는 앵커 가드가 아예 없었다**(72개 전부 초록). 이제 두 테스트가 각각 중앙 앵커 + **같은 폭·높이 상수**를 단언하므로 한쪽이 하드코딩으로 이탈하면 빨개진다 — red-check 은 `side='right'` 되돌림과 높이 하드코딩 두 방향 모두 실측 확인했다. `ModalShell side='right'` 는 **앱 소비자가 0 이 됐지만 코드·테스트를 남긴다**(되돌릴 여지). **재검토 트리거**: 세로 1000px 이하 화면에서 보조지표 nav 스크롤이 실제로 거슬릴 때 — 그때는 카드를 키우는 게 아니라(요구 903px 은 화면을 거의 채운다) nav 그룹 접기를 검토할 것. **⚠ 2026-08-26 에 이 트리거가 소멸했다**: 단일 리스트 전환으로 nav 요구가 903+푸터 → **707px** 이 되어 임계가 세로 ~1,170px → **~830px** 로 내려갔다(아래 항목). 여기 적힌 903px 은 그 시점의 실측으로만 읽을 것. |
| 2026-08-23 | **`--h-live-header` 토큰 삭제 — 이 표의 첫 토큰 제거** | `/study` 폐지(ADR-0157) 후속으로 소비자 `WorkspaceShell.WorkspaceHeader` 가 사라져 **소비처 0** 이 됐다. 지우면서 확인된 사실 하나: 그 마지막 소비처마저 `min-h-12`(3rem = 48px @ 1×)를 얹고 있었으므로(`min-height` 가 인라인 `height` 를 이긴다) **이 토큰은 한 번도 화면 높이를 정한 적이 없다**. 즉 삭제의 시각적 영향은 0 이다. `npm run gen:tokens` 로 `tokens.css`·`tokens.generated.ts` 재생성(손으로 고치지 않는다). |
| 2026-08-23 | **`/study`(복기) 라우트 폐지 — 상단 메뉴가 8개 → 7개 (사용자 결정, ADR-0157)** | 저장뷰는 이제 `/live` 차트 창에서 열린다. 화면에서 사라지는 표면: nav 항목 「복기」 · 그 페이지의 워크스페이스·메모 창·레이아웃 프리셋 메뉴. **남는 표면은 그대로**다 — 우측 레일 「저장뷰」 패널은 nav 짝 없이 레일 버튼으로 열고, 차트 창의 저장 버튼·저장 구간 밴드·착석 칩은 무변경. 부수 효과 둘: 「당일 최고 수평선」 토글이 저장 구간 창에서도 보이고(페이지로 가르던 게이트 제거), 저장뷰 행 하이라이트가 여럿 → 하나가 된다(출처가 그룹 맵 → 기간 슬롯). |
| 2026-08-23 | **Pane Legend 가 지표 설정 변경에 한 박자 늦던 것 수정** | flag provider 는 **비반응형 레지스트리**에 있다(P1: SSE 틱마다 레전드가 재렌더되는 것을 막는 장치). 그래서 provider 값이 달라져도 **오버레이가 다시 렌더될 때**에만 읽힌다. 그런데 이 오버레이는 스토어 토글(`useWindowIndicator`)만 구독하고 **chartPrefs 는 구독하지 않아**, 지표 설정을 바꾸면 선·마커는 즉시 갱신되는데 **레전드만 다음 상호작용(크로스헤어·팬·토글)까지 옛 값**을 보였다. 실측 증상: 매수 최대벽의 MA 필터를 끄면 빨간 선 3개와 화살표가 즉시 나오는데 레전드는 이름만 남아 있었고, 눈 토글 같은 **무관한 조작**을 해야 채워졌다. 처방은 `useScopedChartPrefs()` 를 **값 없이 구독만** 하는 것(`void`). 전체 구독이 안전한 근거: chartPrefs 의 쓰기 경로가 **설정 UI 뿐**이라(실측 4곳) 사용자 조작 빈도이고, P1 이 막은 비용(SSE 틱당 재렌더)을 되살리지 않는다. 반환값은 상태 객체당 memo 된 안정 참조라(`prefsForScope` WeakMap) 렌더마다 새로 구독되지도 않는다. ⚠ **레지스트리를 반응형으로 바꾸는 것은 여전히 금지다** — 그건 P1 을 정면으로 되돌린다. 고친 것은 「언제 다시 읽는가」뿐이다. |
| 2026-08-23 | **팬 프레임마다 `LiveChartRoot` 를 통째로 재렌더하던 두 경로 제거** | `setVisibleTimeCutoff` 가 시간범위 변화마다 setState 를 했다. 문제가 **둘**이었다. **① 무조건 구독**: 그 값은 「보이는 최신 봉 기준」 pref 가 꺼져 있으면 통째로 버려지는데, 두 pref 의 **기본값이 둘 다 false** 라 대다수 사용자가 아무 이득 없이 훅 수백 개짜리 컴포넌트의 재렌더 비용을 내고 있었다 → 한쪽이라도 켜졌을 때만 구독한다. **② 새 객체 identity**: `rightmostVisibleCandleCutoff` 는 호출마다 새 객체를 내므로, 오른쪽 끝 봉이 **그대로여도** 재렌더가 났다 → `nextVisibleTimeCutoff` 가 같으면 이전 참조를 돌려주고 React 가 `Object.is` 로 그 갱신을 버린다. **실측**(삼성전자 1분봉, 30프레임 조작): 줌(오른쪽 끝 고정) 이벤트 31건 중 끝 봉이 달라진 것 **1건** — ②가 31 → 1 로 줄인다. 좌측 팬은 끝 봉이 실제로 움직여 12/10 · 31/29 라 ②의 몫이 작고, 그 경우엔 ①이 기본 설정에서 **전부** 없앤다. 비교를 순수 함수로 뗀 이유: 「참조가 보존되는가」를 컴포넌트 없이 `toBe` 로 재야 한다 — 호출부에 인라인으로 두면 그 비교를 지워도 아무 테스트도 빨개지지 않는다. |
| 2026-08-23 | **당일 최대벽 렌더를 단일 소스로 — 계산 호출부 6곳 → 1곳** | 같은 계산이 여섯 곳에서 각자 돌았고(선 오버레이 2 · 도킹 라벨 2 · 고저 라벨 회피 2), 「이 지표가 지금 그려지는가」가 **네 가지 표기**로 손으로 적혀 있었다. 넷이 우연히 일치했을 뿐 일치를 강제하는 것이 없었고, **실제로 하나가 어긋나 있었다**: **회피 경로만 `allPriceRankLimit` 을 안 넘겨 기본값 1 로 돌고 있었다** — 「체결된 벽 표시 개수」를 2·3 으로 둔 사용자는 그날 2·3번째 벽이 그려지는데도 고저 극값 라벨이 그것들을 피하지 않았다. 인자 하나가 빠진 것이라 타입이 못 잡는다. `usePeakWallRender` 훅 하나가 계산과 게이트를 소유하고, 표면 셋은 **같은 참조**를 받아 자기 플래그만 읽는다. ⚠ **불변식**: `segments` 는 `enabled` 기준으로만 계산한다 — 눈(hidden)으로 숨겨도 레전드는 값을 유지해야 하므로(MA 규칙). 무엇이 그려지는지는 `drawn`/`labels`/`arrows` 플래그가 말한다. 계산이 컴포넌트 밖으로 나오면서 이 규칙의 집도 훅으로 옮겼고, 그 자리에 red-check 가드를 뒀다. 덤: 매도·매수 오버레이가 **한 컴포넌트**가 됐고(`LivePeakWallSegments`, side prop), 봉 극값 맵을 두 벌 만들던 것도 한 벌로 합쳤다. 컴포넌트 576줄 → 331줄, 초기 로드 raw −2.5 KB. |
| 2026-08-23 | **매도 최대벽 오버레이의 팬·줌 재계산 제거 (죽은 구독)** | `LiveAskPeakSegments` 가 `visibleLogicalRangeChange` 마다 세그먼트를 **통째로 다시 만들고** 있었다. 그 구독의 근거는 「보이는 영역 최대벽」 강조가 update 시점에 `getVisibleRange()` 를 읽는 것이었는데, 그 강조가 사라지면서 **이 계산에서 보이는 범위를 읽는 곳이 하나도 남지 않았다** — 유일한 범위 의존 입력인 `visibleTimeCutoff` 는 prop 이고 그 구독은 `LiveChartRoot` 에 따로 있다. **판별식은 비대칭이었다**: 매수 오버레이엔 이 구독이 애초에 없었고 그래서 잘 돌았다 — 같은 계산인데 한쪽만 구독한다면 그 구독은 필요 없거나 반대쪽이 틀린 것이고, 여기선 전자였다. 팬에 따라가야 하는 것들(레전드 셀 · 순위 화살표 · 고저 라벨 회피)은 전부 **draw 시점 랭킹**이라 구독과 무관하다. ⚠ 범위를 읽는 입력을 다시 넣으면 구독도 되살려야 한다 — 가드 테스트가 그때 뒤집힌다. |
| 2026-08-23 | **당일 최대벽 매도·매수 빌드 계층 통합 — 169줄 바이트 동일 중복 제거** | `LiveAskPeakSegments` 와 `LiveBidPeakSegments` 의 순수 계층이 **정규화 diff 로 169줄 바이트 동일**이었다(`expandBaselinePeaks` 40줄과 `buildXPeakOverlaySegments` 39줄은 **함수 이름 한 줄만** 달랐다). `peakWallSegments.ts` 한 벌로 합친다. **중복 자체보다 그것이 가린 것이 문제였다** — 매수의 「보이는 영역 최대벽」 노브가 강조 색 없이 한 달 넘게 살아 있었는데, 169줄이 똑같으니 눈이 "이 둘은 같다" 로 미끄러져 아무도 못 봤다(당일 두 PR 에 걸쳐 이 파일들을 고치면서도 기계적 diff 를 돌리기 전엔 못 봤다). **side 인자를 두지 않는다**: 방향은 이미 호출자가 넘기는 데이터와 필터 안에 있다(`PeakMaFilter` 가 자기 side 를 들고 다닌다). 방향이 실제로 갈리는 것은 **그리기뿐**이라 화살표 계층만 side 를 받는다. ⚠ `applyPeakVisibleTimeCutoff` 의 `side` 인자는 본문이 `void options.side` 로 **버리고 있었다** — 그 죽은 인자가 두 호출부를 텍스트상 다르게 만들어 「같은 계산인데 달라 보이게」 한 원인 중 하나였다(함께 제거). `AskPeakSegment` → `PeakWallSegment` 개명도 같이 했다(매수도 쓰는 타입이 매도 이름을 달고 있었다). **남은 것**: primitive 클래스 이름(`AskPeakSegmentsPrimitive`)은 20개 파일이 참조해 순수 churn 이라 별도로 두고, 세그먼트 **계산 호출부 6곳**(오버레이 2 · 도킹 라벨 2 · 회피 2)의 단일 소스화는 다음 단계다. |
| 2026-08-23 | **「보이는 영역 최대벽」 색 강조 제거 — 매도·매수 모두 (사용자 결정)** | 같은 날 들어간 순위 화살표가 이 채널을 **중복으로 만들었다**: 레전드의 ①②③ 과 캔들 밖 화살표 ①②③ 이 「화면에서 가장 큰 벽」을 **순위까지 정확히** 나르는데, 색 강조는 같은 정보를 「상위 N 개 중 하나」 라는 덜 정밀한 형태로 반복했다. 채널 하나를 통째로 줄인다(캔들 pane 은 이미 급증 마커 ▼/▲ · 도킹 라벨 · 점 · MA 선이 겹치는 곳이다). **계기는 매수 쪽의 죽은 노브였다** — 「보이는 영역 최대벽 표시 개수」가 매수 설정에 있는데 강조 색이 존재한 적이 없어 아무 시각 변화도 없었다(`08f29fc1` 이 Ask/Bid 양쪽 config 에 노브만 대칭으로 넣고 매수 렌더링 절반은 만들어진 적이 없다). 고치는 길이 「대칭 완성」과 「제거」 둘이었고 **둘 다 아닌 「양쪽 제거」**가 선택됐다. ⚠ 그 노브는 무동작이 아니었다 — `maxPeakRankLimit(하루개수, 강조개수)` 를 통해 **하루 안 벽 생성 개수**를 늘리고 있었다(오표기 컨트롤). 기본값이 둘 다 1 이라 **기본 사용자 화면은 안 바뀌지만**, 그 노브를 2·3 으로 둔 사용자는 벽 개수가 「체결된 벽 표시 개수」 하나로만 결정된다. 남은 순위 어휘는 둘로 줄었다: `allPriceRankLimit`(하루 몇 개) · `PEAK_WALL_LEGEND_RANK_LIMIT`(판독 3 고정). **초기 로드 raw −3.5 KB**(1,316.9 → 1,313.4) — 이 예산 상수가 내려간 첫 사례다. |
| 2026-08-23 | **당일 최대벽 상위 3개를 캔들 밖에 순위 화살표로 (사용자 요청)** | 선·점·도킹 라벨은 전부 **벽 가격** y 에 붙는다. 벽이 캔들에서 멀면 "그게 어느 분봉이었나" 가 눈에 안 들어온다 — 화살표만 앵커가 **캔들 극값**(매도 고가 위 ↓ · 매수 저가 아래 ↑)이라 레전드의 ①②③ 과 봉이 1:1 로 이어진다. 매수 방향은 **미러**(사용자 결정): 이 pane 의 기존 문법과 일치한다(도킹 라벨 매도=위/매수=아래 · 급증 마커 ▼/▲). **⚠ ▼ 는 이미 다른 뜻이다** — `WallSurgeMarkersPrimitive`(호가벽 급증)가 같은 pane 에 속 찬 삼각형으로 ▼/▲ 를 쓰고 채움·테두리로 결말·유형까지 인코딩한다. 그래서 **축(shaft)이 있는 화살표 + 순위 숫자**로 형태를 가른다(숫자가 결정적 구분자다 — 급증 마커엔 숫자가 없다). **2026-08-26 후기:** 그 대비 상대였던 호가벽 급증 지표가 제거됐다(ADR-0162) — 축+숫자 형태는 **그대로 둔다**(레전드 ①②③ 과의 1:1 대응이 그 마커의 존재 이유다). **색은 지표 기본색 고정**: 「보이는 영역 최대벽」 강조색은 **선의 언어로 남긴다**. 화살표에까지 얹으면 레전드(행 스와치 하나, 셀별 색 없음)와 채널 수가 갈리고, 강조 규칙이 두 곳에 복제된다. **랭킹은 draw 시점**에 primitive 안에서 한다 — 팬·줌마다 draw 가 다시 도니 별도 구독이 없고, 레전드 provider 와 **같은 함수·같은 프레임의 보이는 범위**를 읽어 둘이 다른 상위 3개를 보일 수 없다. 줌 예산(`peakLabelBudgetForBarSpacing`)은 **적용하지 않는다**: 최대 6개라 라벨 수십 개처럼 충돌하지 않고, 오히려 라벨이 사라진 줌에서 "여기가 상위" 를 알려주는 것이 값어치다. 눈(👁)은 화살표도 지운다(그리기이므로 — 레전드 값과 다른 취급). **고저 극값 라벨과의 충돌은 회피 기계에 연결했다**: 매도 1위 벽의 봉은 화면 고가일 확률이 유난히 높은데 극값 라벨이 정확히 거기 붙는다. 회피 대상은 **그려지는 상위 N 개만** — 전건을 넣으면 있지도 않은 화살표를 피해 라벨이 표류하는 유령 회피가 되고, 그건 칩 rect 에서 이미 겪은 결함이다. |
| 2026-08-22 | **당일 최대벽 flag 레전드 행 복귀 + 값을 「보이는 영역 잔량 상위 3개」로 (사용자 요청)** | 2026-07-22 에 캔들 pane 밀집도 때문에 flag 행을 **전부** 숨긴 결정을, 매도·매수 최대벽 두 행에 한해 되돌린다(`LEGEND_FLAG_IDS` 화이트리스트 — `LEGEND_CELL_PANES` 와 같은 성격). **뒤집기가 아니라 전제 변화다**: 그때 숨긴 flag 값은 「커서가 올라간 거래일의 벽 1개」라 커서를 올리지 않으면 이름만 남은 빈 칩이었는데, 값이 **화면 전체 요약**으로 바뀌면서 커서 없이도 읽을 것이 생겼다 — 2026-08-18 프로그램 순매수 복원(“규칙의 전제가 여기서만 깨져 있었다”)과 같은 성격의 연장이다. **값 규칙**: 보이는 시간 범위와 겹치는 벽 중 잔량 내림차순 3개, 셀은 「순위 + 가격, 잔량」. 3개 고정이며 설정의 「보이는 영역 최대벽 표시 개수」(0~3)와 **무관**하다 — 그 노브는 선 강조 색만 관장하고, 0 을 고른 사용자의 레전드가 통째로 비면 지표를 끌 눈·✕ 까지 사라진다(같은 이유로 겹치는 벽이 0개여도 행은 남긴다). **랭킹은 한 곳**(`peakWallVisibleRanking.rankVisiblePeakSegments`)에서만 하고 선 강조와 레전드가 **같은 함수**를 쓴다 — 두 벌이면 동점(같은 잔량)에서 조용히 갈려 선은 A 를 강조하는데 레전드 1위는 B 가 된다(red-check 실측). 값 문자열도 도킹 라벨과 같은 `formatPriceQty` 다(#839 재발 방지). **대가**: 캔들 pane 에 상시 2줄이 늘어 좁은 워크스페이스 창에서는 3번째 셀이 잘린다 — 셀당 약 13자라 폭을 줄일 여지가 거의 없고(가격 축약은 Y축 정밀도라는 이 지표의 요점을 없앤다), 잘림은 `boxStyle` 의 기존 `overflow:hidden` 이 받는다. **재검토 트리거**: 좁은 창에서 1위조차 안 보인다는 보고가 오면 — 그때는 포맷이 아니라 **행 접기**(라벨만 남기고 값 토글)를 검토할 것. |
| 2026-08-26 | **보조지표 패널 리디자인 — 2모드 플립 폐지 + 글리프 + 미리보기 카드 + 검색** (#1616·#1617, 승인 목업 `docs/superpowers/designs/2026-08-26-indicator-panel-redesign.html`) | 좌측 목록이 「내 지표」와 카탈로그 **두 모드**라 15종 중 무엇이 켜져 있는지 한 화면에서 볼 수 없었다. 2모드 분리의 근거였던 "켜고 끌 때 행이 두 구역 사이를 오가면 방금 조준한 항목이 커서 밑에서 움직인다" 는 **옳은 제약**이고, 순서를 존재 여부와 **무관하게 고정**하면 같은 제약이 더 싸게 만족된다 — 오갈 구역이 없으면 움직일 일도 없다(가드: 추가·삭제 후 행 순서 동일). 추가 여부는 행 **안**의 상태로 말한다: 잉크 농도 + **인스턴스 색 점** + ＋/✕. 색 점은 장식이 아니라 **차트에 실제로 그려지는 색의 메아리**라 패널·레전드·캔버스가 같은 색을 쓴다 — 그래서 **사용자 색이 없는 7종(거래량·총잔량·호가비·체결강도·프로그램·투자자 둘)은 점이 없는 것이 정답**이다(목업은 거래량·체결강도에 점을 그렸으나 그건 일러스트였고, 실제로 찍으려면 없는 값을 지어내야 한다). **글리프 15종**은 단색 `currentColor` 16px 미니 스키마틱이고 문법이 둘로 갈린다 — **오버레이는 캔들 고스트 위, 하단 패널은 구분선 아래**. 즉 그림 하나가 "무엇을 그리나" 와 "어디에 그리나" 를 함께 답하고, 후자는 헤더 eyebrow(`10호가 지표 · 캔들 오버레이`)가 텍스트로 확정한다. ⚠ 조각 공유를 `<symbol id>`+`<use>` 로 하지 말 것 — nav 15행과 미리보기 카드가 **동시에** 렌더돼 문서에 같은 id 가 여럿 생기고, 중복 id 의 `<use>` 는 **조용히 첫 정의만** 따라간다(JSX 프래그먼트 상수로 둔다). **미추가 지표는 설정 폼이 아니라 미리보기 카드**다: 종전엔 존재하지 않는 지표의 *편집 가능한* 폼이 떠서 저 스위치를 만지면 무슨 일이 나는지가 화면에 없었고, 실제로 일부는 상태를 바꿨다(최대벽 방향 토글 — 그 테스트가 미리보기를 우회 경로로 쓰고 있었다). 추가하면 **그 자리가 폼이 된다**(선택 불변). 목업의 위치 스키마 그림·기본값 표는 **보류** — 지표마다 손으로 그린 그림 15장이 필요해지고 설정이 바뀌면 낡는다. **검색**은 nav **안**에 둔다(밖에 래퍼를 더하면 "nav 부모가 톤 면, 그 부모가 2열 그리드" 앵커가 한 겹 어긋난다). Enter 는 **선택까지만** — 라벨=미리보기 어휘가 키보드에도 적용된다. ⚠ 한글 조합 중 Enter 는 **글자 확정이지 명령이 아니라** `isComposing` 가드가 필요하고(리포 최초 사례), Escape 사다리(검색어→메뉴→패널)는 `stopPropagation` 없이는 성립하지 않는다(`ModalShell` 리스너가 `document`, 팝오버가 `window` 라 document 가 먼저 발화). **초기화는 헤더 ⋯ 로** — 가장 위험하고 가장 드문 항목이 매일 쓰는 목록의 상석을 차지하고 있었다(보호 수준은 인라인 2단 그대로, `ConfirmModal` 은 중첩 모달이라 금지). 지표 **이름·설명은 `CATEGORIES` 로 이관**한다 — 미리보기 카드는 Config 를 렌더하지 않으므로 설명이 그 안에 있으면 애초에 닿지 못한다. `hiddenCategories` prop 은 소비처 0 으로 제거(`/study` 폐지의 잔여물). **높이 근거 갱신**: nav 요구 903+푸터 100 ≈ **1,003px → 707px**(검색 40 + 목록 667), 스크롤이 사라지는 세로 뷰포트 ~1,170px → **~830px**. 상수 `min(960px,86vh)` 는 **줄이지 않는다** — 카드 높이는 우측 상세(최대벽이 가장 길다)와 설정 패널도 함께 정하므로 줄이려면 두 소비처를 같이 실측할 것. ⚠ 그 실측에서 `scrollHeight` 를 콘텐츠 높이로 쓰지 말 것(`clientHeight` 아래로 안 내려가 컨테이너 높이를 되돌려 준다 — 867px 이라는 틀린 값을 한 번 얻었다). 2026-08-21 항목의 재검토 트리거(「nav 그룹 접기」)는 이로써 **당분간 소멸**한다. |
| 2026-08-26 | **당일 최대벽 매도\|매수 탭 → 방향×계열 매트릭스 + 필터 가시화** (#1618·#1619, 아트보드 ⑤) | 서브탭은 **절반의 상태를 항상 숨겼다**. 두 방향이 완전한 미러라(갈리는 것은 미도달 판정 기준과 MA 방향뿐) 나란히 두면 대칭이 그대로 보인다. 더 중요한 것은 그 탭이 2026-08-25 가 세운 **"위치가 스코프를 말한다"** 를 계속 망가뜨렸다는 점이다 — "카드 안이면 그 계열, 밖이면 공통" 위에 방향 공용 항목을 위한 **"탭 밖"** 이라는 두 번째 관례를 얹어야 했고, **탭 경계는 눈에 보이는 선이 아니라** 화면에서 읽히지 않았다. 이 결정은 그 원칙을 뒤집는 게 아니라 **완성한다**: 열 머리=방향 마스터 · 셀=방향×계열 · 푸터 행=방향별 계열 공용(캔들 수평선·분봉 내 최댓값) · **매트릭스 밖=방향까지 공용**(강도 pane — 한 pane 을 양방향이 공유하므로 어느 열에 둬도 거짓말이 된다, 배지 동반). **세부 존이 하나가 된다**: 종전 계열 카드 3장이 각자 접히는 세부를 품어 전부 펼치면 21행이라 기본 접힘이었고, 접혀 있으니 뭐가 꺼졌는지 안 보여 「끈 개수」 뱃지를 따로 달아야 했다 — 선택이 항상 하나면 접기도 뱃지도 필요 없다(`usePeakWallFamilyOffCount` 소멸). **두 열을 다 끄면 존재 삭제와 동일**(판정이 `ask \|\| bid`)이고 매트릭스에서는 그것이 **평범해 보이는 두 클릭**으로 도달하므로 레전드 칩 ✕ 와 같은 undo 토스트를 준다 — ⚠ patch 에 `{side}PeakHidden` 을 **함께 실어야** 한다(복원은 op 를 우회하는 raw patch 인데 `set{Side}PeakEnabled(true)` 가 `Hidden:false` 를 같이 쓴다). **필터 가시화**: 「당일 최대벽이 왜 안 보이나」의 실제 원인은 MA 필터 4종이 **전부 기본 ON** 인데 그 필터가 아코디언 3단 깊이에 있었다는 것이다. 셀의 **깔때기**(활성 필터 수, 순수 pref 읽기 — ⚠ 공장값이 둘 다 켜짐이라 **손대지 않은 칸이 2로 시작**한다: 기본이 최대라는 뜻이지 사용자가 뭘 했다는 뜻이 아니다)와 존 헤더의 **리드아웃**(「지금 N개 표시 · M개 필터로 숨김」)이 그걸 표면으로 올린다. **기본값 자체는 유지**(사용자 결정 — 별도 판단). ⚠ **M 은 필터 경계에서 재야 한다**: 밖에서 `후보 − 그려진 것` 으로 빼면 세그먼트 매핑 손실(그 date 의 `RangeSegment` 부재·비유한 값)이 "필터로 숨김" 에 섞여 사용자가 **끄지도 않은 필터를 탓한다** — `N+M ≠ 후보총수` 가 정상이고 UI 는 총수를 주장하지 않는다. ⚠ **미등록 = 데이터 없음이지 0 이 아니다**(일·주·월봉은 발행 안 함 — `{shown:0}` 을 넣으면 "필터가 다 걸렀다" 와 구별 불가). warn 은 **계열 켜짐 ∧ 0개 ∧ 필터가 실제로 걸렀다** 셋을 다 만족할 때만(셋째가 없으면 벽이 없던 날에도 경보가 떠 곧 무시된다). 눈이 꺼져 있으면 문구를 **후보 어법**으로 바꾼다(세그먼트 계산이 `hidden` 을 안 보는 것이 `usePeakWallRender` 불변식이라 "표시" 는 거짓이 된다). ⚠ **deps 계약이 이 기능의 성능 위험 전부**다 — `register()` 는 조건 없이 스토어를 쓰므로 발행 effect 가 팬·줌마다 돌면 개수가 그대로여도 패널 재렌더로 샌다. 발행부를 `usePeakWallCountsPublisher` 로 빼 **원시값 12개**를 deps 로 나열하고 테스트가 그 계약을 잰다(객체를 **하나만** 끼워도 register 호출이 6→24, red-check 실측). 곁가지: 1\|2\|3 세그먼트를 **borderless 트랙 + tint 활성**(2026-07-15 규칙)으로 통일 — 다크에서 `bg-input` 테두리 세그먼트는 카드와 같은 톤이라 안 보인다. `--tint-warn` 은 네 테마에 진작 있었는데 tailwind 매핑만 없었다. |
| 2026-08-26 | **단일 리스트를 2모드(내 지표 / 카탈로그)로 되돌림 (사용자 결정)** — 같은 날 위 항목의 부분 되돌림 | 같은 날 합쳤던 것을 **사용자 결정으로 되돌린다**. 합친 판의 이점(15종이 한 화면 · 행이 안 움직임 · nav 요구 707px)은 실재했지만, 사용자가 그보다 **「지금 쓰는 것」과 「추가할 수 있는 것」이 섞이지 않는 것**을 택했다 — 매일 여는 목록은 대개 전자만 보려고 여는 것이고, 후자는 가끔 찾으러 들어가는 곳이다. 즉 뒤집힌 것은 근거가 아니라 **무엇을 최적화할지의 선택**이다(위 항목의 "행이 안 움직인다" 계약과 그 가드는 함께 사라진다). **되돌린 범위는 목록 구조뿐**이다: 2모드 + 하단 전환 버튼 + 「내 지표」 평리스트 / 카탈로그 그룹 헤더(정확히 이전 형태). 그룹 헤더의 `2/3` 카운트는 단일 리스트 전용 기능이라 함께 사라진다. **유지되는 것**: 글리프 15종 · 인스턴스 색 점 · 미리보기 카드 · 검색 · 헤더 ⋯ 초기화 · 설명 레지스트리 — 이들은 어느 목록 구조에도 얹힌다. ⚠ **검색은 지금 보고 있는 모드 안에서만 거른다**: 「내 지표」에서 친 검색어가 아직 추가하지 않은 지표를 끌어오면 두 목록을 가른 의미가 없어진다. 그리고 **모드를 바꿀 때 검색어를 지운다** — 한쪽에서 친 검색어가 다른 목록에 그대로 걸려 있으면 "왜 비어 있지" 가 된다. 삭제 시 동작도 되돌아간다(선택이 그 자리에 남는 대신 **남은 첫 항목으로** — 그 행이 「내 지표」에서 사라지므로 목록에 없는 것의 설정을 보게 된다). **높이**: nav 요구가 다시 두 모드로 갈려 각각 707px 보다 작아지고 푸터 1행(≈50px)이 돌아온다 — `min(960px,86vh)` 상수는 그대로 충분하다. |
| 2026-08-26 | **당일 최대벽 패널을 방향×계열 매트릭스 → 파이프라인(5단계)으로** — 같은 날 위 매트릭스 항목의 **구조 교체**(프로토타입 3안 A/B 비교, 사용자 판정 C) | 매트릭스는 **상태 조회**에 최적화돼 있었다(여섯 칸이 한눈에). 그런데 이 패널에서 실제로 반복된 질문은 조회가 아니라 진단이었다 — 「당일 최대벽이 왜 안 보이지」. 표 구조에서는 후보가 어디서 잘렸는지가 화면에 없어서 셀마다 **깔때기 배지를 따로 발명**해야 했다. 그게 구조가 답해야 할 것을 장식으로 때운 신호였다. **판정축과 탈락 이유**(실드로어 폭 518px · 실데이터 · `?variant=` 스위처): **A 교정된 매트릭스** — 아래 결함 넷만 고친 판. 고쳐도 진단 질문의 답이 여전히 배지에 있다. **B 표면 우선 스프레드시트** — 축을 뒤집어 행=축·열=방향×계열 6칸. 30개 토글이 한 화면에 들어가고(스크롤 0) 매도·매수 비대칭이 즉시 보이지만, **행마다 붙던 설명 문장이 툴팁으로 내려간다** — 밀도를 사고 설명을 판 것이라 기각. **C 파이프라인**(채택) — 방향 → 계열 → 후보 기준 → 표현 → pane. ③ 이 「지금 N개 표시 · M개 필터로 숨김」을 들고 있어 **레이아웃 자체가 진단**이다. **판 것**: 매도·매수를 나란히 보는 것. ① 의 두 카드가 각자 개수를 들어 반대쪽이 통째로 침묵하지는 않는다(`지금 2개 표시` / `지금 0개 표시`). **단계 번호가 스코프의 깊이**가 되어 종전 「위치가 스코프를 말한다」의 자리 넷(열 머리·셀·푸터·매트릭스 밖)을 순서 하나가 대신한다. **함께 닫힌 결함 넷**(조사 실측): ⓐ 푸터 「캔들 수평선」이 **거짓 이름**이었다 — `{side}PeakHidden` 은 `usePeakWallRender:467` 에서 `drawn` 으로 접혀 선·도킹 라벨·발생 시점 화살표·**순위 화살표**까지 끈다(스크린샷 red-check: 끄니 수평선과 순위 화살표 「2」가 동시에 사라짐). 계열별 「수평선 표시」와 이름까지 충돌했다. **배선은 그대로 두고** 이름·어포던스를 레전드의 눈으로 통일(`EyeGlyph` 를 `PaneLegendOverlay` 에서 끌어올려 두 표면이 같은 그림). ⓑ 관계도가 **매수판만 반쯤 뒤집혀** 있었다 — 셋은 방향별 y 인데 전체 최대벽만 `y="86"` 리터럴이라 매수에서 미도달(80)과 6u 로 붙었다. 네 레인을 전부 방향 파생으로. 곁가지로 「체결됨」 라벨이 캔들 rect(x193–207)와 겹치던 것도 함께(라벨을 166–193 틈으로). ⓒ 열 마스터 토글이 **자기 열보다 옆 열에 붙어** 있었다(실측 x: 매도 라벨 669 · 마스터 792 · 매수 열 시작 834 — 자기 라벨과 103px, 다음 열과 16px). ① 의 카드에서 라벨·마스터·눈이 한 덩어리가 된다. ⓓ 매트릭스 셀이 **넘쳤다** — `clientWidth` 165px vs `scrollWidth` 180–181px 이라 깔때기 배지가 잘렸다. 셀 자체가 사라져 소멸. **깔때기 → `필터 N/2`**: 공장값이 둘 다 켜짐이라 손대지 않은 칸이 2로 시작하는데 맨숫자 `2` 는 "내가 뭘 많이 켜 뒀나" 로 읽힌다. 분모가 **기본이 최대**라는 극성을 숫자 안으로 들여온다(분모는 레지스트리에서 파생 — 상수로 박으면 red 가 뜬다, red-check 실측). **표면 다섯을 두 구획으로**(캔들 위 셋 · 랭킹 참여 둘) — 종전엔 「어디에」 아래 평평한 다섯 형제라 성격이 다른 둘이 섞여 있었다. **리드아웃 문구 정정**: 「수평선 숨김 —」 → 「숨김 —」(눈이 선만 끄지 않으므로). 세 부재 사유(계열 꺼짐 · 미발행 · 눈)와 warn 3조건은 그대로 승계. **보존한 계약**: 마지막 방향 끄기 undo 토스트 3종(`Hidden` 스냅샷 포함) · 「보이는 영역 최대벽」 부재 가드(양 방향 순회로 강화) · 계열별 키 격리 · `peak-wall-detail-zone-{side}-{family}` 스코프 가드. **곁가지 doc drift 3건**: 「전체·미도달은 rank-1 고정」 주석이 코드와 반대였다(실측 rank 1→3 에서 표시 5→7개 — 2026-08-25 백엔드 top-3 로 전제 소멸) · `peakWallStepsRegistry` 의 「체결된 벽은 토글이 없어」 · 카탈로그 설명이 수평선/오버레이만 말하던 것. **프로토타입은 남기지 않는다** — 변형 셋과 스위처는 폐기하고 판정만 여기와 메모리에 적는다. |
| 2026-08-26 | **강도 pane 에 계열 셋 전용 토글** — pane 은 **하나**를 유지 (위 파이프라인 항목의 후속) | 종전엔 "어느 계열이 강도 pane 에 나오는가" 를 **캔들 선 토글이 정했다**(`{side}Peak{Family}LineEnabled`). 그래서 캔들에서 지운 계열을 pane 에서만 계속 보거나, 반대로 캔들에만 두고 pane 은 비우는 조합이 **원리적으로 불가능**했다 — 두 표면이 답하는 질문이 다른데(캔들 = 「그날 어디에 벽이 있었나」, pane = 「그 벽이 언제 얼마나 자랐나」) 스위치가 하나였던 것이다. pane 전용 키 셋을 만든다: `peakWallPane{Traded,Unreached,AllWall}Enabled`. **방향 공용**이다 — pane 자체가 매도·매수 공용이므로 6개가 아니라 3개이고, 슬롯은 그대로 6(방향 2 × 계열 3)이며 **pane 은 늘어나지 않는다**. 계단 셋이 같은 y 축(잔량)이라 겹쳐 읽는 것이 의미가 있고, pane 을 셋으로 쪼개면 화면 부동산만 먹는다. **공장값 T/F/F** — 종전 규칙("캔들 선 토글을 따라간다")의 공장값과 같아, 손대지 않은 사용자가 pane 을 켜면 **종전과 같은 화면**이 나온다. (캔들에서 미도달·전체를 켜 두고 pane 도 보던 사용자는 그 계열이 pane 에서 한 번 사라지고, 새 스위치가 바로 아래 있다 — 결합을 끊는 값이다.) ⚠ **`stepSegments` 의 `?? built` 폴백을 걷어냈다**: 종전엔 게이트가 닫히면 그리기 세그먼트로 떨어져 **소비처가 pane 을 다시 게이트해 주는 것에 의존**했는데, "pane 은 켜졌고 이 계열만 꺼진" 상태가 생기면서 그 의존이 거짓말이 된다. 세 계단이 전부 자기 게이트로 비운다. 가드는 **양방향**이다(캔들 ON·pane OFF → 선만 / 캔들 OFF·pane ON → 계단만) — 한 방향만 재면 "그냥 둘 다 끄는" 구현도 통과한다. red-check: 게이트를 캔들 선 토글로 되돌리면 두 테스트가 빨개진다(실측). 프리셋 화이트리스트(`PRESET_INDICATOR_FLAG_KEYS`)·`INDICATOR_PANE_PREF_KEYS` 에는 **넣지 않는다** — 전자는 "어느 지표가 켜졌나", 후자는 "어느 pane 이 뜨나" 의 목록이고 이 셋은 pane **안**의 계열 선택이다. |
| 2026-08-26 | **강도 pane 토글을 계열 3개 → 슬롯 6개(방향 × 계열)로** (사용자 결정) — 바로 위 항목의 부분 정정 | 위 항목은 "pane 이 매도·매수 공용이므로 토글도 방향 공용 3개" 로 갔다. **틀린 추론이었다** — pane 이 하나인 것과 그 안에 무엇을 넣을지가 방향마다 같아야 하는 것은 별개다. 실제 읽기 방식이 「매도 셋만 겹쳐 보기」나 「양방향의 체결된 벽만 마주 보기」라, 슬롯 6칸(`PEAK_WALL_STEP_SLOTS` = 방향 2 × 계열 3)과 **1:1** 인 키가 맞다: `{side}Peak{Family}PaneEnabled`. **pane 은 여전히 하나다** — 계단이 전부 같은 y 축(잔량)이라 겹쳐 읽는 것이 의미가 있고, 늘리면 화면 부동산만 먹는다. **UI 는 계열 3행 × 방향 2열**: 행이 설명을 소유하고(계열의 성질이 셋 다 다르다 — 단조/비단조), 열 라벨과 스위치가 **같은 grid 트랙**에 앉는다. 종전 매트릭스가 라벨을 열 왼쪽에, 스위치를 `justify-between` 으로 오른쪽 끝에 두어 마스터가 자기 라벨보다 옆 열에 가까웠던 실수(실측 103px vs 16px)를 되풀이하지 않는 배치다. **단계 ① 이 방향을 고르는 자리인데 ⑤ 는 양방향을 함께 둔다** — pane 이 하나라 그 안의 구성은 한 화면에서 정하는 것이 맞고, 그 비대칭이 의도임을 테스트가 못 박는다. **레거시 시드**: 반나절 살았던 방향 공용 3키를 값이 있을 때만 양 방향의 씨앗으로 읽는다(새 키가 있으면 그쪽이 이긴다) — 마이그레이션이 과해 보이지만 그새 만진 선택을 조용히 되돌리는 것이 더 나쁘다. ⚠ `FLAG_INDICATOR_FIELDS` 가드가 **네 번째로** 잡았다(6필드) — 지표 삭제 시 pane 구성도 공장값으로 돌아가야 한다. red-check 은 **방향 상실** 방향으로 확인(키를 매도 하나로 합치면 4건이 빨개진다). |
| 2026-08-26 | **설정·지표 설정 행 밀도 py-3 → py-2** (설정 패널 리디자인 · 프로토타입 C 채택의 선행 커밋) | 설정 모달 「차트」 섹션의 콘텐츠 실측이 1,705px vs 뷰포트 807px — 행 자체의 세로 패딩(12px×2)이 그 길이의 상수 항이었다. 판정된 프로토타입의 밀도 문법(단일 구분선 + py 8px)을 `SettingsRow` 한 곳에서 바꾼다. ⚠ `SettingsRow` 는 ⚙️ 설정 모달과 「지표」 모달의 hoga Config 가 **공유**한다 — 지표 모달 행도 함께 조여지는 것이 이 커밋의 의도다(두 표면의 행 문법이 갈라지는 것이 더 나쁘다). 이중 구분선(행 border-b + 별도 divider)은 설정 본체 재작성에서 따로 닫는다. |
| 2026-08-26 | **설정 모달을 마스터-디테일 → 단일 스크롤 + 스크롤 스파이 목차로** (제안 목업 `docs/superpowers/designs/2026-08-26-settings-panel-redesign.html` · 프로토타입 3안 실기기 판정, 사용자 선택 C) | 종전 구조의 문제 셋(실측): 차트 섹션 콘텐츠 1,705px vs 뷰포트 807px 인데 **이중 구분선**(행 border-b + 별도 divider, 행당 +17px)이 길이를 불리고 있었다 · 날짜 구분선·VI 스타일 행이 **게이트 없이** 서 있어 부모를 꺼도 피커가 살아 있는 죽은 컨트롤이었다 · 8개 섹션에 검색이 없어 「이 설정이 어느 섹션이더라」를 nav 를 눌러 가며 찾아야 했다. **판정축과 탈락 이유**(실모달 760px · 실제 레지스트리 라벨 · `?variant=` 스위처): **A 현행** — 기준선. **B 소그룹+밀도+검색(마스터-디테일 유지)** — 검색이 **별도 결과 뷰**라 조작 후 「돌아가기」가 생기고, 결과 행마다 소속을 말할 섹션 배지가 필요했다. **C 단일 스크롤 + 목차**(채택) — 문서가 항상 전부 펼쳐져 있으니 검색이 **인라인 필터**가 되고(그 자리에서 걸러 그 자리에서 조작, 배지 불요), nav 는 갈아 끼우는 스위치가 아니라 **스크롤 위치를 비추는 목차**다(VS Code 설정 문법). B 의 소그룹·밀도·게이트 문법은 C 에 그대로 승계됐다 — 뒤집힌 것은 **문서 모델**(한 번에 한 섹션 ↔ 항상 전부)이다. **수용한 비용**: 정보 섹션(알림·데이터소스·테마·Symbol Master·앱 정보) 이 항상 마운트라 설정을 열면 그 쿼리들이 함께 뜬다(캐시되는 가벼운 설정 조회들이라 수용) · 전체 스크롤이 길다(목차와 필터가 그 비용을 갚는다 — 프로토타입이 자리 표시 블록으로 길이를 정직하게 보여 준 상태에서의 판정이다). **소그룹은 레지스트리가 소유한다**: `CHART_TOGGLES` 의 `group` 필드 + `CHART_TOGGLE_GROUPS`(순서가 곧 화면 순서). 렌더가 그룹 순회뿐이라 group 없는 최상위 토글은 조용히 사라진다 — 레지스트리 가드 테스트가 그 누락을 빨갛게 만든다(red-check 실측). **필터 매칭은 유닛(부모+종속 행) 단위** — 프로토타입은 행 단위였지만 실렌더러(`IndicatorPrefRows`)는 부모+하위를 한 덩어리로 그리고 부모 없는 하위 행은 맥락을 잃는다(의도된 이탈, 컴포넌트 주석에 기록). 손 스타일 행의 검색 코퍼스는 **렌더와 같은 상수**에서 읽는다(각자 적으면 검색만 낡는다). **필터 중 TOC 클릭은 「필터 해제 → 점프」** — setState 직후엔 리마운트된 DOM 이 없어 대상을 ref 에 적고 query 변화 effect 가 소비한다. Esc 사다리(검색어 → 패널)·`isComposing` 불요(Enter 커밋 없음)는 지표 패널 검색 문법 승계. 스크롤 스파이의 추적 절반은 jsdom 에서 잴 수 없다(모든 rect 가 0) — 클릭 경로의 동기 절반(aria-current + scrollIntoView 호출)만 테스트로 못 박고 추적은 /browse 실화면 검증. ⚠ jsdom 에 `scrollIntoView` 가 없으므로 **옵셔널 호출**(`?.()`)이 필수다 — 기존 테스트들의 nav 클릭이 전부 이 경로를 지난다. 아트보드 ② 의 검색 결과 뷰 모델은 목업 안 후기 주석으로 **대체 표기**했다. 프로토타입 브랜치는 보존하지 않는다 — 판정은 여기와 메모리에 남긴다. |
| 2026-08-28 | **`/heatmap` 섹터 온도 스트립 제거 (사용자 결정)** — 2026-08-07 「현행 칩 클라우드 유지」 항목을 supersede | 2026-08-07 은 상단 밴드의 상시 세로 점유(실측 1680×1000 기준 칩 39개 4줄 = 87px = 뷰포트 9%)에 대해 **축약 3안**(B 양끝단 접기 · C 연속 온도 띠 · D 요약 한 줄)을 A/B 하고 현행 유지를 택했고, 「조사 도구가 이 점유율을 다시 지적해도 재론하지 않는다」는 잠금과 재검토 트리거(섹터 수 ≲20 또는 칩 5줄 이상)를 함께 걸었다. **이번은 그 재론이 아니다** — 당시 후보는 전부 축약이었고 **전면 제거는 검토된 적이 없다**. 사용자 지시로 스트립 자체를 없앤다. **제거 시점 실측**(1280×720, 사용자 데이터 45그룹): 스트립 높이 **100.9px · 칩 44개** 로 2026-08-07 의 87px/39칩보다 **자라 있었다**(섹터가 늘면 wrap 줄이 늘어 점유가 커지는 구조라, 그 항목의 재검토 트리거 「칩 5줄 이상」에 접근 중이었다). 보드 높이 **505.9 → 606.8px(+19.9%)**, `boardTop` 190.1 → 89.2px — **회수량이 스트립 높이와 정확히 일치**해 잔여 여백·접힘 없음을 확인했다(축약 3안이 회수하려던 35~36px 의 2.8배). **잃는 것과 이미 있는 대체**: 39섹터 「시장 온도 한눈」 개요 층 → 그룹 헤더 밴드 틴트(`heatHeaderBg`)가 섹터별 온도를 계속 표시한다(스크롤이 필요해진 것이 이 결정의 실제 대가다) · 칩 클릭 점프(wayfinding) → `그룹` 정렬 `desc`(뜨거운 섹터 최상단) + `HeatmapSearchInput` 그룹명 검색. **점프를 다른 형태로 되살리지 않는다**(사용자 결정). **범위**: `SectorTempStrip.tsx`·그 테스트 삭제, `pages/Heatmap.tsx` 의 import·렌더 + **소비처가 스트립뿐이던 `scrollToFolder`** 제거. ⚠ **`heat.ts` 는 통째로 보존한다** — `heatBg` 는 `/market` 의 KRX 업종 섹터 온도(`MarketPage.tsx`)가, `avgPct`/`makePctOf` 는 `HeatmapFolder`·`HeatmapDrawer` 가 쓴다(이름이 같아 grep 에 함께 걸리지만 **별개 기능**이다). ⚠ **`#heatmap-folder-*` id 도 보존** — 스크롤 앵커 겸 dnd 드롭 타깃이라 점프가 사라져도 역할이 남는다(`HeatmapBoard.test.tsx` 가 고정). 곁가지로 스트립을 원문 참조하던 **주석 4곳**을 갱신했다 — 코드 의존이 0이어도 주석이 삭제 대상을 근거로 들고 있으면 유령 근거가 된다(`liveQuotes.ts` 의 `open?` optional 근거 목록 · `Heatmap.test.tsx` 의 「스트립 칩+헤더로 중복 → All」 · `Heatmap.dragFreeze.test.tsx` 2곳). 「중복」이 사라졌으므로 그 대기 쿼리는 `findAllByText` → `findByText` 로 좁혔다(1개여도 통과해 **테스트는 안 깨지고 주석만 거짓말이 되는** 경로였다). **재검토 트리거**: 섹터 카드 wayfinding 이 실제로 아쉬워질 때(그때의 후보는 스트립 복원이 아니라 헤더의 그룹 목록 드롭다운 — 상시 세로 점유가 0이다). |

## App-shell & live tokens (ADR-0039, ADR-0052)

Layout and source-identity tokens beyond the core scale. The Right Rail tokens (ADR-0052) are app-shell-wide (every route); the live tokens are `/live`-scoped. These layout widths/heights live in `design-tokens.ts` `SIZE_TOKENS` (ADR-0012); this hand-maintained table mirrors them for reference (no auto-marker yet):

| Token | Base intent (1.0×) | Rendered @ default (1×) | Use |
|---|---|---|---|
| `--rail-w` | 48px | 48px | Right Rail icon column width (app shell, all routes; fixed — does not collapse) |
| `--watchlist-panel-w` | 280px | 280px | Watchlist Panel width — opened from the Right Rail (global) |
| `--h-top-nav` | 32px | 32px | Global top navigation row |
| `--h-toolbar` | 32px | 32px | Workspace toolbar row — `WorkspaceShell.WorkspaceToolbar`, 소비처는 `/live` 의 `WorkspaceLiveToolbar` (창 추가·설정·프리셋·캡처헬스 한 줄 버튼 행). 밀도 개편(2026-07-23)으로 60→32px |
| `--h-bottom-bar` | 24px | 24px | Global market-index bottom bar row (하단 시장지표 스트립; 데이터 없으면 행 자체가 접힘) |
| `--app-floor-min-w` | 944px | 944px | App shell 가로 바닥 — 아래로는 압축을 멈추고 `#root` 가 가로 스크롤 (Layout → Responsive floor) |
| `--app-floor-min-h` | 624px | 624px | App shell 세로 바닥 (ADR-0122) — 아래로는 높이 동결 + 세로 스크롤 |

> 두 열이 같은 값인 것은 **2026-08-07 부터 기본 밀도가 1.0× 이기 때문**이다(우연이 아니라 정의상). 열을 합치지 않는 이유는 density 모드가 부활하면 다시 갈라지고, 그때 "base intent 가 무엇이었나" 가 필요하기 때문이다.

**소비처 없는 토큰은 정의째 삭제한다** — 정의만 남은 토큰은 "이 값이 화면에 나타난다"고 오독되기 때문. 2026-07-29 (#916) 에 `--h-pricestrip`(시세 스트립 폐지)·`--h-tab`·`--h-tab-secondary`·`--h-orderbook-row`·`--combobox-min-w` 5개를 삭제했다. 판정은 `--token-name` grep 만으로 하지 말 것 — `TAILWIND_THEME` 이 토큰을 유틸리티로도 매핑하므로(`--h-tab` → `className="h-tab"`) **CSS 변수명과 Tailwind 클래스명 양쪽**을 봐야 한다. 삭제해도 Tailwind 기본 스케일이 승계하지 않는 이름이라 무음 회귀는 없다(`font-mono` 별칭을 남긴 이유와 대비 — 그쪽은 기본 스택이 승계한다). `usage` 문자열은 `npm run gen:tokens` 로 `tokens.css` 주석에 그대로 찍히므로, 고칠 때는 `design-tokens.ts` 를 고치고 재생성해야 한다.

**Source identity** — neither UI state nor status nor price direction, but data provenance.
A fourth category limited to identifying which capture source produced the data.

| Token | Value | Use |
|---|---|---|
| `--source-kis-live-border` | `var(--accent)` | kis_live 출처 표식 — 캘린더 캡처 배지 (`capture/calendarStatus.ts`) |

*소스별 `-bg`/`-border` 8개였으나 2026-07-31 에 7개를 삭제했다.* 이 토큰들은 `SourceChip` 전용이었고,
그 칩을 얹던 `LiveStatusBar` 가 #865 에서 폐지되면서 컴포넌트가 죽은 채 남아 있었다(참조는 자기 테스트뿐).
`-border` 4개는 그보다 앞선 #639 (2026-07-15 borderless 전환) 부터 이미 죽어 있었다 — 칩이 `-bg` 만 썼다.
위의 "소비처 없는 토큰은 정의째 삭제한다" 규칙을 적용한 결과다.

## Copy tone (Stage 9)

- **Domain identifiers** (`hogaplay`, `kis_live`, `cycle_lag_ms`, `EGW00201`): English lowercase, code-style (monospace where appropriate). Never localized.
- **User-facing messages**: Korean natural-language sentences. No trailing periods. Actions are nominalized ("재발급" not "재발급하기").
- **Status labels** (`LiveStateBanner` badges, 차트 창 타이틀바 칩): Korean single words ("장 외", "대기 중", "준비됨"). *(`LiveStatusBar` 는 폐지됐다 — 종목 식별·현재가·등락률·경고는 각 차트 창 타이틀바가, 캡처 헬스는 툴바가 소유한다. 2026-07-29 정정.)*
- **Layout grid for `/live`**: see [Layout → App shell](#layout). (History: this line described a 4-row grid — header + status bar + toolbar + workarea — mirroring the since-deleted `/replay` PriceStrip pattern. Corrected 2026-07-29; the page has been a 3-row grid since `LiveStatusBar` 폐지.)
