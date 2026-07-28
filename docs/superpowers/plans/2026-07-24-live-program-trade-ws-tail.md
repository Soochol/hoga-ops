# Live Program Trade WS Tail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/live`의 프로그램 순매수 데이터 창과 차트 pane이 키움 `0w` WebSocket 수신 후 150ms 프론트 flush 주기 안에 갱신되도록 하면서, 기존 30초 sidecar 저장과 당일 전체 이력은 그대로 보존한다.

**Architecture:** `LiveStream.on_tick`은 KRX `PROGRAM` 틱을 기존 latch에 계속 기록하는 동시에 표시 전용 `LiveBuffer`에도 fan-out한다. 프론트는 `program` kind를 기존 단일 live subscription에서 수집하고, 공통 차트 번들 조립부에서 `/api/range`의 저장 시계열 뒤에 15분 WS 꼬리를 붙인다. `ProgramWindow`는 별도 subscription을 만들지 않고 기존 `GroupChartLink.bundle.program_trade`를 계속 소비하므로 데이터 창과 차트 pane이 동일한 시계열을 본다.

**Tech Stack:** Python 3.11+, FastAPI, asyncio, pytest, TypeScript 6, React 18, TanStack Query, Vitest

## Global Constraints

- 키움 `0w` 프로그램 데이터는 KRX 집계값이므로 `tick.venue == "KRX"`일 때만 표시·저장한다.
- 기존 `program_trade_latch → ProgramTradeCollector(30초) → ProgramTradeStore → /api/range` 저장 경로는 변경하지 않는다.
- `PROGRAM` 틱은 표시 버퍼에는 들어가지만 JSONL/downsampler/parquet 저장 경로에는 들어가지 않는다.
- `/api/live/snapshot` 응답 계약은 변경하지 않고 `/api/live/series`에만 `programs` 배열을 추가한다.
- 프론트는 `ProgramWindow`에서 `useLiveSeries`를 새로 호출하지 않는다. 기존 차트 창의 live source와 `GroupChartLink`를 재사용한다.
- sidecar와 WS 병합은 저장 시계열의 전역 마지막 `t`보다 큰 WS 점만 꼬리로 붙이며, 결과는 `t` 오름차순·동일 `t` last-wins로 만든다.
- 키움 raw 틱에 없는 `delta_qty`/`delta_amount`를 프론트에서 추정하지 않는다. WS 점은 두 필드를 `null`, `gap_risk`를 `false`로 둔다.
- `ProgramTradeSeries.source`는 호환성상 동결된 `"kis_program_trade"` 식별자를 유지한다.
- 백엔드 표시 버퍼와 프론트 버퍼의 보존 시간은 기존 15분을 유지한다.
- 신규 런타임 의존성은 추가하지 않는다.

---

## File Structure

### Backend

- Modify: `hoga/live/stream.py`
  - KRX `PROGRAM` 틱을 latch와 표시 버퍼로 동시에 fan-out하고 저장 ingest 전에 return한다.
- Modify: `hoga/live/buffer.py`
  - `get_series()` 응답에 `programs` 배열을 추가한다. `get_latest()`는 변경하지 않는다.
- Modify: `hoga/live/snapshot.py`
  - `SnapshotKind.PROGRAM`의 새 표시/저장 경계를 설명한다.
- Modify: `tests/unit/live/test_stream.py`
  - 프로그램 틱의 “latch + 표시 buffer, JSONL 제외” 계약을 잠근다.
- Modify: `tests/unit/live/test_buffer.py`
  - 프로그램 kind의 보존, series 조회, subscriber 전달을 검증한다.
- Modify: `tests/unit/live/test_api.py`
  - `/api/live/series`가 `programs`를 hydration payload로 반환하는지 검증한다.

### Frontend

- Modify: `frontend/src/api/types.ts`
  - `LiveSnapshotEntry.kind`에 `program`을 추가한다.
- Modify: `frontend/src/live/liveSnapshotBuffer.ts`
  - 네 번째 kind `program`을 저장·hydrate·clear한다.
- Modify: `frontend/src/api/liveSeries.ts`
  - 초기 REST와 WS에서 `program` 배열을 제공한다.
- Create: `frontend/src/live/programTradeLiveTail.ts`
  - raw WS 프로그램 스냅샷을 `ProgramTradePoint`로 정규화하고 sidecar 시계열과 병합한다.
- Create: `frontend/src/live/programTradeLiveTail.test.ts`
  - 병합 seam, 정렬, 중복, 잘못된 값, source 계약을 단위 테스트한다.
