# /live KIS Past Candles — Design

**Date:** 2026-05-28
**Status:** Draft → for plan
**Scope:** both (backend + frontend)
**Related:** ADR-0013 (RangeBundle single read-path), ADR-0020 (data integrity invariants),
ADR-0036 (no resource caps for local deployment), ADR-0038 (live JSONL then promote),
ADR-0039 (source preference + fallback), ADR-0040 (Live Candle Backfill separate cache),
commit `253d894` (`KisClient.fetch_past_minute_candles`, Step 1).

---

## Problem

`/live`의 1분봉 차트 두 가지 결함:

1. **hogaplay invariant fire 일자의 candle 누락.** ADR-0020에 따라 `regular_session_close_ms <= open_ms`인
   Stock-Date는 `DiskState.INVALID`로 분류되어 `/api/range`가 `excluded_dates`로 surface하고 candles에서 제외한다.
   /live는 현재 `/api/range`의 candles를 그대로 쓰므로, 예를 들어 5/26처럼 hogaplay가 첫 페이지 info row에
   `close_ms=0`을 반환한 일자는 candle도 함께 사라진다. 그러나 KIS는 그 일자의 정상 OHLCV를 보관하고 있다.

2. **Today 분봉 30 bar 한계로 인한 viewport micro-scale.** 기존 `/api/live/candles`는 KIS intraday
   endpoint(`inquire-time-itemchartprice`, FHKST03010200)를 사용해 30 bars만 반환한다. 결과적으로 today bar가
   viewport의 0.7% 비율로 보이는 micro-scale 현상이 발생한다.

두 문제의 공통 원인: /live가 *호가 도메인 우선* 데이터 path만 갖고 있고 *KIS price 도메인* 직결 path가 없다.

## Goal

`/live` 전용 KIS 분봉 path를 새로 만들어 candle은 KIS 단일 source로 통일하고, `/api/range`는 호가 지표(quote_ratio,
fill_strength) + 데이터 coverage 메타(segments, excluded_dates) 전용으로 축소한다. `/replay`는 변경 없음.

## Non-goals

- `/replay` 페이지 변경. `/api/range`의 wire 모델/응답 형식 변경. ADR-0013 wire 그대로.
- hogaplay invariant 자체 수정. ADR-0020 정직성 보존; 5/26은 여전히 `excluded_dates`로 surface된다.
- Today 분봉을 WebSocket 체결 tick aggregator로 마이그레이션. KIS 정석은 장 중 WS이지만 그건 별도 spec 거리.
  이 spec은 REST 폴링 카테고리 안에서 더 좋은 endpoint로 옮기는 작업.

## Decisions

### D1. Endpoint는 today를 포함해 서비스한다

`/api/live/past-candles?code=X&from=YYYYMMDD&to=YYYYMMDD`는 `from..to` 범위 안의 모든 일자(today 포함)에
대해 KIS `inquire-time-dailychartprice` (FHKST03010230)를 호출한다.

**근거.** Today를 별도 endpoint로 두면 frontend가 두 source를 stitch해야 하고 today micro-scale 문제는
별도 해결책이 필요하다. 같은 REST 폴링 카테고리 안에서 dailychartprice는 today에 호출 시 그 시각까지의 완성된
1분봉을 모두 반환하므로, intraday endpoint의 30-bar 한계를 자연 해소한다.

**Trade-off accepted.** Tip-bar(현재 in-progress 분)의 신선도는 dailychartprice가 intraday보다 약간 더
stale할 가능성이 있다 — KIS 문서로 단정 못 함, 구현 단계에서 verify. 둘 다 60s 폴링이므로 실효 차이는 미미.
WS aggregator가 후속 spec에서 도입되면 그쪽이 진짜 실시간성을 책임진다.

### D2. Today는 dailychartprice의 anchor 15:30을 그대로 사용한다

