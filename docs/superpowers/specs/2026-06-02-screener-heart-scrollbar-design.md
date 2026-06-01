# 스크리너 행 관심종목 하트 + 다크 스크롤바 — Design

**Date**: 2026-06-02
**Status**: Draft
**Scope**: `frontend/src/rightrail/QuoteRow.tsx`, `frontend/src/screener/ScreenerDrawer.tsx`, `frontend/src/styles/global.css`, (테스트) `frontend/src/rightrail/QuoteRow.test.tsx`, `frontend/src/screener/ScreenerDrawer.test.tsx`

## Problem

우측 Right Rail 스크리너 패널에서 결과 종목을 보고 관심종목으로 담으려면 현재는 차트(`/live`)로 이동하거나 검색 드롭다운을 거쳐야 한다. 사용자 표현: *"스크리너 결과 리스트에 추가로 하트 아이콘을 토글하면 바로 관심종목 추가하고 싶어."* — 결과 리스트에서 한 동작으로 관심종목을 추가/해제하는 어포던스가 없다.

또한 *"스크리너 리스트의 vertical scrollbar가 현재 다크 컨셉과 맞지 않는데 컨셉에 맞게 개선하고 싶어."* — 스크롤바가 브라우저 기본(밝은 회색 청크)으로 렌더되어 다크 테마(`#13131C` 패널)와 충돌한다. 이 충돌은 스크리너 패널뿐 아니라 관심종목 패널·검색 드롭다운·`/screener` 페이지 등 앱 전역의 스크롤 영역에 동일하게 존재한다.

## Invariants

