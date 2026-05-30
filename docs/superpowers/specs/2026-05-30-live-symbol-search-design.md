# /live 종목 검색 (헤더 인라인 바 + ♥ 토글) — Design

**Date**: 2026-05-30
**Status**: Draft
**Scope**: frontend (`live/`, 신규 `symbols/`·`ui/`, `capture/`, `rightrail/`), backend (`hoga/api/watchlist_routes.py`, `hoga/live/lifecycle.py`)

## Problem

[frontend/src/live/LiveHeader.tsx](../../../frontend/src/live/LiveHeader.tsx)는 현재 제목 "Live"만 있고, 차트에 띄울 종목을 고르는 인페이지 수단이 없다. `activeCode`는 `?code=` 쿼리파라미터나 localStorage(`live.page.v1`)로만 정해지거나 전역 관심종목 패널(읽기 전용)의 행 클릭으로만 전환된다 ([LivePage.tsx:36-56](../../../frontend/src/live/LivePage.tsx)).

사용자는 첨부 이미지("/ 를 눌러 검색하세요")처럼 인라인 검색으로 **임의의 KRX 종목**을 빠르게 찾아 차트에 띄우고, 마음에 들면 ♥로 관심종목(=실시간 추적 대상)에 추가/해제하고 싶어한다. 사용자 표현: *"여기서 첨부이미지처럼 종목검색하는 ui 만들고 싶어 … 전체검색 → 종목 선택하면 차트에 보여주기, 하트 아이콘 만들어서 사용자가 누르면 관심종목 추가/해제 가능."*

핵심 도메인 제약 — 라이브 폴러는 **관심종목에 등록된 코드만** 주기적으로 KIS에서 pull한다 ([poller.py](../../../hoga/live/poller.py), [lifecycle.get_active_codes](../../../hoga/live/lifecycle.py)). 반면 과거 캔들(`/api/range`)은 관심종목과 무관하게 항상 렌더된다. 따라서 "검색 → 선택 → 차트"는:

- **비관심 종목** → 과거 캔들만 (실시간 틱·호가 없음)
- **관심 종목 + 장중** → 과거 + 실시간

이 분기를 정직하게 드러내고, ♥ 한 번으로 비관심 → 관심(실시간) 전환을 즉시 성립시키는 것이 이 spec의 골자다.

## Invariants

이 spec이 건드리거나 의존하는 시스템이 **현재 보존하고 있는** 속성들:

- **Live activeCode resolution**: `/live`의 활성 종목은 `?code=` 쿼리파라미터 우선, 없으면 localStorage `live.page.v1`의 `activeCode`로 정해진다. 근거: [LivePage.tsx:36-56](../../../frontend/src/live/LivePage.tsx), [state/livePage.ts:247-250](../../../frontend/src/state/livePage.ts).
- **Single live source per page (ADR-0040)**: `LivePage`가 `useLiveSeries`·`useLiveBundle`를 **각각 한 번만** 호출해 단일 SSE 연결·단일 링버퍼를 소유한다. 근거: [LivePage.tsx:62-76](../../../frontend/src/live/LivePage.tsx).
- **Workarea gate: watchlist-empty blanks the chart**: 관심종목이 완전히 비면(`watchlistSize===0`) `activeCode`가 있어도 워크에어리어가 "관심종목이 비어 있습니다" 빈 상태로 차트를 막는다. 근거: [LiveWorkarea.tsx:31-37](../../../frontend/src/live/LiveWorkarea.tsx), [useLiveBannerState.ts:51-55](../../../frontend/src/live/useLiveBannerState.ts).
- **Poller tracks the watchlist snapshot taken at (re)start**: 라이브 폴러는 `start_live_poller` 호출 시점에 디스크에서 읽은 `_state.watchlist_codes` 스냅샷만 순회한다. watchlist를 디스크에서 바꿔도 폴러는 자동으로 새 코드를 집지 않는다. 근거: [lifecycle.py:78-92](../../../hoga/live/lifecycle.py), [lifecycle.py:292-302](../../../hoga/live/lifecycle.py); docstring이 *"Stage 8 doesn't auto-restart on change yet, that's a future enhancement"*라 명시.
- **Buffer continuity across poller restart**: `start_live_poller`가 폴러 task를 재시작해도 모듈 전역 `_buffer`(`LiveBuffer`)는 재사용되어 누적 스냅샷이 유지된다. 근거: [lifecycle.py:293](../../../hoga/live/lifecycle.py) (`LivePoller(..., buffer=_buffer)`).
- **Single watchlist data source**: 모든 관심종목 UI는 TanStack Query 키 `['watchlist']` 하나로 읽고 add/remove 뮤테이션으로 쓴다. 근거: [watchlist/useWatchlist.ts](../../../frontend/src/watchlist/useWatchlist.ts).
- **Keyboard shortcut guard**: `/live` 단축키는 입력 요소(INPUT/TEXTAREA/SELECT)·`contentEditable`·`[data-prevent-shortcuts]`에 포커스가 있으면 발화하지 않는다. 근거: [useLiveKeyboard.ts:21-28](../../../frontend/src/live/useLiveKeyboard.ts).
- **Color discipline (3-way + heart shape signal)**: teal=UI 상태, success/error=상태 semantic, red/blue=가격 방향; 하트 fill은 *모양 신호*(currentColor=중립)일 뿐 두 번째 accent가 아니다. 근거: [DESIGN.md](../../../DESIGN.md) Color 절, [RightRail.tsx:35-36](../../../frontend/src/rightrail/RightRail.tsx) 주석.
- **Capture SymbolSearch behavior**: 캡처 검색은 캐시 미가용 시 6자리 숫자 코드를 Enter로 미검증 `SymbolHit`(name='—')으로 승격한다(`promoteUnverifiedCode`). 근거: [capture/SymbolSearch.tsx:84-118](../../../frontend/src/capture/SymbolSearch.tsx).

## Invariant impact

| Invariant | 영향 | 비고 |
|---|---|---|
| Live activeCode resolution | preserves | 검색 선택이 `setActiveCode(code)`를 호출 — 기존 해소 순서에 "유저 검색" 입력 경로를 더할 뿐. 쿼리/스토리지 우선순위 불변. |
| Single live source per page | preserves | 검색은 `setActiveCode`만 한다. 새 `useLiveSeries`/`useLiveBundle` 호출을 만들지 않음 — LivePage의 단일 호출이 새 activeCode로 재구독. |
| Workarea gate: watchlist-empty blanks the chart | **intentionally breaks** | activeCode가 있으면 watchlist 공백 여부와 무관하게 차트(과거)를 렌더한다. 게이트는 `!activeCode`로만 단순화. 정당화는 아래. |
| Poller tracks snapshot at (re)start | **intentionally changes** | add/remove 라우트가 폴러를 새로고침해 watchlist 변경이 즉시 반영된다 — docstring이 예고한 "future enhancement" 구현. 정당화는 아래. |
| Buffer continuity across restart | preserves (의존) | 새로고침이 잦아져도 `_buffer` 재사용으로 스냅샷 유지. 회귀 테스트로 고정. |
| Single watchlist data source | preserves | 멤버십 읽기/토글 모두 `['watchlist']` + 기존 add/remove 훅 재사용. |
| Keyboard shortcut guard | preserves/extends | `/` 트리거가 동일 `shouldIgnoreEvent` 가드를 재사용 — 입력 중 `/`는 리터럴로 타이핑됨. |
| Color discipline | preserves | ♥는 RightRail의 `HeartIcon`(채움=중립 currentColor / 외곽선=dim)을 그대로 추출·재사용. teal/rose 미사용. |
| Capture SymbolSearch behavior | preserves | 훅 이관 후에도 `promoteUnverifiedCode`를 `onEnterEmpty` 이음새로 보존. `Capture.test`가 회귀 가드. |

**"Workarea gate" 의도적 변경 정당화** — 사용자가 선택한 모델(전체검색 → 차트 표시, ♥는 명시적)에서는 "둘러보기는 자유, 추적은 명시적"이 핵심 가치다. 관심종목이 비었다는 이유로 검색해 고른 종목의 과거 차트를 막으면 이 모델이 성립하지 않는다. 빈 watchlist의 안내 역할은 (a) activeCode 없을 때의 "/" 검색 유도 빈 상태와 (b) 상태바의 "실시간 ✕ · ♡ 눌러 실시간 추적" 힌트가 대신한다. `kis_credentials_missing`(watchlist는 있는데 폴러 미동작)·`off_hours` 배너는 그대로 둔다.

