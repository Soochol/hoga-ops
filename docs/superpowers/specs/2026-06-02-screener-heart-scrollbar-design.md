# 스크리너/관심종목 행 인라인 토글 + 다크 스크롤바 — Design

**Date**: 2026-06-02
**Status**: Draft
**Scope**: `frontend/src/rightrail/QuoteRow.tsx`, `frontend/src/screener/ScreenerDrawer.tsx`, `frontend/src/watchlist/WatchlistDrawer.tsx`, `frontend/src/ui/TrashIcon.tsx` (신규), `frontend/src/styles/global.css`, (테스트) `QuoteRow.test.tsx`, `ScreenerDrawer.test.tsx`, `WatchlistDrawer.test.tsx`

## Problem

우측 **Right Rail**의 **Screener Panel**에서 결과 종목을 보고 관심종목으로 담으려면 현재는 차트(`/live`)로 이동하거나 헤더 검색을 거쳐야 한다. 사용자 표현: *"스크리너 결과 리스트에 하트 아이콘을 토글하면 바로 관심종목 추가하고 싶어."*

이 앱에서 **관심종목 = Watchlist** 는 단순 즐겨찾기가 아니라 **무인 일일 캡처 등록**이다(CONTEXT.md). 그릴링에서 추가로 확정: **Watchlist Panel** 에서도 인라인 **제거**가 가능해야 한다(현재는 `/watchlist` 풀페이지·검색·상태바에서만). 단, Watchlist Panel 은 전 행이 등록종목이라 "채워진 하트 열"은 시각적으로 무거우므로 **하트 대신 전용 삭제(휴지통) 아이콘**을 쓴다.

또한 *"스크리너 리스트의 vertical scrollbar가 다크 컨셉과 안 맞아 개선하고 싶어."* — 스크롤바가 브라우저 기본(밝은 회색)으로 렌더되어 다크 테마와 충돌한다. 같은 충돌이 Watchlist Panel·검색 드롭다운·`/screener` 등 앱 전역에 있다.

## Invariants

