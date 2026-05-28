# 체결 사이드바 카드 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: both    # frontend + backend
spec: docs/superpowers/specs/2026-05-28-remove-fills-sidebar-card-design.md
adr: docs/adr/0047-remove-fills-sidebar-card.md
```

**Goal:** Remove the "체결" sidebar card and all its dead code (frontend component, hooks, adapters, backend REST route, models, tests) from `/live` and `/replay`. Keep the chart's FillStrength indicator pane intact.

**Architecture:** Top-down deletion in 4 commits — UI shell first (so `useTradesAroundCursor*` hooks become unused), then frontend hooks + adapters, then backend route, then stale-comment cleanup. Each commit leaves `npm run build` and `uv run pytest` green so bisecting stays useful.

**Tech Stack:** React + Vite + Vitest (frontend), FastAPI + pytest (backend). No new dependencies; this is pure deletion.

---

## File Structure

### Files deleted

| Path | Reason |
|---|---|
| `frontend/src/sidebar/FillTape.tsx` | 체결 카드 본체 컴포넌트 |
| `frontend/tests/component/FillTape.test.tsx` | FillTape 단위 테스트 |

### Files modified

**Frontend**

| Path | Change |
|---|---|
| `frontend/src/sidebar/CursorSidebar.tsx` | `fills` prop, 체결 카드 섹션, FillTape import, `useTradesAroundCursor` 호출 제거. grid를 3행 → 2행으로 reflow. |
| `frontend/src/live/LiveSidebar.tsx` | FillTape import + 모든 trade 변수 + `fills` prop 전달 제거. |
| `frontend/src/live/liveSidebarAdapters.ts` | `flattenTrades`, `LIVE_FILLTAPE_MAX` 제거. |
| `frontend/src/live/liveSidebarAdapters.test.ts` | `flattenTrades` describe 블록 제거. |
| `frontend/src/api/useCursor.ts` | `useTradesAroundCursor` 함수 제거. |
| `frontend/src/api/useLiveCursor.ts` | `useLiveTradesAroundCursor` 함수 + 관련 도큐 코멘트 제거. |
| `frontend/src/api/useLiveCursor.test.ts` | `useLiveTradesAroundCursor` describe 제거. |
| `frontend/src/live/LiveSidebar.test.tsx` | `useLiveTradesAroundCursor` mock 제거. |
| `frontend/src/live/LivePage.test.tsx` | `useLiveTradesAroundCursor` mock 제거. |
| `frontend/src/util/time.ts:101` | JSDoc 안의 `/api/trades` 토큰 제거. |
| `frontend/src/chart/ChartStage.tsx:282` | 역사적 코멘트의 `/api/trades` 참조 제거/재서술. |

**Backend**

| Path | Change |
|---|---|
| `hoga/api/routes.py` | `@router.get("/trades")` 라우트 핸들러 + `TradesResponse` import 제거. |
| `hoga/api/models.py` | `TradesResponse` 클래스 + (다른 사용처 없으면) `ApiTrade` import 제거. |
| `hoga/tables/trades.py` | `query_up_to`, `query_range` 제거 (routes.py 가 유일 caller — Task 3 step 1 에서 확인). |
| `tests/test_api_validation.py:25` | endpoint 파라미터 리스트에서 `/api/trades?t=0` 제거. |
| `hoga/api/queries.py:75` | 역사적 incident 코멘트에서 `/api/trades` 참조 제거/재서술. |

### Files NOT touched (intentionally)

- `frontend/src/chart/projectors/fillStrength.ts` — 차트 체결강도 pane projector (별개 시각화)
- `frontend/src/chart/util/zeroBaseline.ts` — Cumulative Net Fill 라인이 사용
- `frontend/src/live/bucketHogaSeries.ts`, `buildLiveBundle.ts` — `trade` SSE 입력을 `fillStrengthPoints` 로 변환 (차트에 필요)
- `frontend/src/api/types.ts` 의 `Trade`, `ApiTrade` — capture/SSE 에서 계속 사용
- `hoga/tables/trades.py` 의 `ApiTrade` 클래스 / `_row_to_api` — capture pipeline 에서 계속 사용 (단 `query_*` 헬퍼는 삭제)
- `hoga/api/sse.py` — `trade` 이벤트 emitter (차트가 소비)
- 과거 spec 파일들 (`docs/superpowers/specs/2026-05-22-*`, `2026-05-23-*` 등) — historical record

---

## Task 1: Frontend UI shell — Remove 체결 card from CursorSidebar + LiveSidebar

**Goal:** `/live` 와 `/replay` 사이드바에 카드가 2개만 보이도록 만든다. FillTape 파일과 테스트도 함께 삭제. 이 task가 끝나면 hook들은 `import` 되지 않고 dead가 되지만 아직 정의는 남아있다.

**Files:**
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`
- Modify: `frontend/src/live/LivePage.test.tsx`
- Delete: `frontend/src/sidebar/FillTape.tsx`
- Delete: `frontend/tests/component/FillTape.test.tsx`