- Modify: `frontend/src/live/useLiveBundle.ts`
  - 공통 chart bundle의 `program_trade`에 WS 꼬리를 결합한다.
- Modify: `frontend/src/live/useLiveBundle.test.tsx`
  - sidecar + WS 병합이 차트 번들에 반영되고 비활성 게이트를 존중하는지 검증한다.
- Modify: `frontend/src/live/liveSnapshotBuffer.test.ts`
  - `program` kind의 그룹핑·hydrate·clear를 검증한다.
- Modify: `frontend/src/api/liveSeries.test.tsx`
  - 초기 `programs` hydration과 WS `program` push를 검증한다.
- Modify: `frontend/src/api/liveSeries.test-d.ts`
  - `/api/live/series` 타입 fixture에 `programs`를 추가한다.
- Modify: `frontend/src/live/LivePage.test.tsx`
  - `useLiveSeries` mock 반환형에 `program`을 추가한다.
- Modify: `frontend/src/live/useLiveBundle.test.tsx`
  - 모든 `LiveSeriesData` fixture에 `program`을 추가한다.
- Modify: `frontend/src/live/workspace/DataWindow.test.tsx`
  - `useLiveSeries` mock 반환형에 `program`을 추가한다.

### Documentation

- Modify: `CONTEXT.md`
  - 프로그램 순매수의 키움 `0w` 수집, 30초 sidecar 저장, WS 표시 꼬리 구조를 정확히 기록한다.
- Modify: `docs/adr/0118-broker-full-specialization.md`
  - PR-F4의 “수집 WS 전환”에 이어 표시 경로도 WS fan-out한다는 amendment를 추가한다.

---

### Task 1: Backend PROGRAM Display Fan-out

**Files:**
- Modify: `tests/unit/live/test_stream.py:165-196`
- Modify: `hoga/live/stream.py:345-375`
- Modify: `hoga/live/snapshot.py:25-34`

**Interfaces:**
- Consumes: `WsTick(kind=SnapshotKind.PROGRAM, venue="KRX", payload={...})`
- Produces: latch의 최신 raw payload와 `LiveBuffer.publish(code, [LiveSnapshot(kind=PROGRAM)])`
- Preserves: NXT drop, active-code 입구 필터, JSONL/downsampler 미진입

- [ ] **Step 1: 기존 회귀 테스트를 새 표시 계약으로 변경한다**

`tests/unit/live/test_stream.py`의 기존 테스트 이름과 기대값을 다음 의미로 바꾼다.

```python
async def test_program_tick_routes_to_latch_and_display_buffer_not_storage(tmp_path):
    """KRX PROGRAM은 latch와 표시 buffer에 가지만 JSONL 저장에는 들어가지 않는다."""
    from hoga.live import program_trade_latch

    program_trade_latch.reset_for_tests()
    buf = LiveBuffer()
    display_q = buf.subscribe("005930")
    nxt_display_q = buf.subscribe("000660")
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(
        buffer=buf,
        writer=writer,
        date_fn=lambda: "20260605",
        phase_fn=lambda: "regular",
    )
    stream._gate_open = True

    now = int(time.time() * 1000)
    tick = WsTick(
        code="005930",
        t_ms=now,
        kind=SnapshotKind.PROGRAM,
        venue="KRX",
        payload={
            "code": "005930",
            "t_ms": now,
            "net_qty": 50,
            "net_amount": 2_500_000,
            "sell_qty": 100,
            "sell_amount": 5_000_000,
            "buy_qty": 150,
            "buy_amount": 7_500_000,
            "price": 50_000,
        },
    )
    await stream.on_tick(tick)
    await stream.on_tick(
        WsTick(
            code="000660",
            t_ms=now,
            kind=SnapshotKind.PROGRAM,
            venue="NXT",
            payload={"code": "000660", "t_ms": now, "net_qty": 1},
        )
    )

    latched = program_trade_latch.drain()
    assert set(latched) == {"005930"}
    assert latched["005930"]["net_qty"] == 50

    display_entry = await asyncio.wait_for(display_q.get(), timeout=1.0)
    assert display_entry == {
        **tick.payload,
        "kind": "program",
        "phase": "regular",
        "venue": "KRX",
    }
    assert nxt_display_q.empty()

    await stream.flush_once(now_ms=now + 10_000)
    assert not (tmp_path / "live" / "20260605" / "005930.jsonl").exists()
    program_trade_latch.reset_for_tests()
```