**"Poller refresh" 의도적 변경 정당화** — `start_live_poller`는 docstring상 *idempotent하며 watchlist 변경을 즉시 반영하기 위한* 재시작 경로로 설계됐고, `_buffer`를 보존한다. ♥ → 즉시 실시간이라는 약속을 정직하게 만들려면 이 경로를 add/remove에 연결하는 것이 정공법이며, "watchlist 변경 → 폴러 추적"이라는 불변식을 **서버에 두어** 모든 클라이언트에 일관시킨다.

## Goals

- `/live` 헤더에 인라인 검색 바. `/`로 포커스, 종목명 또는 코드로 **전체 KRX 마스터** 검색, 바 아래 드롭다운(↑↓/Enter/Esc/클릭).
- 결과 선택 → `setActiveCode(code)` → 차트 렌더(과거는 항상, 실시간 틱은 관심+장중).
- 활성 종목 옆 ♥ 토글 + 결과 행 ♥ → 관심종목 추가/해제. 장중이면 추가/해제가 **다음 폴링 사이클부터 즉시** 반영(폴러 새로고침, 버퍼 보존).
- 관심종목이 비어 있어도 activeCode가 있으면 차트가 막히지 않는다.
- 콤보박스 상호작용을 헤드리스 훅 `useSymbolCombobox`로 추출하고 캡처 `SymbolSearch`까지 이관해 중복/드리프트를 제거한다(부채 청산).

## Non-Goals

- `/watchlist` 풀 페이지·캡처 폼의 구조 변경 — 캡처는 **훅 이관만**(동작 보존).
- 전역(다른 페이지) 검색 — `/live` 한정. `activeCode`는 live 도메인 개념.
- WebSocket 등 실시간 전송/소스 변경.
- 아이콘 라이브러리 도입 — 인라인 SVG.
- 검색 결과에 캡처 통계(`captured_count`) 노출 — 라이브 행은 종목명·코드·시장·♥만.
- 반응형/모바일 — 데스크톱 전용 기조 유지.

## Design

### Architecture / file map

```
LiveHeader
 ├─ "Live" 제목
 └─ LiveSymbolSearch        (신규) ── useSymbolCombobox(헤드리스) + useSymbolSearch(데이터) + useWatchlist/add/remove
LiveStatusBar               (변경) ── 활성 종목 옆 ♥ 토글 + 실시간/과거 힌트
LiveWorkarea / LiveEmptyState (변경) ── activeCode만으로 게이트; "/" 검색 유도 빈 상태
useLiveBannerState          (변경) ── watchlist_empty가 차트를 막지 않도록 분리
useSymbolCombobox           (신규, symbols/) ── 입력·개폐·하이라이트·키보드만 소유
HeartIcon                   (신규, ui/) ── RightRail에서 추출(채움=중립/외곽선=dim)
capture/SymbolSearch        (변경) ── 위 훅으로 이관(onEnterEmpty 이음새로 promote 보존)
rightrail/RightRail         (변경) ── HeartIcon 공유 import
backend: watchlist_routes   (변경) ── add/remove 후 refresh_live_poller 호출
backend: lifecycle          (변경) ── refresh_live_poller(stop-then-conditional-start) 추가
```