### Step 1.1 — Snapshot baseline test result

- [ ] 현재 frontend 테스트 스위트가 깨끗하게 통과하는지 확인 (이후 회귀 식별 기준).

Run:
```bash
cd frontend && npm test -- --run 2>&1 | tail -20
```

Expected: 모든 테스트 PASS.

### Step 1.2 — Rewrite CursorSidebar.tsx

- [ ] `frontend/src/sidebar/CursorSidebar.tsx` 전체를 아래 내용으로 교체.

```tsx
import { type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerTrajectoryTable from './BrokerTrajectoryTable';
import TotalQtyBar from './TotalQtyBar';
import {
  useOrderbookAtCursor,
  useCursor,
} from '../api/useCursor';
import { useBrokerSeriesForDay } from '../api/brokerSeries';
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import type { VirtualAxis } from '../util/virtualAxis';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
};

/**
 * Connected variant for /replay. Binds 10호가 (cursor-anchored, useSpot) and
 * 거래원 (day-anchored, react-query) to their respective hooks. The 체결 card
 * was removed 2026-05-28 (see ADR-0047) — the chart's 체결강도 pane provides
 * equivalent information in a more compact visualization.
 */
export function CursorSidebarConnected({ axis }: { axis: VirtualAxis }) {
  const orderbook = useOrderbookAtCursor();
  const { code, date, cursorMs } = useCursor();
  const { data, isLoading } = useBrokerSeriesForDay(code, date);
  // undefined = loading, null = fetched-empty, value = data. Matches the
  // useSpot contract that OrderbookTable consumes so the two cards present
  // consistent loading/empty states.
  const series = isLoading ? undefined : (data?.brokers ?? null);
  const maskRatio = useAuctionMaskActive(axis);

  return (
    <CursorSidebar
      orderbook={
        <>
          <OrderbookTable snapshot={orderbook} />
          <TotalQtyBar snapshot={orderbook} maskRatio={maskRatio} />
        </>
      }
      brokers={<BrokerTrajectoryTable series={series} cursorMs={cursorMs} />}
    />
  );
}

export default function CursorSidebar({ orderbook, brokers }: Props) {
  return (
    <aside
      id="replay-sidebar"
      className="grid grid-rows-[minmax(624px,2fr)_1fr] gap-2 p-2 bg-bg h-full min-h-0"
    >
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
    </aside>
  );
}

function SidebarCard({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-card={testId.replace(/^card-/, '')}
      className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
    >
      <header className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
        {label}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">—</div>;
}
```

Key diffs from before:
- `FillTape` import 제거
- `useTradesAroundCursor` import 제거 (이 hook은 Task 2 에서 함수 자체를 제거)
- `Props.fills` 제거
- `CursorSidebarConnected` 의 `useTradesAroundCursor()` 호출 + `fills={<FillTape trades={trades} />}` 제거
- `<aside>` grid: `grid-rows-[minmax(624px,2fr)_1.4fr_1fr]` → `grid-rows-[minmax(624px,2fr)_1fr]`
- 체결 `SidebarCard` 섹션 제거
- 컴포넌트 도큐 코멘트는 ADR-0047 참조

### Step 1.3 — Edit LiveSidebar.tsx

- [ ] `frontend/src/live/LiveSidebar.tsx` 에서 다음 4개 영역을 정확히 편집.

Edit A — imports (라인 1~22):

```tsx
import { useMemo } from 'react';
import CursorSidebar from '../sidebar/CursorSidebar';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import { useLiveSeries } from '../api/liveSeries';
import {
  aggregateBrokerSeries,
  latestOrderbookSnapshot,
} from './liveSidebarAdapters';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import { useLivePageStore } from '../state/livePage';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
} from '../api/useLiveCursor';
import type { MinuteTimeframe } from '../state/livePage';
import { isMinuteTimeframe } from '../state/livePage';
```

