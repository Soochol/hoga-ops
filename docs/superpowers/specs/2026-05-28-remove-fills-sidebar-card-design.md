# 체결 사이드바 카드 제거 — Design

**Date**: 2026-05-28
**Status**: Draft
**Scope**: `frontend/src/sidebar/CursorSidebar.tsx`, `frontend/src/sidebar/FillTape.tsx`, `frontend/src/live/LiveSidebar.tsx`, `frontend/src/live/liveSidebarAdapters.ts`, `frontend/src/api/useCursor.ts`, `frontend/src/api/useLiveCursor.ts`, `hoga/api/routes.py`, `hoga/api/models.py`, 대응 테스트.

## Problem

`/live`와 `/replay` 사이드바는 세 카드(**10호가 / 거래원 / 체결**)로 구성된다. 사용자는 "체결" 카드가 불필요하다고 판단해 양쪽 페이지에서 제거하기를 원한다 — 인용: "10호가, 거래원, 체결에서 체결 ui는 삭제하고 싶어."

체결 카드는 `FillTape` 컴포넌트가 `useTradesAroundCursor` (replay) / `useLiveTradesAroundCursor` (live) 가 가져온 cursor-anchored 체결 N건을 시간 역순으로 렌더한다. 카드 자체뿐 아니라 그 카드만을 위해 존재하는 REST 엔드포인트(`/api/trades?code=&date=&t=&limit=`)와 어댑터 (`flattenTrades`, `LIVE_FILLTAPE_MAX`) 도 함께 dead code가 된다.

## Invariants