| 구분 | 파일 | 역할 |
|---|---|---|
| 신규 | `frontend/src/symbols/useSymbolCombobox.ts` (+test) | 헤드리스 콤보박스 훅 |
| 신규 | `frontend/src/live/LiveSymbolSearch.tsx` (+test) | 헤더 인라인 검색 바 |
| 신규 | `frontend/src/ui/HeartIcon.tsx` | 공유 하트 아이콘(채움/외곽선) |
| 변경 | `frontend/src/live/LiveHeader.tsx` | LiveSymbolSearch 마운트 |
| 변경 | `frontend/src/live/LiveStatusBar.tsx` (+test) | 활성 종목 ♥ + 실시간/과거 힌트 |
| 변경 | `frontend/src/live/LiveWorkarea.tsx` (+test) | activeCode만으로 게이트 |
| 변경 | `frontend/src/live/LiveEmptyState.tsx` (+test) | "/" 검색 유도 카피 |
| 변경 | `frontend/src/live/useLiveBannerState.ts` (+test) | watchlist_empty 차트 차단 해제 |
| 변경 | `frontend/src/capture/SymbolSearch.tsx` | 훅 이관(promote는 onEnterEmpty로) |
| 변경 | `frontend/src/rightrail/RightRail.tsx` | HeartIcon 공유 import |
| 변경 | `hoga/api/watchlist_routes.py` (+test) | add/remove 후 폴러 새로고침 |
| 변경 | `hoga/live/lifecycle.py` (+test) | `refresh_live_poller` 추가 |

데이터 훅(`capture/useSymbols.ts`의 `useSymbols`/`useSymbolSearch`/`filterSymbols`)은 **그대로 둔다** — 콤보박스 훅은 데이터 비의존(소비자가 items 주입)이므로 이동 불필요. 추출 범위를 상호작용 메커니즘으로 한정해 디프를 좁힌다.

### useSymbolCombobox (헤드리스 훅)

상호작용 *메커니즘*만 소유하고 *데이터·표현·선택 정책*은 소유하지 않는다(Downshift/Headless UI 패턴).

```ts
interface UseSymbolComboboxOpts<T> {
  items: T[];                         // 소비자가 필터된 결과를 주입
  onSelect: (item: T) => void;        // 하이라이트 항목 확정
  onEnterEmpty?: (query: string) => boolean; // 결과 없을 때 Enter 처리(true=소비됨)
}
interface UseSymbolComboboxResult {
  query: string; setQuery: (q: string) => void;
  open: boolean; setOpen: (o: boolean) => void;
  highlightedIndex: number;
  inputProps: { value; onChange; onFocus; onKeyDown; ref };
  getOptionProps: (index: number) => { onMouseDown; onMouseEnter; 'aria-selected' };
  listProps: { role: 'listbox' };
}
```

키보드 규약(캡처 현 동작과 동일):
- `Enter`: `open && items.length>0` → `onSelect(items[highlightedIndex])`; 아니면 `onEnterEmpty?.(query)`.
- `ArrowDown/Up`: 하이라이트 ±1 clamp(0..items-1). `Escape`: `setOpen(false)`.
- `query` 변경 시 `highlightedIndex=0`으로 리셋. 옵션 `onMouseDown`은 `preventDefault`(blur 전 클릭 확정).

**Enter 이음새**: 캡처는 `onEnterEmpty`로 6자리 코드 → 미검증 `SymbolHit` 승격(기존 `promoteUnverifiedCode`). 라이브는 `onEnterEmpty`로 6자리 코드 → `setActiveCode`(보기 전용, watchlist 추가 안 함; 심볼 마스터 콜드여도 차트 동작). 둘 다 *선택 정책*은 소비자 소유 — 훅은 분기만 제공.

### LiveSymbolSearch (헤더 인라인 바)

- [LiveHeader.tsx](../../../frontend/src/live/LiveHeader.tsx)의 제목 옆에 마운트. 입력 바 idle 카피 "종목명 또는 코드 검색…" + `/` kbd 힌트. 포커스 시 teal 보더(DESIGN.md Combobox 토큰).
- items = `useSymbolSearch(query, 20)`. `useSymbolCombobox({ items, onSelect, onEnterEmpty })`.
- `onSelect(hit)` = `useLivePageStore.setActiveCode(hit.code)` + `setOpen(false)` + 입력 blur/clear. `onEnterEmpty(q)` = `/^\d{6}$/.test(q)`면 `setActiveCode(q)` 후 true.
- 결과 행: 종목명 · 코드(mono) · 시장 배지 · `HeartIcon`(멤버십). 행 ♥ 클릭은 `onMouseDown preventDefault` 후 add/remove 뮤테이션(행 선택과 분리 — 이벤트 stopPropagation).
- **`/` 글로벌 포커스**: 컴포넌트가 자체 `window` keydown 리스너로 `/`를 받아 입력에 포커스(`shouldIgnoreEvent` 가드 재사용 → 입력 중이면 무시, 처리 시 `preventDefault`). `useLiveKeyboard`는 건드리지 않는다(현재 `/` 미바인딩). `shouldIgnoreEvent`는 공유 유틸로 추출하거나 동일 로직을 작은 헬퍼로 둔다.
- 멤버십: `useWatchlist`의 `entries`에 코드 존재 여부 → 채움/외곽선.

