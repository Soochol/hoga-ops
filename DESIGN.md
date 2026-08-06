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
  - **함정: `10.5px`·`11.5px`·`13px` 는 "토큰과 같은 값" 이 아니다.** 타이포 표의
    **base-intent 열**을 그대로 px 로 박은 흔적인데, 실제 렌더는 ×1.125 된 값이라
    다르다(`xs` base 10.5px → 렌더 11.81px). 표를 보고 px 를 적는 순간 다이얼에서
    떨어져 나간다.

**Future density modes (backlog):** A user-facing toggle (Compact 1.0× / Comfortable 1.125× / Cozy 1.25×) would set `:root font-size` via `[data-density="..."]`; `chartScale.ts` now derives from `RENDERED_ROOT_PX` (design-tokens.ts) but charts read it at mount, so a runtime toggle still needs a chart remount. Not in scope today.

## Aesthetic Direction

- **Direction:** Industrial/Utilitarian × Modern Professional ("Quiet Trading Terminal")
- **Decoration level:** Minimal-intentional — typography does the work. Single accent color. No patterns, textures, gradients, or decorative blobs.
- **Mood:** Serious. Information-first. The product should feel like a precision tool, not a SaaS dashboard. Closer in spirit to Linear than to a Y Combinator startup landing page.
- **Reference points:** TradingView (chart syntax), Linear (UI restraint), Vercel (typography), Bloomberg (data density — but without the 1990s color palette).
- **Density posture:** Ships at a comfortable density (1.125× of base intent), a notch denser than typical-SaaS sizing (was 1.25× until 2026-07-15). The original 1.0× intent (`denser than typical SaaS`, Bloomberg-leaning) is preserved in the token system and reachable through a future Compact density toggle. The product DNA is "Linear-like restraint" at the chosen density, not "must always be small."

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
| Token | Base intent (1.0×) | Rendered @ default (1.125×) | Use |
|---|---|---|---|
| `badge` | 8.5px | 9.563px | Hierarchical badges (e.g., SymbolSearch market tag) |
| `2xs` | 9px | 10.125px | Dense chrome micro-labels (창 크롬 서브라벨·상태 칩) |
| `xs` | 10.5px | 11.813px | Small-caps labels, badges |
| `sm` | 11.5px | 12.938px | Table rows, secondary data values |
| `base` | 13px | 14.625px | Body / UI default |
| `md` | 14px | 15.75px | Section / page headings |
| `lg` | 16px | 18px | Brand text |
| `xl` | 22px | 24.75px | Current price (price strip) |
| `2xl` | 32px | 36px | Future hero numerics |
<!-- END AUTO: tokens-typography -->

## Color