Diff vs. current:
- `FillTape` import 제거
- `flattenTrades` import 제거
- `useLiveTradesAroundCursor` import 제거

Edit B — useLiveSeries destructure (around line 47): 변경 없음 (`trade` 는 여전히 destructure에서 추출되지만 fillStrength 차트가 사용 — wait, 실제로 LiveSidebar 본문에서 `trade` 가 더 이상 필요 없으므로 destructure에서도 빼야 한다). 정확한 변경:

```tsx
  // Latest-mode data (always subscribed — useSpot hooks in spot mode
  // sit dormant when cursorMs is null, no extra fetches).
  const { ob, broker } = useLiveSeries(code ?? '');
  const latestOrderbook = useMemo(() => latestOrderbookSnapshot(ob), [ob]);
  const latestBrokerSeries = useMemo(() => aggregateBrokerSeries(broker), [broker]);
  const latestBrokerTs =
    broker.length > 0 ? (broker[broker.length - 1].t_ms as number) : Date.now();
```

Diff:
- `const { ob, trade, broker } = useLiveSeries(...)` → `const { ob, broker } = useLiveSeries(...)` (trade destructure 제거 — `useLiveSeries` 가 trade 이벤트를 내부적으로 처리하지만 LiveSidebar 는 더 이상 그 배열을 직접 읽지 않는다)
- `const latestTrades = useMemo(() => flattenTrades(trade), [trade]);` 라인 제거

> ⚠️ **검증**: 차트의 fillStrength pane이 `useLiveSeries.trade` 를 어떻게 받는지 확인. 만약 차트가 동일한 `useLiveSeries(code)` 호출의 `trade` 배열을 직접 받는다면, 차트 컴포넌트에서 그 destructure는 그대로 유지된다 (이 task는 LiveSidebar.tsx 만 건드림). React-query / Zustand cache로 흐른다면 destructure 위치와 무관하게 동일 데이터.

확인 명령:

```bash
grep -n "useLiveSeries" frontend/src/live/ frontend/src/chart/ -r
```

Expected: `useLiveSeries(code)` 가 차트 쪽에서 별도 호출됨 (`useLiveBundle` 또는 차트 stage 진입점). LiveSidebar 의 destructure 변경은 차트에 영향 없음.

Edit C — Spot-mode block (around line 54~58):

```tsx
  // Spot-mode data (dormant when cursorMs null).
  const spotTimeframe: MinuteTimeframe | null =
    timeframe && isMinuteTimeframe(timeframe) ? timeframe : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code, timeframe: spotTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code });
```

Diff:
- `const spotTrades = useLiveTradesAroundCursor({ code, timeframe: spotTimeframe });` 제거

Edit D — Branch + JSX (around line 68~123):

```tsx
  // Branch on spot vs latest.
  const spotSnap = spotOrderbook?.snapshot ?? null;
  const spotAvailableFrom = spotOrderbook?.available_from ?? null;
  const orderbookForCard = isSpot ? spotSnap : latestOrderbook;
  const brokerSeriesForCard = isSpot
    ? spotBrokers
    : (broker.length === 0 ? undefined : latestBrokerSeries);
  const brokerCursorMs = cursorMs ?? latestBrokerTs;

  // T14b: "다음 가용: HH:MM" hint above orderbook table when spot orderbook
  // has no snapshot yet but backend knows when the first row arrives.
  const showAvailableHint =
    isSpot && spotOrderbook !== undefined && spotSnap === null && spotAvailableFrom !== null;

  return (
    <div
      data-testid="live-sidebar"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
      }}
    >
      <SidebarHeader cursorMs={cursorMs} latestOrderbookTs={latestOrderbook?.ts_ms ?? null} />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CursorSidebar
          orderbook={
            <>
              {showAvailableHint && (
                <div
                  data-testid="orderbook-available-hint"
                  style={{
                    padding: 'var(--space-xs) var(--space-md)',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--fg-dimmer)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  다음 가용: {formatTime(spotAvailableFrom!)}
                </div>
              )}
              <OrderbookTable snapshot={orderbookForCard} />
              <TotalQtyBar snapshot={orderbookForCard} maskRatio={maskRatio} />
            </>
          }
          brokers={
            <BrokerTrajectoryTable series={brokerSeriesForCard} cursorMs={brokerCursorMs} />
          }
        />
      </div>
    </div>
  );
```