- [ ] **Step 2: 테스트를 실행해 표시 publish 부재로 실패하는지 확인한다**

Run:

```bash
uv run --extra dev pytest -q tests/unit/live/test_stream.py::test_program_tick_routes_to_latch_and_display_buffer_not_storage
```

Expected: `display_q.get()`이 timeout되어 FAIL.

- [ ] **Step 3: `PROGRAM` 분기에서 KRX만 latch와 표시 버퍼에 fan-out한다**

`hoga/live/stream.py`에서 일반 ingest 경로로 흘려보내지 말고 프로그램 분기 안에서 표시 snapshot을 직접 발행한다.

```python
if tick.kind is SnapshotKind.PROGRAM:
    if tick.venue != "KRX":
        return
    program_trade_latch.update(tick.code, dict(tick.payload))
    payload = {
        **tick.payload,
        "phase": self._phase_fn(),
        "venue": tick.venue,
    }
    snap = LiveSnapshot(t_ms=tick.t_ms, kind=tick.kind, payload=payload)
    await self._buffer.publish(tick.code, [snap], now_ms=_now_ms())
    return
```

`hoga/live/snapshot.py`의 `PROGRAM` 주석은 다음 계약으로 갱신한다.

```python
# 종목프로그램매매(키움 0w). stream.on_tick이 KRX 틱을 표시 buffer와
# program_trade_latch 양쪽으로 fan-out한다. 표시 buffer는 /api/live/series와
# WS push용이며, latch는 30초 sidecar 저장용이다. JSONL ingest에는 들어가지 않는다.
PROGRAM = "program"
```

- [ ] **Step 4: Task 1 테스트를 재실행한다**

Run:

```bash
uv run --extra dev pytest -q tests/unit/live/test_stream.py::test_program_tick_routes_to_latch_and_display_buffer_not_storage
```

Expected: PASS.

- [ ] **Step 5: Task 1 변경을 커밋한다**

```bash
git add \
  hoga/live/stream.py \
  hoga/live/snapshot.py \
  tests/unit/live/test_stream.py
git commit -m "feat(live): 프로그램 틱을 표시 WS 버퍼로 fan-out"
```

---

### Task 2: Backend Series Hydration Contract

**Files:**
- Modify: `tests/unit/live/test_buffer.py:37-52,100-115`
- Modify: `tests/unit/live/test_api.py:191-220`
- Modify: `hoga/live/buffer.py:137-193`

**Interfaces:**
- Consumes: `(code, SnapshotKind.PROGRAM.value)` deque
- Produces: `LiveBuffer.get_series(code)["programs"]: list[dict]`
- Produces: `GET /api/live/series?...` JSON의 `programs` 배열
- Preserves: `get_latest()`의 기존 orderbook/trade/broker 응답

- [ ] **Step 1: buffer와 API의 실패 테스트를 작성한다**

`test_get_series_returns_all_published`의 publish 목록과 assertions에 프로그램을 추가한다.

```python
_snap(
    t,
    SnapshotKind.PROGRAM,
    {"net_qty": 10 + tick, "net_amount": 1_000_000 + tick},
)
```

```python
assert len(series["programs"]) == 3
assert series["programs"][0]["kind"] == "program"
assert series["programs"][2]["net_qty"] == 12
```

subscriber 테스트는 네 번째 entry를 받고 프로그램 kind를 확인한다.

```python
received = [await asyncio.wait_for(q.get(), timeout=1.0) for _ in range(4)]
assert [entry["kind"] for entry in received] == [
    "ob",
    "trade",
    "broker",
    "program",
]
```

`test_get_live_series_returns_buffered_arrays`에도 프로그램 snapshot을 publish하고 REST 응답을 검증한다.

```python
LiveSnapshot(
    t_ms=t,
    kind=SnapshotKind.PROGRAM,
    payload={"net_qty": 10 + tick, "net_amount": 1_000_000 + tick},
)
```

```python
assert len(body["programs"]) == 3
assert body["programs"][-1]["net_qty"] == 12
```

- [ ] **Step 2: 세 테스트를 실행해 실패를 확인한다**

Run:

```bash
uv run --extra dev pytest -q \
  tests/unit/live/test_buffer.py::test_get_series_returns_all_published \
  tests/unit/live/test_buffer.py::test_subscribe_receives_published_entries \
  tests/unit/live/test_api.py::test_get_live_series_returns_buffered_arrays
```

