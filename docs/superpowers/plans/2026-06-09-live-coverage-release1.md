# 출시1: /live 관심종목 커버리지 (미수집 배지 + 보는종목 REST 폴링) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 장중에 어느 종목을 열어도 호가·거래원·지표가 보이게 한다 — 미수집 배지로 상태를 명시하고, 보는 종목을 REST로 폴링해 데이터를 채운다. 2번째 계좌 없이 account 0(기존 15콜/초)만으로 동작.

**Architecture:** 프론트는 백엔드가 이미 emit하는 `live_set`을 소비해 3-state(실시간/저녁대기/미수집) 배지를 표시. 백엔드는 `/api/ws` 보는종목 신호를 받아 그 종목이 WS `live_set` 밖이면 그 종목만 REST 폴링(은퇴 때 지운 `fetch_orderbook`/`fetch_trades`/`fetch_brokers` 복원)→`writer.append`→`promote`→`kis_live` parquet. **`live_set` 멤버십이 "누가 그 종목을 수집하는가"의 단일 권위** — WS set 안이면 WS만, 밖이면 REST만(배타성). promote 시 혼합 JSONL 감지가 안전망.

**Tech Stack:** Python(pytest, httpx, polars), React/TypeScript(vitest, @testing-library), KIS REST TR `FHKST01010200`(호가)/`FHPST01060000`(체결)/`FHKST01010600`(거래원).

**관련 설계:** `docs/superpowers/specs/2026-06-09-live-watchlist-coverage-hybrid-design.md`, **ADR-0067**

> **Architecture 정정(Grill):** 위 Architecture 문장의 "REST 폴링→writer.append→promote→parquet"은 grill에서 뒤집혔다 — **REST는 `buffer.publish`로 화면 표시만, 디스크 저장 안 함**(저장은 WS만). 아래 Grill 갱신 우선.

---

## ⚠️ Grill 갱신 (2026-06-09) — 실행 시 **이 델타가 아래 태스크보다 우선** (ADR-0067)

grill-with-docs 리뷰 결과, 아래 원본 태스크에서 다음을 바꿔 실행한다:

1. **배지(Part A Task 2)** — `deriveCollectionStatus`를 4-state로: 시그니처 `(code, liveSet, watchlistCodes, viewedCodes)` →
   - `'realtime'` (code ∈ liveSet)
   - `'polling'` (code ∉ liveSet ∧ code ∈ viewedCodes) ← **신규, 이 모델의 주력 상태**
   - `'uncollected'` (그 외)
   - `'waiting_eod'` 는 watchlist>26 폴백에서만. `viewedCodes`는 현재 보는 종목(`activeCode`).
   Task 3(LiveStatusBar)·Task 4(WatchlistDrawer) 배지도 `polling` 케이스 포함.

2. **REST 폴러 = 화면 표시 전용, 저장 안 함 (Part B Task 3·4 변경)** —
   - Task 3(snapshot 빌더): `to_jsonl` 저장이 아니라 **LiveBuffer entry로 변환**(WS Live Tick과 동일 shape)해 `buffer.publish`. JSONL/promote 경로 미사용.
   - Task 4(`rest_poller`): `activeCode` 1종목(멀티탭이면 소수)을 **2초 주기** 폴링 → `buffer.publish`만. **`writer.append` 호출 없음.** ADR-0064 교훈 필수: 폴링 루프 try/except 격리 + 사망 감지 + 상태 정직 노출(거짓 health 금지). 테스트에 "루프 예외 시 태스크 안 죽고 상태 노출" 케이스 추가.

3. **배타(Part B Task 6)** — WS active 종목은 `set_excluded_codes`로 폴링 skip. 저장 충돌은 애초에 없음(REST 미저장)이라 안전망 부담 감소.

4. **Part C 삭제** — REST가 저장을 안 하므로 혼합 JSONL이 *생기지 않는다*. **Task C2(혼합 JSONL 감지) 제거.** Task C1(소스 회귀 검증)은 "WS 저장만, 변경 없음" 확인이라 선택(생략 가능).

5. **LiveSidebar 빈 패널 안내(self-review 보강1) 유지** — `uncollected` 종목에 "관심종목에 추가하면 실시간 수집" 안내.

> 원본 Part B Task 1·2(kis_models·kis_client REST 메서드 복원)와 Task 5(ws.py forward)·Task 6(lifecycle 통합)은 유효. 저장 경로만 buffer-publish로 바뀐다.

---

## File Structure

**Part A — 미수집 배지 (frontend, 백엔드 0):**
- Modify `frontend/src/api/liveStatus.ts` — `LiveStatus`에 `live_set: string[]` 추가
- Create `frontend/src/live/collectionStatus.ts` — 3-state 파생 순수함수
- Modify `frontend/src/live/LiveStatusBar.tsx` — active 종목 헤더 배지
- Modify `frontend/src/watchlist/WatchlistDrawer.tsx` / `frontend/src/live/LiveSidebar.tsx` — 행 배지·빈 패널 안내

**Part B — 보는종목 REST 폴링 (backend):**
- Modify `hoga/live/kis_models.py` — `KisOrderbook`/`KisTrade`/`KisBrokers` 복원
- Modify `hoga/live/kis_client.py` — `fetch_orderbook`/`fetch_trades`/`fetch_brokers` 복원
- Modify `hoga/live/snapshot.py` — `from_orderbook`/`from_trades`/`from_brokers` 빌더 복원
- Create `hoga/live/rest_poller.py` — `LiveRestPoller`(on_subscribe/on_unsubscribe/start/stop/set_excluded_codes)
- Modify `hoga/api/ws.py` — subscribe/unsubscribe → poller forward
- Modify `hoga/live/lifecycle.py` — poller 기동·종료 + `set_active_codes`→`set_excluded_codes` 배타성

**Part C — 소스통합 + 배타성 안전망 (backend):**
- Test `hoga/api/sources.py`/`bundle.py` — WS·REST 종목 공존 회귀 검증(변경 없음 확인)
- Modify `hoga/live/promote.py` — 혼합 JSONL 감지·경고

---

## Part A — 미수집 배지

### Task 1: Update LiveStatus interface to include live_set
**Files:**
- Modify: `frontend/src/api/liveStatus.ts:19` (after `watchlist_count`)

- [ ] **Step 1: Write the failing test** — Update `liveStatus.test.tsx` to assert the `live_set` field exists:
```typescript
it('includes live_set field in LiveStatus response', async () => {
  const fake = {
    running: true,
    started_at_ms: 1_000_000,
    last_tick_ms: 1_000_500,
    cycle_lag_ms: 200,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: 3,
    kis_calls_today: 12,
    kis_rate_limit_remaining: null,
    live_set: ['005930', '000660'],
  };
  vi.spyOn(client, 'apiCall').mockResolvedValue(fake);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useLiveStatus(), { wrapper: wrapper(qc) });
  await waitFor(() => expect(result.current.data?.live_set).toEqual(['005930', '000660']));
});
```

- [ ] **Step 2: Run test to verify it fails** — The test fails because the TypeScript interface doesn't include `live_set`:
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- liveStatus.test.tsx 2>&1 | grep -A 5 "live_set"
```
Expected error (TS): Property 'live_set' does not exist on type 'LiveStatus' (or vitest runtime: type mismatch when mock supplies it).

Alternatively, typecheck only:
```bash
cd /home/dev/code/hoga-ops/frontend && npx tsc --noEmit 2>&1 | grep live_set
```
Expected: TS2339 error at `liveStatus.ts` or the test file.

- [ ] **Step 3: Write minimal implementation** — Add the field to the LiveStatus interface in `liveStatus.ts`:
```typescript
export interface LiveStatus {
  running: boolean;
  started_at_ms: number | null;
  last_tick_ms: number | null;
  cycle_lag_ms: number;
  capture_healthy: boolean;
  capture_reason: string;
  watchlist_count: number;
  kis_calls_today: number;
  kis_rate_limit_remaining: number | null;
  live_set: string[];
}
```

- [ ] **Step 4: Run test to verify it passes** — Runtime test passes (mock is consumed):
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- liveStatus.test.tsx
```
Expected: ✓ includes live_set field in LiveStatus response

And typecheck passes:
```bash
cd /home/dev/code/hoga-ops/frontend && npx tsc --noEmit
```
Expected: No TS2339 errors.

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add frontend/src/api/liveStatus.ts frontend/src/api/liveStatus.test.tsx && git commit -m "feat(liveStatus): add live_set field to capture actively collected codes

Backend /api/live/status emits live_set (top 13 codes ordered by watchlist);
frontend now consumes it for collection status badge visibility (ADR task).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Implement deriveCollectionStatus pure function
**Files:**
- Create: `frontend/src/live/collectionStatus.ts`
- Modify/Test: `frontend/src/live/collectionStatus.test.ts`