Diff:
- `tradesForCard` 변수 제거
- `<CursorSidebar ... fills={<FillTape trades={tradesForCard} />} />` 의 `fills` prop 제거
- 컴포넌트 헤더 코멘트 (29 라인 부근) "three cards (10호가 / 거래원 / 체결)" → "two cards (10호가 / 거래원)" 로 갱신, ADR-0047 참조 추가

Edit E — 컴포넌트 헤더 코멘트 (라인 28~39):

```tsx
/**
 * Live Sidebar — two cards (10호가 / 거래원) wired to live data.
 *
 * Reuses the existing CursorSidebar layout shell from /replay so visual
 * parity is automatic. The data wiring differs:
 *   - /replay uses cursor-keyed REST hooks (useCursor, useBrokerSeriesForDay)
 *   - /live uses useLiveSeries (initial REST + SSE) in latest mode
 *   - /live uses useLiveCursor hooks in spot mode (cursor set via hover)
 *
 * Per ADR-0044 and Design C1: header toggles between LIVE● pulse (latest
 * mode) and "과거 시점" + pinned timestamp (spot mode) when cursor is set.
 *
 * The third "체결" card was removed 2026-05-28 (ADR-0047). The chart's
 * 체결강도 pane provides equivalent information in compact form.
 */
```

### Step 1.4 — Update LiveSidebar.test.tsx mocks

- [ ] `frontend/src/live/LiveSidebar.test.tsx` 의 mocks 정리.

다음 3종 변경:

1. 라인 22 의 `useLiveTradesAroundCursor: vi.fn(() => undefined),` 항목을 mock 객체에서 제거.
2. 라인 45, 80, 159 의 `(cursorHooks.useLiveTradesAroundCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);` 호출 3건을 제거.
3. (있다면) `card-fills` testId 를 검증하는 assertion 제거. 검색:

```bash
grep -n "card-fills" frontend/src/live/LiveSidebar.test.tsx
```

해당 라인이 있으면 그 expect 문 제거. `card-orderbook` / `card-brokers` assertion 은 유지.

### Step 1.5 — Update LivePage.test.tsx mocks

- [ ] `frontend/src/live/LivePage.test.tsx` 라인 38 의 `useLiveTradesAroundCursor: () => undefined,` 항목을 mock 객체에서 제거. `card-fills` testId assertion 이 있으면 함께 제거.

```bash
grep -n "card-fills" frontend/src/live/LivePage.test.tsx
```

### Step 1.6 — Delete FillTape files

- [ ] FillTape 컴포넌트와 그 테스트를 삭제.

```bash
rm frontend/src/sidebar/FillTape.tsx
rm frontend/tests/component/FillTape.test.tsx
```

### Step 1.7 — Run frontend tests + build

- [ ] frontend 검증.

Run:
```bash
cd frontend && npm test -- --run 2>&1 | tail -20
```

Expected: 모든 테스트 PASS. 만약 typecheck 에러로 `useTradesAroundCursor` / `useLiveTradesAroundCursor` 미사용 import 경고가 나오면 무시 (Task 2 에서 함수 자체 제거 — 현재는 정의는 살아있고 사용처만 없는 상태).

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: 빌드 성공. TypeScript 미사용 import 에러가 발생하면 임시로 해당 import 라인을 정리 (이미 step 1.2~1.3 에서 정리되었어야 함).

### Step 1.8 — Commit

- [ ] 변경사항 커밋.

```bash
git add frontend/src/sidebar/CursorSidebar.tsx \
        frontend/src/sidebar/FillTape.tsx \
        frontend/tests/component/FillTape.test.tsx \
        frontend/src/live/LiveSidebar.tsx \
        frontend/src/live/LiveSidebar.test.tsx \
        frontend/src/live/LivePage.test.tsx
git commit -m "$(cat <<'EOF'
feat(sidebar): /live /replay 체결 카드 제거 (UI shell)

CursorSidebar grid를 3행 → 2행 (minmax(624px,2fr)_1fr) 으로 reflow.
FillTape 컴포넌트와 단위 테스트 삭제. LiveSidebar/LivePage 테스트의
useLiveTradesAroundCursor mock 정리. 데이터 hook 정의는 Task 2 에서 제거.

Refs: ADR-0047, docs/superpowers/specs/2026-05-28-remove-fills-sidebar-card-design.md
EOF
)"
```

---

## Task 2: Frontend — Remove trade hooks + adapter