Expected: `programs` 키 부재 또는 subscriber entry 수 불일치로 FAIL.

- [ ] **Step 3: `get_series()`에 프로그램 deque를 추가한다**

`hoga/live/buffer.py`의 lock 내부에서 프로그램 deque도 frozen tuple로 복사하고 응답에 넣는다.

```python
async with self._lock:
    ob_buf = self._buf.get((code, SnapshotKind.OB.value))
    tr_buf = self._buf.get((code, SnapshotKind.TRADE.value))
    br_buf = self._buf.get((code, SnapshotKind.BROKER.value))
    pr_buf = self._buf.get((code, SnapshotKind.PROGRAM.value))
    snapshots = tuple(ob_buf) if ob_buf else ()
    trades = tuple(tr_buf) if tr_buf else ()
    brokers = tuple(br_buf) if br_buf else ()
    programs = tuple(pr_buf) if pr_buf else ()

return {
    "code": code,
    "snapshots": [_strip_t_only(e) for e in snapshots],
    "trades": [_strip_t_only(e) for e in trades],
    "brokers": [_strip_t_only(e) for e in brokers],
    "programs": [_strip_t_only(e) for e in programs],
}
```

`get_latest()`는 프로그램을 추가하지 않는다. spot snapshot 소비자는 프로그램 카드를 읽지 않으며 계약 확장은 별도 요구사항이다.

- [ ] **Step 4: Task 1과 Task 2의 백엔드 테스트를 함께 실행한다**

Run:

```bash
uv run --extra dev pytest -q \
  tests/unit/live/test_stream.py::test_program_tick_routes_to_latch_and_display_buffer_not_storage \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py::test_get_live_series_returns_buffered_arrays
```

Expected: PASS.

- [ ] **Step 5: backend hydration 변경을 커밋한다**

```bash
git add \
  hoga/live/buffer.py \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py
git commit -m "feat(live): 프로그램 표시 버퍼를 series 응답에 포함"
```

---

### Task 3: Frontend Live Transport and Buffer Contract

**Files:**
- Modify: `frontend/src/api/types.ts:548-557`
- Modify: `frontend/src/live/liveSnapshotBuffer.ts:34-112`
- Modify: `frontend/src/api/liveSeries.ts:42-200`
- Modify: `frontend/src/live/liveSnapshotBuffer.test.ts`
- Modify: `frontend/src/api/liveSeries.test.tsx`
- Modify: `frontend/src/api/liveSeries.test-d.ts`
- Modify: `frontend/src/live/LivePage.test.tsx`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`
- Modify: `frontend/src/live/workspace/DataWindow.test.tsx`

**Interfaces:**
- Consumes: WS `{ch:"live", code, data:{kind:"program", t_ms, net_qty, net_amount, ...}}`
- Consumes: REST `LiveSeriesResponse.programs`
- Produces: `LiveSeriesData.program: ReadonlyArray<Record<string, unknown>>`
- Preserves: KRX/NXT venue filtering은 `ob`/`trade`에만 적용; 프로그램은 서버에서 KRX로 강제됨

- [ ] **Step 1: 잠금 파일 기준으로 frontend 의존성을 설치한다**

Run:

```bash
cd frontend
npm ci
```

Expected: `package-lock.json` 변경 없이 dependencies 설치 성공.

- [ ] **Step 2: frontend buffer와 hook의 실패 테스트를 작성한다**

`liveSnapshotBuffer.test.ts`의 kind grouping에 프로그램을 추가한다.

```typescript
buf.push({ t_ms: 1, kind: 'program', net_qty: 10, net_amount: 1_000_000 });
expect(buf.get('program')).toHaveLength(1);
```

hydrate 테스트에도 프로그램 배열을 추가한다.

```typescript
program: [{ t_ms: 12, kind: 'program', net_qty: 10, net_amount: 1_000_000 }],
```

```typescript
expect(buf.get('program')).toHaveLength(1);
```

`liveSeries.test.tsx`의 초기 payload와 WS 테스트에 프로그램을 추가한다.

```typescript
programs: [{ t_ms: 70, kind: 'program', net_qty: 10, net_amount: 1_000_000 }],
```

```typescript
expect(result.current.program).toHaveLength(1);
```

```typescript
sock.message({
  ch: 'live',
  code: '005930',
  data: {
    t_ms: 101,
    kind: 'program',
    venue: 'KRX',
    net_qty: 20,
    net_amount: 2_000_000,
  },
});
```

```typescript
await waitFor(() => expect(result.current.program).toHaveLength(1));
```

- [ ] **Step 3: frontend 테스트를 실행해 타입 또는 길이 assertion 실패를 확인한다**

Run:

```bash
cd frontend
npm test -- --run src/live/liveSnapshotBuffer.test.ts src/api/liveSeries.test.tsx
```

Expected: `program`이 `SnapshotKind`에 없다는 타입 오류 또는 runtime buffer가 frame을 버려 길이 0으로 FAIL.

- [ ] **Step 4: 네 번째 live kind를 타입과 buffer에 추가한다**

`frontend/src/api/types.ts`:

```typescript
export interface LiveSnapshotEntry {
  t_ms: number;
  kind: 'ob' | 'trade' | 'broker' | 'program';
  [field: string]: unknown;
}
```

`frontend/src/live/liveSnapshotBuffer.ts`:

```typescript
export type SnapshotKind = 'ob' | 'trade' | 'broker' | 'program';