- [ ] **Step 1: Write the failing test** — Create the test file first:
```typescript
import { describe, it, expect } from 'vitest';
import { deriveCollectionStatus } from './collectionStatus';

describe('deriveCollectionStatus', () => {
  it('returns "realtime" when code is in live_set', () => {
    const status = deriveCollectionStatus('005930', ['005930', '000660'], ['005930', '000660', '035720']);
    expect(status).toBe('realtime');
  });

  it('returns "uncollected" when code is not in watchlist', () => {
    const status = deriveCollectionStatus('005930', ['000660'], []);
    expect(status).toBe('uncollected');
  });

  it('returns "waiting_eod" when code is in watchlist but NOT in live_set (beyond 13-cap)', () => {
    const status = deriveCollectionStatus('012345', ['005930', '000660'], ['005930', '000660', '012345']);
    expect(status).toBe('waiting_eod');
  });

  it('returns "uncollected" when code is null', () => {
    const status = deriveCollectionStatus(null, ['005930'], ['005930']);
    expect(status).toBe('uncollected');
  });

  it('returns "realtime" when live_set includes the code even if watchlist is large', () => {
    const watchlist = Array.from({ length: 50 }, (_, i) => `code_${i}`);
    const liveSet = ['005930', '000660'];
    const status = deriveCollectionStatus('005930', liveSet, watchlist);
    expect(status).toBe('realtime');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- collectionStatus.test.ts
```
Expected error: Cannot find module './collectionStatus' (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation** — Create `collectionStatus.ts`:
```typescript
/**
 * Collection status for a symbol — pure function derived from live_set and watchlist.
 *
 * Three-state visibility:
 * - 'realtime': Code is in live_set (top 13 by watchlist order) → WS + charts/panels live
 * - 'waiting_eod': Code is in watchlist but NOT in live_set (beyond cap) → EOD fill only,
 *   no intraday polling (REST poller retired in Task 11)
 * - 'uncollected': Code is NOT in watchlist → No collection attempted
 *
 * Note: "waiting_eod" label and semantics TBD per design-review (placeholder).
 */
export type CollectionStatus = 'realtime' | 'waiting_eod' | 'uncollected';

export function deriveCollectionStatus(
  code: string | null,
  liveSet: string[],
  watchlistCodes: string[],
): CollectionStatus {
  if (!code) return 'uncollected';
  if (liveSet.includes(code)) return 'realtime';
  if (watchlistCodes.includes(code)) return 'waiting_eod';
  return 'uncollected';
}
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- collectionStatus.test.ts
```
Expected: ✓ All 5 tests pass.

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add frontend/src/live/collectionStatus.ts frontend/src/live/collectionStatus.test.ts && git commit -m "feat(collectionStatus): pure function to derive 3-state collection visibility

Discriminates realtime (in live_set), waiting_eod (in watchlist beyond 13-cap),
and uncollected (not in watchlist) — used by LiveStatusBar badge, WatchlistDrawer
row badges, and empty-state hints.

Semantics and label text ('waiting_eod' placeholder) TBD per design-review.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add collection status badge to LiveStatusBar
**Files:**
- Modify: `frontend/src/live/LiveStatusBar.tsx:100-115` (replace the LIVE●/재연결 중… block)
- Modify/Test: `frontend/src/live/LiveStatusBar.test.tsx`

- [ ] **Step 1: Write the failing test** — Add test cases to `LiveStatusBar.test.tsx`:
```typescript
it('shows "LIVE●" badge when activeCode is in live_set (realtime)', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }],
    next_run_at_ms: 0,
  });
  qc.setQueryData(['live', 'status'], {
    running: true,
    started_at_ms: 1000,
    last_tick_ms: 1500,
    cycle_lag_ms: 0,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: 1,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: ['005930'],
  });
  render(
    <QueryClientProvider client={qc}>
      <LiveStatusBar activeCode="005930" captureHealthy={true} captureReason="healthy" bundle={EMPTY_BUNDLE} />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/LIVE●/)).toBeInTheDocument();
});

it('shows "장중 미수집" badge when activeCode is in watchlist but NOT in live_set (waiting_eod)', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
      { code: '012345', name: '기타', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 1 },
    ],
    next_run_at_ms: 0,
  });
  qc.setQueryData(['live', 'status'], {
    running: true,
    started_at_ms: 1000,
    last_tick_ms: 1500,
    cycle_lag_ms: 0,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: 2,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: ['005930'],
  });
  render(
    <QueryClientProvider client={qc}>
      <LiveStatusBar activeCode="012345" captureHealthy={true} captureReason="healthy" bundle={EMPTY_BUNDLE} />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/장중 미수집/i)).toBeInTheDocument();
  // Verify the hint text is shown as well
  expect(screen.getByText(/17시 후 채워짐/i)).toBeInTheDocument();
});

it('shows "실시간 ✕" + hint only when activeCode is NOT in watchlist (uncollected)', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }],
    next_run_at_ms: 0,
  });
  qc.setQueryData(['live', 'status'], {
    running: true,
    started_at_ms: 1000,
    last_tick_ms: 1500,
    cycle_lag_ms: 0,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: 1,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: ['005930'],
  });
  render(
    <QueryClientProvider client={qc}>
      <LiveStatusBar activeCode="000000" captureHealthy={true} captureReason="healthy" bundle={EMPTY_BUNDLE} />
    </QueryClientProvider>,
  );
  // Non-member gets the original hint (no badge state needed)
  expect(screen.getByText(/실시간 ✕/)).toBeInTheDocument();
  expect(screen.getByText(/눌러 실시간 추적/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- LiveStatusBar.test.tsx
```
Expected errors: Assertions fail because `deriveCollectionStatus` is not called yet and badge is not rendered.

- [ ] **Step 3: Write minimal implementation** — Modify `LiveStatusBar.tsx` to import and use the function:
```typescript
import { deriveCollectionStatus } from './collectionStatus';
import { useLiveStatus } from '../api/liveStatus';

export function LiveStatusBar({ activeCode, captureHealthy, captureReason, bundle }: Props) {
  // ... existing code ...
  const { data: liveStatus } = useLiveStatus();
  const liveSet = liveStatus?.live_set ?? [];
  const { isMember } = useWatchlistMembership();
  
  // ... existing code ...
  
  // At line 104 (after SourceChip, before the existing conditional at line 104):
  // Derive collection status for badge rendering
  const collectionStatus = activeCode ? deriveCollectionStatus(activeCode, liveSet, codes) : 'uncollected';
  
  // Replace the block at lines 104-115 with:
  {activeCode && !isMember ? (
    <span style={{ color: 'var(--fg-dimmer)' }}>
      過去 チャート · 実時間 ✕
      <span className="ml-2 inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
        <HeartIcon filled={false} className="w-[1em] h-[1em]" /> 눌러 실시간 추적
      </span>
    </span>
  ) : collectionStatus === 'realtime' ? (
    <span style={{ color: 'var(--success)' }}>LIVE●</span>
  ) : collectionStatus === 'waiting_eod' ? (
    <span
      data-testid="collection-status-waiting-eod"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-xs)',
        padding: '0 var(--space-xs)',
        borderRadius: '4px',
        background: 'rgba(245,158,11,0.10)',
        border: '1px solid rgba(245,158,11,0.30)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg-dim)',
      }}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: '#F59E0B' }} />
      장중 미수집
    </span>
  ) : (
    <span>재연결 중…</span>
  )}
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- LiveStatusBar.test.tsx
```
Expected: ✓ All existing tests + 3 new collection-status tests pass.

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add frontend/src/live/LiveStatusBar.tsx frontend/src/live/LiveStatusBar.test.tsx && git commit -m "feat(LiveStatusBar): render 3-state collection status badge (realtime/waiting_eod/uncollected)

Calls deriveCollectionStatus(activeCode, liveSet, watchlistCodes) to show:
- LIVE● when code is in live_set (realtime WS)
- 장중 미수집 (amber badge) when code in watchlist but beyond 13-cap (EOD only)
- 실시간 ✕ hint when code not in watchlist (uncollected)

Fixes bug where watchlist members beyond live_set cap showed LIVE● despite blank panels.

Badge label text ('장중 미수집', EOD semantics) TBD per design-review.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Add collection status badges to WatchlistDrawer rows
**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx:183-212` (SortableQuoteRow component)
- Modify: `frontend/src/rightrail/QuoteRow.tsx` (parent component that renders the row)
- Modify/Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [ ] **Step 1: Write the failing test** — Add test case to `WatchlistDrawer.test.tsx`:
```typescript
it('renders collection status badges for watchlist rows (realtime / waiting_eod)', async () => {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed live status with only 005930 in live_set (000660 is uncollected)
  qc.setQueryData(['live', 'status'], {
    running: true,
    started_at_ms: 1000,
    last_tick_ms: 1500,
    cycle_lag_ms: 0,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: 2,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: ['005930'],
  });
  render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
  await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
  // 005930 (in live_set) shows realtime badge
  expect(screen.getByTestId('watchlist-row-005930').textContent).toContain('LIVE');
  // 000660 (in watchlist but not in live_set) shows waiting_eod badge
  expect(screen.getByTestId('watchlist-row-000660').textContent).toContain('미수집');
});
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- WatchlistDrawer.test.tsx
```
Expected error: Badge elements not found (assertion fails).

- [ ] **Step 3: Write minimal implementation** — Modify `SortableQuoteRow` to pass collection status to `QuoteRow`:
```typescript
// In WatchlistDrawer.tsx, update SortableQuoteRow call (line 365):
function SortableQuoteRow(props: {
  entry: WatchlistEntry;
  price: number | null; pct: number | null; changeWon: number | null;
  active: boolean;
  collectionStatus: 'realtime' | 'waiting_eod' | 'uncollected';  // NEW prop
  onPick: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete: () => void;
}) {
  // ... rest of component ...
  return (
    <QuoteRow
      // ... existing props ...
      collectionStatus={props.collectionStatus}  // NEW
    />
  );
}

// In WatchlistDrawer.tsx map block (line 362+), call deriveCollectionStatus:
{g.entries.map((entry) => {
  const q = quoteByCode.get(entry.code);
  const collectionStatus = deriveCollectionStatus(entry.code, liveSet, codes);  // NEW
  return (
    <SortableQuoteRow
      // ... existing props ...
      collectionStatus={collectionStatus}
      // ...
    />
  );
})}

// Add import at top of WatchlistDrawer.tsx:
import { deriveCollectionStatus } from '../live/collectionStatus';
import { useLiveStatus } from '../api/liveStatus';

// Add hook in WatchlistDrawer component body (after useWatchlist):
const { data: liveStatus } = useLiveStatus();
const liveSet = liveStatus?.live_set ?? [];

// In frontend/src/rightrail/QuoteRow.tsx, add prop and render badge:
interface Props {
  // ... existing props ...
  collectionStatus?: 'realtime' | 'waiting_eod' | 'uncollected';
}

export function QuoteRow({
  name, price, pct, changeWon, active, ariaLabel, testId, onClick,
  onContextMenu, onDelete, indented, sortableRef, sortableStyle, dragListeners, dragging,
  collectionStatus,
}: Props) {
  // ... existing code ...
  
  // In the JSX, after the name/code cell, add:
  {collectionStatus === 'realtime' && (
    <span
      data-testid={`collection-badge-realtime-${testId}`}
      style={{
        display: 'inline-block',
        fontSize: 'var(--text-xs)',
        color: 'var(--success)',
        fontWeight: 600,
        marginLeft: 'var(--space-xs)',
      }}
    >
      LIVE
    </span>
  )}
  {collectionStatus === 'waiting_eod' && (
    <span
      data-testid={`collection-badge-waiting-${testId}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        fontSize: 'var(--text-xs)',
        color: '#F59E0B',
        marginLeft: 'var(--space-xs)',
      }}
    >
      <span className="inline-block w-1 h-1 rounded-full" style={{ background: '#F59E0B' }} />
      미수집
    </span>
  )}
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops/frontend && npm test -- WatchlistDrawer.test.tsx
```
Expected: ✓ renders collection status badges for watchlist rows (realtime / waiting_eod) passes.

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/rightrail/QuoteRow.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx && git commit -m "feat(WatchlistDrawer): show collection status badges on watchlist rows

SortableQuoteRow now renders deriveCollectionStatus result:
- LIVE badge (green) for realtime codes (in live_set)
- 미수집 badge (amber) for waiting_eod codes (in watchlist, beyond 13-cap)
- No badge for uncollected codes (users can't see non-watchlist rows)

Helps users understand why certain watchlist entries have blank panels during intraday.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

**Notes:**
- All badge labels ('LIVE●', '장중 미수집', '미수집') are placeholder defaults — design-review must confirm final copy, colors, and icon choices.
- DESIGN.md tokens: --success (#22C55E) for realtime, amber (#F59E0B) for waiting_eod (status semantic per §Color).
- Task 4's QuoteRow modification requires checking the actual current file structure — path and prop signature may differ; adjust lines accordingly.
- All 3-state logic (realtime/waiting_eod/uncollected) reuses the pure function from Task 2; no business logic duplicated.

---

## Part B — 보는종목 REST 폴링

### Task 1: Restore KIS REST Models (kis_models.py)
**Files:**
- Modify: `hoga/live/kis_models.py:29` (after InvestorNetPoint)
- Test: `tests/unit/live/test_kis_rest_methods.py:1` (new section after existing tests)

- [ ] **Step 1: Write the failing test** — add KisOrderbook/KisTrade/KisBrokers model tests to tests/unit/live/test_kis_rest_methods.py
```python
# Add to tests/unit/live/test_kis_rest_methods.py after the existing tests

def test_kis_orderbook_model_parses_10_levels() -> None:
    """KisOrderbook model validates asks/bids with 10 levels each."""
    from hoga.live.kis_models import KisOrderbook, OrderbookLevel
    
    ob = KisOrderbook(
        code="005930",
        asks=[OrderbookLevel(price=26850 + i, qty=1000 - i*50) for i in range(10)],
        bids=[OrderbookLevel(price=26800 - i, qty=900 - i*40) for i in range(10)],
        total_ask_qty=8500,
        total_bid_qty=7200,
        t_ms=1779800000000,
    )
    assert ob.code == "005930"
    assert len(ob.asks) == 10
    assert len(ob.bids) == 10
    assert ob.asks[0].price == 26850
    assert ob.bids[0].price == 26800


def test_kis_trade_model_side_classification() -> None:
    """KisTrade model validates side (-1/0/1/2) and side_source."""
    from hoga.live.kis_models import KisTrade
    
    trades = [
        KisTrade(price=26900, qty=10, side=1, side_source="inferred", t_ms=1779800000001),
        KisTrade(price=26890, qty=5, side=-1, side_source="inferred", t_ms=1779800000002),
        KisTrade(price=26895, qty=1, side=0, side_source="inferred", t_ms=1779800000003),
        KisTrade(price=26900, qty=2, side=2, side_source="auction", t_ms=1779800000004),
    ]
    assert trades[0].side == 1
    assert trades[1].side == -1
    assert trades[2].side == 0
    assert trades[3].side_source == "auction"


def test_kis_brokers_model_top5_buy_sell() -> None:
    """KisBrokers model validates buy_top/sell_top with canonical names."""
    from hoga.live.kis_models import KisBrokerEntry, KisBrokers
    
    brokers = KisBrokers(
        code="005930",
        buy_top=[KisBrokerEntry(name=f"Broker{i}", qty=1000-i*100) for i in range(1, 6)],
        sell_top=[KisBrokerEntry(name=f"Seller{i}", qty=900-i*100) for i in range(1, 6)],
    )
    assert len(brokers.buy_top) == 5
    assert len(brokers.sell_top) == 5
    assert brokers.buy_top[0].qty == 900
```

- [ ] **Step 2: Run test to verify it fails** 
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_kis_rest_methods.py::test_kis_orderbook_model_parses_10_levels -xvs
```
Expected: `ModuleNotFoundError: No module named 'hoga.live.kis_models'; KisOrderbook/OrderbookLevel not defined`

- [ ] **Step 3: Write minimal implementation** — restore the three models to kis_models.py
```python
# Add to hoga/live/kis_models.py after InvestorNetPoint

class OrderbookLevel(BaseModel):
    price: int
    qty: int


class KisOrderbook(BaseModel):
    code: str
    asks: list[OrderbookLevel]  # asks[0] = best ask (lowest)
    bids: list[OrderbookLevel]  # bids[0] = best bid (highest)
    total_ask_qty: int
    total_bid_qty: int
    t_ms: int  # client-side epoch ms (UTC)


class KisTrade(BaseModel):
    price: int
    qty: int
    side: Literal[-1, 0, 1, 2]  # -1=sell, 0=mid, 1=buy, 2=auction
    side_source: Literal["inferred", "auction"]
    t_ms: int  # epoch ms (UTC)


class KisBrokerEntry(BaseModel):
    name: str
    qty: int


class KisBrokers(BaseModel):
    code: str
    buy_top: list[KisBrokerEntry]   # top-5 buy brokers
    sell_top: list[KisBrokerEntry]  # top-5 sell brokers
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_kis_rest_methods.py::test_kis_orderbook_model_parses_10_levels tests/unit/live/test_kis_rest_methods.py::test_kis_trade_model_side_classification tests/unit/live/test_kis_rest_methods.py::test_kis_brokers_model_top5_buy_sell -xvs
```
Expected: `3 passed`

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add hoga/live/kis_models.py tests/unit/live/test_kis_rest_methods.py && git commit -m "Task 1: Restore KIS REST models (OrderbookLevel, KisOrderbook, KisTrade, KisBrokers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Restore KIS REST Fetcher Methods (kis_client.py)
**Files:**
- Modify: `hoga/live/kis_client.py:29` (add imports), `hoga/live/kis_client.py:412` (after fetch_past_minute_candles)
- Test: `tests/unit/live/test_kis_rest_methods.py` (new section for REST fetchers)

- [ ] **Step 1: Write the failing test** — test fetch_orderbook, fetch_trades, fetch_brokers with mock responses
```python
# Add to tests/unit/live/test_kis_rest_methods.py

import json
from pathlib import Path
from datetime import datetime

import httpx
import pytest

from hoga.live.kis_client import KisClient, KisCredentials
from hoga.live.kis_models import KisOrderbook, KisTrade, KisBrokers, OrderbookLevel
from tests.unit.live._fakes import FakeTokenProvider

FIXTURES = Path("tests/fixtures/kis_mock/responses")


@pytest.mark.asyncio
async def test_fetch_orderbook_parses_10_levels_from_output1() -> None:
    """fetch_orderbook (FHKST01010200) reads from output1 and builds 10 levels."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        # Mock output1 with askp1-10, bidp1-10, total_askp_rsqn, total_bidp_rsqn
        return httpx.Response(200, json={
            "rt_cd": "0",
            "msg_cd": "MCA00000",
            "msg1": "정상처리 되었습니다.",
            "output1": {
                "askp1": "26850", "askp2": "26851", "askp3": "26852", "askp4": "26853",
                "askp5": "26854", "askp6": "26855", "askp7": "26856", "askp8": "26857",
                "askp9": "26858", "askp10": "26859",
                "askp_rsqn1": "100", "askp_rsqn2": "200", "askp_rsqn3": "300", "askp_rsqn4": "400",
                "askp_rsqn5": "500", "askp_rsqn6": "600", "askp_rsqn7": "700", "askp_rsqn8": "800",
                "askp_rsqn9": "900", "askp_rsqn10": "1000",
                "bidp1": "26800", "bidp2": "26799", "bidp3": "26798", "bidp4": "26797",
                "bidp5": "26796", "bidp6": "26795", "bidp7": "26794", "bidp8": "26793",
                "bidp9": "26792", "bidp10": "26791",
                "bidp_rsqn1": "150", "bidp_rsqn2": "250", "bidp_rsqn3": "350", "bidp_rsqn4": "450",
                "bidp_rsqn5": "550", "bidp_rsqn6": "650", "bidp_rsqn7": "750", "bidp_rsqn8": "850",
                "bidp_rsqn9": "950", "bidp_rsqn10": "1050",
                "total_askp_rsqn": "5500",
                "total_bidp_rsqn": "5250",
            }
        })
    
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        ob = await client.fetch_orderbook("005930")
        assert ob.code == "005930"
        assert len(ob.asks) == 10
        assert len(ob.bids) == 10
        assert ob.asks[0].price == 26850
        assert ob.asks[0].qty == 100
        assert ob.bids[0].price == 26800
        assert ob.bids[0].qty == 150
        assert ob.total_ask_qty == 5500
        assert ob.total_bid_qty == 5250
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_fetch_trades_parses_output2_with_lee_ready_side_classification() -> None:
    """fetch_trades (FHPST01060000) reads output2 and classifies side via Lee-Ready."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        # Load timeconclusion fixture which has output2 with askp/bidp for side inference
        fixture_data = json.loads((FIXTURES / "timeconclusion_005930.json").read_text())
        return httpx.Response(200, json=fixture_data)
    
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        trades = await client.fetch_trades("005930")
        assert isinstance(trades, list)
        assert len(trades) > 0
        for trade in trades:
            assert isinstance(trade, KisTrade)
            assert -1 <= trade.side <= 2
            assert trade.side_source in ("inferred", "auction")
            assert trade.t_ms > 0
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_fetch_brokers_parses_output_top5_buy_sell() -> None:
    """fetch_brokers (FHKST01010600) reads output[0] and returns top-5 buy/sell."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        fixture_data = json.loads((FIXTURES / "broker_005930.json").read_text())
        return httpx.Response(200, json=fixture_data)
    
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        brokers = await client.fetch_brokers("005930")
        assert brokers.code == "005930"
        assert len(brokers.buy_top) == 5
        assert len(brokers.sell_top) == 5
        for entry in brokers.buy_top:
            assert entry.name  # canonicalized
            assert entry.qty > 0
        for entry in brokers.sell_top:
            assert entry.name  # canonicalized
            assert entry.qty > 0
    finally:
        await client.aclose()
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_kis_rest_methods.py::test_fetch_orderbook_parses_10_levels_from_output1 -xvs
```
Expected: `AttributeError: 'KisClient' object has no attribute 'fetch_orderbook'`

- [ ] **Step 3: Write minimal implementation** — restore classify_side and three fetch methods to kis_client.py
```python
# Add to hoga/live/kis_client.py after line 28 (imports)

from hoga.live.kis_models import (
    InvestorNetPoint,
    KisCandle,
    KisOrderbook,
    KisTrade,
    KisBrokers,
    OrderbookLevel,
    KisBrokerEntry,
)

# Add after _RATE_LIMIT_BACKOFF definition (before _TokenBucket)

def classify_side(
    t_ms: int, prpr: int, askp: int, bidp: int
) -> tuple[Literal[-1, 0, 1, 2], Literal["inferred", "auction"]]:
    """Lee-Ready trade direction inference + auction window guard.

    Returns (side, side_source).
    side: -1=sell, 0=mid, 1=buy, 2=auction
    side_source: "inferred" | "auction"
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    in_open_auction = (h == 8 and m >= 50) or (h == 9 and m == 0)
    in_close_auction = h == 15 and 20 <= m < 30
    if in_open_auction or in_close_auction:
        return 2, "auction"
    if prpr >= askp:
        return 1, "inferred"
    if prpr <= bidp:
        return -1, "inferred"
    return 0, "inferred"


# Add after fetch_past_minute_candles (around line 495)

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        """Fetch 10-level real-time orderbook for *code* (e.g. '005930')."""
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            tr_id="FHKST01010200",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
            },
        )
        out1 = body["output1"]
        asks = [
            OrderbookLevel(price=int(out1[f"askp{i}"]), qty=int(out1[f"askp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        bids = [
            OrderbookLevel(price=int(out1[f"bidp{i}"]), qty=int(out1[f"bidp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        return KisOrderbook(
            code=code,
            asks=asks,
            bids=bids,
            total_ask_qty=int(out1["total_askp_rsqn"]),
            total_bid_qty=int(out1["total_bidp_rsqn"]),
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        """Fetch per-trade history via inquire-time-itemconclusion (FHPST01060000).

        Uses Lee-Ready side classification. Auction window trades get side=2.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
            tr_id="FHPST01060000",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
                "fid_input_hour_1": "153000",
            },
        )
        today_kst = datetime.now(KIS_KST).date()
        trades: list[KisTrade] = []
        for row in body["output2"]:
            hhmmss = row["stck_cntg_hour"]
            hh = int(hhmmss[:2])
            mm = int(hhmmss[2:4])
            ss = int(hhmmss[4:6])
            dt = datetime(
                today_kst.year, today_kst.month, today_kst.day,
                hh, mm, ss, tzinfo=KIS_KST
            )
            t_ms = int(dt.timestamp() * 1000)
            prpr = int(row["stck_prpr"])
            askp = int(row.get("askp", "0") or "0")
            bidp = int(row.get("bidp", "0") or "0")
            side, side_source = classify_side(t_ms, prpr, askp, bidp)
            trades.append(KisTrade(
                price=prpr,
                qty=int(row["cnqn"]),
                side=side,
                side_source=side_source,
                t_ms=t_ms,
            ))
        return trades

    async def fetch_brokers(self, code: str) -> KisBrokers:
        """Fetch top-5 buy/sell broker breakdown for *code*.

        Broker names are canonicalized at the boundary so the buffer / SSE /
        JSONL / promoted parquet downstream all see the same canonical KRX
        member-firm name.
        """
        from hoga.broker_names import canonical

        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-member",
            tr_id="FHKST01010600",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
            },
        )
        out = body["output"][0]  # KIS returns a 1-element list
        buy_top = [
            KisBrokerEntry(
                name=canonical(out[f"shnu_mbcr_name{i}"]),
                qty=int(out[f"total_shnu_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        sell_top = [
            KisBrokerEntry(
                name=canonical(out[f"seln_mbcr_name{i}"]),
                qty=int(out[f"total_seln_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        return KisBrokers(code=code, buy_top=buy_top, sell_top=sell_top)
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_kis_rest_methods.py::test_fetch_orderbook_parses_10_levels_from_output1 tests/unit/live/test_kis_rest_methods.py::test_fetch_trades_parses_output2_with_lee_ready_side_classification tests/unit/live/test_kis_rest_methods.py::test_fetch_brokers_parses_output_top5_buy_sell -xvs
```
Expected: `3 passed`

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add hoga/live/kis_client.py tests/unit/live/test_kis_rest_methods.py && git commit -m "Task 2: Restore KIS REST fetcher methods (fetch_orderbook/fetch_trades/fetch_brokers)

Restores FHKST01010200/FHPST01060000/FHKST01010600 parsers with classify_side
Lee-Ready inference. Uses existing 15/s token bucket via _get_with_rate_retry.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Restore LiveSnapshot Builders (snapshot.py)
**Files:**
- Modify: `hoga/live/snapshot.py:54` (after from_fill)
- Test: `tests/unit/live/test_snapshot.py` (new builders section)

- [ ] **Step 1: Write the failing test** — test from_orderbook/from_trades/from_brokers builders
```python
# Add to tests/unit/live/test_snapshot.py after test_from_fill_payload_shape

def test_from_orderbook_builds_ob_snapshot() -> None:
    """from_orderbook creates OB snapshot with phase attached to payload."""
    from hoga.live.kis_models import KisOrderbook, OrderbookLevel
    
    ob = KisOrderbook(
        code="005930",
        asks=[OrderbookLevel(price=26850, qty=6141)],
        bids=[OrderbookLevel(price=26800, qty=879)],
        total_ask_qty=102768,
        total_bid_qty=95085,
        t_ms=1779800000000,
    )
    snap = LiveSnapshot.from_orderbook(ob, phase="regular")
    assert snap.kind is SnapshotKind.OB
    assert snap.t_ms == ob.t_ms
    assert snap.payload["phase"] == "regular"
    assert snap.payload["total_ask_qty"] == 102768
    assert snap.payload["code"] == "005930"


def test_from_trades_wraps_in_trades_key() -> None:
    """from_trades creates TRADE snapshot with trades array and phase."""
    from hoga.live.kis_models import KisTrade
    
    trades = [
        KisTrade(price=26900, qty=10, side=1, side_source="inferred", t_ms=1779800000001),
        KisTrade(price=26890, qty=5, side=-1, side_source="inferred", t_ms=1779800000002),
    ]
    snap = LiveSnapshot.from_trades(trades, t_ms=1779800000000, phase="afterhours")
    assert snap.kind is SnapshotKind.TRADE
    assert snap.t_ms == 1779800000000
    assert snap.payload["phase"] == "afterhours"
    assert "trades" in snap.payload
    assert len(snap.payload["trades"]) == 2


def test_from_brokers_builds_broker_snapshot() -> None:
    """from_brokers creates BROKER snapshot with buy_top/sell_top and phase."""
    from hoga.live.kis_models import KisBrokers, KisBrokerEntry
    
    brokers = KisBrokers(
        code="005930",
        buy_top=[KisBrokerEntry(name="미래에셋", qty=1000)],
        sell_top=[KisBrokerEntry(name="키움", qty=900)],
    )
    snap = LiveSnapshot.from_brokers(brokers, t_ms=1779800000000, phase="regular")
    assert snap.kind is SnapshotKind.BROKER
    assert snap.t_ms == 1779800000000
    assert snap.payload["phase"] == "regular"
    assert snap.payload["code"] == "005930"
    assert "buy_top" in snap.payload
    assert len(snap.payload["buy_top"]) == 1
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_snapshot.py::test_from_orderbook_builds_ob_snapshot -xvs
```
Expected: `AttributeError: type object 'LiveSnapshot' has no attribute 'from_orderbook'`

- [ ] **Step 3: Write minimal implementation** — restore three builders to snapshot.py
```python
# Add to hoga/live/snapshot.py after from_fill method (around line 53)

    @classmethod
    def from_orderbook(cls, ob: "KisOrderbook", *, phase: str) -> LiveSnapshot:
        """Build an OB snapshot from a typed KIS orderbook.

        Byte-identical to the legacy poller path (``ob.model_dump()`` plus a
        ``phase`` key) so promote.py's on-disk re-parse is unaffected.
        """
        payload = ob.model_dump()
        payload["phase"] = phase
        return cls(t_ms=ob.t_ms, kind=SnapshotKind.OB, payload=payload)

    @classmethod
    def from_trades(
        cls, trades: list["KisTrade"], *, t_ms: int, phase: str
    ) -> LiveSnapshot:
        """Build a TRADE snapshot. ``t_ms`` is the cycle's outer tick (the OB t_ms)."""
        payload = {"trades": [t.model_dump() for t in trades], "phase": phase}
        return cls(t_ms=t_ms, kind=SnapshotKind.TRADE, payload=payload)

    @classmethod
    def from_brokers(
        cls, brokers: "KisBrokers", *, t_ms: int, phase: str
    ) -> LiveSnapshot:
        """Build a BROKER snapshot. ``t_ms`` is the cycle's outer tick."""
        payload = brokers.model_dump()
        payload["phase"] = phase
        return cls(t_ms=t_ms, kind=SnapshotKind.BROKER, payload=payload)

# At top of file, update TYPE_CHECKING imports:
# Change from: (none currently)
# To:
if TYPE_CHECKING:
    from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_snapshot.py::test_from_orderbook_builds_ob_snapshot tests/unit/live/test_snapshot.py::test_from_trades_wraps_in_trades_key tests/unit/live/test_snapshot.py::test_from_brokers_builds_broker_snapshot -xvs
```
Expected: `3 passed`

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add hoga/live/snapshot.py tests/unit/live/test_snapshot.py && git commit -m "Task 3: Restore LiveSnapshot builders (from_orderbook/from_trades/from_brokers)

Restores typed builders for OB/TRADE/BROKER snapshots with phase attachment.
Byte-identical to poller-era hand-rolled payloads for promote compatibility.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Create REST Poller (rest_poller.py)
**Files:**
- Create: `hoga/live/rest_poller.py`
- Test: `tests/unit/live/test_rest_poller.py`

- [ ] **Step 1: Write the failing test** — test LiveRestPoller lifecycle and polling loop
```python
# Create tests/unit/live/test_rest_poller.py

"""REST Poller for codes outside WS live_set (Task 4)."""
import asyncio
import pytest

from hoga.live.rest_poller import LiveRestPoller


class _FakeKisClient:
    """Mock KIS client that returns fixed responses."""
    
    async def fetch_orderbook(self, code: str):
        from hoga.live.kis_models import KisOrderbook, OrderbookLevel
        return KisOrderbook(
            code=code,
            asks=[OrderbookLevel(price=26850+i, qty=1000) for i in range(10)],
            bids=[OrderbookLevel(price=26800-i, qty=1000) for i in range(10)],
            total_ask_qty=10000,
            total_bid_qty=10000,
            t_ms=1779800000000,
        )
    
    async def fetch_trades(self, code: str):
        from hoga.live.kis_models import KisTrade
        return [
            KisTrade(price=26900, qty=10, side=1, side_source="inferred", t_ms=1779800000001),
        ]
    
    async def fetch_brokers(self, code: str):
        from hoga.live.kis_models import KisBrokers, KisBrokerEntry
        return KisBrokers(
            code=code,
            buy_top=[KisBrokerEntry(name="Broker1", qty=1000)],
            sell_top=[KisBrokerEntry(name="Seller1", qty=900)],
        )


class _FakeWriter:
    """Mock writer that tracks appends."""
    
    def __init__(self):
        self.appends: list[tuple[str, str, list]] = []
    
    async def append(self, date: str, code: str, snapshots: list):
        self.appends.append((date, code, snapshots))
    
    async def fsync_all(self):
        pass


@pytest.mark.asyncio
async def test_rest_poller_on_subscribe_tracks_code() -> None:
    """on_subscribe adds a code to the polling set."""
    poller = LiveRestPoller(
        kis=_FakeKisClient(),
        writer=_FakeWriter(),
        date_fn=lambda: "20260609",
    )
    poller.on_subscribe("005930")
    # Verify code is tracked (implementation detail: internal set)
    assert "005930" in poller._subscribed_codes


@pytest.mark.asyncio
async def test_rest_poller_on_unsubscribe_removes_code() -> None:
    """on_unsubscribe removes a code from polling set."""
    poller = LiveRestPoller(
        kis=_FakeKisClient(),
        writer=_FakeWriter(),
        date_fn=lambda: "20260609",
    )
    poller.on_subscribe("005930")
    poller.on_unsubscribe("005930")
    assert "005930" not in poller._subscribed_codes


@pytest.mark.asyncio
async def test_rest_poller_set_excluded_codes_filters_polling() -> None:
    """set_excluded_codes marks WS-active codes to skip in polling."""
    poller = LiveRestPoller(
        kis=_FakeKisClient(),
        writer=_FakeWriter(),
        date_fn=lambda: "20260609",
    )
    poller.on_subscribe("005930")
    poller.on_subscribe("000660")
    # Exclude one code (WS live)
    poller.set_excluded_codes({"005930"})
    # Polling should skip 005930
    assert "000660" not in poller._excluded_codes
    assert "005930" in poller._excluded_codes


@pytest.mark.asyncio
async def test_rest_poller_start_stop_lifecycle() -> None:
    """start/stop manage the polling loop task."""
    poller = LiveRestPoller(
        kis=_FakeKisClient(),
        writer=_FakeWriter(),
        date_fn=lambda: "20260609",
        poll_interval_s=0.01,  # Fast for test
    )
    poller.on_subscribe("005930")
    
    # Start polling
    poller.start()
    await asyncio.sleep(0.05)  # Let at least one cycle run
    
    # Verify polling ran (writer should have appends)
    assert len(poller._writer.appends) > 0
    
    # Stop polling
    poller.stop()
    await asyncio.sleep(0.01)
    
    # Task should be done or None
    if poller._task is not None:
        assert poller._task.done() or poller._task.cancelled()
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_rest_poller.py::test_rest_poller_on_subscribe_tracks_code -xvs
```
Expected: `ModuleNotFoundError: No module named 'hoga.live.rest_poller'`

- [ ] **Step 3: Write minimal implementation** — create rest_poller.py
```python
# Create hoga/live/rest_poller.py

"""REST Poller for codes outside WS live_set (Task 4).

Polls subscribed codes that fall outside the WS live_set (max 13) to capture
orderbook/trade/broker data via KIS REST, writing to the same JSONL pipeline
as WS captures. Shares the single KisClient's 15/s token bucket.

Lifecycle:
  on_subscribe(code) — add code to poll set
  on_unsubscribe(code) — remove code from poll set
  set_excluded_codes(set) — mark WS-active codes to skip (no double-polling)
  start() — spawn polling loop
  stop() — cancel loop (unsubscribe finishes current cycle)
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from hoga.live.kis_client import KisClient
    from hoga.live.writer import LiveWriter

_log = logging.getLogger(__name__)


@dataclass
class LiveRestPoller:
    """REST poller for codes outside WS live_set."""
    
    kis: KisClient
    writer: LiveWriter
    date_fn: Callable[[], str]
    poll_interval_s: float = 3.0
    
    def __post_init__(self) -> None:
        self._subscribed_codes: set[str] = set()
        self._excluded_codes: set[str] = set()
        self._task: asyncio.Task | None = None  # type: ignore[type-arg]
    
    def on_subscribe(self, code: str) -> None:
        """Add code to polling set. No-op if already subscribed."""
        self._subscribed_codes.add(code)
    
    def on_unsubscribe(self, code: str) -> None:
        """Remove code from polling set. Next cycle will skip it."""
        self._subscribed_codes.discard(code)
    
    def set_excluded_codes(self, codes: set[str]) -> None:
        """Set WS-active codes (don't poll these; prevents double-fetch)."""
        self._excluded_codes = set(codes)
    
    def start(self) -> None:
        """Spawn the polling loop if not running."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(
                self._polling_loop(), name="rest-poller"
            )
    
    def stop(self) -> None:
        """Cancel the polling loop. Current cycle completes before stopping."""
        if self._task is not None and not self._task.done():
            self._task.cancel()
    
    async def _polling_loop(self) -> None:
        """Main polling loop. Runs one cycle every poll_interval_s seconds."""
        from .session_gate import market_phase
        from .snapshot import LiveSnapshot
        
        while True:
            try:
                now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
                phase = market_phase(now_ms)
                
                # Collect codes to poll (subscribed − excluded)
                to_poll = self._subscribed_codes - self._excluded_codes
                if not to_poll:
                    await asyncio.sleep(self.poll_interval_s)
                    continue
                
                date = self.date_fn()
                
                # Fetch all codes in parallel
                for code in to_poll:
                    try:
                        ob, trades, brokers = await asyncio.gather(
                            self.kis.fetch_orderbook(code),
                            self.kis.fetch_trades(code),
                            self.kis.fetch_brokers(code),
                        )
                        
                        snaps = [
                            LiveSnapshot.from_orderbook(ob, phase=phase),
                            LiveSnapshot.from_trades(trades, t_ms=ob.t_ms, phase=phase),
                            LiveSnapshot.from_brokers(brokers, t_ms=ob.t_ms, phase=phase),
                        ]
                        await self.writer.append(date, code, snaps)
                    except Exception:
                        _log.exception("rest_poller.fetch_failed code=%s", code)
                
                await self.writer.fsync_all()
                await asyncio.sleep(self.poll_interval_s)
            except asyncio.CancelledError:
                break
            except Exception:
                _log.exception("rest_poller.cycle_failed")
                await asyncio.sleep(self.poll_interval_s)
```

- [ ] **Step 4: Run test to verify it passes**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_rest_poller.py::test_rest_poller_on_subscribe_tracks_code tests/unit/live/test_rest_poller.py::test_rest_poller_on_unsubscribe_removes_code tests/unit/live/test_rest_poller.py::test_rest_poller_set_excluded_codes_filters_polling tests/unit/live/test_rest_poller.py::test_rest_poller_start_stop_lifecycle -xvs
```
Expected: `4 passed`

- [ ] **Step 5: Commit**
```bash
cd /home/dev/code/hoga-ops && git add hoga/live/rest_poller.py tests/unit/live/test_rest_poller.py && git commit -m "Task 4: Create REST poller for codes outside WS live_set

Polls subscribed codes not in WS live_set (cap 13) via KIS REST.
Shares existing 15/s token bucket. Respects set_excluded_codes for
no double-polling. Polling interval default 3s (tunable).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Forward WS Receiver Events to REST Poller (ws.py)
**Files:**
- Modify: `hoga/api/ws.py:24-113`

- [ ] **Step 1: Write the failing test** — test that receiver calls rest_poller on_subscribe/on_unsubscribe
```python
# Add to tests/unit/live/test_rest_poller.py

@pytest.mark.asyncio
async def test_ws_receiver_forwards_subscribe_to_rest_poller() -> None:
    """WS receiver calls rest_poller.on_subscribe on subscribe action."""
    # This is an integration test; actual test lives in API layer
    # but the contract is: receiver sees {action:'subscribe', code:str}
    # and calls rest_poller.on_subscribe(code)
    # (verified in Task 5 integration test in hoga/api/)
    pass
```

- [ ] **Step 2: Run test to verify structure**
```bash
cd /home/dev/code/hoga-ops && grep -n "def receiver" hoga/api/ws.py
```
Line 64: receiver is the coroutine inside build_ws_router.

- [ ] **Step 3: Write implementation** — modify ws.py to accept rest_poller and forward events
```python
# Modify hoga/api/ws.py

# Change build_ws_router signature (line 24):
def build_ws_router(
    bus: EventBus,
    get_buffer: Callable[[], LiveBuffer | None],
    get_rest_poller: Callable[[], object | None] | None = None,
    *,
    ping_timeout_s: float = _PING_TIMEOUT_S,
) -> APIRouter:

# Inside receiver() coroutine (around line 69):
# After: elif action == "unsubscribe" and isinstance(code, str) and code in code_subs:
# Add before the task cancellation:

                elif action == "unsubscribe" and isinstance(code, str) and code in code_subs:
                    # Forward to rest_poller if available
                    if get_rest_poller is not None:
                        poller = get_rest_poller()
                        if poller is not None:
                            poller.on_unsubscribe(code)
                    q, task = code_subs.pop(code)
                    task.cancel()
                    buf = get_buffer()
                    if buf is not None:
                        buf.unsubscribe(code, q)

# And in the subscribe branch (around line 70):
                if action == "subscribe" and isinstance(code, str):
                    # Forward to rest_poller if available
                    if get_rest_poller is not None:
                        poller = get_rest_poller()
                        if poller is not None:
                            poller.on_subscribe(code)
                    if code not in code_subs:
                        buf = get_buffer()
                        if buf is None:
                            continue
                        q = buf.subscribe(code)
                        code_subs[code] = (q, asyncio.create_task(pump_live(code, q)))
                    emit({"ch": "subscribed", "code": code})
```

- [ ] **Step 4: Run test to verify** — check that API layer passes rest_poller
```bash
cd /home/dev/code/hoga-ops && grep -A 5 "build_ws_router" hoga/api/app.py
```
Line 219: `app.include_router(build_ws_router(bus, live_get_buffer))`
Will need to update in Task 6.

- [ ] **Step 5: Commit** (tentative; full integration in Task 6)
```bash
cd /home/dev/code/hoga-ops && git add hoga/api/ws.py && git commit -m "Task 5: Forward WS subscribe/unsubscribe to REST poller

Receiver accepts get_rest_poller callable (mirroring get_buffer pattern).
Forwards on_subscribe/on_unsubscribe calls for codes outside WS live_set.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Lifecycle Integration (lifecycle.py)
**Files:**
- Modify: `hoga/live/lifecycle.py` (singleton + start/stop), `hoga/api/app.py` (wiring)

- [ ] **Step 1: Write the failing test** — test that lifecycle starts rest_poller and syncs excluded codes
```python
# Add to tests/unit/live/test_lifecycle.py or new test_rest_poller_integration.py

@pytest.mark.asyncio
async def test_lifecycle_starts_rest_poller_on_stream_start(tmp_path: Path) -> None:
    """start_live_stream starts the REST poller singleton."""
    from hoga.live.lifecycle import (
        start_live_stream, stop_live_stream, reset_for_tests, get_rest_poller
    )
    from pathlib import Path
    
    reset_for_tests()
    try:
        # Mock enough state to start a stream
        # (This is integration-heavy; actual test in full context)
        await start_live_stream(data_dir=tmp_path / "live")
        poller = get_rest_poller()
        assert poller is not None
        assert poller._task is not None
        await stop_live_stream()
    finally:
        reset_for_tests()
```

- [ ] **Step 2: Run test to verify it fails**
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/test_lifecycle.py -k rest_poller -xvs 2>&1 | head -50
```
Expected: `AttributeError: module 'hoga.live.lifecycle' has no attribute 'get_rest_poller'`

- [ ] **Step 3: Write implementation** — add rest_poller singleton to lifecycle.py
```python
# Add to hoga/live/lifecycle.py after _buffer definition (line 135)

from hoga.live.rest_poller import LiveRestPoller  # noqa: PLC0415 — defer import

_rest_poller: LiveRestPoller | None = None


def get_rest_poller() -> LiveRestPoller | None:
    """Get the module-level REST poller singleton."""
    return _rest_poller


# In _start_live_stream_locked, after creating stream (around line 398):
# Add before stream.ws = ws

    global _rest_poller  # noqa: PLW0603
    _rest_poller = LiveRestPoller(
        kis=kis,
        writer=LiveWriter(data_dir / "live"),
        date_fn=_today_kst,
        poll_interval_s=3.0,  # Default 3s (tunable via env)
    )
    _rest_poller.start()

# In stream setup (around line 405), call set_excluded_codes:
    stream.set_active_codes(set(codes))
    # Sync REST poller excluded codes (WS-active codes)
    if _rest_poller is not None:
        _rest_poller.set_excluded_codes(set(codes))

# In _stop_live_stream_locked, add rest_poller cleanup:
    global _state, _rest_poller  # noqa: PLW0603
    if _rest_poller is not None:
        _rest_poller.stop()
        _rest_poller = None
    # ... rest of stop logic

# In refresh_live_stream, sync excluded codes after ws.update_codes:
    await stream.ws.update_codes(codes)
    stream.set_active_codes(set(codes))
    if _rest_poller is not None:
        _rest_poller.set_excluded_codes(set(codes))
    await _buffer.drop_codes_except(set(codes))

# In reset_for_tests (around line 292):
    global _state, _buffer, _rest_poller  # noqa: PLW0603
    for task in (_state.stream_task, _state.ws_task):
        if task is not None and not task.done():
            task.cancel()
    if _rest_poller is not None:
        _rest_poller.stop()
        _rest_poller = None
    _state = _State()
    _buffer = LiveBuffer()
    kis_runtime.reset_for_tests()
    _today_promote_last_ms.clear()
```

- [ ] **Step 4: Run test to verify** — start integration test
```bash
cd /home/dev/code/hoga-ops && python -m pytest tests/unit/live/ -k "rest_poller or lifecycle" --co -q 2>&1 | head -20
```
Expected: test node listings

- [ ] **Step 5: Update API wiring** — modify app.py to pass get_rest_poller to build_ws_router
```python
# In hoga/api/app.py, after line 37, add import:
from hoga.live.lifecycle import get_rest_poller as live_get_rest_poller

# Change line 219 from:
    app.include_router(build_ws_router(bus, live_get_buffer))
# To:
    app.include_router(build_ws_router(bus, live_get_buffer, live_get_rest_poller))
```

- [ ] **Step 6: Commit**
```bash
cd /home/dev/code/hoga-ops && git add hoga/live/lifecycle.py hoga/api/app.py tests/unit/live/ && git commit -m "Task 6: Lifecycle integration for REST poller

Adds module-level REST poller singleton in lifecycle.py. Starts poller
in _start_live_stream_locked; syncs excluded_codes (WS live_set) in
start/refresh; stops in _stop_live_stream_locked. Wires get_rest_poller
to build_ws_router in app.py for subscribe/unsubscribe forwarding.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

---

## Part C — 소스통합 + 배타성 안전망

### Task 1: Regression Test — Source Aggregation per-(date, code) Resolution

**Files:**
- Create: `tests/unit/api/test_sources_dual_kis_live.py`

- [ ] **Step 1: Write the failing test** — test two codes on same date both sourcing from kis_live independently

```python
"""Regression: dual WS/REST kis_live coexistence per (date, code) — ADR-0037."""
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.api.sources import resolve_source
import json
import polars as pl


def _write_meta(path: Path, **kwargs) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    default = {
        "source": "kis_live",
        "code": "000000",
        "date": "20260609",
        "promoted_at": "2026-06-09T10:00:00+00:00",
        "row_counts": {"snapshots": 1, "trades": 0, "brokers": 0, "fills": 0},
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }
    default.update(kwargs)
    path.write_text(json.dumps(default, indent=2))


def _write_snapshots(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _write_empty_candles(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "ts_ms": pl.Series([], dtype=pl.Int64),
        "open": pl.Series([], dtype=pl.Int64),
        "close": pl.Series([], dtype=pl.Int64),
        "high": pl.Series([], dtype=pl.Int64),
        "low": pl.Series([], dtype=pl.Int64),
        "vol_a": pl.Series([], dtype=pl.Int64),
        "vol_b": pl.Series([], dtype=pl.Int64),
    }).write_parquet(path)


def _write_empty_trades(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "ts_ms": pl.Series([], dtype=pl.Int64),
        "seq": pl.Series([], dtype=pl.Int64),
        "price": pl.Series([], dtype=pl.Int64),
        "qty": pl.Series([], dtype=pl.Int64),
        "side": pl.Series([], dtype=pl.Int8),
        "change_pct": pl.Series([], dtype=pl.Float64),
        "cum_vol": pl.Series([], dtype=pl.Int64),
        "cum_trades": pl.Series([], dtype=pl.Int64),
        "low_so_far": pl.Series([], dtype=pl.Int64),
        "high_so_far": pl.Series([], dtype=pl.Int64),
        "net_pressure": pl.Series([], dtype=pl.Int64),
        "unknown_14": pl.Series([], dtype=pl.Int64),
        "unknown_16": pl.Series([], dtype=pl.Float64),
        "unknown_17": pl.Series([], dtype=pl.Float64),
        "unknown_18": pl.Series([], dtype=pl.Float64),
    }).write_parquet(path)


def _snap(t_hhmmssms: int, total_bid: int, total_ask: int) -> dict:
    base = {"ts_ms": t_hhmmssms, "seq": 0}
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            base[f"{prefix}{i}"] = 0
    base["bid_q1"] = total_bid
    base["ask_q1"] = total_ask
    base.update({"tot_ask": total_ask, "tot_ask_d": 0, "tot_bid": total_bid, "tot_bid_d": 0})
    return base


def test_dual_code_both_kis_live_per_code_independent(tmp_path: Path) -> None:
    """두 종목(A,B)이 같은 날 모두 kis_live 소스로 존재 → 각 종목별로 kis_live 독립 resolve.

    배경: WS(종목A)와 REST폴링(종목B)이 같은 소스명='kis_live'로 저장되므로,
    resolve_source & build_range_bundle이 per-(date,code)로 독립적으로
    kis_live를 식별하고 읽어야 함. ADR-0037/ADR-0039 회귀.
    """
    date = "20260609"
    code_a = "005930"  # WS가 생성했다고 가정 (sim)
    code_b = "000660"  # REST 폴링이 생성했다고 가정 (sim)
    sd_dir_a = tmp_path / "parquet" / date / code_a
    sd_dir_b = tmp_path / "parquet" / date / code_b

    # Code A: kis_live 소스 (WS 경로)
    _write_meta(sd_dir_a / "kis_live" / "meta.json", code=code_a, date=date)
    _write_snapshots(sd_dir_a / "kis_live" / "snapshots.parquet", [
        _snap(100000000, 1111, 2222),
    ])
    _write_empty_candles(sd_dir_a / "kis_live" / "candles.parquet")
    _write_empty_trades(sd_dir_a / "kis_live" / "trades.parquet")

    # Code B: kis_live 소스 (REST 경로)
    _write_meta(sd_dir_b / "kis_live" / "meta.json", code=code_b, date=date)
    _write_snapshots(sd_dir_b / "kis_live" / "snapshots.parquet", [
        _snap(100000000, 3333, 4444),
    ])
    _write_empty_candles(sd_dir_b / "kis_live" / "candles.parquet")
    _write_empty_trades(sd_dir_b / "kis_live" / "trades.parquet")

    engine = QueryEngine(tmp_path)

    # Test resolve_source per code
    src_a = resolve_source(engine, date, code_a, "kis_live")
    src_b = resolve_source(engine, date, code_b, "kis_live")
    assert src_a == "kis_live"
    assert src_b == "kis_live"

    # Test build_range_bundle preserves per-code data
    bundle_a = build_range_bundle(
        engine, code=code_a, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="kis_live"
    )
    bundle_b = build_range_bundle(
        engine, code=code_b, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="kis_live"
    )

    assert len(bundle_a.segments) == 1
    assert bundle_a.segments[0].source == "kis_live"
    assert any(p.bid_total == 1111 for p in bundle_a.quote_ratio.points)

    assert len(bundle_b.segments) == 1
    assert bundle_b.segments[0].source == "kis_live"
    assert any(p.bid_total == 3333 for p in bundle_b.quote_ratio.points)
```

- [ ] **Step 2: Run test to verify it passes** — test passes on first run (validates per-code independence already works)

Run: `uv run pytest tests/unit/api/test_sources_dual_kis_live.py::test_dual_code_both_kis_live_per_code_independent -v`

Expected: `PASSED` — The test passes because `resolve_source` already resolves per (date, code) via `classify_stock_date`, and `build_range_bundle` calls `_resolve_source(engine, d, code, ...)` for each date independently. **This test is a regression guard ensuring per-code independence survives refactors** (e.g., if a future change accidentally mixed sources across codes, this test would break).

- [ ] **Step 3: No implementation needed** — existing code path is correct, test confirms it

No code change required — `sources.py` resolve_source (line 22–46) already handles per-code lookup via per-code directory path `engine.data_dir / "parquet" / date / code`, and `bundle.py` build_range_bundle (line 406) calls resolve_source once per code per date.

- [ ] **Step 4: Commit the test** — add the regression test to the suite

```bash
git add tests/unit/api/test_sources_dual_kis_live.py
git commit -m "test(api): dual-code kis_live coexistence regression (ADR-0037 per-code independence)"
```

---

### Task 2: Producer Exclusivity Detection — Mixed WS/REST JSONL Warning

**Files:**
- Modify: `hoga/live/promote.py` (add detection + warning log)
- Create: `tests/unit/live/test_promote_mixed_producer_detection.py`

- [ ] **Step 1: Write the failing test** — assert warning is logged when JSONL contains both kind=trade and kind=fill

```python
"""Producer exclusivity detection: warn when WS (kind=fill) + REST (kind=trade) mix.

Safeguard for mid-session WS/REST poller switch (plan line 1958).
"""
import json
import logging
from pathlib import Path

import pytest

from hoga.live.promote import _parse_jsonl_to_records
from hoga.api.timeenc import hhmmssms_to_unix_ms


def test_mixed_producer_jsonl_detection_warns(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """Single JSONL with both kind=trade (REST) + kind=fill (WS) → warn."""
    code = "005930"
    date = "20260609"
    jsonl_path = tmp_path / "live" / date / f"{code}.jsonl"
    jsonl_path.parent.mkdir(parents=True)

    # Build valid Unix-ms timestamps within 20260609 KST day window
    # 09:00:00.000 KST on 20260609
    base_t = hhmmssms_to_unix_ms("20260609", 90000000)
    lines = []

    # REST poller frame: kind=trade (before WS switch)
    lines.append(json.dumps({
        "t_ms": base_t + 1000,
        "kind": "trade",
        "payload": {
            "trades": [{"price": 75000, "qty": 10, "side": 1}],
        },
    }))

    # WS frame: kind=fill (after WS switch mid-session)
    lines.append(json.dumps({
        "t_ms": base_t + 2000,
        "kind": "fill",
        "payload": {"buy_qty": 50, "sell_qty": 30},
    }))

    jsonl_path.write_text("\n".join(lines) + "\n")

    # Parse and capture log
    with caplog.at_level(logging.WARNING, logger="hoga.live.promote"):
        snapshots, trades, broker_rows, fills, meta = _parse_jsonl_to_records(
            jsonl_path, code=code, date=date,
        )

    # Verify both lists populated
    assert len(trades) == 1, "kind=trade should yield 1 trade"
    assert len(fills) == 1, "kind=fill should yield 1 fill"

    # Verify warning was logged
    assert any(
        "live.promote.mixed_producer" in r.message
        for r in caplog.records
    ), f"Expected mixed_producer warning; got: {[r.message for r in caplog.records]}"
```

- [ ] **Step 2: Run test to verify it fails** — test fails (warning not yet in code)

Run: `uv run pytest tests/unit/live/test_promote_mixed_producer_detection.py::test_mixed_producer_jsonl_detection_warns -v`

Expected: `FAILED: AssertionError — Expected mixed_producer warning; got: [...]` — no warning logged yet because detection code is not implemented.

- [ ] **Step 3: Write minimal implementation** — add mixed-producer detection to _parse_jsonl_to_records

Insert in `hoga/live/promote.py` at line 220 (just before `meta = _build_meta(...)`):

```python
# Detective for mid-session WS/REST switch (plan line 1958, design §5.5 safety net).
# WS emits kind=fill → fills.parquet; REST/poller emits kind=trade → trades.parquet.
# Both non-empty = mixed producer in single JSONL (mid-session cutover artifact).
if trades and fills:
    _log.warning(
        "live.promote.mixed_producer code=%s date=%s trades=%d fills=%d",
        code, date, len(trades), len(fills),
    )
```

Full context (lines 218–224):

```python
            elif kind == "fill":
                # 그릴링 Q4: 10초 체결강도 구간합 → fills.parquet.
                # side 분류는 다운샘플러가 write-time에 적용 완료(±1만, side=0 제외).
                fill_seq += 1
                fills.append(Fill(
                    ts_ms=ts_ms_encoded,
                    seq=fill_seq,
                    buy_qty=int(p.get("buy_qty") or 0),
                    sell_qty=int(p.get("sell_qty") or 0),
                ))

    # Detective for mid-session WS/REST switch (plan line 1958, design §5.5 safety net).
    # WS emits kind=fill → fills.parquet; REST/poller emits kind=trade → trades.parquet.
    # Both non-empty = mixed producer in single JSONL (mid-session cutover artifact).
    if trades and fills:
        _log.warning(
            "live.promote.mixed_producer code=%s date=%s trades=%d fills=%d",
            code, date, len(trades), len(fills),
        )

    meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count, fill_count=len(fills))
```

- [ ] **Step 4: Run test to verify it passes** — warning now logged, assertion passes

Run: `uv run pytest tests/unit/live/test_promote_mixed_producer_detection.py::test_mixed_producer_jsonl_detection_warns -v`

Expected: `PASSED` — caplog captures the mixed_producer warning, assertion succeeds. Verify by running with `-s` flag to see log output:

Run: `uv run pytest tests/unit/live/test_promote_mixed_producer_detection.py::test_mixed_producer_jsonl_detection_warns -v -s`

Expected log line: `WARNING hoga.live.promote:promote.py:XXX live.promote.mixed_producer code=005930 date=20260609 trades=1 fills=1`

- [ ] **Step 5: Commit** — add implementation + test to bundle

```bash
git add hoga/live/promote.py tests/unit/live/test_promote_mixed_producer_detection.py
git commit -m "fix(live): detect mixed WS/REST producer in single JSONL, warn with code/date/counts

When WS (kind=fill) and REST poller (kind=trade) mix in the same (date,code) JSONL
during mid-session cutover, both promote_today and promote_one now log a warning
with the code, date, and row counts. This is the safeguard gate from plan line 1958
and design §5.5 — both parquet files created = mid-session artifact detected.

ADR-0038/0043 promotion already absorbs the mixed state (produces both .parquet files);
this warning lets operators detect the cutover lag and retiming for future deploys.

Fixes: WS/REST exclusivity safety net (no producer field added per ADR constraint).
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review 결과 (실행 전 반영할 보강 2건)

writing-plans self-review에서 타입 일관성(`deriveCollectionStatus`·`LiveRestPoller`·`fetch_*`)은 확인됨. spec 대비 2건의 gap 발견 — 출시1 실행 시 반영(둘 다 작고 frontend-only, Part B와 독립):

**보강 1 — LiveSidebar 빈 패널 안내 (Part A 태스크 누락).**
File Structure엔 있으나 태스크가 없음. 미수집/저녁대기 종목을 열면 호가/거래원 패널 위에 "장중 미수집 — 17시 이후 채워집니다" 안내. 실행 시 `LiveSidebar.tsx`의 OrderbookTable 위에 `deriveCollectionStatus` 기반 조건부 안내 추가(현재 코드를 읽어 정확한 위치 확정).

**보강 2 — '폴링중(준실시간)' 배지 상태 (Part A↔B 연결, 핵심).**
현재 `deriveCollectionStatus`는 `realtime`/`waiting_eod`/`uncollected` 3-state라, 보는 종목이 REST 폴링으로 채워지는 중에도 `waiting_eod`(저녁대기)로 표시돼 **모순**(데이터는 나오는데 배지는 "미수집"). 해결: `'polling'` 상태 추가 — `deriveCollectionStatus(code, liveSet, watchlistCodes, viewedCodes)`로 인자를 늘려 "live_set 밖 + 현재 보는 종목(폴링 대상)"이면 `'polling'`. 보는 종목 정보는 프론트가 이미 `activeCode`로 보유하므로 **백엔드 status 변경 불필요**. Part A의 Task 2(파생함수)·Task 3(배지)를 4-state로 확장하고 테스트도 폴링 케이스 추가.

> 두 보강은 Part A(배지)에 흡수된다. 정확한 코드는 실행 시 `LiveSidebar.tsx`/`LiveStatusBar.tsx`를 읽어 확정한다.
