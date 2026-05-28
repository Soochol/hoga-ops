# /live 일봉 백필 분리 — D-direct backend endpoint — Design

**Date**: 2026-05-28
**Status**: Draft
**Scope**: both (backend + frontend)
**Related**: ADR-0013 (RangeBundle single read-path), ADR-0020 (invariant catalog),
ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire), ADR-0045 (spec declares invariants),
ADR-0046 (live MA fork from replay), [2026-05-28 live-kis-past-candles spec](2026-05-28-live-kis-past-candles-design.md),
[2026-05-28 live-daily-pane-policy spec](2026-05-28-live-daily-pane-policy-design.md).

신설 ADR: `docs/adr/0048-live-daily-direct-backfill.md` (본 spec 채택과 함께).

---

## Problem

`/live` 페이지의 캔들 차트는 사용자가 과거로 스크롤할 때 최대 **~250 calendar days
(~170 거래일 ≈ 8개월)** 분량의 일봉만 보여준다. 더 과거로 스크롤하면
`clampEngaged=true` 가 트리거되어 UI에서 한도 도달 메시지로 막힌다.

원인은 아키텍처 결정에 있다 (ADR-0040):

- 백엔드 `GET /api/live/past-candles` 는 **항상 1분봉만** 반환한다 (KIS TR_ID
  `FHKST03010230`, `inquire-time-dailychartprice`).
- 프론트엔드 `useLiveBundle` 은 D/W/M timeframe 에서 `aggregateCalendar` 로 그 1분봉을
  클라이언트 사이드에서 일/주/월봉으로 재집계한다.