const KINDS: readonly SnapshotKind[] = ['ob', 'trade', 'broker', 'program'] as const;
```

`byKind`와 `snapshot` 초기값에 다음 필드를 각각 추가한다.

```typescript
program: [],
```

```typescript
program: Object.freeze([]),
```

- [ ] **Step 5: `useLiveSeries`의 초기 hydration과 반환 계약을 확장한다**

`LiveSeriesResponse`와 `LiveSeriesData`에 다음 필드를 추가한다.

```typescript
programs: Array<Record<string, unknown>>;
```

```typescript
program: ReadonlyArray<Record<string, unknown>>;
```

empty stable reference를 추가한다.

```typescript
const EMPTY_PROGRAM_SNAPSHOTS: ReadonlyArray<Record<string, unknown>> =
  Object.freeze([]);
```

구버전 백엔드와 잠깐 교차 배포되어도 크래시하지 않도록 hydration에는 runtime fallback을 둔다.

```typescript
program: (initial.data.programs ?? []) as Array<{ t_ms: number; kind: string }>,
```

반환 객체에 stable buffer read를 추가한다.

```typescript
program: bufferVisible
  ? readKind(bufferRef.current, 'program', tick)
  : EMPTY_PROGRAM_SNAPSHOTS,
```

모든 `LiveSeriesData` fixture와 `useLiveSeries` mock에 아래 필드를 명시해 새 계약을 컴파일 타임에 고정한다.

```typescript
program: [],
```

모든 `LiveSeriesResponse` 타입 fixture에는 다음 필드를 추가한다.

```typescript
programs: [],
```

- [ ] **Step 6: frontend transport 테스트와 build를 실행한다**

Run:

```bash
cd frontend
npm test -- --run src/live/liveSnapshotBuffer.test.ts src/api/liveSeries.test.tsx
npm run build
```

Expected: 모든 테스트 PASS, TypeScript build PASS.

- [ ] **Step 7: frontend transport 변경을 커밋한다**

```bash
git add \
  frontend/src/api/types.ts \
  frontend/src/api/liveSeries.ts \
  frontend/src/api/liveSeries.test.tsx \
  frontend/src/api/liveSeries.test-d.ts \
  frontend/src/live/liveSnapshotBuffer.ts \
  frontend/src/live/liveSnapshotBuffer.test.ts \
  frontend/src/live/LivePage.test.tsx \
  frontend/src/live/useLiveBundle.test.tsx \
  frontend/src/live/workspace/DataWindow.test.tsx
git commit -m "feat(live): 프로그램 WS 스냅샷을 프론트 버퍼에 노출"
```

---

### Task 4: Pure Sidecar + WS Tail Merge

**Files:**
- Create: `frontend/src/live/programTradeLiveTail.ts`
- Create: `frontend/src/live/programTradeLiveTail.test.ts`

**Interfaces:**
- Consumes: `ProgramTradeSeries | null | undefined`
- Consumes: `readonly Record<string, unknown>[]` from `LiveSeriesData.program`
- Produces: `mergeProgramTradeSeriesWithLiveTail(...): ProgramTradeSeries`
- Guarantees: strict seam, last-wins dedup, ascending order, explicit null delta, frozen source identifier

- [ ] **Step 1: 병합 의미론을 고정하는 단위 테스트를 작성한다**

`frontend/src/live/programTradeLiveTail.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mergeProgramTradeSeriesWithLiveTail } from './programTradeLiveTail';