### LiveStatusBar — 활성 종목 ♥

[LiveStatusBar.tsx](../../../frontend/src/live/LiveStatusBar.tsx)의 `symbolLabel` 옆에 ♥ 토글 추가:
- 멤버십(`useWatchlist`)이면 채운 ♥ + 기존 LIVE 인디케이터; 아니면 외곽선 ♥ + "과거 차트 · 실시간 ✕" + 끝에 teal 보조문구 "♡ 눌러 실시간 추적".
- ♥ 클릭 → `useAddToWatchlist`/`useRemoveFromWatchlist`. 멤버십이 토글 방향을 정함(이중추가 방지). 실패(409/404)는 `['watchlist']` refetch로 정정.
- 멤버십(♥)과 장 phase(LIVE●/off_hours)는 **별개 신호** — 장외엔 멤버여도 틱이 없고, 이는 기존 off_hours 처리로 표현.

### Workarea 게이트 변경

[LiveWorkarea.tsx](../../../frontend/src/live/LiveWorkarea.tsx):
- 기존: `if (watchlistEmpty) blank → if (!activeCode) blank → chart`.
- 변경: `if (!activeCode) → LiveEmptyState(search) → else chart`. `watchlistEmpty` 프롭으로 인한 차트 차단 제거.
- [LivePage.tsx:88-106](../../../frontend/src/live/LivePage.tsx)에서 `watchlistEmpty` 전달을 정리하고, [useLiveBannerState.ts](../../../frontend/src/live/useLiveBannerState.ts)의 `watchlist_empty` primary가 **activeCode가 있을 때 차트를 막거나 모순 배너를 띄우지 않도록** 분리한다. `kis_credentials_missing`/`off_hours`는 유지.

### LiveEmptyState

[LiveEmptyState.tsx](../../../frontend/src/live/LiveEmptyState.tsx)의 `no_active_code` 분기를 "/" 검색 유도로 교체: kbd `/` + "를 눌러 종목을 검색하세요" + 보조 "최근 본 종목이 있으면 자동으로 불러옵니다". `watchlist_empty` 분기는 더 이상 차트 차단에 쓰이지 않으므로 제거하거나 동일 검색 유도로 통합.

### 백엔드 — 폴러 새로고침 (+ remove-to-empty)

**문제**: `start_live_poller`는 watchlist가 비면 `stop`(line 279)보다 먼저 early-return False라([lifecycle.py:259-262](../../../hoga/live/lifecycle.py)), 마지막 종목 ♥ 해제 시 그냥 `start`만 부르면 **stale 폴러가 옛 코드로 계속 돈다.** 따라서 단순 start가 아니라 stop-then-conditional-start가 필요.

`hoga/live/lifecycle.py`에 추가:
```python
async def refresh_live_poller(*, data_dir: Path) -> None:
    """Re-sync the poller's tracked codes to the on-disk watchlist.

    Non-empty → start_live_poller (idempotent restart; rebuilds _state,
    reuses _buffer). Empty → stop_live_poller (start alone would early-return
    without stopping the stale poller). Cheap: no awaited network round-trip;
    KisClient reuses the on-disk token cache.
    """
    from hoga.api.watchlist import load_watchlist
    if load_watchlist(data_dir):
        await start_live_poller(data_dir=data_dir)
    else:
        await stop_live_poller()
```

`hoga/api/watchlist_routes.py`: `add_to_watchlist`·`remove_from_watchlist`가 mutate 성공 후 `await refresh_live_poller(data_dir=data_dir)`를 호출(반환 전). KIS 자격 없거나 장외여도 안전(start는 False/idle-gated, stop은 no-op). 새로고침 후 기존 per-code SSE 구독(`/api/live/stream?code=`)이 다음 사이클부터 자동으로 채워지므로 프론트 재구독 불필요. 프론트는 ♥ 뮤테이션 성공 시 `['watchlist']`에 더해 `['live','status']`도 무효화해 상태바 인디케이터를 최신화한다.