**Goal:** Task 1 에서 호출처가 사라진 frontend hook들과 어댑터 함수를 제거.

**Files:**
- Modify: `frontend/src/api/useCursor.ts`
- Modify: `frontend/src/api/useLiveCursor.ts`
- Modify: `frontend/src/api/useLiveCursor.test.ts`
- Modify: `frontend/src/live/liveSidebarAdapters.ts`
- Modify: `frontend/src/live/liveSidebarAdapters.test.ts`

### Step 2.1 — Verify hooks are now unused

- [ ] Task 1 적용 후 hook들이 실제 dead 인지 확인.

```bash
grep -rn "useTradesAroundCursor\|useLiveTradesAroundCursor\|flattenTrades\|LIVE_FILLTAPE_MAX" frontend/src/ 2>&1
```

Expected output: 정의 파일 (`useCursor.ts`, `useLiveCursor.ts`, `liveSidebarAdapters.ts`) 자기 자신과 각 테스트 파일에서만 매치되어야 함. 다른 모듈에서 import 하는 곳이 있으면 Task 1 적용이 누락된 것 — 그 파일을 수정한 뒤 이 step 다시 실행.

### Step 2.2 — Delete useTradesAroundCursor from useCursor.ts

- [ ] `frontend/src/api/useCursor.ts` 의 라인 91~115 부근 `export function useTradesAroundCursor(...)` 전체 + 그 직전 코멘트 (라인 88~90 부근의 "FillTape의 last N at-or-before T semantic" 류) 를 제거.

확인:
```bash
grep -n "useTradesAroundCursor\|FillTape" frontend/src/api/useCursor.ts
```

Expected: 매치 0건.

### Step 2.3 — Delete useLiveTradesAroundCursor from useLiveCursor.ts

- [ ] `frontend/src/api/useLiveCursor.ts` 의 `// ─── Task 11: useLiveTradesAroundCursor ───` 섹션 (라인 102 부근부터 함수 끝까지) 전체 제거. 라인 38 의 도큐 코멘트 (`useLiveOrderbookAtCursor and useLiveTradesAroundCursor`) 도 `useLiveOrderbookAtCursor` 만 남도록 갱신.

확인:
```bash
grep -n "useLiveTradesAroundCursor\|FillTape" frontend/src/api/useLiveCursor.ts
```

Expected: 매치 0건.

### Step 2.4 — Delete useLiveTradesAroundCursor tests

- [ ] `frontend/src/api/useLiveCursor.test.ts` 의 `// ─── Task 11: useLiveTradesAroundCursor ───` describe 블록 (라인 135~165 부근) 전체 제거. 파일 상단 import 의 `useLiveTradesAroundCursor` 도 제거.

확인:
```bash
grep -n "useLiveTradesAroundCursor" frontend/src/api/useLiveCursor.test.ts
```

Expected: 매치 0건.

### Step 2.5 — Delete flattenTrades + LIVE_FILLTAPE_MAX from adapters

- [ ] `frontend/src/live/liveSidebarAdapters.ts` 에서:
  - `LIVE_FILLTAPE_MAX` 상수 + 그 위 도큐 코멘트 (라인 103~109) 제거
  - `flattenTrades` 함수 + 도큐 코멘트 (라인 113~152) 제거
  - 파일 상단에서 더 이상 쓰이지 않는 import 정리 (`Trade` 타입 import 가 다른 곳에서 쓰이는지 확인 — `aggregateBrokerSeries` / `latestOrderbookSnapshot` 가 Trade 를 안 쓰면 제거)

확인:
```bash
grep -n "flattenTrades\|LIVE_FILLTAPE_MAX\|FillTape" frontend/src/live/liveSidebarAdapters.ts
```

Expected: 매치 0건.

### Step 2.6 — Delete flattenTrades tests

- [ ] `frontend/src/live/liveSidebarAdapters.test.ts` 의 `describe('flattenTrades', ...)` 블록 (라인 107~139) 전체 제거. 파일 상단 import 에서 `flattenTrades` 도 제거.

확인:
```bash
grep -n "flattenTrades" frontend/src/live/liveSidebarAdapters.test.ts
```

Expected: 매치 0건.

### Step 2.7 — Run frontend tests + build

- [ ] 검증.

```bash
cd frontend && npm test -- --run 2>&1 | tail -20
```

Expected: 모든 테스트 PASS.

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: 빌드 성공, 미사용 import 경고 0건.