- **`useLiveSeries.trade` SSE 스트림 무결성**: `/live` 페이지에서 `useLiveSeries(code)` 가 emit하는 `trade` 배열은 차트의 체결강도(FillStrength) pane 입력이다 — `bucketHogaSeries(snapshots, trade, bucket_ms)` 가 `fillStrengthPoints` 를 계산하고, `buildLiveBundle` 이 차트 bundle에 합친다. 근거: [bucketHogaSeries.ts](../../../frontend/src/live/bucketHogaSeries.ts), [buildLiveBundle.ts](../../../frontend/src/live/buildLiveBundle.ts).
- **`Trade` / `ApiTrade` 타입 살아있음**: SSE emitter (`hoga/api/sse.py`) 와 capture pipeline (`hoga/tables/trades.py`) 이 `ApiTrade` 로 trade 이벤트를 만든다. 근거: [hoga/tables/trades.py:232](../../../hoga/tables/trades.py#L232).
- **CursorSidebar 카드 grid 비율**: 현재 `grid-rows-[minmax(624px,2fr)_1.4fr_1fr]` 에서 10호가는 최소 624px 높이를 보장받는다. 근거: [CursorSidebar.tsx:56](../../../frontend/src/sidebar/CursorSidebar.tsx#L56).
- **`/replay` 와 `/live` 사이드바 시각 parity**: ADR-0023 이후 두 페이지는 동일한 `CursorSidebar` 레이아웃 쉘을 공유한다. 근거: [LiveSidebar.tsx:31](../../../frontend/src/live/LiveSidebar.tsx#L31).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| `useLiveSeries.trade` SSE 무결성 | preserves | UI 소비처만 제거. 스트림과 `bucketHogaSeries` 경로는 그대로. |
| `Trade` / `ApiTrade` 타입 | preserves | SSE/capture 사용 유지. `TradesResponse` (REST wrapper) 만 제거. |
| CursorSidebar grid 비율 | intentionally breaks | 3행 → 2행으로 reflow. 10호가의 `minmax(624px,2fr)` 는 유지하고 체결이 차지하던 1fr 을 거래원이 흡수한다. |
| `/replay`-`/live` 사이드바 parity | preserves | 동일한 `CursorSidebar` 컴포넌트를 양쪽이 계속 공유. 두 페이지 모두에서 동시에 체결 카드가 사라진다. |

Grid 비율 변경의 정당화: 카드를 하나 제거하는 변경은 본질적으로 grid를 reflow하지 않을 수 없다. 가장 보수적인 reflow는 (a) 10호가의 최소 높이 보장을 유지하고 (b) 거래원이 자연스럽게 freed 공간을 흡수하는 것 — `grid-rows-[minmax(624px,2fr)_1.4fr]`. 10호가는 dominant pane이므로 비율 우위를 유지한다.

## Goals

- `/live`와 `/replay` 사이드바에서 **체결 카드 완전 제거** (DOM, ARIA, testId 모두).
- 체결 카드 전용 코드는 모두 제거하여 dead code 0 보장 — `FillTape`, FillTape 전용 어댑터/훅, `/api/trades` REST 엔드포인트, `TradesResponse` 모델, 관련 테스트.
- 차트의 체결강도(FillStrength) pane은 손대지 않고 그대로 동작.
- 백엔드 `uv run pytest` + 프론트 `cd frontend && npm run build` 통과.

## Non-Goals

- 차트의 **체결강도(FillStrength) 인디케이터 pane** 변경 — 별개 시각화로 그대로 유지.
- `ApiTrade` / `Trade` 타입, capture pipeline, SSE `trade` emitter 변경.
- 사이드바의 10호가/거래원 카드 내부 디자인 변경.
- `useLiveOrderbookAtCursor`, `useLiveBrokersAtCursor`, `useOrderbookAtCursor` 등 다른 cursor 훅 변경.
- 키보드 단축키, 키 바인딩 변경 (체결 카드는 단축키 타깃이 아니므로 영향 없음).

## Architecture

체결 카드는 다음 4계층으로 구성된다:

```
┌─────────────────────────────────────────────────────────┐
│ Presentation: FillTape.tsx                              │
│   └─ <CursorSidebar fills={<FillTape trades={...}/>}/>  │
├─────────────────────────────────────────────────────────┤
│ Adapter (live only): flattenTrades, LIVE_FILLTAPE_MAX   │
├─────────────────────────────────────────────────────────┤
│ Data hook:                                              │
│   /replay → useTradesAroundCursor → /api/trades         │
│   /live   → useLiveTradesAroundCursor → /api/trades     │
├─────────────────────────────────────────────────────────┤
│ Backend: GET /api/trades → TradesResponse               │
└─────────────────────────────────────────────────────────┘
```

각 계층을 그 계층의 유일한 소비자가 사라지므로 전부 제거한다 — bottom-up이 아니라 top-down 순서로 (UI 먼저, 그 다음 훅, 그 다음 백엔드 라우트). 이 순서가 안전한 이유: UI를 제거하면 hook 호출이 사라지고, hook 호출이 사라지면 백엔드 라우트 호출이 사라진다. 역순으로 하면 dangling 호출이 생긴다.

## Affected files (구체적)

### Frontend — delete

- `frontend/src/sidebar/FillTape.tsx`
- `frontend/tests/component/FillTape.test.tsx`

### Frontend — modify

- `frontend/src/sidebar/CursorSidebar.tsx`
  - Props `fills?: ReactNode` 제거 → `Props = { orderbook?; brokers? }`
  - `<aside>` grid: `grid-rows-[minmax(624px,2fr)_1.4fr_1fr]` → `grid-rows-[minmax(624px,2fr)_1.4fr]`
  - `<SidebarCard label="체결" testId="card-fills">` 섹션 제거
  - `FillTape` import + `useTradesAroundCursor` import + `CursorSidebarConnected` 내 `const trades = useTradesAroundCursor()` 제거
  - JSX 의 `fills={<FillTape trades={trades} />}` 제거

- `frontend/src/live/LiveSidebar.tsx`
  - `FillTape` import 제거
  - `flattenTrades`, `useLiveTradesAroundCursor` import 제거
  - `latestTrades`, `spotTrades`, `tradesForCard` 변수 제거
  - `<CursorSidebar ... fills={...} />` 의 `fills` prop 제거

- `frontend/src/live/liveSidebarAdapters.ts`
  - `flattenTrades` 함수 + `LIVE_FILLTAPE_MAX` 상수 제거
  - 관련 imports (`Trade`, `RawSnapshot` 의 trade-side 사용) 정리

- `frontend/src/api/useCursor.ts`
  - `useTradesAroundCursor` 함수 제거

- `frontend/src/api/useLiveCursor.ts`
  - `useLiveTradesAroundCursor` 함수 제거 (Task 11 블록)

### Frontend — test cleanup

- `frontend/src/live/liveSidebarAdapters.test.ts` — `flattenTrades` describe 블록 제거
- `frontend/src/api/useCursor.test.tsx` — `useTradesAroundCursor` 테스트 케이스 제거
- `frontend/src/api/useLiveCursor.test.ts` — `useLiveTradesAroundCursor` describe 제거
- `frontend/src/live/LiveSidebar.test.tsx` — `useLiveTradesAroundCursor` mock 제거, `card-fills` assertion 제거
- `frontend/src/live/LivePage.test.tsx` — `useLiveTradesAroundCursor` mock 제거
- `frontend/src/replay/Workarea.test.tsx` — 영향 검토 (CursorSidebar는 stub 이지만 mock signature 확인)

### Backend — modify

- `hoga/api/routes.py`
  - `@router.get("/trades", response_model=TradesResponse)` 핸들러 (`def trades(...)`) 제거
  - `TradesResponse` import 제거
  - 사용처 없어진 `trades_tbl.query_up_to`, `trades_tbl.query_range` import — 다른 사용처 없으면 함께 정리

- `hoga/api/models.py`
  - `TradesResponse` 클래스 제거
  - `from hoga.tables.trades import ApiTrade` — 다른 사용처가 있으면 유지, 없으면 제거

- `hoga/tables/trades.py`
  - `query_up_to`, `query_range` — 다른 사용처가 있는지 확인 후 결정. capture pipeline은 별도 write 경로이므로 query 헬퍼 사용 안 함 가능성 높음. dead라면 제거.

### Backend — test cleanup

- `tests/test_api_validation.py:25` 의 `/api/trades?t=0` 검증 케이스 제거 (또는 case 리스트에서 빼기)
- 그 외 `hoga/api/` 하위의 `/api/trades` 라우트 테스트 (있다면) 제거

### Stale-comment cleanup (plan stage)

다음은 dead가 된 `/api/trades` 를 가리키는 comment-only 참조다. 실행 단계에서 함께 정리한다:

- `frontend/src/util/time.ts:101` — JSDoc 의 "spot-data queries (/api/orderbook, /api/trades)" 에서 trades 토큰 제거
- `frontend/src/chart/ChartStage.tsx:282` — 과거 architecture comment 안의 `/api/trades` 참조 제거
- `hoga/api/queries.py:75` — historical incident 코멘트 안의 `/api/trades` 참조 제거 또는 재서술

## Data flow after change

```
/live page:
  useLiveSeries(code) → { ob, trade, broker }
                          │      │       │
                          │      │       └─→ BrokerTrajectoryTable (사이드바 거래원 카드)
                          │      │
                          │      └─→ bucketHogaSeries → fillStrengthPoints → 차트 체결강도 pane
                          │              (UI 소비처 더 이상 없음 — sidebar 체결 카드 삭제됨)
                          │
                          └─→ OrderbookTable (사이드바 10호가 카드)

/replay page:
  useOrderbookAtCursor → OrderbookTable (사이드바 10호가)
  useBrokerSeriesForDay → BrokerTrajectoryTable (사이드바 거래원)
  (체결 카드 슬롯과 useTradesAroundCursor 호출 사라짐)
```

## Testing strategy

1. **빨강 → 초록 단계** — `FillTape.test.tsx`, `flattenTrades` 테스트, `useTradesAroundCursor*` 테스트, `card-fills` assertions 가 삭제되어 테스트 스위트가 그대로 통과해야 한다 (테스트가 사라지는 것이지 실패하는 게 아님).
2. **회귀 방지** — `LivePage.test.tsx` 와 `LiveSidebar.test.tsx` 가 `card-orderbook` 과 `card-brokers` testId 존재를 계속 검증함을 확인.
3. **차트 체결강도 회귀 방지** — `bucketHogaSeries.test.ts` 의 `fillStrengthPoints` 테스트가 계속 통과함을 확인. `useLiveSeries.test.tsx` 의 `trade` hydration 테스트도 유지.
4. **검증 게이트** — `uv run pytest` (백엔드 전체) + `cd frontend && npm run build` 둘 다 통과.
5. **수동 QA** — `/browse` 로 `http://localhost:5173/live` 와 `http://localhost:5173/replay` 열어서 (a) 체결 카드 부재 (b) 10호가/거래원 카드 정상 (c) 차트 체결강도 pane 정상 확인.

## Risk and rollback

- **Grid reflow 시각 회귀**: 10호가의 `minmax(624px,2fr)` 가 유지되므로 dominant pane 높이는 변하지 않는다. 거래원이 freed 공간을 흡수하는 형태이므로 사용자 인지 모델에 큰 충격 없음. 시각 spot-check 권장.
- **백엔드 외부 클라이언트**: `/api/trades` 를 외부에서 호출하는 클라이언트는 없다고 가정 (내부 frontend 전용 API). 만약 있다면 deprecation 경로가 필요하지만, 이 spec은 그 가정 아래에서 진행한다.
- **롤백**: 본 spec은 순수 삭제이므로 git revert 한 번이면 완전 복구된다. 단계적 머지 불필요.

## Decisions made during brainstorming

- 차트 체결강도(FillStrength) pane은 **유지** (사용자 확인).
- 백엔드 `/api/trades` 엔드포인트는 **이번 PR에서 함께 제거** (사용자 선택, dead code 최소화).
- `/live` 와 `/replay` **양쪽에서** 체결 카드 삭제 (사용자 확인).

## Related decisions

- **ADR-0047** (`docs/adr/0047-remove-fills-sidebar-card.md`) — 본 spec의 결정을 ADR로 기록. ADR-0023 / ADR-0044 의 "three cards" 인용이 stale 임을 명시.
- **CONTEXT.md** "Cursor Sidebar" 항목 — 2-card 정의로 갱신됨.

## Open questions

없음. 모든 명확화 완료.