### 캡처 마이그레이션 (부채 청산)

[capture/SymbolSearch.tsx](../../../frontend/src/capture/SymbolSearch.tsx)를 `useSymbolCombobox`로 이관:
- `text`/`open`/`highlight`/`onKeyDown`/highlight-reset effect → 훅으로 대체.
- 캡처 고유(캐시 상태 칩·refresh·stale 넛지·`captured_count` 행)는 그대로.
- `promoteUnverifiedCode`를 `onEnterEmpty`로 주입 — Enter 동작 보존.
- `value`/`onChange` 컨트롤드 계약 유지. [Capture.test.tsx](../../../frontend/src/pages/Capture.test.tsx)가 회귀 가드 + 훅 단위테스트로 Enter-empty 보강.

### Design tokens / color discipline

- `HeartIcon`은 [RightRail.tsx:50-64](../../../frontend/src/rightrail/RightRail.tsx)의 SVG를 `frontend/src/ui/HeartIcon.tsx`로 추출(`{ filled: boolean }`, currentColor 기반). RightRail은 거기서 import. **신규 색 토큰 없음** — 채움=중립 fg, 외곽선=dim. DESIGN.md 색 규율(teal/rose 비사용) 준수.
- 새 레이아웃 폭/높이 토큰 불필요(헤더 검색 바는 기존 `--h-live-header` 안). idle/포커스 보더·드롭다운 그림자는 DESIGN.md Combobox 토큰(`0 8px 24px rgba(0,0,0,.4)`, 포커스 teal 보더) 재사용.

### 구현 슬라이스 (tracer-bullet — writing-plans에서 상세화)

1. `useSymbolCombobox` + 단위테스트 (UI 무변경, 순수 추출).
2. `LiveSymbolSearch` + LiveHeader 마운트 + 검색→`setActiveCode` + Workarea/EmptyState 게이트 완화 + banner 분리. (검색해서 과거 차트까지 — 수직 슬라이스)
3. `HeartIcon` 추출 + LiveStatusBar ♥ + 멤버십 + add/remove + 결과 행 ♥.
4. 백엔드 `refresh_live_poller` + 라우트 연결 (+remove-to-empty stop) + 테스트. (♥ → 즉시 실시간 성립)
5. 캡처 `SymbolSearch` 훅 이관.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 콤보박스 ↑↓ clamp | items 3개, highlight=0 | ArrowUp 무변(0), 끝에서 ArrowDown 무변(2) |
| 콤보박스 Enter 선택 | open, items>0, highlight=1 | `onSelect(items[1])` 호출 |
| 콤보박스 onEnterEmpty 이음새 | items=[], `onEnterEmpty` 제공 | Enter 시 `onEnterEmpty(query)` 호출, true면 기본동작 억제 |
| 콤보박스 query 변경 리셋 | highlight=2 후 query 변경 | highlight=0 |
| Esc 닫기 | open=true | `setOpen(false)` |
| 검색 `/` 포커스 | `/live` 마운트, body 포커스 | `/` keydown 시 입력 포커스, preventDefault |
| 검색 입력 중 `/` 리터럴 | 입력에 포커스 | `/` 무시(shouldIgnoreEvent) → 리터럴 타이핑 |
| 검색 선택 → activeCode | "삼" 입력, Enter | `setActiveCode('005930')`, 드롭다운 닫힘 |
| 6자리 코드뷰 (마스터 콜드) | items=[], "036570" Enter | `setActiveCode('036570')`, watchlist 미추가 |
| 결과 행 ♥ (비멤버) | 005930 비멤버 행 ♥ 클릭 | `useAddToWatchlist('005930')`, 행 선택 미발생 |
| 상태바 ♥ 멤버 표시 | activeCode 멤버 | 채운 ♥ + LIVE 인디케이터 |
| 상태바 ♥ 비멤버 표시 | activeCode 비멤버 | 외곽선 ♥ + "실시간 ✕ · ♡ 눌러 실시간 추적" |
| 상태바 ♥ 토글 | 멤버 ♥ 클릭 | `useRemoveFromWatchlist` 호출 |
| Workarea 게이트(공백+activeCode) | watchlistSize=0, activeCode='005930' | 차트 렌더(빈 상태 아님) |
| Workarea 게이트(no activeCode) | activeCode=null | "/" 검색 유도 빈 상태 |
| EmptyState 카피 | cause=no_active_code | kbd `/` + "검색하세요" |
| 캡처 promote 보존 | 캐시 unavailable, "005930" Enter | 미검증 SymbolHit(name='—') 선택 |
| **백엔드** add → refresh | watchlist=[A], POST add B | `refresh_live_poller` 호출, `get_active_codes()`⊇{A,B} |
| **백엔드** remove non-last | watchlist=[A,B], DELETE A | poller 재시작, `get_active_codes()`={B} |
| **백엔드** remove last → stop | watchlist=[A], DELETE A | `stop_live_poller`, poller 미동작 |
| **백엔드** 버퍼 보존 | 버퍼에 스냅샷 N개, refresh | refresh 후에도 동일 버퍼 N개 유지 |