### Step 2.8 — Commit

- [ ] 커밋.

```bash
git add frontend/src/api/useCursor.ts \
        frontend/src/api/useLiveCursor.ts \
        frontend/src/api/useLiveCursor.test.ts \
        frontend/src/live/liveSidebarAdapters.ts \
        frontend/src/live/liveSidebarAdapters.test.ts
git commit -m "$(cat <<'EOF'
refactor(frontend): drop dead 체결 hooks + adapter

useTradesAroundCursor (replay), useLiveTradesAroundCursor (live),
flattenTrades, LIVE_FILLTAPE_MAX — all callers removed in prior commit.

Refs: ADR-0047
EOF
)"
```

---

## Task 3: Backend — Remove /api/trades route

**Goal:** `/api/trades` 엔드포인트 + `TradesResponse` 모델 + 전용 query 헬퍼 삭제. capture pipeline 이 사용하는 `ApiTrade` 와 `_row_to_api` 는 유지.

**Files:**
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/models.py`
- Modify: `hoga/tables/trades.py`
- Modify: `tests/test_api_validation.py`

### Step 3.1 — Verify trades-route is the only caller of query_up_to / query_range

- [ ] dead code 범위 확인.

```bash
grep -rn "query_up_to\|query_range" hoga/ tests/ --include="*.py" 2>&1
```

Expected: `hoga/api/routes.py` 의 라인 156, 164 (route 핸들러 내부) 와 `hoga/tables/trades.py` 의 정의부 (라인 281, 291) 만 매치. 다른 caller가 있으면 `query_*` 헬퍼는 유지하고 spec/plan 갱신 필요.

### Step 3.2 — Remove trades route from routes.py

- [ ] `hoga/api/routes.py` 에서 다음을 제거:
  - 라인 140~170 의 `@router.get("/trades", response_model=TradesResponse)` 핸들러 전체
  - 상단 import 의 `TradesResponse` (라인 21 부근)
  - 상단 import 의 `trades_tbl` (있다면 다른 곳에서 안 쓰이는 경우)

확인:
```bash
grep -n "trades\|TradesResponse" hoga/api/routes.py
```

Expected: 매치 0건 (또는 unrelated trades 단어, 예: 코멘트). `TradesResponse` 와 `@router.get("/trades")` 매치는 0이어야 함.

### Step 3.3 — Remove TradesResponse from models.py

- [ ] `hoga/api/models.py` 에서:
  - `TradesResponse` 클래스 (라인 73~74) 제거
  - `from hoga.tables.trades import ApiTrade` (라인 15) — 다른 모델에서 사용 여부 확인:
    ```bash
    grep -n "ApiTrade" hoga/api/models.py
    ```
    매치가 라인 15 import 와 73~74 (TradesResponse) 만이면 import 도 함께 제거.

확인:
```bash
grep -n "TradesResponse" hoga/api/models.py
```

Expected: 매치 0건.

### Step 3.4 — Remove query_up_to + query_range from tables/trades.py

- [ ] Step 3.1 에서 caller 가 routes.py 뿐임을 확인했으면, `hoga/tables/trades.py` 에서:
  - `query_up_to` 함수 (라인 281 부근) 제거
  - `query_range` 함수 (라인 291 부근) 제거
  - 두 함수 위의 `# === Query (returns ApiTrade directly — no intermediate dict) ===` 헤더 코멘트 (라인 246) 와 `_row_to_api` 헬퍼 — 이 헬퍼는 두 함수가 유일한 caller 인지 확인:
    ```bash
    grep -n "_row_to_api" hoga/tables/trades.py
    ```
    매치가 정의부 + query_* 안에서만이면 `_row_to_api` 도 함께 제거. 다른 곳 (예: capture write path) 에서 쓰이면 유지.

확인:
```bash
grep -n "query_up_to\|query_range" hoga/tables/trades.py
```

Expected: 매치 0건.

### Step 3.5 — Remove /api/trades from validation test

- [ ] `tests/test_api_validation.py` 라인 25 의 `"/api/trades?t=0",` 항목을 endpoint 파라미터 리스트에서 제거.

수정 전:
```python
@pytest.mark.parametrize(
    "endpoint",
    [
        "/api/meta",
        "/api/orderbook?t=0",
        "/api/trades?t=0",
        "/api/candles",
    ],
)
```

수정 후:
```python
@pytest.mark.parametrize(
    "endpoint",
    [
        "/api/meta",
        "/api/orderbook?t=0",
        "/api/candles",
    ],
)
```