- 백엔드 [hoga/live/api.py:27](../../../hoga/live/api.py#L27) 의 `_PAST_MAX_DAYS = 250`,
  프론트 [frontend/src/live/useLiveBundle.ts:17](../../../frontend/src/live/useLiveBundle.ts#L17) 의
  `PAST_CANDLES_MAX_DAYS = 250` 가 하드 캡.
- 캡 없이 일봉 N년치를 받으려면 N × ~96,000 개의 1분봉을 한 JSON으로 전송해야 해서
  payload 가 폭발 (1년 = ~5MB, 5년 = ~25MB). 250일 캡은 사실상 payload 보호 장치.

사용자 의사: "**일봉은 캡 없이 끝까지 스크롤할 수 있어야 한다**". 분봉(1m/3m/5m/10m/15m/30m)은
현행 250일 캡 유지.

## Invariants

본 spec 이 건드리는 시스템들이 현재 보존하고 있는 속성들:

- **Replay read-path 단일성**: `/replay` 페이지의 candle/indicator 데이터는 오로지
  `/api/range` → RangeBundle 만 거친다. 근거: ADR-0013, ADR-0040 spec brief 제약.
- **분봉 wire 안정성**: `/api/live/past-candles` 응답 스키마와
  `kis-past-candles/<code>/<YYYYMMDD>.json` 캐시 namespace 는 호환성을 유지한다. 근거:
  ADR-0040 spec brief 제약 #2, [hoga/live/past_candles_cache.py](../../../hoga/live/past_candles_cache.py).
- **lightweight-charts t_ms monotonic**: RangeBundle.candles 와
  LivePastCandlesResponse.candles 는 모두 ascending t_ms 이고 중복 t_ms 가 없다. 근거:
  [buildLiveBundle.ts](../../../frontend/src/live/buildLiveBundle.ts) 의 dedupe 가정,
  lightweight-charts API 요구.
- **OHLC 일관성**: `low ≤ min(open, close) ≤ max(open, close) ≤ high`, `close > 0`,
  `volume ≥ 0`. 근거: ADR-0020 invariant catalog, ADR-0040 defensive parse 정책.
- **단일 read-path 균열의 지역성**: ADR-0013 을 깨뜨리는 분기(현재 ADR-0040 의
  분봉 wire)는 `/live` 페이지 도메인 안에 갇혀 있다. 근거: ADR-0040 Consequences.
- **clampEngaged 의미적 일관성**: `clampEngaged=true` 는 "사용자 요청 from 이 시스템
  한도 밖" 이라는 의미. UI 는 이 값을 보고 사용자에게 한도 도달을 표시한다. 근거:
  [useLiveBundle.ts:127](../../../frontend/src/live/useLiveBundle.ts#L127) 현재 사용처.

## Invariant impact

| Invariant | 영향 | 비고 |
|---|---|---|
| Replay read-path 단일성 | preserves | 신규 `/api/live/past-daily-candles` 는 `/live` 전용. `/api/range` 무변경. |
| 분봉 wire 안정성 | preserves | `/api/live/past-candles` 핸들러/캐시 zero diff. 형제 핸들러로 추가. |
| lightweight-charts t_ms monotonic | preserves | 신규 핸들러의 step 6 (dedupe + sort + filter) 가 ASC + unique 보장. |
| OHLC 일관성 | preserves | `fetch_past_daily_candles` 의 boundary defense 가 위반 row 를 skip 하고 `data_warnings.invariant_violation` 으로 surface. |
| 단일 read-path 균열의 지역성 | preserves (with explicit extension) | 신규 ADR-0048 이 ADR-0040 과 *병렬* 균열임을 명문화. `/live` 도메인 범위 동일 유지. |
| clampEngaged 의미적 일관성 | intentionally redefines (per-timeframe) | 분봉은 그대로 250d 클램프, 일봉은 항상 false. |

**"intentionally redefines" 정당화**: 250일 캡은 분봉 payload 보호 장치였고 D-direct 는
그 비용을 ~1/390 로 줄이므로, 같은 변수에 한 임계값을 강제하는 것이 오히려 의미를
흐린다. timeframe 별로 다른 의미를 가짐을 명문화하고, frontend 분기 코드는 useLiveBundle
한 곳에 집중한다.

## Goals

- 일봉(D) timeframe 에서 250일 캡 제거 → 사용자가 KIS 보유 기간 한도까지 과거로
  스크롤 가능.
- 주봉(W) / 월봉(M) 도 같은 데이터 소스(D-direct backend)로 frontend 재집계.
- 분봉(1m/3m/5m/10m/15m/30m) 의 현행 동작 zero diff.
- `/replay` 페이지 zero diff.
- ADR-0040 supersede 가 아닌 **병렬 ADR (ADR-0048)** 으로 균열을 명문화.

## Non-Goals

- `/replay` 페이지 변경.
- 분봉 250일 캡 변경.
- 분봉 wire 스키마 / cache namespace 변경 (응답 필드, 디렉토리 layout, 파일 형식 모두 zero diff).
- ADR-0040 supersede.
- 다른 timeframe(예: tick, 60m) 도입.
- payload 압축/스트리밍 최적화.
- WebSocket aggregator (별도 spec 거리).
- hogaplay invariant 자체 변경.

**스코프 내 명시 (Non-Goals 아님)**:

- 분봉 `PastCandlesCache` 의 today negative caching 도입. 일봉 path 와 동일 패턴으로
  통일 — wire/namespace 무변경, cache 내부 동작만 강화. 두 path 가 형제 구조라는 본
  spec 의 아키텍처 원칙과 정합 (사용자 의사 grill Q2).

## Design

### Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│  /live page                                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  useLiveBundle (frontend)                                 │    │
│  │                                                            │    │
│  │  isMinute(tf) ──yes──► useLivePastCandles (분봉 wire 유지)│    │
│  │       │                          │                         │    │
│  │       no                         ▼                         │    │
│  │       ▼               /api/live/past-candles (250d cap)    │    │
│  │  useLivePastDailyCandles  ◄── 신규                         │    │
│  │       │                                                    │    │
│  │       ▼                                                    │    │
│  │  /api/live/past-daily-candles?from=...&to=...              │    │
│  │       (NO cap — 무제한)                                    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  Frontend post-processing:                                        │
│   - timeframe == 'D' → use daily bars 그대로                      │
│   - timeframe == 'W' or 'M' → aggregateCalendar(dailyBars,'W'|'M')│
│                                                                   │
│  clampEngaged (useLiveBundle):                                    │
│   - isMinute: historicalFromDate < (today - 250d) 시 true         │
│   - D/W/M: 항상 false (무제한)                                    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  hoga/live (backend)                                              │
│  ┌────────────────────────────────────────────────────────┐      │
│  │  api.py                                                 │      │
│  │   - 기존 /past-candles 핸들러 무변경                    │      │
│  │   - 신규 /past-daily-candles 핸들러 추가                │      │
│  │       _validate_daily_past_request(code, from, to)      │      │
│  │       cap = NONE; rate-limit 은 partial response 로 처리│      │
│  └────────────────────────────────────────────────────────┘      │
│  ┌────────────────────────────────────────────────────────┐      │
│  │  past_daily_candles_cache.py (신설) — 메모리 only        │      │
│  │   - per-code 누적 batch 리스트 (dict[code, list[...]])   │      │
│  │   - today 메모리 TTL (60s) + negative cache              │      │
│  │   - 디스크 X (데이터 양 작아서 메모리 충분; restart =    │      │
│  │     자연 invalidation)                                    │      │
│  └────────────────────────────────────────────────────────┘      │
│  ┌────────────────────────────────────────────────────────┐      │
│  │  kis_client.py                                          │      │
│  │   - 신규 fetch_past_daily_candles(code, from, to)        │      │
│  │     TR_ID: FHKST03010100 (inquire-daily-itemchartprice)  │      │
│  │     period code "D"                                      │      │
│  │     KIS quirk (응답 외 날짜) defensive parse             │      │
│  │     rate-limit / api error → 기존 typed errors 답습      │      │
│  └────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

핵심 분리: 분봉 path 와 일봉 path 는 핸들러/캐시/KIS 메서드 모두 **형제 구조**로 완전
분리. ADR-0040 의 spec brief 제약("/replay 영향 0", "분봉 wire 무변경")이 자연 충족.

### D1. Wire (응답 스키마)

`GET /api/live/past-daily-candles?code=<6digits>&from=<YYYYMMDD>&to=<YYYYMMDD>`

응답:

```json
{
  "code": "005930",
  "from": "20060101",
  "to": "20260528",
  "candles": [
    { "t_ms": 1136080800000, "open": 12345, "high": 12500, "low": 12200, "close": 12450, "volume": 1234567 }
  ],
  "cached_batches": ["20060101__20151231", "20160101__20251231"],
  "fresh_batches": ["20260101__20260528"],
  "data_warnings": []
}
```

필드 노트:

- `t_ms`: 그 거래일의 **regular session open** (KST 09:00:00) timestamp.
  lightweight-charts axis 가 D timeframe 에서 일자의 첫 모먼트를 candle anchor 로 인식
  (기존 `aggregateCalendar` 의 D output 과 동일 alignment).
- `candles`: ascending t_ms 정렬, 비거래일은 row 없음 (KIS 응답 그대로 — defensive
  parse 가 quirk 차단).
- `cached_batches` / `fresh_batches`: 분봉 wire 의 `cached_dates`/`fresh_dates` 와 의미
  대칭. 디버그용.
- `data_warnings`: ADR-0040 패턴 답습 — `{batch, reason, msg}` 객체 list. reason 후보:
  `kis_rate_limit`, `kis_api_error`, `invariant_violation` (close ≤ 0 등).
  `cache_write_failed` 는 해당 없음 (메모리 only).

422 응답:

- `invalid_code` — code 가 6자리 숫자가 아님
- `invalid_date` — from/to 가 YYYYMMDD 형식이 아님
- `from_after_to` — from > to
- `date_in_future` — to > today_kst

**date_range_too_large 422 는 발생시키지 않는다** (D-direct 는 무제한).

### D2. 캐시 구조 — 프로세스 메모리 only

**디스크 캐시 안 둔다** (grill Q4 결정). 일봉 데이터는 너무 작아서 디스크가 필요 없음:

- 1 종목 20년치 = ~5,000 bars × ~50 bytes ≈ **250 KB**
- 실 사용 패턴(2-3 종목 비교): **< 1 MB**
- 절대 worst case (50 종목 × 20년) = ~12 MB

분봉 path 가 disk 를 쓰는 이유는 250일 × 50종목 ≈ 300 MB 가 메모리에 못 들어가기 때문.
일봉은 그 제약이 없음. 메모리 only 로 가면 다음이 모두 사라짐:

- 디스크 파일 형식 / 파일명 명세
- atomic_write, OSError, cache_write_failed, 권한/디스크 full 처리
- corrupt file 처리 (`list_batches ignores corrupt name`)
- KIS data 정정 후 cache 가 stale 상태로 영속하는 위험 (Grill Q3) — process restart 자연 회복
- "operator 가 파일 삭제해야 KIS 재호출" 운영 절차

**구조** (개략 — 정확한 코드는 plan 단계 결정):

```python
class PastDailyCandlesCache:
    # code -> 누적된 batch 리스트 (insertion order)
    # 각 batch: (from_date, to_date, bars)
    _per_code: dict[str, list[tuple[date, date, list[dict]]]]

    # today: code -> (fetched_at_monotonic, dict | None)
    # tri-state: 키 없음 = cache miss, value 가 dict = hit, value 가 None = negative cache
    _today_mem: dict[str, tuple[float, dict | None]]
```

캐시 정책:

- **per-batch in memory** — 한 KIS 호출 결과를 한 (from, to, bars) entry 로 메모리에
  보관. 파일 / 파일명 없음.
- **immutable within process lifetime** — 일봉은 한 번 확정되면 절대 바뀌지 않음. 캐시
  invalidation 없음. process restart 가 자연 invalidation.
- **today 분리** — today 일봉은 batch 에 절대 포함되지 않음. `_today_mem` 에만, 60s TTL.
  자정 over → 익일 첫 요청 시 today 가 past 로 굳어 batch list 에 자연 포함.
- **today negative caching** — today 가 비거래일(주말/공휴일) 인 경우 KIS 가 빈 응답을
  반환할 가능성. 그 결과(`None`) 자체를 메모리에 60s TTL 로 캐시하여 페이지 새로고침/
  자동 prefetch 마다 KIS 가 반복 호출되는 것을 막는다. TTL 만료 시 다시 fetch.
- **부분 겹침 허용** — 사용자가 `[2020, 2025]` 받은 후 `[2018, 2022]` 요청하면
  `2018-2019` 만 새 batch 로 추가 (gap fill). 두 batch 가 부분 겹침 가능 — union 시
  t_ms dedupe (last-write-wins). 메모리 비용보다 코드 단순성 우선.

**Trade-off 명시** (사용자 사전 동의):

- backend restart 시 다음 페이지 열기에서 5년치 cold start = KIS 페이지네이션 ~13회
  ≈ 10-30초 loading. 단일 사용자 로컬 dev tool 의 사용 패턴(자주 restart 안 함, 종목
  비교 자주 안 함)에서 수용 가능.
- 분봉 path 와 비대칭 (분봉은 disk + memory). 정당화: **데이터 양이 다르다** —
  분봉 ~300MB worst case → disk 필요, 일봉 ~12MB worst case → 메모리 충분.

### D3. Cache lookup 알고리즘 (핸들러 책임)

요청 `(code, req_from, req_to)`:

1. **Read existing batches from memory**: `cache._per_code.get(code, [])` 로 누적된
   (b_from, b_to, bars) 리스트 가져옴.
2. **Filter by intersection**: `b_to >= req_from and b_from <= req_to` 인 batch 만
   취해서 `loaded_bars` 에 누적, `cached_batches` 에 `f"{b_from}__{b_to}"` 형식으로
   기록 (디버그용 라벨; 메모리에 파일명은 없지만 wire response 에는 그대로 surface).
3. **Compute gaps**: 기존 batch coverage 에서 `[req_from, min(req_to, today-1)]` 를
   빼서 gap intervals 계산. 인접 batch 는 coalesce (예: `[(2020,2022), (2023,2025)]`
   는 `[(2020, 2025)]` 로 합쳐 처리).
4. **Fetch gaps**: 각 gap 에 대해 `kis.fetch_past_daily_candles(code, gap_from, gap_to)`
   호출 → `DailyCandleFetchResult`. 응답의 `candles` 를 새 batch 로
   `cache._per_code[code].append((gap_from_date, gap_to_date, bars))` 추가, `loaded_bars`
   에도 누적, `fresh_batches` 에 기록. 응답의 `violations` 는 각각 `data_warnings` 에
   추가 (reason=`invariant_violation`, batch=해당 gap, detail=violation 의 detail).
   - `KisRateLimitError` → `data_warnings` 에 기록, **break** (다음 gap 도 시도 안
     함; 분봉 핸들러의 `aborted` 패턴 답습).
   - `KisApiError` → `data_warnings` 에 기록, **continue** (다음 gap 시도).
   - **caching policy**: violations 가 있어도 *clean part 는* 그대로 메모리 batch 에
     append. process restart 가 자연 invalidation (디스크 운영 절차 불필요).
5. **Today handling**: `req_to >= today_kst` 인 경우, `cache.get_today(code)` 확인.
   - cache hit (`dict`): 그 bar 를 `loaded_bars` 에 추가, `cached_batches` 에
     `today_s__today_s` 기록.
   - cache hit (`None`): negative cache — today 가 비거래일임이 캐시됨. KIS 호출
     skip. 응답에 today row 없음.
   - cache miss: `kis.fetch_past_daily_candles(code, today_s, today_s)` 호출.
     - 응답 non-empty: 첫 row 를 `today_bar` 로 `cache.store_today(code, bar)`,
       `loaded_bars` 에 추가, `fresh_batches` 에 기록.
     - 응답 empty (주말/공휴일): `cache.store_today(code, None)` — negative cache
       기록, 다음 60s 동안 KIS 재호출 방지.
6. **Dedupe + sort + filter**: 모든 누적 bars 를 t_ms 기준 dedupe (last-write-wins),
   ASC sort, `[frm_ms, too_ms]` 로 final filter.

### D4. KIS client 메서드

`hoga/live/kis_client.py` 에 추가:

```python
@dataclass(frozen=True)
class DailyCandleFetchResult:
    candles: list[KisCandle]                      # passed invariant defense, ASC by t_ms
    violations: list[DailyInvariantViolation]     # row-level violations dropped by defense

@dataclass(frozen=True)
class DailyInvariantViolation:
    date_yyyymmdd: str                            # the date that was dropped
    reason: Literal['close_nonpositive', 'ohlc_inconsistent', 'malformed_row', 'out_of_range']
    detail: str                                   # short human-readable context

async def fetch_past_daily_candles(
    self, code: str, from_yyyymmdd: str, to_yyyymmdd: str
) -> DailyCandleFetchResult:
    """Fetch daily OHLCV for *code* across [from, to] (KST).

    KIS TR_ID: FHKST03010100 (inquire-daily-itemchartprice), period_div_code='D'.
    KIS retains roughly 20-30 years of daily candles per the portal docs.

    Returns DailyCandleFetchResult with:
    - candles: ascending t_ms, KIS quirk + OHLC invariant defense applied.
      t_ms anchors at regular_session_open (KST 09:00:00) of each trading day.
      Non-trading days are absent (KIS does not emit rows for them).
    - violations: per-row drop reasons surfaced to the caller so the handler can
      add them to data_warnings. *Caller* (not this client) decides whether to
      cache the partially-clean batch or refuse to cache; this method makes the
      decision visible.
    """
```

설계 결정: 반환을 tuple-of-(candles, violations) 가 아닌 **dataclass** 로 둔 이유 —
호출처에서 unpack 패턴 (`candles, violations = await ...`) 보다 `result.candles` /
`result.violations` 가 명시적이고 future 필드 추가 (fetch metadata 등) 가 break change
없이 가능.

호출 파라미터 (구현 단계 KIS 문서 verify):

```python
path = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
tr_id = "FHKST03010100"
params = {
    "FID_COND_MRKT_DIV_CODE": "J",            # 주식
    "FID_INPUT_ISCD": code,                   # 종목코드
    "FID_INPUT_DATE_1": from_yyyymmdd,        # 시작일
    "FID_INPUT_DATE_2": to_yyyymmdd,          # 끝일
    "FID_PERIOD_DIV_CODE": "D",               # D=일봉
    "FID_ORG_ADJ_PRC": "0",                   # 0=수정주가
}
```

**수정주가(`FID_ORG_ADJ_PRC=0`)** 사용 이유: 액면분할/배당락 발생 시 과거 가격을 현재
단위로 보정한 값을 받음. 차트 연속성 보장 (반대값 `1` 은 원주가 — 액면분할 지점에서
가격 점프).

Pagination 처리: `fetch_past_minute_candles` 의 walk-back 패턴 답습. cursor 는
`FID_INPUT_DATE_2`, 매 페이지 후 earliest received date - 1 일로 이동. hard cap 60
페이지 (≈ 6,000 bars; KIS 보유 기간 안전 한도).

KIS quirk guard: 응답 row 의 `stck_bsop_date` 가 `[from, to]` 밖이면 skip
(`fetch_past_minute_candles` 의 비거래일 quirk 가드 답습).

Boundary invariant defense: `close > 0`, `high >= max(open, close)`,
`low <= min(open, close)` 위반 시 row 를 `candles` 에서 제외하고
`DailyInvariantViolation(date, reason, detail)` 을 `violations` list 에 추가.
핸들러는 violations 를 `data_warnings.invariant_violation` 으로 wire surface →
**operator/사용자가 KIS data 이상을 즉시 인지** (영구 손실 방지를 위한 *명시적 surface*
설계 — grill Q3 결정).

### D5. Frontend wire / hook

신규 파일: `frontend/src/api/livePastDailyCandles.ts`

```ts
export interface LivePastDailyCandlesResponse {
  code: string;
  from: string;
  to: string;
  candles: ReadonlyArray<{
    t_ms: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: ReadonlyArray<{
    batch: string;
    reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation';
    msg: string;
  }>;
}

export function useLivePastDailyCandles(
  code: string | null, from: string | null, to: string | null,
) {
  return useQuery<LivePastDailyCandlesResponse>({
    queryKey: ['live', 'past-daily-candles', code, from, to],
    queryFn: async () => { /* fetch */ },
    enabled: !!(code && from && to),
    staleTime: 60_000,
  });
}
```

### D6. `useLiveBundle` 분기

두 hook 이 모두 mount 되지만 `enabled` 로 한쪽만 실제 fetch. 자세한 코드 구조는
brainstorming 의 Section E.2 참고. 핵심:

```ts
// 분봉 path: 기존 그대로
const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo);
const pastCandlesQuery = useLivePastCandles(
  enableMinute ? code : null, enableMinute ? minutePastFrom : null, enableMinute ? minutePastTo : null,
);

// 일봉 path: 신규, NO clamp
const enableDaily = !!(code && !isMinute);
const dailyPastFrom = seedFrom;                 // 클램프 없음 — 사용자 스크롤 그대로
const dailyPastTo = todayKstYyyymmdd;
const pastDailyCandlesQuery = useLivePastDailyCandles(
  enableDaily ? code : null, enableDaily ? dailyPastFrom : null, enableDaily ? dailyPastTo : null,
);

// hoga indicators (/api/range): 분봉만 — 변경 없음
const enableRange = !!(code && isMinute && minutePastFrom <= minutePastTo);
const past = useRange(/* 기존 그대로 */);

// kisCandles 계산
const kisCandles = useMemo<Candle[]>(() => {
  if (isMinute) {
    const raw = pastCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return [];
    const bars = aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000);
    return bars.map(kisBarToCandle);
  }
  // D-direct path
  const raw = pastDailyCandlesQuery.data?.candles ?? [];
  if (raw.length === 0) return [];
  const bars = timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
  return bars.map(kisBarToCandle);
}, [isMinute, timeframe, pastCandlesQuery.data, pastDailyCandlesQuery.data]);

// clampEngaged: 분봉만 적용
const clampEngaged = isMinute
  && historicalFromDate != null
  && historicalFromDate < earliestAllowedMinute;
```

### D7. `aggregateCalendar` 입력 단위 변경

기존 시그니처는 입력이 1분봉이라는 암묵 가정. 새 호출 site (일봉 → W/M) 에서는 입력이
일봉. **함수 자체는 변경 불필요** — `aggregateCalendar` 는 입력 bars 의 t_ms 를 KST
date 로 변환해 calendar bucket 에 넣을 뿐, bar 의 시간 해상도를 알 필요가 없음.

⚠ **확인 필요한 가정** (구현 단계 verify + 회귀 테스트로 보장): 현재
`aggregateCalendar(raw, 'D')` 가 한 거래일의 모든 1m bar 를 OHLC 로 합치는데, D-direct
path 에서는 raw 가 이미 한 거래일당 1 row. 이 경우에도 결과가 동일해야 함 (즉
"identity-ish": 단일 bar 인 거래일의 OHLC 는 그 bar 자체와 같아야 함).

### D8. 스크롤 트리거 / prefetch

`LiveChartRoot.tsx:200-238` 의 `prefetchChunkDaysFor(timeframe)` 무변경. 일봉의
prefetch 동작이 무제한이 되었으므로 사용자가 끝없이 스크롤하면 backend 가 KIS gap fill
을 계속 트리거. backend 의 per-batch 캐시 + gap fill 알고리즘이 자연 처리 (매 두번째
요청부터는 캐시 hit).

### D9. InvariantOutcomesBanner

`data_warnings` 가 존재하면 기존 분봉 path 와 동일하게 banner 에 표시. wire 필드 이름이
`data_warnings` 로 동일하므로 banner 컴포넌트 분기 불필요.

### D10. ADR-0040 과의 관계

본 spec 은 ADR-0040 을 **supersede 하지 않는다**. 두 ADR 은 같은 `/live` 도메인 안에서
형제 균열로 공존:

- ADR-0040: 분봉 wire + disk cache (`kis-past-candles/`) + memory mirror
- ADR-0048 (신설): 일봉 wire + 메모리 only cache (디스크 없음)

두 cache 는 서로 독립이고 같은 (code, date) 가 두 곳에 중복 저장되는 일은 없다
(분봉 cache 는 1m bars 만, 일봉 cache 는 daily bars 만; 데이터 단위 자체가 다름).
따라서 ADR-0040 의 "Trigger Conditions" 중 "두 path 간 데이터 불일치 사고" 는 본
spec 으로는 발동되지 않는다.

### D11a. 분봉 PastCandlesCache 의 today negative caching 패치

본 spec scope 안에 포함되는 *유일한* 분봉 path 변경. wire / namespace zero diff.

- `PastCandlesCache._today_mem` 의 value 타입을 `tuple[float, list[dict]]` 에서
  `tuple[float, list[dict] | None]` 로 확장.
- `store_today(code, bars: list[dict] | None)` — `bars=None` 일 때 negative cache 기록.
- `get_today(code)` 는 현재 `list[dict] | None` 반환 (None = cache miss). negative cache
  진입 후 60s 동안은 cache hit + `None` value 를 반환해야 하므로, tri-state 가 필요.
  구현 옵션은 plan 단계에서 결정 (sentinel value vs `(state, bars)` 튜플 vs
  `Optional[Optional[list[dict]]]` distinguishable wrapper).
- API 핸들러 `_get_past_candles` ([hoga/live/api.py:213-222](hoga/live/api.py#L213-L222))
  의 today 분기: KIS 응답이 빈 list 인 경우 `cache.store_today(code, None)` 호출.
- `PastDailyCandlesCache` 와 동일한 tri-state 표현을 두 캐시가 공유 (helper 모듈로
  추출하거나 base class 도입 가능 — plan 단계 결정).

### D11. CONTEXT.md 갱신

본 spec 의 구현/배포 시점에 CONTEXT.md 의 두 entry 를 갱신한다. 갱신 본은 "path"
같은 추상 메타 단어를 쓰지 않고 *무엇을 어떻게 하는지* 평이하게 묘사 (grill Q4 결정).

**1. Live Candle Backfill entry 전체 재작성** (CONTEXT.md line 303-305):

> **Live Candle Backfill**:
> `/live` 페이지가 KIS REST 를 직접 호출해서 받아온 OHLCV 캔들. 두 KIS endpoint 를
> 사용한다:
> - **분봉** (1m/3m/5m/10m/15m/30m timeframe): `GET /api/live/past-candles` → KIS
>   `inquire-time-dailychartprice` (TR_ID `FHKST03010230`). 응답은 1분봉, 백엔드가
>   disk 에 per-Stock-Date 캐시 (`~/.local/share/hoga-ops/kis-past-candles/<code>/<YYYYMMDD>.json`).
>   250-day hard cap (payload 보호 — 1년치 일봉을 분봉으로 보내면 ~5MB). 프론트는
>   3m/5m/.../30m 을 1분봉에서 client-aggregate.
> - **일봉** (D/W/M timeframe): `GET /api/live/past-daily-candles` → KIS
>   `inquire-daily-itemchartprice` (TR_ID `FHKST03010100`, period_div_code='D'). 응답은
>   일봉, 백엔드가 **프로세스 메모리** 에만 캐시 (디스크 안 둠 — 데이터 양이
>   매우 작아서 메모리 충분; restart = 자연 invalidation). cap 없음 (KIS 보유 기간
>   ~20-30년이 자연 상한). 프론트는 D 를 그대로, W/M 는 client-aggregate.
>
> 둘 다 **Live Capture** (10초 폴링으로 snapshot/trade/broker raw 이벤트 수집) 와
> 다른 호출 — KIS 의 *pre-aggregated candle* endpoint 만 사용하는 on-demand 호출. 두
> 캐시는 서로 독립 (한쪽이 분봉, 다른쪽이 일봉이라 같은 데이터가 양쪽에 중복될 수
> 없음). `/api/range` 의 promoted Parquet 호출과도 독립 — promoted Parquet 은
> snapshots/trades/brokers 만 담고 candle 은 안 담기 때문. /replay 는 둘 다 안 쓴다
> (RangeBundle 한 길로만). ADR-0040 (분봉) + ADR-0048 (일봉) 두 결정으로 둘 다
> *별도 cache + 별도 endpoint* 를 갖는다.
> _Avoid_: "past candles" 단독 (소스를 잃음 — KIS-specific), "historical candles"
> (replay candle wire 와 중첩), "candle backfill" 단독 ("Live" 페이지 scope 누락).

**2. LiveTimeframe entry 부분 수정** (CONTEXT.md line 225 의 한 문장 교체):

> 기존: "the calendar subset (D/W/M) is **frontend-only** — `/api/live/past-candles`
> returns 1-minute bars and the page client-aggregates them via
> `aggregateCalendar(raw, 'D'|'W'|'M')`..."
>
> 신: "the calendar subset (D/W/M) uses a **separate backend endpoint** —
> `GET /api/live/past-daily-candles` returns daily bars directly (no client-side
> minute→daily aggregation needed); the page renders D as-is and client-aggregates
> D→W/M via `aggregateCalendar(rawDaily, 'W'|'M')`. `/api/range` is not involved for
> D/W/M (hoga-derived panes have no data and are not mounted)."

## Testing

### Unit tests (backend)

| Case | Setup | Expected |
|---|---|---|
| `_validate_daily_past_request` accepts uncapped range | code=valid, from=20060101, to=20260528 | (frm, too, today) tuple, no exception |
| `_validate_daily_past_request` rejects future to | to > today_kst | 422 date_in_future |
| `_validate_daily_past_request` rejects from > to | from=20260101, to=20251231 | 422 from_after_to |
| `_validate_daily_past_request` rejects invalid code | code='abc' | 422 invalid_code |
| `_validate_daily_past_request` rejects invalid date | from='2026-01-01' | 422 invalid_date |
| `_compute_gaps`: empty cache | existing=[], req=[2020-01-01, 2025-12-31] | [(2020-01-01, 2025-12-31)] |
| `_compute_gaps`: full coverage | existing=[(2020-01-01, 2025-12-31)], req=[2021, 2024] | [] |
| `_compute_gaps`: prefix gap | existing=[(2020, 2025)], req=[2018, 2022] | [(2018, 2019-12-31)] |
| `_compute_gaps`: suffix gap | existing=[(2020, 2022)], req=[2020, 2024] | [(2023, 2024)] |
| `_compute_gaps`: middle gap | existing=[(2020, 2022), (2024, 2025)], req=[2021, 2024-06-30] | [(2023, 2023-12-31)] |
| `_compute_gaps`: adjacent coalesce | existing=[(2020, 2022), (2023, 2025)], req=[2018, 2025] | [(2018, 2019-12-31)] (single call) |
| `PastDailyCandlesCache.append_batch + read` round-trip | append (code, frm, to, bars), read intersecting range | returns those bars |
| `PastDailyCandlesCache` empty code returns no batches | fresh cache, code never seen | _per_code.get(code, []) = [] |
| `PastDailyCandlesCache` multiple non-overlapping batches | append two batches, read covering range | both returned in append order |
| `PastDailyCandlesCache.get_today` TTL | store, time.monotonic advanced 61s | returns sentinel "miss" (ready to re-fetch) |
| `PastDailyCandlesCache.store_today(None)` negative cache | call store_today(code, None), then get_today within 60s | returns sentinel "negative cache: fetched, no data" — distinguishable from "miss" via tri-state |
| `PastDailyCandlesCache` negative cache TTL | store_today(code, None), advance 61s, get_today | returns "miss" (ready to re-fetch) |
| `fetch_past_daily_candles` quirk guard | KIS mock returns row with date out of range | candles excludes it, violations has entry (reason=out_of_range) |
| `fetch_past_daily_candles` OHLC violation | row with close=0 | candles excludes it, violations has entry (reason=close_nonpositive, date set) |
| `fetch_past_daily_candles` malformed row | row missing stck_bsop_date | candles excludes it, violations has entry (reason=malformed_row) |
| `fetch_past_daily_candles` clean response | KIS mock returns 100 valid rows | candles=100, violations=[] |
| `fetch_past_daily_candles` pagination | KIS mock returns 100 + 50 + empty | candles=150 ASC by t_ms, violations=[] |
| `fetch_past_daily_candles` rate limit | KIS mock raises KisRateLimitError on page 2 | exception propagates (no partial result return) |

### Integration tests (backend)

| Case | Setup | Expected |
|---|---|---|
| `/past-daily-candles` cache miss → KIS | fresh cache instance, KIS mock returns 250 bars | 200, fresh_batches=[range], in-memory batch appended |
| `/past-daily-candles` cache hit | second call to same range within same process | 200, cached_batches=[range], KIS not called |
| `/past-daily-candles` partial hit (gap fill) | first call [2020,2025], second call [2018,2022] | KIS called once for [2018,2019], response merges, ASC, dedupe |
| `/past-daily-candles` rate limit mid-gap | 2 gaps, KIS raises rate limit on second | first gap stored, data_warnings has second, response includes first |
| `/past-daily-candles` today inclusion | to=today_kst, fresh cache | today→memory cache, fresh_batches includes today_s__today_s |
| `/past-daily-candles` today TTL refresh | call twice within 60s | second call cached (no KIS) |
| `/past-daily-candles` today non-trading day | to=today_kst (Saturday), KIS mock returns empty output2 | negative cache stored, second call within 60s skips KIS, response excludes today row |
| `/past-candles` (minute) today non-trading day | to=today_kst (Saturday), KIS mock returns empty output2 | PastCandlesCache today negative cache stored, second call within 60s skips KIS, response excludes today rows |
| `PastCandlesCache.store_today(None)` (minute negative cache) | call store_today(code, None), then get_today within 60s | returns sentinel "fetched, no data" (distinguishable from "not fetched") |
| `/past-daily-candles` invariant violation surfaces to wire | KIS mock returns close=0 row in middle of clean batch | row dropped from candles, data_warnings has {batch, reason='invariant_violation', msg=detail}, clean part appended to memory batch |
| `/past-daily-candles` violation persists within process lifetime | first call surfaces violation, second call hits in-memory batch | second call returns same candles (missing the violating date), data_warnings empty; process restart re-fetches and re-surfaces |
| `/past-daily-candles` process restart loses cache | first call populates memory, simulate restart by re-instantiating cache, second call | KIS called again, fresh_batches non-empty (validates restart = invalidation) |

### Frontend tests

| Case | Setup | Expected |
|---|---|---|
| `useLiveBundle` D enables daily hook only | code=valid, timeframe='D' | useLivePastDailyCandles fetches, useLivePastCandles enabled=false |
| `useLiveBundle` 1m enables minute hook only | timeframe='1m' | useLivePastCandles fetches, useLivePastDailyCandles enabled=false |
| `useLiveBundle` clampEngaged false on D for old from | timeframe='D', historicalFromDate=2010-01-01 | clampEngaged=false |
| `useLiveBundle` clampEngaged true on 1m for old from | timeframe='1m', historicalFromDate=2010-01-01 | clampEngaged=true |
| `aggregateCalendar('W', dailyInput)` correctness | 5 일봉 of one week | 1 weekly bar with correct OHLC |
| `aggregateCalendar('D', dailyInput)` identity-ish | raw daily bars | output 동일 OHLC, 동일 t_ms |
| `useLiveBundle` D → W toggle reuses daily data | mount D, switch to W | useLivePastDailyCandles cached, no re-fetch |

### Invariant 회귀 테스트

- **t_ms monotonic**: `/past-daily-candles` 응답의 `candles[i].t_ms < candles[i+1].t_ms`
  assertion (response 단계 + dedupe 후 union 단계 양쪽).
- **OHLC 일관성**: 모든 응답 candle 에 대해
  `low <= min(o,c) and max(o,c) <= high and c > 0 and v >= 0` assertion.
- **분봉 wire 무변경 회귀**: 기존 `test_live_api.py` 의 `/past-candles` 케이스가
  zero diff 로 pass.

### Manual verification

- `/live` 페이지에서 종목 선택 → timeframe `D` → 차트 우측 끝으로 가서 마우스 끝없이
  휠 다운 → 250일 클램프 메시지 *안* 뜨고 차트가 계속 과거로 확장되는지.
- W timeframe: 같은 종목에서 `W` 토글 → 일봉이 W 로 재집계되는지 (5년치 ≈ 260 weekly
  bars).
- `1m` timeframe: 분봉은 그대로 250일에서 `clampEngaged=true` 메시지 (UI 동작 회귀
  없음).
- `/replay` 페이지: 페이지 열고 일반 동작 sanity check (영향 0 확인).
- `data_warnings` UI: KIS 강제 rate-limit 시뮬레이션(예: mock 또는 .env 토큰 일시
  무효화) → InvariantOutcomesBanner 가 partial-failure 알림 표시.

## Risks / Open questions

- **KIS daily endpoint 정확한 파라미터/응답 형태**: 위 D4 의 params/response 가정은
  구현 단계에서 KIS 공식 문서로 verify 필요. 응답 row key (예: `stck_bsop_date`,
  `stck_oprc` 등) 가 분봉과 같지 않을 가능성. 차이가 발견되면 D4 의 parsing 로직만
  조정 (wire/cache 설계는 무영향).
- **수정주가 vs 원주가 선택**: `FID_ORG_ADJ_PRC=0` (수정주가) 채택. 사용자가 원주가를
  선호한다면 future spec 으로 토글 추가 (지금은 차트 연속성 우선).
- **per-batch 누적 시 메모리 크기**: 같은 종목에 batch 가 누적 → 실 사용 패턴(2-3
  종목 × 5년)에서는 < 1 MB, worst case(50 종목 × 20년)도 ~12 MB. 위험 없음.
- **backend restart 시 cold start**: 다음 페이지 열기에서 5년치 KIS 페이지네이션 ~13회
  ≈ 10-30초 loading 상태. 단일 사용자 로컬 dev tool 의 사용 패턴(자주 restart 안 함)
  에서 수용 (사용자 사전 동의). dev workflow 가 `--reload --reload-dir hoga` 라서
  backend 코드 한 줄 바꿀 때마다 재시작이 발생하므로, 일봉 데이터 자주 fetch 하는
  코드 영역(`hoga/live/`) 작업 시 이 비용이 누적된다. 견디기 어려우면 future spec 으로
  optional disk persistence 추가 고려.
- **today bar 의 신선도**: KIS daily endpoint 가 today 호출 시 "현재까지의 일봉
  snapshot" 을 어떻게 반환하는지 구현 단계 verify. 비정상이면 today 만 분봉 path 에서
  계산하는 fallback 검토.
- **부분 겹침 batch 의 worst case**: 사용자가 매번 다른 범위로 요청을 반복하면 batch
  파일 수가 무한 증가 가능. 실 사용 패턴(scroll-back 은 from 이 점점 작아지는
  monotonic 방향)에서는 자연스럽지 않음. 발생 시 후속 spec 으로 batch coalesce 도입.
- **분봉 path 의 동일 invariant violation 손실 위험**: `fetch_past_minute_candles` 도
  KIS 1분봉 응답에 OHLC violation 이 있으면 본 spec 의 D-direct 와 동일하게 silently
  skip (단 분봉은 현재 boundary defense 가 약함 — defensive parse 만 있음). 분봉 path
  의 violation surface 강화는 본 spec scope 외 — 별도 follow-up issue. 본 spec 의
  `DailyCandleFetchResult` 패턴은 분봉용 `MinuteCandleFetchResult` 로 확장 가능한 모형.

## Out of Scope (Backlog)

- 분봉 cap 의 점진 상향 (별도 spec).
- D-direct 응답에 분할/배당 metadata 추가 (현재는 수정주가만).
- WebSocket 기반 today 일봉 실시간 갱신.
- D-direct path 의 promoted Parquet 통합 (ADR-0048 의 Trigger Conditions 발동 시).
- W/M backend 직접 서빙 (현재는 frontend 재집계로 충분).