- **QuoteRow 행 클릭 = 차트 열기**: `QuoteRow` 클릭 시 `onClick`(스크리너의 `openLive`, 관심종목의 `onPick`)이 발화해 `activeCode`를 바꾸고 필요 시 `/live`로 이동한다. 근거: [QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx), [ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx).
- **QuoteRow 공용 행 계약**: `QuoteRow`는 스크리너 패널과 관심종목 패널이 공유한다. 현재 시그니처(`code,name,price,pct,active,ariaLabel,testId,onClick`)로 호출하는 모든 사용처가 동일하게 렌더된다. 근거: [WatchlistDrawer.tsx](../../../frontend/src/watchlist/WatchlistDrawer.tsx), [ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx), `QuoteRow.test.tsx`.
- **useWatchlistMembership 단일 소유 계약**: `useWatchlistMembership()`는 *컴포넌트당 1회* 호출되어 O(1) `isMember` 술어와 `toggle`을 제공한다 (행마다 호출 금지). 근거: [useWatchlistMembership.ts](../../../frontend/src/watchlist/useWatchlistMembership.ts) doc 주석.
- **관심종목 mutation 자동 무효화**: `toggle`이 호출하는 add/remove mutation은 성공 시 `['watchlist']` 쿼리를 무효화하여 `isMember`가 즉시 갱신된다. 근거: [useWatchlist.ts](../../../frontend/src/watchlist/useWatchlist.ts).
- **하트 = 중립 shape 신호**: 하트 fill은 `currentColor`(중립색)이며 teal `--accent`를 쓰지 않는다. teal은 UI 상태 전용, second accent 금지. 근거: [DESIGN.md](../../../DESIGN.md) 색 규율, [HeartIcon.tsx](../../../frontend/src/ui/HeartIcon.tsx) doc 주석.
- **per-row 하트 상호작용 패턴**: 검색 드롭다운 하트는 `<button>` + `aria-label`(관심종목 추가/해제) + `aria-pressed` + `onClick` 내 `e.stopPropagation()` + `onMouseDown` `preventDefault`로 동작한다. 근거: [LiveSymbolSearch.tsx:107-116](../../../frontend/src/live/LiveSymbolSearch.tsx#L107-L116).
- **색 하드코딩 금지**: 모든 chrome 색은 `tokens.css`의 CSS 변수를 쓰고 px 색 리터럴을 박지 않는다(그라데이션·장식 금지). 근거: [DESIGN.md](../../../DESIGN.md).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| QuoteRow 행 클릭 = 차트 열기 | preserves | 하트 `<button>` `onClick`에서 `e.stopPropagation()` → 행 `onClick` 미발화 |
| QuoteRow 공용 행 계약 | preserves | 신규 prop은 모두 옵트인(optional). `onToggleWatch` 미전달 시 하트 미렌더 → 기존 사용처·테스트 동일 렌더 |
| useWatchlistMembership 단일 소유 계약 | preserves | `ScreenerDrawer`가 컴포넌트 최상위에서 1회 호출, 행에는 `isMember(code)`/`toggle(code)` 결과만 내려줌 |
| 관심종목 mutation 자동 무효화 | preserves | 기존 훅을 그대로 재사용 |
| 하트 = 중립 shape 신호 | preserves | 미등록 `--fg-dimmer`, 등록 `--fg`. teal 미사용 |
| per-row 하트 상호작용 패턴 | preserves | `LiveSymbolSearch`의 접근성/이벤트 패턴을 그대로 이식 |
| 색 하드코딩 금지 | preserves | 스크롤바 색은 `--border-strong`/`--fg-dimmer` 토큰 사용 |

## Goals

1. 스크리너 패널 결과 행에서 하트 클릭 한 번으로 관심종목 추가/해제, 상태가 즉시 시각 반영된다.
2. 하트 클릭이 행 클릭(차트 열기)과 간섭하지 않는다.
3. 스크롤바가 다크 테마에 자연스럽게 녹아든다 — 전역 적용으로 스크리너 패널·관심종목 패널·드롭다운·`/screener` 모두 일관.
4. 기존 `QuoteRow` 사용처(관심종목 패널)와 테스트가 회귀 없이 그대로 동작한다.

## Non-Goals

- 관심종목 패널에 하트 노출 (스코프 밖 — 단, `QuoteRow`가 옵트인 prop을 받으므로 나중에 prop 전달만으로 가능. 아래 Backlog 참조).
- `/screener` 메인 페이지 결과 테이블 행 변경.
- 스크롤바를 utility-class opt-in으로 만들기 (전역 base 규칙으로 적용).
- 밀도(density) 토글, 스크롤바 폭의 density 연동.

## Design

### 1. `QuoteRow` — 옵트인 하트 어포던스

[QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx) props에 추가:

```ts
watched?: boolean;          // 관심종목 등록 여부 (시각 상태)
onToggleWatch?: () => void; // 토글 핸들러; 없으면 하트 자체를 렌더하지 않음
```

- **렌더 조건**: `onToggleWatch != null`일 때만 행 맨 오른쪽(등락률 셀 다음)에 하트 `<button>` 렌더. 미전달 시 DOM 변화 없음(공용 행 계약 보존).
- **마크업/이벤트** ([LiveSymbolSearch.tsx:107-116](../../../frontend/src/live/LiveSymbolSearch.tsx#L107-L116) 이식):
  - `<button type="button">` + `<HeartIcon filled={watched} />`
  - `aria-label={watched ? '관심종목 해제' : '관심종목 추가'}`, `aria-pressed={watched}`
  - `onClick={(e) => { e.stopPropagation(); onToggleWatch(); }}` — 행 `onClick`(차트 열기) 미발화
  - `onMouseDown={(e) => e.preventDefault()}` — 포커스 이동/blur 방지(검색 하트와 동일)
- **색·표시 (선택 C: "항상 표시 + 미등록 초저대비")**:
  - 미등록: `text-fg-dimmer`(`#64748B`) + `opacity-45` (평소 거의 안 보임)
  - 행 hover 또는 행 포커스: `group-hover:opacity-100`, `group-focus-within:opacity-100`
  - 하트 자체 hover/focus: `hover:text-fg focus-visible:text-fg`
  - 등록: `text-fg`(`#E2E8F0`) 채워짐, `opacity-100` 상시 (검색 하트 컨벤션과 동일 — 중립색)
  - 전환: `transition` opacity/color, `duration ≈ 80ms`(DESIGN.md micro)
- **`<li>`에 `group` 클래스 추가** — 위 `group-hover`/`group-focus-within` 활성화에 필요. 기존 클래스(`hover:bg-bg-input-hover focus-visible:bg-bg-input-hover` 등)는 유지.
- **레이아웃**: 하트 셀은 고정폭(`flex-0 0 18px` 수준)으로 등락률 셀 오른쪽에 배치. 코드/이름/현재가/등락률 셀의 기존 정렬·truncate 계약은 불변.

### 2. `ScreenerDrawer` — 배선

[ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx):

- 컴포넌트 최상위에서 `const { isMember, toggle } = useWatchlistMembership();` **1회** 호출.
- 결과 `<ul>`의 각 `QuoteRow`에 추가 전달:
  ```tsx
  watched={isMember(r.code)}
  onToggleWatch={() => toggle(r.code)}
  ```
- 하트는 **모든 결과 행**에 노출된다. top-30 제한은 라이브 시세 오버레이(`liveCodes`)에만 적용되는 것이며 관심종목 membership/toggle과 무관하다 — 31번째 이하 행도 하트로 토글 가능.
- 새 API·새 store 없음. `toggle` → `useAddToWatchlist`/`useRemoveFromWatchlist` → `['watchlist']` 무효화 → `isMember` 재계산 → 하트 즉시 갱신.

### 3. 스크롤바 전역 스타일 (선택 A: Thin 8px)

[global.css](../../../frontend/src/styles/global.css)에 전역 규칙 추가(`@tailwind` 지시문 이후):

```css
/* 다크 테마 스크롤바 — 전역. 토큰만 사용(DESIGN.md). */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--border-strong);   /* #2A2A38 */
  border-radius: 4px;
}
*::-webkit-scrollbar-thumb:hover { background: var(--fg-dimmer); } /* #64748B */

/* Firefox 폴백 (폭/색만 제어 가능) */
* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
```

- WebKit/Chromium이 이 앱의 실제 렌더 환경(Vite dev + `/browse` Chromium). `height`도 지정해 가로 스크롤바도 동일 톤 적용.
- 트랙 투명 → 패널 배경(`--bg-card`)이 그대로 보여 thumb만 떠 있는 절제된 형태.
- 전역(`*`) 적용이라 관심종목 패널·`LiveSymbolSearch`/`SymbolSearch` 드롭다운·`/screener` 페이지가 함께 정돈됨.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 하트 미렌더(회귀) | `QuoteRow`를 `onToggleWatch` 없이 렌더 | 하트 `<button>` 부재 — 기존 사용처(관심종목 패널)·기존 스냅샷 동일 |
| 하트 렌더 + 상태 | `watched={true}`, `onToggleWatch` 전달 | 하트 버튼 존재, `aria-pressed="true"`, `aria-label="관심종목 해제"`, `HeartIcon filled` |
| 미등록 상태 | `watched={false}`, `onToggleWatch` 전달 | `aria-pressed="false"`, `aria-label="관심종목 추가"` |
| 하트 클릭이 행과 분리 | 하트 버튼 클릭 | `onToggleWatch` 1회 호출 **and** 행 `onClick` 미호출(stopPropagation 검증) |
| 키보드 활성화 보존 | 행에 Enter/Space | 행 `onClick` 발화(기존 계약 불변) |
| ScreenerDrawer 토글 발화 | 결과 렌더 후 특정 행 하트 클릭 | 비회원이면 add, 회원이면 remove mutation 발화; `useWatchlistMembership` 1회 호출 |

**Invariant 회귀 테스트**: 위 "preserves" 항목 중 핵심 두 가지를 명시 검증 — (a) 행 클릭=차트 열기(하트 클릭 시 행 `onClick` 미호출), (b) 공용 행 계약(`onToggleWatch` 미전달 시 하트 미렌더). 나머지(자동 무효화, 색 규율)는 기존 훅 재사용/CSS 토큰 사용으로 구조적으로 보존됨.

### Manual verification

`/live` 또는 Right Rail이 보이는 페이지에서:
1. 우측 레일 → 스크리너 패널 열고 저장 조건 선택 → **조회**.
2. 결과 행에 마우스를 올리면 미등록 하트가 또렷해지는지(평소 초저대비) 확인.
3. 하트 클릭 → 채워짐(등록), 같은 행을 클릭해도 차트로 이동하지 않음 확인.
4. 관심종목 패널을 열어 방금 추가된 종목이 보이는지(자동 무효화) 확인. 하트 재클릭 → 해제 → 관심종목 패널에서 사라짐.
5. 결과 31행 이상인 조건으로 하단 행 하트도 토글되는지 확인.
6. 스크롤바: 스크리너 패널·관심종목 패널·검색 드롭다운에서 8px 다크 thumb, hover 시 밝아짐 확인. 가로/세로 모두 톤 일치.

## Risks / Open questions

- **중첩 인터랙티브 요소**: `QuoteRow`의 `<li role="button" tabIndex={0}>` 안에 `<button>` 하트가 들어간다(엄밀히는 nested interactive). 그러나 동일 패턴이 `LiveSymbolSearch`(`role="option"` + 내부 버튼)에 이미 존재하므로 **선례 일관성**을 택한다. 행의 `role`/`tabIndex`는 변경하지 않는다. 후속으로 행 전체를 `<button>`이 아닌 구조로 재설계하는 것은 별도 작업.
- **검색 하트와 미세한 농도 차이**: 검색 드롭다운 하트는 미등록을 `text-fg-dimmer`(불투명)로 두지만, 스크리너 패널은 선택 C에 따라 `opacity-45`로 한 단계 더 흐리게 둔다. 검색 드롭다운은 일시적(타이핑 중에만 등장)이고 스크리너 패널은 상시 노출되므로 휴지 상태를 더 조용히 두는 것이 의도된 차이다. 두 곳을 완전 통일하려면 검색 하트도 같은 농도로 낮추는 후속 변경이 가능(Backlog).
- **`*` 전역 스크롤바**: 모든 스크롤 영역에 적용된다. 차트 캔버스(`lightweight-charts`)는 자체 캔버스라 영향 없음. 의도치 않게 영향받는 영역이 발견되면 utility-class opt-in으로 좁힐 수 있다.

## Out of Scope (Backlog)

- 관심종목 패널 인라인 해제: `WatchlistDrawer`의 `QuoteRow`에 `watched`/`onToggleWatch` prop만 전달하면 "관심 해제" 하트가 생긴다(전 행이 채워진 하트라 시각 중복 가능 — 채택 시 호버-전용 노출 검토).
- `/screener` 메인 페이지 결과 테이블에도 하트 추가.
- 검색 드롭다운 하트 농도를 스크리너와 통일.
- density 모드 도입 시 스크롤바 폭의 density 연동.