### Step 3.6 — Check for other /api/trades tests

- [ ] route-specific 테스트가 따로 있는지 확인.

```bash
grep -rln "/api/trades\|api/trades" tests/ hoga/ --include="*.py" 2>&1
```

Expected: 라인 코멘트 (`hoga/api/queries.py`, `hoga/api/sources.py`) 외에 actual test code 매치 없음. 만약 별도 테스트 파일 (`tests/test_trades_route.py` 등) 이 있다면 함께 제거.

### Step 3.7 — Run backend tests

- [ ] 검증.

```bash
uv run pytest 2>&1 | tail -30
```

Expected: 모든 테스트 PASS. 만약 import error (`cannot import TradesResponse` 류) 가 나면 step 3.2~3.4 가 누락한 reference 가 있으므로 grep 으로 찾아 제거:

```bash
grep -rn "TradesResponse\|query_up_to\|query_range" hoga/ tests/ --include="*.py" 2>&1
```

### Step 3.8 — Commit

- [ ] 커밋.

```bash
git add hoga/api/routes.py \
        hoga/api/models.py \
        hoga/tables/trades.py \
        tests/test_api_validation.py
git commit -m "$(cat <<'EOF'
refactor(api): drop /api/trades route, TradesResponse, trade query helpers

Frontend dropped its consumers in prior commits. Capture pipeline keeps
ApiTrade + _row_to_api (writes parquet rows); the query helpers were
read-path only and now have no callers.

Refs: ADR-0047
EOF
)"
```

---

## Task 4: Stale-comment cleanup

**Goal:** `/api/trades` 가 사라진 후에도 prose 안에 남는 stale 참조를 정리. 4개 파일, 모두 코멘트 한 줄 단위 수정.

**Files:**
- Modify: `frontend/src/util/time.ts:101`
- Modify: `frontend/src/chart/ChartStage.tsx:282`
- Modify: `hoga/api/queries.py:75`
- Modify: `hoga/api/sources.py:5`

### Step 4.1 — Identify exact comment lines

- [ ] 각 파일의 stale 라인 컨텍스트를 읽고 정확한 수정 문구 결정.

```bash
sed -n '99,105p' frontend/src/util/time.ts
sed -n '278,286p' frontend/src/chart/ChartStage.tsx
sed -n '72,80p' hoga/api/queries.py
sed -n '1,10p' hoga/api/sources.py
```

### Step 4.2 — Edit frontend/src/util/time.ts

- [ ] 라인 101 부근의 JSDoc 에서 `/api/trades` 토큰 제거. 현재:
  ```ts
   * cursor so spot-data queries (/api/orderbook, /api/trades)
  ```
  → :
  ```ts
   * cursor so spot-data queries (/api/orderbook)
  ```

### Step 4.3 — Edit frontend/src/chart/ChartStage.tsx

- [ ] 라인 282 부근의 역사적 코멘트 (`via useCursor + a fresh /api/trades fetch (before this commit). At`) 에서 `/api/trades` 참조를 일반화하거나 코멘트 자체가 stale 이면 제거. 정확한 처리는 라인 context 에 달림 — Step 4.1 에서 읽은 후 결정. 권장: `/api/trades fetch` → `a trade fetch` (역사적 서술의 디테일은 그대로 두되 죽은 엔드포인트 이름은 일반어로).

### Step 4.4 — Edit hoga/api/queries.py

- [ ] 라인 75 부근의 incident 코멘트 (`/api/trades requests killed the server`) 에서 `/api/trades` 를 일반어로 바꾸거나 코멘트가 더 이상 의미 없으면 제거. 코멘트 자체는 cursor() 호출 패턴 설명이므로 유지하되 endpoint 이름을 일반화: `/api/trades` → `read-path` 또는 `trade-row queries`.

### Step 4.5 — Edit hoga/api/sources.py

- [ ] 라인 5 부근의 모듈 docstring 안에서 `/api/trades` 참조 제거. 현재:
  ```python
  /api/trades, /api/brokers/series) can honor `?source_pref=` without
  ```
  → :
  ```python
  /api/brokers/series) can honor `?source_pref=` without
  ```

### Step 4.6 — Verify no remaining /api/trades references

- [ ] 전체 repo에서 `/api/trades` 가 사라졌는지 확인.

```bash
grep -rn "/api/trades\|api/trades" --include="*.py" --include="*.ts" --include="*.tsx" 2>&1
```