describe('mergeProgramTradeSeriesWithLiveTail', () => {
  it('keeps persisted history and appends only snapshots after the seam', () => {
    const persisted = {
      source: 'kis_program_trade' as const,
      points: [
        {
          t: 100,
          net_qty: 1,
          net_amount: 1_000,
          delta_qty: 1,
          delta_amount: 1_000,
          gap_risk: false,
        },
        {
          t: 200,
          net_qty: 2,
          net_amount: 2_000,
          delta_qty: 1,
          delta_amount: 1_000,
          gap_risk: false,
        },
      ],
    };
    const live = [
      { t_ms: 150, kind: 'program', net_qty: 99, net_amount: 99_000 },
      { t_ms: 200, kind: 'program', net_qty: 20, net_amount: 20_000 },
      { t_ms: 300, kind: 'program', net_qty: 3, net_amount: 3_000 },
    ];

    expect(mergeProgramTradeSeriesWithLiveTail(persisted, live)).toEqual({
      source: 'kis_program_trade',
      points: [
        ...persisted.points,
        {
          t: 300,
          net_qty: 3,
          net_amount: 3_000,
          delta_qty: null,
          delta_amount: null,
          gap_risk: false,
        },
      ],
    });
  });

  it('sorts out-of-order live snapshots and keeps the last duplicate', () => {
    const merged = mergeProgramTradeSeriesWithLiveTail(null, [
      { t_ms: 300, kind: 'program', net_qty: 3, net_amount: 3_000 },
      { t_ms: 100, kind: 'program', net_qty: 1, net_amount: 1_000 },
      { t_ms: 300, kind: 'program', net_qty: 30, net_amount: 30_000 },
    ]);

    expect(merged.points.map((point) => point.t)).toEqual([100, 300]);
    expect(merged.points[1].net_qty).toBe(30);
  });

  it('drops invalid timestamps and normalizes invalid cumulative values to null', () => {
    const merged = mergeProgramTradeSeriesWithLiveTail(undefined, [
      { t_ms: 'bad', kind: 'program', net_qty: 1, net_amount: 1_000 },
      { t_ms: 100, kind: 'program', net_qty: Number.NaN, net_amount: 'bad' },
    ]);

    expect(merged).toEqual({
      source: 'kis_program_trade',
      points: [{
        t: 100,
        net_qty: null,
        net_amount: null,
        delta_qty: null,
        delta_amount: null,
        gap_risk: false,
      }],
    });
  });
});
```

- [ ] **Step 2: 새 테스트가 import 실패로 RED인지 확인한다**

Run:

```bash
cd frontend
npm test -- --run src/live/programTradeLiveTail.test.ts
```

Expected: `programTradeLiveTail` module을 찾지 못해 FAIL.

- [ ] **Step 3: 순수 병합 함수를 구현한다**

`frontend/src/live/programTradeLiveTail.ts`:

```typescript
import type { ProgramTradePoint, ProgramTradeSeries } from '../api/types';

function nullableSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function livePoint(snapshot: Record<string, unknown>): ProgramTradePoint | null {
  const t = snapshot.t_ms;
  if (typeof t !== 'number' || !Number.isSafeInteger(t)) return null;
  return {
    t,
    net_qty: nullableSafeInteger(snapshot.net_qty),
    net_amount: nullableSafeInteger(snapshot.net_amount),
    delta_qty: null,
    delta_amount: null,
    gap_risk: false,
  };
}

export function mergeProgramTradeSeriesWithLiveTail(
  persisted: ProgramTradeSeries | null | undefined,
  liveSnapshots: readonly Record<string, unknown>[],
): ProgramTradeSeries {
  const persistedPoints = persisted?.points ?? [];
  let seamMs = -Infinity;
  for (const point of persistedPoints) {
    if (point.t > seamMs) seamMs = point.t;
  }

  const byTime = new Map<number, ProgramTradePoint>();
  for (const point of persistedPoints) byTime.set(point.t, point);
  for (const snapshot of liveSnapshots) {
    const point = livePoint(snapshot);
    if (point !== null && point.t > seamMs) byTime.set(point.t, point);
  }

  return {
    source: persisted?.source ?? 'kis_program_trade',
    points: [...byTime.values()].sort((a, b) => a.t - b.t),
  };
}
```

- [ ] **Step 4: 병합 단위 테스트를 통과시킨다**

Run:

```bash
cd frontend
npm test -- --run src/live/programTradeLiveTail.test.ts
```

Expected: PASS.

- [ ] **Step 5: 순수 병합 단위를 커밋한다**

```bash
git add \
  frontend/src/live/programTradeLiveTail.ts \
  frontend/src/live/programTradeLiveTail.test.ts