**Invariant 회귀 테스트**:
- *Single live source per page*: 검색 선택이 `useLiveSeries` 호출 수를 늘리지 않는지(LivePage 단일 호출 유지).
- *Buffer continuity*: `refresh_live_poller` 전후 `get_buffer()` 동일 인스턴스 + 스냅샷 보존.
- *Capture SymbolSearch behavior*: 훅 이관 후 `promoteUnverifiedCode` 동작 유지(Capture.test + 단위).
- *Keyboard shortcut guard*: 입력 포커스 시 `/` 미발화.
- *Single watchlist data source*: ♥가 `['watchlist']` 외 새 fetch 경로를 만들지 않는지.

### Manual verification

- `/live`에서 `/` → 검색 → "삼성" → Enter/클릭 → 삼성전자 차트가 뜬다.
- watchlist 비운 상태에서 검색 선택 → 과거 차트가 막히지 않고 뜬다; 상태바 외곽선 ♥ + "실시간 ✕".
- 장중에 상태바 ♥ 클릭 → 채운 ♥ 전환 + 잠시 후 실시간 틱/호가 유입(폴러 새로고침). 다시 ♥ 클릭 → 해제, 틱 멈춤.
- 마지막 관심종목을 ♥ 해제 → 폴러가 멈추는지(다른 코드 폴링 잔존 없음).
- `/capture` 종목 검색이 이관 후에도 동일 동작(6자리 코드 Enter 승격 포함).

## Risks / Open questions

- **잦은 ♥ 토글 → 폴러 재시작 비용**: 매 토글이 KisClient/LiveWriter를 재생성하고 진행 중 사이클을 취소한다. 단일 사용자·간헐 클릭엔 허용. 디바운스는 backlog.
- **`useLiveBannerState` 분리 범위**: `watchlist_empty` primary를 완전 제거할지, activeCode 유무로 억제만 할지 구현 시 확정(테스트로 고정). `kis_credentials_missing` 분기는 유지.
- **`/` 글로벌 리스너 위치**: LiveSymbolSearch 자체 리스너 vs `useLiveKeyboard`에 `onOpenSearch` 추가. 전자(자체완결)를 기본안으로 하되 cross-component ref 플러밍 회피 차원에서 design 시 재확인.
- **off-hours ♥ 추가**: 폴러는 시작되나 `_should_poll_now`로 idle — "실시간 ✕"(멤버십)과 장 phase 표현이 겹치지 않게 카피 분리 유지.

## Out of Scope (Backlog)

- 전역(다른 페이지) 종목 검색·검색 단축키.
- 폴러 재시작 디바운스/증분 watchlist 반영(전체 재시작 대신 코드 추가만).
- 검색 결과의 캡처 통계/최근가 미리보기.
- `useSymbolCombobox`의 ARIA combobox 완전 준수(`aria-activedescendant` 등) 고도화.
- 캡처/라이브 결과 행의 공통 컴포넌트 추출(세 번째 소비자 등장 시).