- **QuoteRow 행 클릭 = 차트 열기**: `QuoteRow` 클릭/Enter/Space 시 `onClick`(스크리너 `openLive`, 관심종목 `onPick`)이 발화해 `activeCode`를 바꾸고 필요 시 `/live`로 이동. 근거: [QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx).
- **QuoteRow 공용 행 계약**: `QuoteRow`는 Screener/Watchlist 패널이 공유하며, 신규 prop 없이 호출하는 사용처가 동일하게 렌더된다. 근거: [WatchlistDrawer.tsx](../../../frontend/src/watchlist/WatchlistDrawer.tsx), [ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx), `QuoteRow.test.tsx`.
- **useWatchlistMembership 단일 소유 계약**: *컴포넌트당 1회* 호출(행마다 호출 금지). 근거: [useWatchlistMembership.ts](../../../frontend/src/watchlist/useWatchlistMembership.ts) doc.
- **관심종목 mutation 자동 무효화**: add/remove mutation 성공 시 `['watchlist']` 무효화 → membership/목록 즉시 갱신. 근거: [useWatchlist.ts](../../../frontend/src/watchlist/useWatchlist.ts).
- **하트 = 중립 shape 신호**: 하트 fill은 `currentColor`(중립색)이며 teal `--accent` 미사용. 근거: [DESIGN.md](../../../DESIGN.md), [HeartIcon.tsx](../../../frontend/src/ui/HeartIcon.tsx).
- **per-row 인라인 토글 상호작용 패턴**: 행 안의 액션 버튼은 `<button>` + `aria-label`(추가/해제) + `aria-pressed`(토글일 때) + `onClick` 내 `e.stopPropagation()` + `onMouseDown` `preventDefault`. 근거: [LiveSymbolSearch.tsx:107-116](../../../frontend/src/live/LiveSymbolSearch.tsx#L107-L116).
- **관심종목 제거 메타포 = 휴지통 + `--error` hover**: `/watchlist` 풀페이지가 제거를 🗑 + `hover:text-error`로 표현. 근거: [WatchlistRow.tsx:49-57](../../../frontend/src/watchlist/WatchlistRow.tsx#L49-L57).
- **색 하드코딩 금지**: chrome 색은 `tokens.css` 변수 사용(그라데이션·장식 금지). 근거: [DESIGN.md](../../../DESIGN.md).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| QuoteRow 행 클릭 = 차트 열기 | preserves | 액션 버튼 마우스 클릭은 `stopPropagation`; 키보드는 `<li>` `onKeyDown`에 **`e.target !== e.currentTarget` 가드** 추가(중첩 버튼 Enter가 행 `onClick`을 발화하던 버블링 차단) |
| QuoteRow 공용 행 계약 | preserves | 신규 `trailingAction?: ReactNode`는 옵트인. 미전달 시 trailing 셀 미렌더 → 기존 사용처·테스트 동일 |
| useWatchlistMembership 단일 소유 계약 | preserves | `ScreenerDrawer`가 최상위 1회 호출, 행엔 결과만 전달. `WatchlistDrawer`는 제거 전용이라 `useRemoveFromWatchlist`만 사용(membership Set 불필요) |
| 관심종목 mutation 자동 무효화 | preserves | 기존 훅 재사용 |
| 하트 = 중립 shape 신호 | preserves | 하트 미등록 `--fg-dimmer`/등록 `--fg`, teal 미사용 |
| per-row 인라인 토글 패턴 | preserves | `LiveSymbolSearch` 패턴 이식 |
| 제거 메타포 = 휴지통 + error hover | preserves | 레일 드로어는 SVG `TrashIcon`(레일은 SVG 계열), `hover:text-error`로 풀페이지와 의미 일치 |
| 색 하드코딩 금지 | preserves | 스크롤바·아이콘 모두 토큰 사용 |

## Goals

1. **Screener Panel** 결과 행에서 하트 클릭 한 번으로 관심종목 추가/해제, 상태 즉시 시각 반영.
2. **Watchlist Panel** 행에서 휴지통 아이콘으로 인라인 제거(클릭 → 행 사라짐).
3. 액션 클릭/Enter가 행 클릭(차트 열기)과 간섭하지 않는다(마우스·키보드 모두).
4. 스크롤바가 다크 테마에 녹아든다 — 전역 적용으로 모든 스크롤 영역 일관.
5. 신규 prop 미전달 시 기존 `QuoteRow` 사용처/테스트가 회귀 없이 동작.

## Non-Goals

- **Watchlist Panel 에서의 추가**(불가능 — 패널은 등록종목만 표시). 추가는 Screener Panel·검색·상태바·`/watchlist` 페이지에서.
- `/screener` 메인 페이지 결과표(`ResultTable`) 변경(이미 ♥/📥 버튼 보유).
- 검색 드롭다운/상태바 하트의 기존 동작 변경(향후 공용화는 Backlog).
- 스크롤바 utility-class opt-in(전역 base 규칙으로 적용), density 연동.

## Design

### 1. `QuoteRow` — trailing action 슬롯 + 키보드 격리

[QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx)에 **범용 옵트인 슬롯** 추가(하트·휴지통 등 affordance를 패널이 주입):

```ts
trailingAction?: React.ReactNode; // 등락률 셀 다음 고정폭 셀에 렌더; 없으면 셀 미생성
```

- `trailingAction`이 있을 때만 등락률 셀 오른쪽에 고정폭 트레일링 셀을 렌더. 슬롯 내용물(하트/휴지통)이 자체적으로 `stopPropagation`·`preventDefault`·a11y를 책임진다(아래 §2·§3).
- `<li>`에 **`group` 클래스 추가** → 슬롯 내용물이 `group-hover:`/`group-focus-within:`로 호버/포커스 시 등장 처리 가능(C 트리트먼트·휴지통 reveal에 필요).
- **키보드 격리(신규 가드)**: `onKeyDown` 최상단에 `if (e.target !== e.currentTarget) return;`. 중첩 버튼에서 Enter/Space 시 keydown이 `<li>`로 버블링돼 행 `openLive`가 같이 발화하던 문제를 차단. 행 자체가 포커스됐을 때만 Enter/Space → `onClick`.
- 기존 셀(코드/이름/현재가/등락률)의 정렬·truncate·active 스타일은 불변.

### 2. Screener Panel — 추가/해제 하트 (C 트리트먼트)

[ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx):

- 컴포넌트 최상위에서 `const { isMember, toggle } = useWatchlistMembership();` **1회** 호출.
- 각 `QuoteRow`에 `trailingAction={<하트버튼 watched={isMember(r.code)} onToggle={() => toggle(r.code)} />}` 전달. **모든 결과 행**에 노출(top-30은 Live Quote 오버레이에만 해당).
- 하트 버튼(인라인, [LiveSymbolSearch](../../../frontend/src/live/LiveSymbolSearch.tsx#L107-L116) 패턴 이식):
  - `<button type="button">` + `<HeartIcon filled={watched} />`
  - `aria-label={watched ? '관심종목 해제' : '관심종목 추가'}`, `aria-pressed={watched}`
  - `onClick={(e)=>{ e.stopPropagation(); onToggle(); }}`, `onMouseDown={(e)=>e.preventDefault()}`
  - 색·표시(선택 **C**): 미등록 `text-fg-dimmer opacity-45` → `group-hover:opacity-100 group-focus-within:opacity-100`, 자체 `hover:text-fg focus-visible:text-fg`. 등록 `text-fg opacity-100`(상시). 전환 `transition` opacity/color ≈ 80ms(DESIGN.md micro).
- 새 API/store 없음. `toggle` → add/remove → `['watchlist']` 무효화 → 하트 즉시 갱신.

### 3. Watchlist Panel — 인라인 제거 (휴지통)

[WatchlistDrawer.tsx](../../../frontend/src/watchlist/WatchlistDrawer.tsx) (이미 공용 `QuoteRow` + Live Quote 사용):

- `const removeM = useRemoveFromWatchlist();` (제거 전용이므로 membership Set 불필요 — 표시 행은 전부 등록종목).
- 각 `QuoteRow`에 `trailingAction={<제거버튼 onRemove={() => removeM.mutate(entry.code)} name={entry.name} />}` 전달.
- 제거 버튼(인라인):
  - `<button type="button">` + `<TrashIcon />`
  - `aria-label={`${name} 관심종목 해제`}`
  - `onClick={(e)=>{ e.stopPropagation(); onRemove(); }}`, `onMouseDown={(e)=>e.preventDefault()}`
  - 표시(가벼운 reveal): `text-fg-dimmer opacity-0` → `group-hover:opacity-100 group-focus-within:opacity-100`, 자체 `hover:text-error focus-visible:text-error`(제거 신호). 휴지통이 평소 숨겨져 패널이 깨끗하고, 호버/키보드 포커스 시 등장. (톤이 과하면 QA에서 `opacity-30` 등으로 조정 — 사용자 합의.)
- 클릭 → `DELETE /api/watchlist/{code}` → `['watchlist']` 무효화 → 행이 다음 refetch에서 사라짐. `DELETE`는 멱등이라 중복 클릭 무해.

### 4. `TrashIcon` (신규)

[ui/TrashIcon.tsx](../../../frontend/src/ui/TrashIcon.tsx) — `HeartIcon`/`FunnelIcon`과 동일 패턴의 작은 SVG. `currentColor` stroke, `className`으로 사이징(`aria-hidden`). 레일 드로어가 SVG 계열이므로 풀페이지의 🗑 이모지 대신 SVG를 쓰되 "제거" 메타포(휴지통)는 동일.

### 5. 스크롤바 전역 스타일 (선택 A: Thin 8px)

[global.css](../../../frontend/src/styles/global.css)에 전역 규칙 추가(`@tailwind` 지시문 이후, 토큰만 사용):

```css
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; } /* #2A2A38 */
*::-webkit-scrollbar-thumb:hover { background: var(--fg-dimmer); }                    /* #64748B */
* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }      /* Firefox 폴백 */
```

- WebKit/Chromium이 실제 렌더 환경(Vite dev + `/browse`). `height`도 지정해 가로 스크롤바 동일 톤. 트랙 투명 → 패널 배경만 보이고 thumb만 떠 있는 절제된 형태. 전역(`*`)이라 모든 스크롤 영역 일관. `lightweight-charts` 캔버스는 자체 캔버스라 무영향.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 슬롯 미렌더(회귀) | `QuoteRow`를 `trailingAction` 없이 렌더 | 트레일링 셀/버튼 부재 — 기존 사용처 동일 |
| 슬롯 렌더 | `trailingAction={<button>x</button>}` | 트레일링 셀에 버튼 존재 |
| 키보드 격리 | 슬롯 버튼에 포커스 후 Enter | 슬롯 버튼 핸들러 발화, 행 `onClick` **미호출**(`e.target !== e.currentTarget` 가드) |
| 행 자체 키보드 | 행(`<li>`) 포커스 후 Enter/Space | 행 `onClick` 발화(기존 계약) |
| 마우스 격리 | 슬롯 버튼 클릭 | 버튼 핸들러 발화, 행 `onClick` 미호출(`stopPropagation`) |
| 스크리너 하트 토글 | 결과 렌더 후 행 하트 클릭 | 비회원→add / 회원→remove mutation 발화; `aria-pressed`·`HeartIcon filled` 반영; `useWatchlistMembership` 1회 |
| 관심종목 휴지통 제거 | 관심종목 패널 행 휴지통 클릭 | `useRemoveFromWatchlist` mutate(code) 1회; `aria-label="… 관심종목 해제"` |

**Invariant 회귀 테스트**: (a) 행 클릭=차트 열기(액션 클릭·Enter 시 행 `onClick` 미호출 — 마우스/키보드 둘 다), (b) 공용 행 계약(`trailingAction` 미전달 시 trailing 셀 미렌더). 나머지는 기존 훅 재사용/CSS 토큰으로 구조적 보존.

### Manual verification

`/live` 등 Right Rail 노출 페이지에서:
1. Screener Panel → 조건 선택 → 조회. 행 hover 시 미등록 하트가 또렷해짐(평소 초저대비). 하트 클릭 → 채워짐, 같은 행 클릭해도 차트 이동 안 함. 키보드 Tab으로 하트 포커스 → 보임 + Enter로 토글, 행으로는 점프 안 됨.
2. 결과 31행 이상 조건에서 하단 행 하트도 토글.
3. Watchlist Panel → 평소 휴지통 숨김, 행 hover/포커스 시 등장 → 클릭 시 `hover:text-error`, 제거되어 행 사라짐. 방금 스크리너에서 추가한 종목이 여기 보였다가 제거됨(자동 무효화 양방향).
4. 스크롤바: Screener/Watchlist 패널·검색 드롭다운에서 8px 다크 thumb, hover 시 밝아짐. 가로/세로 톤 일치.

## Risks / Open questions

- **중첩 인터랙티브 요소**: `QuoteRow`의 `<li role="button" tabIndex={0}>` 안에 `<button>`(엄밀히 nested interactive). 동일 패턴이 `LiveSymbolSearch`에 이미 존재 → 선례 일관성을 택하고 행 `role`/`tabIndex`는 불변. 키보드 격리는 `e.target !== e.currentTarget` 가드로 처리. 행 전체 구조 재설계는 별도 작업.
- **휴지통 reveal 농도**: 기본 `opacity-0`(완전 숨김)이라 발견성이 낮을 수 있음. 단일 사용자 도구라 호버-reveal로 충분하다고 판단하되, 무겁/가볍 톤은 QA에서 조정(사용자 합의).
- **하트 농도 vs 검색 하트**: 스크리너 미등록 하트는 `opacity-45`로 검색 드롭다운(`text-fg-dimmer` 불투명)보다 흐림. 일시적 드롭다운 vs 상시 패널의 의도된 차이. 완전 통일은 Backlog.
- **`*` 전역 스크롤바**: 모든 스크롤 영역 적용. 의도치 않은 영역 발견 시 utility-class로 좁힐 수 있음.

## Out of Scope (Backlog)

- 검색 드롭다운/상태바 하트를 공용 `WatchHeartButton`으로 추출·통일.
- `/screener` 메인 페이지 결과표 affordance를 SVG 아이콘으로 통일(현재 ♥/📥/🗑 이모지).
- density 모드 도입 시 스크롤바 폭 연동.

> **ADR 불필요**: 본 변경은 prop 추가로 가역적이고, CONTEXT.md 갱신으로 "왜 이렇게?"의 의외성이 해소됨(하드-투-리버스·서프라이즈·트레이드오프 3요건 미충족). Right Rail 패널 자체의 결정은 ADR-0052에 이미 기록.