Expected: 매치 0건 (또는 docs/superpowers/specs/* 안의 historical spec 만 — 그쪽은 frozen).

### Step 4.7 — Run full test suite

- [ ] 코멘트 변경이 어떤 테스트도 깨지 않는지 마지막 확인.

```bash
uv run pytest 2>&1 | tail -10
cd frontend && npm test -- --run 2>&1 | tail -10
cd frontend && npm run build 2>&1 | tail -10
```

Expected: 모두 PASS / 빌드 성공.

### Step 4.8 — Commit

- [ ] 커밋.

```bash
git add frontend/src/util/time.ts \
        frontend/src/chart/ChartStage.tsx \
        hoga/api/queries.py \
        hoga/api/sources.py
git commit -m "$(cat <<'EOF'
chore: drop stale /api/trades references in comments

Endpoint was removed in prior commit. Comments referencing it are
either generalized or trimmed — historical context preserved without
the dead identifier.

Refs: ADR-0047
EOF
)"
```

---

## Task 5: Manual QA on dev servers

**Goal:** 시각적 회귀가 없는지 실제 브라우저에서 spot-check.

### Step 5.1 — Start dev servers

- [ ] backend (백그라운드):

```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

- [ ] frontend (별도 터미널, 백그라운드):

```bash
cd frontend && npm run dev
```

서버 기동 확인:
```bash
curl -s http://127.0.0.1:8000/api/events | head -5
```

### Step 5.2 — Verify /live page

- [ ] `/browse` skill 또는 직접 브라우저로 `http://localhost:5173/live` 접속.

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B snapshot -i | grep -E "card-orderbook|card-brokers|card-fills"
```

Expected: `card-orderbook` 과 `card-brokers` 매치. `card-fills` 매치 **0건**.

- [ ] 콘솔 에러 확인:

```bash
$B console --errors
```

Expected: 에러 없음.

- [ ] 차트 체결강도 pane 정상 동작 확인 (시각): 가격 차트 아래에 buy/sell 막대 히스토그램 + Cumulative Net Fill 라인이 보여야 함.

### Step 5.3 — Verify /replay page

- [ ] `/replay` 도 동일하게 확인.

```bash
$B goto http://localhost:5173/replay
$B snapshot -i | grep -E "card-orderbook|card-brokers|card-fills"
```

Expected: `card-orderbook`, `card-brokers` 매치. `card-fills` 매치 0건.

### Step 5.4 — Verify chart hover behavior on /live

- [ ] hover spot mode 가 정상 동작하는지 확인 (10호가 카드만 spot 데이터로 바뀌고 거래원은 day-anchored 유지).

```bash
$B snapshot -i
# 차트 영역 좌표 확인 후
$B hover -e <chart-element-ref>
$B snapshot -i | grep -E "live-sidebar-pulse|과거 시점"
```

Expected: 사이드바 헤더 라벨이 `LIVE` → `과거 시점` 으로 전환.

### Step 5.5 — Stop dev servers

- [ ] background process 정리. 정확한 PID 는 starting step 에서 확인.

---

## Self-Review checklist (작성 직후 1회)

- [x] Spec 의 모든 modify/delete 파일에 대응 task 존재 — Task 1 (UI 8개), Task 2 (hook+adapter 5개), Task 3 (backend 4개), Task 4 (comment 4개).
- [x] Spec 이 "stale-comment cleanup" 을 plan 단계로 이월 — Task 4 가 명시.
- [x] Spec 이 `tests/test_api_validation.py:25` 명시 — Task 3 Step 3.5 가 처리.
- [x] No placeholder 검사 — 모든 step에 구체 명령/코드/예상 출력 포함.
- [x] 타입/이름 일관성 — `useTradesAroundCursor`, `useLiveTradesAroundCursor`, `flattenTrades`, `TradesResponse`, `LIVE_FILLTAPE_MAX` 명칭이 전체 plan 에서 동일.
- [x] Grid 변경 한 곳에서만 발생 — Task 1 Step 1.2 (CursorSidebar.tsx). LiveSidebar 는 grid 안 건드림.
- [x] 차트 체결강도 pane 영향 차단 — Task 1 Edit B 의 ⚠️ 검증 노트 + Task 5 Step 5.2 의 시각 확인 (이중 안전망).

## Deferred review notes

(없음 — 단계 4 review 후 채워질 자리.)