git commit -m "feat(live): 프로그램 sidecar와 WS 꼬리 병합"
```

---

### Task 5: Integrate the WS Tail into the Shared Chart Bundle

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts:739-790`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: `live.program` from Task 3
- Consumes: `mergeProgramTradeSeriesWithLiveTail` from Task 4
- Produces: `computedChartBundle.program_trade` containing history + current WS tail
- Downstream: chart program pane and `ProgramWindow` receive the same bundle through `GroupChartLink`

- [ ] **Step 1: hook 통합 회귀 테스트를 작성한다**

기존 “merges sidecar program trade into the chart and live bundles” 테스트에 WS 꼬리를 추가하거나 별도 테스트를 작성한다. live fixture는 다음 점을 포함한다.

```typescript
const liveWithProgram: LiveSeriesData = {
  ...liveFixture,
  program: [
    {
      t_ms: 1_779_840_120_000,
      kind: 'program',
      venue: 'KRX',
      net_qty: 2_000,
      net_amount: 140_000_000,
    },
  ],
};
```

sidecar 마지막 점보다 WS 점이 뒤에 있고 결과 bundle에 두 점이 모두 있어야 한다.

```typescript
expect(result.current.bundle?.program_trade?.points).toEqual([
  programPoint,
  {
    t: 1_779_840_120_000,
    net_qty: 2_000,
    net_amount: 140_000_000,
    delta_qty: null,
    delta_amount: null,
    gap_risk: false,
  },
]);
```

프로그램 indicator와 data-window demand가 모두 꺼진 fixture에서는 live 점을 bundle에 넣지 않는 테스트도 추가한다.

```typescript
expect(result.current.bundle?.program_trade?.points).toEqual([]);
```

- [ ] **Step 2: hook 테스트가 WS 점 누락으로 실패하는지 확인한다**

Run:

```bash
cd frontend
npm test -- --run src/live/useLiveBundle.test.tsx
```

Expected: sidecar 점만 있고 WS 점이 없어 FAIL.

- [ ] **Step 3: 공통 chart bundle 조립부에 병합을 연결한다**

`useLiveBundle.ts`에 import를 추가한다.

```typescript
import { mergeProgramTradeSeriesWithLiveTail } from './programTradeLiveTail';
```

sidecar 필드 복사 직후, `if (sidecarSource)` 바깥에서 유효 수요 게이트를 적용한다.

```typescript
if (effProgramTradeEnabled) {
  built.program_trade = mergeProgramTradeSeriesWithLiveTail(
    built.program_trade,
    live.program,
  );
}
```

`computedChartBundle`의 dependency array에 두 값을 추가한다.

```typescript
live.program,
effProgramTradeEnabled,
```

`ProgramWindow`에는 새 `useLiveSeries` 호출을 추가하지 않는다. `ChartWindow`가 갱신된 bundle을 `publishGroupChartLink`로 발행하므로 기존 `series={link.bundle?.program_trade ?? null}`가 최신 점을 받는다.

- [ ] **Step 4: hook, 데이터 창, projector 테스트를 실행한다**

Run:

```bash
cd frontend
npm test -- --run \
  src/live/useLiveBundle.test.tsx \
  src/live/workspace/DataWindow.test.tsx \
  src/chart/projectors/programTrade.test.ts \
  src/sidebar/ProgramTradeSummaryCard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: bundle 통합 변경을 커밋한다**

```bash
git add \
  frontend/src/live/useLiveBundle.ts \
  frontend/src/live/useLiveBundle.test.tsx