- **Approach:** Restrained. Single UI accent per theme. Three mutually-exclusive color categories for UI state, status semantic, and price direction. Two commercial themes share one token contract (see below) — components never branch on theme, they only read tokens.
- **Themes (four, selectable):** the app ships four full palettes behind `<html data-theme>`:
  - **Obsidian** (dark, default) — warm graphite surfaces + brass accent. The trading-terminal / live surfaces.
  - **Ledger** (light) — ivory paper surfaces + banker's-green accent. The review/research surfaces.
  - **Toss Light** (light, `toss-light`) — white cards on a grey floor + toss-blue accent. Benchmarked from tossinvest.com's live tokens (2026-07-22). **The default preference** (2026-08-07 사용자 결정 — `DEFAULT_THEME_PREFERENCE` in `state/themePrefs.ts`, mirrored in `index.html`). Still **never produced by `auto`** — being the default and being auto-reachable are different things. See the Toss Light/Dark note below the token table for the accent-vs-price collision it carries, which is now the *default* experience rather than opt-in.
  - **Toss Dark** (dark, `toss-dark`) — lighter cards on a near-black floor + toss-blue accent. The dark counterpart of Toss Light, benchmarked from tossinvest.com's live dark tokens (2026-07-22). **Manual-select only.**
  - The **preference** (`obsidian` / `ledger` / `toss-light` / `toss-dark` / `auto`) lives in `state/themePrefs.ts` (localStorage `ui.themePreference.v1`); `auto` maps `/live` + `/heatmap` → Obsidian and everything else → Ledger via `effectiveTheme(pref, pathname)` (auto only ever picks Obsidian or Ledger — never a toss-* theme). `App.tsx` writes the resolved theme to `data-theme`; `index.html` sets it inline before first paint (FOUC + wrong-theme chart cache guard).
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
  - **Ink greys:** `--fg #191f28` · `--fg-dim #4e5968` · `--fg-dimmer #8b95a1`. Borders `--border #e5e8eb` · `--border-strong`/`--chart-pane-divider #d1d6db`.
  - **Accent = toss blue** `#3182f6` (hover `#2272eb`, fg white). `--success #03b26c` · `--error #e42939` · `--warn #eb7300`.
  - **Price direction (KRX):** `--price-up #de2b39` (red) · `--price-down #1957c2` (blue).
  - **⚠ Sanctioned exception to the three-way color discipline — accent-vs-price blue collision:** Toss's brand accent is blue and Toss's "down" price is also blue; Toss has no "UI color ≠ price color" rule so it lets them overlap. We keep the toss-blue accent (it *is* the theme's identity) and instead push `--price-down` one tone **darker** (`#1957c2`, blue800) than the accent (`#3182f6`) so the two blues separate. accent rides SOLID-FILL contexts (buttons, active tab, focus, crosshair); down-price rides text/border. **The two blues being close is this decision, not a bug** — mirrors the pre-existing `--error`/`--price-up` both-red overlap. Not perfect on the highest-density surfaces (a blue crosshair over a blue down-candle can read close); accepted for this theme. Elevation/MA tokens reuse the Ledger paper values (both are light surfaces).

- **Toss Dark palette (2026-07-22, `[data-theme='toss-dark']`):** the dark counterpart of
  Toss Light, benchmarked from tossinvest.com's live *dark* tokens. Also manual-select only.
  - **Surfaces revive the layer step** (inverted from light): `--bg #101013` (near-black floor) with `--bg-card #17171c` (cards sit *lighter* than the floor), `--bg-subtle #0c0c0f` (chrome sunk below the floor), `--bg-input #202027` / hover `#2c2c35`.
  - **Off-white ink (NOT pure white):** `--fg #eceff5` — Toss's dark txt-primary is `rgba(242,246,255,0.9)`, deliberately avoiding `#ffffff` to cut glare. `--fg-dim #c3c3c6` (grey700) · `--fg-dimmer #7e7e87` (grey500). Borders `--border #2c2c35` (grey100, kept subtle) · `--border-strong`/`--chart-pane-divider` `#4d4d59`/`#3e3f49`.
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
- **Sidebar width:** 320px base intent / 360px rendered (token: `--sidebar-w`). 유일한 소비처는 `/inventory` 의 master-detail 좌열(`pages/Inventory.tsx`) — 이름과 달리 사이드바 컴포넌트의 폭이 아니다. *(2026-07-29: `usage` 문자열이 가리키던 "replay viewer 의 Cursor Sidebar" 는 실재하지 않아 실제 소비처로 고쳤다.)*
- **Top nav height:** 32px base intent / 36px rendered (token: --h-top-nav).

## Layout

- **Approach:** Grid-disciplined hybrid — strict grid for the app shell, looser composition inside chart panes.
- **App shell:**
  - Top-level: **column** shell (2026-07-15) — `grid-template-columns: 1fr var(--rail-w)` plus an optional `var(--watchlist-panel-w)` before the rail when a right-rail panel is open. The **right panel (drawer + fixed rail) spans full viewport height** (top to bottom). The left column is a 3-row stack `grid-template-rows: var(--h-top-nav) minmax(0, 1fr) auto` (TopNav / page content / bottom market-index bar; bottom row `auto` collapses to 0 when the bar has no data). The top header therefore spans only the left column's width — it **yields the top-right corner to the full-height right panel**. The explicit row contract keeps content from growing the row (or the `/live` chart) past the viewport. TopNav itself is borderless `--bg` (see below) so the header merges into the page content. **앱 셸에는 이제 크롬 톤이 없다** — 우측 패널(레일 + 드로어 + sticky 그룹헤더)도 2026-07-29 (#911) 에 `--bg-subtle` → `--bg` 로 넘어가 셸 전체가 단일 `--bg` 면이다(`ui/RailShell.tsx` = `bg-bg`). `--bg-subtle` 는 셸 밖 recessed 표면에만 남는다: 모달 내부 박스(`CollectDialog`·`StudyViewSaveDialog`), 스크리너 조건 카드, 설정/지표 nav, 워크스페이스 창 헤더의 비포커스 톤 밴드, sticky 표 헤더(체결 열 헤더 — 거래원 합계행·잠정투자자 열 헤더는 2026-07-30 에 `--bg-card` 로 환원). *(이전 문장: "chrome tone (`--bg-subtle`) survives only on the right panel" — 2026-07-29 정정.)*
  - Main (page-content row): each route owns its own grid. **`/live`** (`frontend/src/live/LivePage.tsx`) is a **3-row** grid — `grid-template-rows: auto auto minmax(0, 1fr)` = `LiveStateBanner` (빈/에러 상태 매트릭스; 상태가 없으면 빈 `div` 로 접힌다 — `null` 을 반환하면 캔버스가 툴바 자리로 밀려 올라간다) / `WorkspaceLiveToolbar` (`--h-toolbar`) / `WorkspaceCanvas` (`1fr`). 열 축도 `minmax(0, 1fr)` 로 **명시해야 한다** — 비워두면 `grid-auto-columns: auto` 가 되고 그 트랙이 차트 캔버스의 min-content 폭에서 바닥을 쳐 `<main overflow-hidden>` 에 잘린다. **`/study`** (`StudyPage.tsx`) 는 2행 `grid-rows-[auto_minmax(0,1fr)]` (탭 바 + 헤더 / `StudyWorkspaceCanvas`). 나머지 feature 라우트는 workarea 한 행뿐. *(History: 이 줄은 `grid-template-rows: 40px 60px 52px 1fr` (tabs + toolbar + price strip + workarea) 로 Replay Viewer 를 기술했다 — `/replay` 라우트·페이지·`state/replayLayout.ts` 는 모두 존재하지 않는다(`main.tsx` 의 라우트는 live·study·heatmap·inventory·screener·capture·settings 7개). 2026-07-29 정정.)*
- **Workspace canvas (`/live`·`/study`):** 고정 grid 가 아니라 **자유 배치 창 캔버스**(ADR-0119, #706) — 창마다 프랙셔널 rect 를 갖고 자석 스냅 엔진이 배치한다. 창 사이 **2px 틈은 좌표가 아니라 렌더 인셋**이다(`frontend/src/workspace/WindowFrame.tsx` `GAP = 2`; 보이는 카드가 바깥 rect 에서 `GAP/2` 물러나 그려진다) — 스냅 좌표계는 틈에 영향받지 않으므로 간격을 바꿔도 스냅 불변식은 그대로다. *(History: 여기엔 Replay Viewer workarea `grid-template-columns: 1fr 12px <sidebarPx>` (chart + splitter + Cursor Sidebar) 와 `localStorage['replay.layout']` 기술이 있었다 — `state/replayLayout.ts` 와 `sidebar/CursorSidebar.tsx` 는 둘 다 이제 존재하지 않는다(전자는 이전에, 후자는 #916 에서 삭제). ADR-0022 의 트레이드오프는 역사로만 유효. 2026-07-29 정정.)*
- **Chart pane stack (`/live` 차트 창):** CSS grid 가 아니라 **lightweight-charts pane** 을 `setStretchFactor(spec.stretch)` 로 배분한다. 순서와 기본 stretch 는 `frontend/src/chart/paneSpecs.ts` 가 SSOT — candle 1.4 / volume 0.3 / quote-totals 0.4 / ratio 0.4 / fill-strength 0.4 / program-trade 0.35, 그리고 D 전용 투자자 pane 2개(각 0.3). 사용자 조정값(Pane Stretch, #703)이 스펙 기본값을 덮고, 높이가 모자라면 `usePaneFolding` 이 하위 pane 부터 접는다. 어떤 pane 이 뜨는지는 `paneSpecsForTimeframe.ts` 의 게이트(분봉 전용 호가 pane, D 전용 투자자 pane)가 정한다. *(History: `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` (candles+vol / ratio / intensity / fill) — Replay Viewer 4-pane 시절. 2026-07-29 정정.)*
- **Max content width:** No cap. App fills the viewport (desktop-only).
- **Responsive floor (`--app-floor-min-w`, 2026-07-21):** the app has **one floor for every route**: `57rem` (1026px @ default density, 912px base intent). Above it the shell compresses fluidly; below it the shell stops compressing and `#root` scrolls horizontally (`global.css`). There is **no zoom-detection code anywhere** — browser zoom *is* effective-viewport narrowing, so the width response covers zoom for free (`visualViewport.scale` branching is prohibited: it double-counts window resize vs zoom and doubles the test matrix).
  - **Why a single global value:** the floor is set by the **shell chrome every route shares**, not by page content. Content-light routes (`/settings`, `/capture`) would reflow narrower, but the chrome breaks first, so per-page floors add complexity with no gain. `App.tsx` wraps every route via `<Outlet/>`, so one declaration reaches all pages and a new route can't forget it.
    - 유도 실측(2026-07-21, 기본 밀도): TopNav 자연폭 939px + `--rail-w` 54px = **993px**, 토큰이 33px 여유를 더해 1026px. **이 993px 은 2026-08-04 nav 한글화로 stale 이다** — 같은 절차로 재측정하니 자연폭 **710px**(−229px), 필요폭 **764px** 로 줄었다(라벨 글자 수가 준다: `Screener` 8자 → `스크리너` 4자). **토큰은 그대로 57rem 을 유지한다**: 바닥은 nav 하나가 아니라 전 라우트가 공유하는 셸 크롬이 정하는데, nav 가 더 이상 병목이 아니게 됐을 뿐 *다음* 병목이 무엇인지는 측정된 바 없다. 내리려면 그 병목부터 실측할 것 — 지금 내리면 근거 없이 다른 크롬을 압축하게 된다.
  - **Why rem, not px:** everything the floor protects (nav, rail, panel widths) is rem-based, so the floor must track the density dial — at a future Cozy 1.25× the chrome needs proportionally more room. This is why the floor is *not* on the fixed-px list (which covers hairlines and small radii only).
  - **Why the scroll owner is `#root`:** if the document scrolls, the shell's `100vh` and the horizontal scrollbar trigger each other (scrollbar begets scrollbar). The shell is `h-full min-w-app-floor`, never `w-screen` — `100vw` includes the vertical scrollbar width, which would make the shell wider than the viewport at every width below the floor. Guarded by `App.test.tsx`.
  - **세로 바닥 (`--app-floor-min-h`, ADR-0122):** 폭과 **대칭**으로 `39rem` (702px @ default density, 624px base intent). `/live` 창은 캔버스 비율로 스케일하므로 캔버스가 계속 낮아지면 호가 단수가 조용히 잘린다 — 바닥 아래에서는 높이도 동결하고 `#root` 가 세로 스크롤을 갖는다. 줌인은 양축을 함께 줄이므로 가로 바닥만으로는 반쪽이다(실측: 줌 200% 에서 폭은 여유였고 **높이가 먼저** 하한에 부딪혔다). 셸은 `min-h-app-floor min-w-app-floor` 를 함께 건다(`App.tsx`).
  - **Re-deriving the floor:** measure the chrome, don't guess. `document.querySelector('nav').firstElementChild` → set `width:max-content` → read `getBoundingClientRect().width`, add the rail. Bump the token when the nav gains items. **라벨 텍스트가 바뀔 때도 재측정 대상이다** — 항목 수가 그대로여도 폭은 움직인다(2026-08-04 한글화가 그 사례).
- Dense tool panels use one outer surface with internal dividers; avoid nested cards inside sidebars, drawers, modals, and detail panels. (Exception: `/live`·`/study` 상세 지표 카드는 승인된 예외 — Migration Status 참조.)
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
- **Content framing:** primary content sits in `bg-bg-card` cards (`PanelCard`). Multi-pane pages (master-detail, splitter) use one card per pane; single-content pages use one card. Never nest cards. **Feature-route cards are `borderless` in both themes (2026-07-15, 통일 결정):** `/heatmap`·`/screener`·`/inventory`·`/capture` 카드는 `PanelCard borderless` 로 테두리 없이 `--bg-card` + `--shadow-panel` 만으로 배경과 분리 — `/live` 차트 패널과 동일 크롬(부유 카드 모델을 feature route 전반으로 확장). 내부 헤더/스트립 밴드도 `bg-subtle`→`bg-card`, 구분선 `border-strong`→`border` 로 평탄화(live `WorkspaceToolbar` = `bg-card` + `border-b border-border` 와 동형). **Ledger(라이트) tradeoff:** 라이트는 `--bg`=`--bg-card` + 옅은 shadow 라 카드 경계가 다크보다 약하게 읽힌다 — 이전엔 이 때문에 Ledger feature 카드의 `--border` 를 유지했으나, `/live`·`/study` 워크스페이스와의 전면 통일을 위해 **사용자 결정으로 borderless 채택**(라이트에서도 shadow+gap 의존). `--border` 는 이제 카드 프레임이 아니라 카드 **내부** 구분선(`border-b`/`border-t border-border`)·입력·테이블 등에만 쓴다.
- **Floating-card workspace (`/live` + `/study`, 통일 2026-07-15 · 창 모델로 승계 2026-07-22):** both `/live` and `/study` use the **same 부유 카드 모델** — no outer frame border; cards (`bg-bg-card` + `rounded` + `shadow-panel`, borderless) float on a `--bg` field. **현재 형태**: 카드 = 워크스페이스 **창**이고, 개수·배치는 사용자가 정하며(고정된 "차트 pane + 상세 pane" 2장 구도는 없다), 틈은 **2px 렌더 인셋**이다(위 Workspace canvas 항목). 아래 문장의 "차트 pane / 상세 pane 두 카드 + 4px gap + 스플리터" 는 창 모델 이전(ADR-0119 前) 기술이며 카드 크롬 규칙을 세운 근거로만 읽는다 — `/live` 에는 스플리터가 없다(`VerticalSplitter` 의 소비처는 `/capture` 뿐, 창 크기는 `WindowFrame` 의 가장자리 핸들이 조정한다). Chrome above the field (`/live` 종목명 스트립 / `/study` 탭 바 + 헤더 행 — `/live` 멀티 탭은 ADR-0113 으로 제거) is full-bleed `--bg`. Separation is carried by **gap + `shadow-panel`** (다크는 톤 스텝 0이라 shadow 단독, 라이트는 옅은 shadow). `/study` 는 이전엔 단일 `PanelCard`(border) 안 flush 패널(`--bg-card`↔`--bg-subtle` 톤 스텝)이었으나 `/live` 와 동일 모델로 전환 — 바깥 `PanelCard` 프레임 제거, 상세 aside `bg-subtle`→`bg-card` 카드화, 탭 바·헤더 `--bg` 화. 상태 화면(빈/로딩/에러)은 `PageContainer`+`PanelCard` 유지(전환 점프 방지). Rationale: 원래 차트↔상세 17px 이음매의 1px 선 3개가 소음이라 "분리는 톤+간격이 담당" 규칙(#610~613)을 적용, 나아가 두 워크스페이스의 레이어 모델을 하나로 통일. 스플리터 리사이즈 라인은 평상시 숨김·호버/드래그 시 `--accent` 노출(`/live`).
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
  separator(드래그 리사이즈 기능 보유). 창 이음매(2px gap+그림자)는 카드 모델의 일부로 존치 —
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
> Default rendering = × 1.125. See [Scale Factor](#scale-factor).

### Tabs (`/study` — `ChartTabBar`)
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
- 종목 행 들여쓰기: 관심종목 패널에서만 `pl-10`(50px) — 그룹명 첫 글자(≈46px)보다
  오른쪽에서 시작해 부모-자식 위계를 들여쓰기로도 표현(`QuoteRow indented`).
  그룹 없는 스크리너는 평면 목록이라 미적용(기본 `pl-md`).

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
| 2026-07-21 | **호가창 잔량 증감 뱃지 = KRX 컨벤션(증가 `--price-up` 빨강 / 감소 `--price-down` 파랑)** — 차트 오버레이의 teal/fuchsia 와 의도적 분기 (사용자 승인) | 잔량 증감 색은 원래 teal/fuchsia 한 쌍을 세 표면(차트 오버레이·`/live` BookPanel·`/study` OrderbookTable)이 공유했다. 그 색조의 근거는 **레이어 겹침** — 차트에선 잔량 증감과 호가 히트맵(빨강·파랑)이 같은 셀에 동시에 켜져 색이 충돌하면 판독 불가다. 호가창 뱃지엔 겹치는 레이어가 없어 그 제약이 성립하지 않고, 증감은 `--price-*` 의 정의("positive delta = red")에 그대로 들어맞는 시장 데이터라 KRX 컨벤션이 더 직관적이다. 뱃지 2곳만 `priceDirClass()` 로 전환하고 차트 오버레이 기본색(`DEPTH_DELTA_DEFAULT_*`)은 불변 — **두 표면의 색이 다른 것은 버그가 아니라 이 결정이다.** 뱃지는 막대 바깥쪽 끝에 붙어 같은 색 막대(ask 파랑 28% / bid 빨강 28%) 위에 얹히는 경우가 생기지만, 막대가 저알파라 솔리드 텍스트가 읽힌다(장중 실화면 확인). |
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

## App-shell & live tokens (ADR-0039, ADR-0052)

Layout and source-identity tokens beyond the core scale. The Right Rail tokens (ADR-0052) are app-shell-wide (every route); the live tokens are `/live`-scoped. These layout widths/heights live in `design-tokens.ts` `SIZE_TOKENS` (ADR-0012); this hand-maintained table mirrors them for reference (no auto-marker yet):

| Token | Base intent (1.0×) | Rendered @ default (1.125×) | Use |
|---|---|---|---|
| `--rail-w` | 48px | 54px | Right Rail icon column width (app shell, all routes; fixed — does not collapse) |
| `--watchlist-panel-w` | 280px | 315px | Watchlist Panel width — opened from the Right Rail (global) |
| `--h-top-nav` | 32px | 36px | Global top navigation row |
| `--h-live-header` | 32px | 36px | Workspace header row — `WorkspaceShell.WorkspaceHeader`. **이름과 달리 유일한 소비처는 `/study`** (`StudyPage.tsx`); `/live` 는 상태바 폐지 후 이 밴드를 쓰지 않는다. 그나마 `/study` 호출부가 `min-h-12` 를 얹어 실효 높이는 54px 다(`min-height` 가 인라인 `height` 를 이긴다 — #900 의 "54px 원인은 버튼이 아니라 2줄 식별부") |
| `--h-toolbar` | 32px | 36px | Workspace toolbar row — `WorkspaceShell.WorkspaceToolbar`, 소비처는 `/live` 의 `WorkspaceLiveToolbar` (창 추가·설정·프리셋·캡처헬스 한 줄 버튼 행). 밀도 개편(2026-07-23)으로 60→32px |
| `--h-bottom-bar` | 24px | 27px | Global market-index bottom bar row (하단 시장지표 스트립; 데이터 없으면 행 자체가 접힘) |
| `--app-floor-min-w` | 912px | 1026px | App shell 가로 바닥 — 아래로는 압축을 멈추고 `#root` 가 가로 스크롤 (Layout → Responsive floor) |
| `--app-floor-min-h` | 624px | 702px | App shell 세로 바닥 (ADR-0122) — 아래로는 높이 동결 + 세로 스크롤 |

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