`fetch_past_minute_candles`는 anchor를 15:30 KST에 고정하고 walk-back한다. Today에 호출하면 KIS는 "현재 시각까지의
완성된 bar"만 반환하고 그 이전 anchor에서는 추가 bar가 없으므로 페이지네이션이 일찍 종료된다. 코드 변경 불요.

**구현 단계 verification.** 한 코드 1분 폴링으로 mid-session(예: 11:00) 호출 시 09:00~10:59 bar가 반환되는지
확인. 만약 빈 응답이면 anchor 로직을 today에서 `min(15:30, now)`로 조정.

### D3. Caching: 디스크 + 메모리 하이브리드

- **Past 일자 (`date < today_kst`).** 디스크 영구 cache:
  `~/.local/share/hoga-ops/kis-past-candles/<code>/<YYYYMMDD>.json`. Atomic write (`hoga/api/_atomic_write.py`
  재사용). 한 process 내 hot keep을 위해 in-memory side cache (`dict[(code, date), list[dict]]`).
- **Today 일자.** 메모리 only. TTL 60s. 자정 over flush(past로 굳히기)는 follow-up.

**근거.** KIS는 ~1년 보관, past 일자는 immutable. 단일 사용자 로컬 배포에서 같은 일자 반복 조회는 흔하므로 디스크
영구 cache가 자연스러운 선택. /api/live/candles의 기존 60s memory cache 패턴은 today 한정으로 보존.

**거부된 대안.** Promoted Parquet 재사용 (D Q2의 Option C)은 KRX vs KIS source 혼합으로 인한 데이터 출처 추적
어려움이 spec 범위를 초과해 거부.

### D4. Hard cap 60일 (422 on overage)

`(to - from) + 1 > 60`이면 `422 date_range_too_large` 응답.

**근거.** Frontend가 사용자 scroll로 `historicalFromDate`를 자동 확장하므로 ADR-0036의 "자동 트리거 부재" 전제가
약하다. 60일 × 평균 4 KIS 호출 = 240 calls worst-case가 ~15-30s 안에 끝나도록 응답 시간을 예측 가능하게 만드는
선택. 60일은 거래일 약 3개월에 해당하며 /live의 자연 lookback 깊이.