git commit -m "fix(live): 프로그램 창에 WS 최신 꼬리를 반영"
```

---

### Task 6: Documentation and End-to-End Verification

**Files:**
- Modify: `CONTEXT.md:153-155`
- Modify: `docs/adr/0118-broker-full-specialization.md`

**Interfaces:**
- Documents: KRX-only fan-out, 30초 durable sidecar, 15분 display buffer, strict seam merge
- Verifies: backend tests, frontend tests, type build, lint, clean worktree

- [ ] **Step 1: 프로그램 순매수 용어 정의를 현재 구조에 맞게 고친다**

`CONTEXT.md`의 프로그램 순매수 정의는 다음 사실을 포함하도록 교체한다.

```markdown
**프로그램 순매수 (Program Trade Net Buy)**:
The Kiwoom `0w` stock-level intraday cumulative program-trade net-buy series
for one stock Code. A KRX tick fans out to two consumers: the display-only
LiveBuffer publishes it immediately to `/api/live/series` and the shared live
WebSocket, while `program_trade_latch` retains the latest value for
ProgramTradeCollector's 30-second durable sidecar flush. `/live` merges the
persisted `/api/range` history with the strict-after-seam 15-minute WS tail;
the chart pane and ProgramWindow consume that same merged RangeBundle.
```

`_Avoid_`에는 다음 금지 표현을 반영한다.

```markdown
_Avoid_: treating it as KIS REST data; saying that the WS tick is written to
JSONL/parquet; adding a second ProgramWindow subscription.
```

- [ ] **Step 2: ADR-0118에 표시 경로 amendment를 추가한다**

ADR의 PR-F4 설명 뒤에 다음 결정을 기록한다.

```markdown
### 2026-07-24 amendment — 0w display fan-out

PR-F4 replaced KIS REST collection with Kiwoom `0w`, but initially routed the
tick only to `program_trade_latch`; `/live` therefore remained bounded by the
30-second flush plus the today-range refresh cadence. KRX `PROGRAM` ticks now
also publish to the display-only `LiveBuffer` and return before JSONL ingest.
The frontend appends that 15-minute live tail strictly after the persisted
program-trade seam in the shared chart bundle. This preserves durable storage,
avoids a second subscription in `ProgramWindow`, and gives both the chart pane
and data window the same near-real-time value.
```

- [ ] **Step 3: backend 전체 관련 테스트를 실행한다**

Run:

```bash
uv run --extra dev pytest -q \
  tests/unit/live/test_stream.py \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py \
  tests/unit/live/test_program_trade_collector.py \
  tests/unit/live/test_program_trade_store.py
```

Expected: PASS.

- [ ] **Step 4: frontend 전체 관련 테스트를 실행한다**

Run:

```bash
cd frontend
npm test -- --run \
  src/live/liveSnapshotBuffer.test.ts \
  src/api/liveSeries.test.tsx \
  src/live/programTradeLiveTail.test.ts \
  src/live/useLiveBundle.test.tsx \
  src/live/workspace/DataWindow.test.tsx \
  src/chart/projectors/programTrade.test.ts \
  src/sidebar/ProgramTradeSummaryCard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: 정적 검증을 실행한다**

Run:

```bash
cd frontend
npm run build
npm run lint
```

Expected: TypeScript/Vite build PASS, ESLint PASS.

- [ ] **Step 6: 전체 회귀 스위트를 실행한다**

Run:

```bash
uv run --extra dev pytest -q
cd frontend
npm test -- --run
```

Expected: backend와 frontend 전체 테스트 PASS.

- [ ] **Step 7: 문서와 최종 검증 변경을 커밋한다**

```bash
git add CONTEXT.md docs/adr/0118-broker-full-specialization.md
git commit -m "docs(live): 프로그램 WS 표시 꼬리 계약 기록"
```

- [ ] **Step 8: 최종 diff와 작업 트리를 확인한다**

Run:

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected:

- `git diff --check` 출력 없음.
- `git status --short` 출력 없음.
- 최근 로그에 backend fan-out, backend hydration, frontend buffer, tail merge, bundle integration, docs 커밋이 순서대로 보임.

---

## Acceptance Criteria

- 브라우저가 KRX `0w` WS frame을 받은 후 프로그램 카드의 누적 순매수 금액·수량이 다음 150ms trailing flush에 갱신된다.
- 차트의 프로그램 순매수 pane과 프로그램 데이터 창이 같은 최신 점을 표시한다.
- 새로고침 또는 종목 전환 직후 `/api/live/series.programs`가 최대 15분의 WS tail을 복구한다.
- `/api/range`가 제공한 당일 전체 프로그램 이력은 유지되고 WS tail과 중복되지 않는다.
- NXT `PROGRAM` 틱은 latch, 표시 buffer, 저장 파일 어디에도 들어가지 않는다.
- 프로그램 WS 틱은 JSONL/downsampler/parquet ingest에 들어가지 않는다.
- raw WS 틱에 없는 delta를 프론트가 추정하지 않는다.
- 프로그램 indicator와 data-window demand가 모두 꺼져 있으면 bundle에 live program 점을 주입하지 않는다.
- 기존 10호가, 체결, 거래원 live series 계약과 venue filtering이 변하지 않는다.
- 관련 backend/frontend 테스트, 전체 테스트, frontend build/lint가 모두 통과한다.