**ADR-0036과의 관계.** 본 endpoint는 ADR-0036의 trigger condition ("자동 retry loop 추가" + "재현 가능한 폭주
사고")에 *근접*한 자동 트리거이므로 cap을 두는 것이 ADR-0036의 정신과 모순되지 않는다. ADR-0036은 "임의 cap을
sprinkle하지 말라"는 정책이지 "어떤 cap도 두지 말라"가 아니다.

### D5. Partial failure: skip + data_warnings

한 일자가 KIS 500 등으로 실패해도 그 일자만 건너뛰고 나머지는 정상 응답. `data_warnings` 배열에 `{date, reason, msg}`
형태로 surface. /api/range의 `excluded_dates` 패턴 일치.

**KIS rate limit mid-range.** `KisRateLimitError` 발생 시 즉시 break, 그 일자와 이후 모든 일자를
`rate_limit_aborted` reason으로 warning 처리. 200 응답에 partial candles + warnings로 정직하게 노출.

### D6. `/api/live/candles` (intraday) 같은 PR에서 제거

`/api/live/candles` endpoint, `useLiveCandles` hook, `KisClient.fetch_candles` 메서드, 관련 tests 모두 삭제.
Today bars는 이제 `/api/live/past-candles`가 서비스한다.

**근거.** Dead code 누적 방지. 한 진실 = 한 path. ADR-0013의 "domain object → one wire" 정신의 candle 도메인
적용.

### D7. 5/26-style 정합성: candle 표시, hoga 지표만 비움

KIS는 candle을 반환하고 `/api/range`는 `excluded_dates`로 표시한 일자(예: 5/26):
- `buildLiveBundle`은 `pastBundle.candles`를 무시하고 KIS candle을 그대로 사용 → candle 표시됨.
- `pastBundle.quote_ratio.points`, `fill_strength.points`는 그대로 통과 → 그 일자엔 자연스럽게 비어있음.
- `pastBundle.excluded_dates`, `data_warnings`, `segments`도 그대로 통과 → 기존 LiveChartRoot 배지/표시 유지.

**근거.** KIS price와 hogaplay hoga는 *독립 도메인*. coverage 불일치 자체가 도메인의 진실이며, 숨기지 않는 것이
ADR-0020 정직성 원칙과 일치.

## Architecture

```
                    /live 페이지
                         │
        ┌────────────────┴────────────────┐
        │                                 │
useLivePastCandles                   useRange (기존)
(new hook)                                │
        │                                 │
GET /api/live/past-candles          GET /api/range
?code=X&from=A&to=B                  ?code=X&from=A&to=B&...
        │                                 │
backend:                            backend:
  for date in [A..B]:                 호가 지표 + segments
    cache hit? → load                 (candles는 buildLive
    miss + date < today:                Bundle이 무시)
      → disk + KIS fetch
    miss + date == today:
      → memory TTL 60s + KIS fetch
        │                                 │
        └──────────────┬──────────────────┘
                       ▼
              buildLiveBundle merges:
                - candles ← KIS (today 포함)
                - quote_ratio/fill_strength ← /api/range
                - segments/excluded_dates ← /api/range
```

## Backend spec

### Endpoint

`GET /api/live/past-candles`

| Param | Type | Required | Validation |
|---|---|---|---|
| `code` | string | yes | `^\d{6}$`, else 422 |
| `from` | YYYYMMDD | yes | parseable, else 422 |
| `to` | YYYYMMDD | yes | `from <= to` (단일 일자 시 `from == to` 허용), else 422 |

422 케이스:
- `(to - from) + 1 > 60` → `date_range_too_large` (`max_days: 60`)
- `to > today_kst` → `date_in_future`
- Param 형식 위반 → 표준 422

### Response (200)

```json
{
  "code": "005930",
  "from": "20260401",
  "to": "20260527",
  "candles": [
    {"t_ms": 1714545000000, "open": 80000, "high": 80500, "low": 79800, "close": 80300, "volume": 12345}
  ],
  "cached_dates": ["20260401", "20260402"],
  "fresh_dates": ["20260527"],
  "data_warnings": [
    {"date": "20260515", "reason": "kis_api_error", "msg": "HTTP_500"}
  ]
}
```

- `candles`: 모든 정상 일자의 1m bar concat, ASC by `t_ms`.
- `cached_dates` / `fresh_dates`: 운영 가시성. 한 일자가 두 list에 동시에 나타나지 않음.
- `data_warnings`: 실패 일자 surface.

### 일자 처리 루프 (의사 코드)

```python
async def get_past_candles(code, from_date, to_date):
    today = today_kst_yyyymmdd()
    candles_all, cached_dates, fresh_dates, warnings = [], [], [], []
    aborted = False
    dates = list(date_range(from_date, to_date))
    for i, date in enumerate(dates):
        if aborted:
            warnings.append({"date": date, "reason": "rate_limit_aborted", "msg": "..."})
            continue
        try:
            if date < today:
                bars = _disk_cache_load(code, date)
                if bars is None:
                    bars = await kis.fetch_past_minute_candles(code, date)
                    _disk_cache_store(code, date, bars)
                    fresh_dates.append(date)
                else:
                    cached_dates.append(date)
            else:  # date == today
                bars = _today_cache_get(code)
                if bars is None:
                    bars = await kis.fetch_past_minute_candles(code, date)
                    _today_cache_set(code, bars)
                    fresh_dates.append(date)
                else:
                    cached_dates.append(date)
            candles_all.extend(bars)
        except KisApiError as e:
            warnings.append({"date": date, "reason": "kis_api_error", "msg": e.msg_cd})
        except KisRateLimitError as e:
            warnings.append({"date": date, "reason": "kis_rate_limit", "msg": str(e)})
            aborted = True
    return {...}
```

### Rate-limit policy

일자 순회는 직렬 (concurrent fanout 안 함). `fetch_past_minute_candles` 내부의 KIS HTTP 응답 시간이 사실상 페이싱.
별도 `asyncio.sleep` 없음.

### Cache 구현 노트

- 디스크 경로 helper: `_kis_past_candles_path(data_dir, code, date)`.
  `data_dir` 결정은 captures와 동일 (`hoga/cli/path.py::default_data_dir` 재사용).
- 디스크 파일 포맷: `{"candles": list[dict], "fetched_at_ms": int, "kis_tr_id": "FHKST03010230"}`.
  추후 schema 진화 시 `version` 필드 추가 위해 dict로 wrap.
- Atomic write: `hoga/api/_atomic_write.py` 재사용.
- Memory side cache: module-level `dict`. Bound 없음 (단일 사용자, 코드 수 < 100 가정).
- Today memory cache: module-level `dict[str, tuple[float, list[dict]]]`. TTL 60s.

### 테스트 (`tests/api/test_live_past_candles.py`)

| Case | Assertion |
|---|---|
| Happy path 단일 past 일자 | KIS 1회 fetch, disk write, response.candles ASC |
| 같은 일자 두 번째 요청 (warm cache) | KIS 0회 호출, cached_dates 포함 |
| Today 일자, 60s 이내 두 번째 요청 | KIS 0회, cached_dates |
| Today 일자, 60s 초과 후 재요청 | KIS 재호출 |
| `(to-from)+1 > 60` | 422 `date_range_too_large` |
| `code` 형식 위반 | 422 |
| `to > today` | 422 `date_in_future` |
| KIS 500 mid-range | 그 일자만 warnings, 나머지 일자 정상 응답 |
| KIS rate limit mid-range | 그 일자부터 모두 warning (rate_limit_aborted), 이전 일자는 candles에 포함 |
| 주말 일자 (KIS 빈 응답) | candles 0건, warnings 없음 |
| Disk cache 영구성 (process restart 시뮬레이션) | 두 process 모두 hit |

### 제거 대상

| 파일/심볼 |
|---|
| `hoga/live/api.py::_get_candles` route |
| `hoga/live/api.py::_CANDLES_CACHE` module dict + TTL constant |
| `hoga/live/kis_client.py::fetch_candles` (intraday endpoint method) |
| `tests/live/test_*candles*.py` (intraday endpoint tests, 단 `fetch_past_minute_candles` tests는 유지) |

## Frontend spec

### 새 hook

`frontend/src/api/livePastCandles.ts`:

```ts
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LivePastCandle {
  t_ms: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface LivePastCandlesResponse {
  code: string;
  from: string;
  to: string;
  candles: LivePastCandle[];
  cached_dates: string[];
  fresh_dates: string[];
  data_warnings: Array<{ date: string; reason: string; msg: string }>;
}

export function useLivePastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-candles', code, from, to] as const,
    queryFn: () =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
```

### `useLiveBundle.ts` 재구성

- `useLiveCandles` import 제거.
- `useLivePastCandles(code, pastFrom, todayKstYyyymmdd)` 추가.
- `useRange`의 `to`는 여전히 `yesterdayKst` (호가 도메인은 past만; today 호가는 SSE).
- Timeframe aggregation은 `useLiveBundle` 내 `useMemo`에서 처리 (1m → 그대로, 3m+ → `aggregateCandles`).
- D/W/M timeframe에서는 `useLivePastCandles` disabled (현재 1m 전용 endpoint).
- **Cap clamping**: 두 endpoint의 backend cap이 다르다 — `/api/range`는 90일 (CONTEXT.md의 **Stock-Date
  Range** 정의), `/api/live/past-candles`는 60일 (D4). `/live`는 두 endpoint를 동시 호출하므로 `useLiveBundle`
  레벨에서 `pastFrom`을 `max(historicalFromDate, today - 60일)`로 *frontend clamping*. 효과: backend 정책은 각자
  자원 모델에 맞게 독립 유지, /replay는 90일 그대로, /live만 60일 안에서 동작. 사용자가 60일 이전을 scroll로 도달하려
  시도하면 viewport 정책(49e497e)이 자연 한계로 작동.

### `buildLiveBundle.ts` 재구성

입력 인터페이스 변경:

```ts
export interface BuildLiveBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  pastBundle: RangeBundle | null;   // /api/range — 호가 지표 + segments
  kisCandles: Candle[];              // /api/live/past-candles 응답 + client aggregation
  sseOb: ObSnapshot[];
  sseTrade: TradeSnapshot[];
  bucketMs: number;
}
```

로직 변경:
- `candles`는 `kisCandles` 그대로 (pastBundle.candles 무시, todayCandles 별도 분기 제거).
- KIS 응답의 `{t_ms, open, high, low, close, volume}`을 wire `Candle` 모델로 변환 시 `vol_a = volume,
  vol_b = 0` 매핑 (기존 buildLiveBundle today candles 매핑 그대로). 변환 위치는 `useLiveBundle`의 useMemo 안.
- `quote_ratio.points` / `fill_strength.points`는 `pastBundle` past points + SSE today points concat (현재 로직 유지).
- `segments` past + today (`source: 'kis_live'`) concat (현재 로직 유지).
- `excluded_dates`, `data_warnings` pastBundle 그대로 통과.
- Today segment 판정은 `sseOb.length > 0 || sseTrade.length > 0 || kisCandles.some(c => c.ts_ms >= todaySession.open_ms)`.

### 제거 대상

| 파일/심볼 |
|---|
| `frontend/src/api/liveCandles.ts` |
| `frontend/src/api/liveCandles.test.tsx` |
| `useLiveBundle.ts`의 `useLiveCandles` import + 사용 |

### 테스트

| Case | File | Assertion |
|---|---|---|
| `useLivePastCandles` enabled 조건 | `livePastCandles.test.tsx` | code/from/to 누락 시 query 미발생 |
| `useLivePastCandles` queryKey 분리 | 동일 | (code, from, to) 변경 시 cache 분리 |
| `keepPreviousData` 동작 | 동일 | data가 undefined로 안 떨어짐 |
| `buildLiveBundle` candles 소스 | `buildLiveBundle.test.ts` | pastBundle.candles 변경해도 결과 candles 동일 |
| `buildLiveBundle` excluded_dates 통과 | 동일 | pastBundle.excluded_dates → result.excluded_dates |
| `buildLiveBundle` segments 합성 | 동일 | past + kis_live today |
| 5/26 시나리오 시뮬 | 동일 | pastBundle.excluded_dates에 20260526, kisCandles에 20260526 bars → 둘 다 표시 |
| `useLiveBundle` D/W/M 분기 | `useLiveBundle.test.tsx` | useLivePastCandles disabled |
| Timeframe aggregation 3m | 동일 | aggregateCandles 호출 |

## Why not promoted Parquet integration (Alt B)

KIS dailychartprice 결과를 `<data_dir>/parquet/{date}/{code}/kis_live/candles.parquet`로 작성해 기존 `/api/range`의
`source_pref=kis_live` fallback (ADR-0039)으로 자동 처리하는 방안도 가능하다. 그 길이 ADR-0013 (RangeBundle single
read-path) 정신과 더 깊이 정합한다는 사실은 인정한다. 그러나 다음 이유로 *이 spec에서는 거부*했다:

1. **/replay 비-영향 제약.** 본 spec의 brief는 명시적으로 "/replay에는 변화 없음"을 제약으로 설정. Alt B는 source_pref
   = kis_live 사용자에게 *자동 파급* — 현재 빈 차트가 갑자기 풍부한 KIS candle로 채워짐. 이는 /replay 사용자 경험 변경이며
   별도 검토/spec 거리.
2. **Promotion 패턴과의 미묘한 충돌.** ADR-0038은 Promotion을 "18:00 batched + idempotent"로 정의. Alt B의 on-demand
   KIS dailychartprice fetch는 *non-batched, mid-day*. 한 디렉토리에 두 writer (cold-path Promotion + hot-path
   on-demand)가 공존하면 idempotency 정책 + concurrent write 보호 필요.
3. **meta.json / disk_state / invariant 적용 범위.** kis_live/candles.parquet가 도입되면 `DiskState.classify_from_meta`
   는 이 새 부분-promotion 상태를 인지해야 하고, ADR-0020 invariant 카탈로그에 KIS candle 무결성 invariants
   (예: `close > 0`, `t_ms` 단조성)를 추가하는 작업이 동반.
4. **인크리멘털 도달 경로 존재.** Alt A로 출발한 후 follow-up spec에서 "cache namespace를 promoted Parquet으로
   migrate" 작업으로 자연스럽게 Alt B에 도달 가능. 반대 방향 (Alt B → Alt A)은 의미 없으므로 *큰 결정을 미루는* 선택이
   안전.

**결과적 트레이드오프 수용**: KIS candle 데이터가 두 곳 (kis-past-candles cache, kis_live promoted parquet — 후자엔
현재 candles.parquet 자체가 없음)으로 분산되는 외관상 중복. 실제로는 *두 곳이 같은 데이터를 담지 않으므로* 중복 아님
— Alt A의 cache는 backfill 결과, kis_live promoted Parquet은 snapshots/trades/brokers만. 이 비-중복성을 follow-up
spec에서 통합할 때 정리.

## Risks

- **Tip-bar staleness.** Dailychartprice의 today bar가 intraday endpoint보다 stale할 가능성. 구현 단계에서
  empirical verify. 만약 stale이면 anchor를 `min(15:30, now)`로 조정하거나, 별도 후속으로 WS aggregator로
  마이그레이션.
- **Disk cache 누적.** 사용자가 100 코드 × 250 거래일 fetch하면 ~25k 파일 / ~25MB. Bound 없음. 사용자가 직접
  rm으로 청소 가능. Bounded LRU는 follow-up.
- **Cache invalidation gap.** Past 일자 cache는 영구이므로 만약 KIS가 retroactive correction을 한다면 stale.
  실제로 KIS가 그러는지 알 수 없음. `hoga validate --fix` 같은 CLI 도구는 follow-up.

## Out of scope

- WebSocket 체결 tick → 1m candle aggregator (today를 진정한 실시간으로 만드는 작업).
- Disk cache LRU / GC.
- Today memory cache의 자정 over flush.
- Promoted Parquet과 KIS cache의 통합.
- LiveChartRoot viewport 정책 변경 (이미 49e497e로 commit됨).

## Acceptance criteria

1. `GET /api/live/past-candles?code=005930&from=20260401&to=20260527` → 200 with ASC candles, today (20260527)
   포함.
2. 5/26 시나리오: KIS candle은 표시, `/api/range`의 `excluded_dates`에 20260526 포함, hoga 지표는 그 일자 비어있음.
3. 60일 초과 → 422 `date_range_too_large`.
4. `/api/live/candles`, `useLiveCandles`, `KisClient.fetch_candles` 모두 코드베이스에서 제거됨.
5. `uv run pytest` 전체 통과 (기존 741 + 본 spec 신규 tests).
6. `cd frontend && npm run build` 통과.
7. 같은 일자 두 번째 요청 시 KIS 호출 0회 (cached_dates에 일자 포함).
