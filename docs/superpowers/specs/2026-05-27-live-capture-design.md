# Live Capture — 당일 실시간 호가 지표 캡쳐 & 라이브 차트

**Status**: Draft (awaiting user review)
**Date**: 2026-05-27
**Scope**: backend (`hoga/live/`), frontend (`/live` 페이지), captures 도메인 source-분기 확장

---

## 1. 목적

장 중에 사용자가 watchlist 종목의 **호가 기반 지표**(매도/매수 총잔량, 호가비, 체결강도, 거래원 net)를 **실시간으로 보고 모니터링**할 수 있게 한다. 부수 효과로, 수집된 데이터는 영구 보관되어 다음 날 이후 `/replay`에서 historical 형태로 다시 재생 가능하다.

**무엇이 아닌가**:
- 주문/트레이딩 자동화가 아님 (시세 조회 전용, KIS 주문 API 사용 안 함)
- hogaplay 캡쳐의 대체가 아님 (보완 관계 — 두 소스가 공존)
- watchlist 관리 기능이 아님 (기존 watchlist를 read-only로 사용)

## 2. 사용자 시나리오

1. 사용자가 장 시작 직후 `/live` 페이지를 연다.
2. 우측 Live Sidebar(10호가/거래원/체결 3카드)가 active 종목의 최신 데이터를 표시한다.
3. 메인 영역: 캔들+거래량 차트(KIS 분봉/일/주봉) + 호가 지표 차트(3 pane: Quote Totals, 호가비, FillStrength).
4. ⭐ 토글로 우측 Watchlist 패널 열기. watchlist 종목 클릭시 active 전환, 두 차트 refetch.
5. 16:00 KST에 polling 자동 종료. 18:00 Daily Scheduler가 JSONL → Parquet 승격.
6. 다음 날, 같은 Stock-Date를 `/replay`에서 열면 sourcePreference 설정(`hogaplay 우선` 또는 `kis_live 우선`)에 따라 표시되는 source가 결정된다.

## 3. 도메인 용어 (CONTEXT.md에 추가 예정)

- **Live Capture**: KIS Open API를 통해 watchlist 종목의 시세를 N초 주기로 수집하는 운영 모드 (장 중 09:00–16:00 KST).
- **Live Snapshot**: 한 (Code, t_ms)에서 측정한 단일 단위. 세 가지 kind — `ob`(10호가), `trade`(체결 단위 묶음), `broker`(거래원 top5×2).
- **Live Session**: 하루 한 번 Live Capture가 가동되는 운영 단위. 09:00 시작 ~ 16:00 종료, 비영업일에는 가동 안 함.
- **Source** (= `hogaplay` | `kis_live`): 같은 Stock-Date의 captured artifact가 어느 수집 경로로 만들어졌는지 식별하는 라벨. captures 폴더의 source별 서브폴더 이름이자 `meta.json`의 `source` 필드.
- **Promotion**: Live Capture의 JSONL append-only artifact를 captures 도메인의 Parquet artifact로 변환하는 단계. Daily Scheduler 18:00 fire 시 hogaplay enqueue 직전에 실행.

`Avoid`:
- "Real-time Capture" — Live Capture가 정식 명칭
- "Tick Capture" — 10s 스냅샷이라 tick-level 아님
- "Streaming Capture" — WebSocket이 아니라 REST polling이므로 streaming은 오해

## 4. 아키텍처 개요

```
[Backend]
hoga/live/
├─ kis_client.py     ← KIS REST 클라이언트 + access_token 관리
├─ poller.py         ← watchlist 전체 10s tick polling loop
├─ snapshot.py       ← Live Snapshot 도메인 모델 (frozen dataclass)
├─ writer.py         ← JSONL append-only writer
├─ promote.py        ← JSONL → captures Parquet 변환
└─ api/live.py       ← /api/live/* 엔드포인트

[Storage]
<data_dir>/live/{date}/{code}.jsonl                  ← 장 중 임시
<data_dir>/raw/{date}/{code}/kis_live/orderbook.parquet
                              /kis_live/trades.parquet
                              /kis_live/brokers.parquet
                              /kis_live/meta.json    ← {source: "kis_live", ...}
<data_dir>/raw/{date}/{code}/hogaplay/...            ← 기존, 변경 없음

[Frontend]
/live (새 라우트)
├─ LiveCandlePane.tsx      ← 캔들+거래량 (KIS API 직접)
├─ LiveIndicatorPane.tsx   ← 3 pane: Quote Totals / 호가비 / FillStrength
├─ LiveSidebar             ← 기존 CursorSidebar 재사용 (10호가/거래원/체결)
└─ WatchlistPanel.tsx      ← ⭐ 토글 우측 패널

/replay (기존, 확장만)
└─ Settings popover에 sourcePreference 토글 추가
```

## 5. 데이터 흐름

### 장 중 (09:00 ~ 16:00 KST)

1. **Poller loop** (`hoga/live/poller.py`):
   ```
   while is_session_active():
     cycle_start = now()
     for code in watchlist:
       ob, trades, brokers = await kis_client.fetch_all(code)
       writer.append(code, today, ob, trades, brokers)
       publish_sse(code, snapshot)  # /api/live/stream 구독자에게
     await sleep_until(cycle_start + 10s)
   ```
2. **Writer**: 각 측정을 `<data_dir>/live/{date}/{code}.jsonl`에 append. fsync는 매 cycle 끝에 한 번.
3. **SSE**: 새 Live Snapshot이 들어올 때마다 `/api/live/stream?code=...` 구독자에게 push.
4. **Frontend `/live`**: 초기 마운트시 `/api/live/series`로 09:00~now까지 한 번에 받아 차트 그림 + SSE 구독해 10s마다 update.

### 장 종료 후 (18:00 Daily Scheduler)

1. **Promote 단계** (hogaplay enqueue 직전, 멱등):
   ```
   # JSONL이 존재하지만 아직 kis_live Parquet으로 승격되지 않은 모든 (date, code) 쌍 찾기
   for (date, code) in scan_unpromoted_jsonls(<data_dir>/live/):
     # 멱등 가드: raw/{date}/{code}/kis_live/meta.json 존재시 skip
     if (raw/{date}/{code}/kis_live/meta.json).exists():
       continue
     rows = read_jsonl(<data_dir>/live/{date}/{code}.jsonl)
     entities = convert_to_entities(rows)
     write_parquet(raw/{date}/{code}/kis_live/orderbook.parquet, entities.orderbooks)
     write_parquet(raw/{date}/{code}/kis_live/trades.parquet,    entities.trades)
     write_parquet(raw/{date}/{code}/kis_live/brokers.parquet,   entities.brokers)
     write_meta(raw/{date}/{code}/kis_live/meta.json, source="kis_live", ...)
     archive(jsonl_path)  # 또는 삭제 — plan에서 결정
   ```
   멱등 보장: meta.json 존재 = 승격 완료. 중복 실행해도 안전.
2. 이어서 기존 hogaplay enqueue 동작 (변경 없음).
3. 다음 날 hogaplay COMPLETE 되면 같은 Stock-Date에 두 source가 공존.

## 6. API 컨트랙트

### 신규 엔드포인트

```
GET  /api/live/snapshot?code=005930
     → 최신 1건 Live Snapshot (Live Sidebar용)

GET  /api/live/series?code=005930&from_ms=...&to_ms=...&timeframe=1m
     → 09:00~now 시리즈, RangeBundle과 동일 shape
     → segments[0].session_close_ms = null (still open 표시)

GET  /api/live/stream?code=005930   (SSE)
     → 새 Live Snapshot 도착시 push event

GET  /api/live/candles?code=005930&timeframe=1m|5m|D|W
     → KIS 분/일/주봉 프록시. ApiCandle shape으로 변환

GET  /api/live/status
     → { running, last_tick_ms, watchlist_count, cycle_lag_ms, ... }

POST /api/live/control
     → { action: "start" | "stop" | "pause" } (관리/디버그용)
```

### 기존 엔드포인트 확장

```
GET  /api/range?code=...&from=...&to=...&timeframe=...
              &source_pref=hogaplay|kis_live      ← 신규 query param
     → segments[i].source 응답에 포함
```

해석 규칙 (per Stock-Date):
```
sources = list_sources(code, date)
if source_pref in sources:
  chosen = source_pref
elif sources:
  chosen = sources[0]      # fallback: 존재하는 다른 source
else:
  excluded_dates.append(date)
```

### Wire Model 신규 타입

```python
class LiveSnapshot(BaseModel):
    code: str
    t_ms: int
    orderbook: ApiOrderbookSnapshot | None
    recent_trades: list[ApiTrade]
    brokers: ApiBrokerEntry | None

class LiveSeriesResponse(BaseModel):
    code: str
    date: str
    session_open_ms: int
    session_close_ms: int | None    # null = 진행 중
    is_open: bool
    quote_ratio: QuoteRatioSlice
    fill_strength: FillStrengthSlice
    broker_series: BrokerSeriesSlice

class LiveStatus(BaseModel):
    running: bool
    started_at_ms: int | None
    last_tick_ms: int | None
    cycle_lag_ms: int
    watchlist_count: int
    kis_calls_today: int
    kis_rate_limit_remaining: int | None
```

## 7. 프론트엔드 `/live` 페이지

### 레이아웃

```
┌──────────────────────────────────────┬──────────────┬────────────┐
│ Candle + Volume Chart                │ Live Sidebar │ Watchlist  │
│   (Timeframe: 1m | 5m | D | W)       │              │ (⭐ 토글)  │
│                                      │ 10호가 카드  │            │
│ Indicator Chart (3 panes)            │ 거래원 카드  │ 005930     │
│   - Quote Totals                     │ 체결 카드    │ 000660     │
│   - 호가비                           │              │ ...        │
│   - FillStrength                     │              │            │
└──────────────────────────────────────┴──────────────┴────────────┘
```

- **active code**: URL `?code=005930` 으로 동기화. watchlist row 클릭시 변경.
  첫 방문시 (`?code=` 없음): localStorage `live.activeCode` → watchlist 첫 entry → "관심종목을 추가하세요" 빈 상태 순서로 fallback.
- **Live Sidebar**: 기존 `CursorSidebar`/`CursorSidebarConnected` 컴포넌트 재사용. cursor는 "최신 t_ms"로 자동 추적.
- **Watchlist 패널**: 기본 hide. ⭐ 헤더 토글. 폭/상태는 `localStorage["live.panel.v1"]`.
- **두 차트의 X축 동기**: lightweight-charts `subscribeVisibleTimeRangeChange` 마스터(캔들) → 슬레이브(지표).

### 컴포넌트

```
frontend/src/live/
├─ LivePage.tsx
├─ LiveCandlePane.tsx       ← RangeSeriesPane + CANDLE_SPEC + VOLUME_SPEC 재사용
├─ LiveIndicatorPane.tsx    ← RangeSeriesPane + RATIO_SPEC + QUOTE_TOTALS_SPEC + FILL_STRENGTH_SPEC 재사용
├─ WatchlistPanel.tsx
├─ useLiveSeries.ts         ← /api/live/series 초기 + SSE 구독
├─ useLiveCandles.ts        ← /api/live/candles + 1m refresh
├─ useLiveStatus.ts
└─ state/livePage.ts        ← Zustand: activeCode, timeframe, panelOpen
```

### 빈 상태 / 에러 상태

- **장 외**: 차트는 마지막 가용 Live Session 데이터 표시 + "장 외 시간입니다 (09:00 시작)" 배너
- **KIS 자격증명 없음**: "KIS 설정이 필요합니다" + .env 안내 링크
- **KIS 토큰 만료**: 헤더 배너, 재인증 안내 (기존 cookie_expired 패턴)
- **watchlist 비어 있음**: "관심종목을 추가하세요" + /capture 페이지 링크

## 8. Source Preference

- **위치**: `/replay` Settings popover의 "차트" 카테고리
- **타입**: `'hogaplay' | 'kis_live'` (전역 설정, 기본 `'hogaplay'`)
- **저장**: `localStorage` 또는 `state/chartViewPrefs.ts`
- **효과**: `/api/range` 호출시 `source_pref` query param에 실어 보냄, 변경시 React Query refetch
- **의미**: preference + fallback — 선호 source가 없으면 다른 source 사용 (둘 다 없으면만 빈 차트)

`/live` 페이지에는 sourcePreference 토글이 없다 — 오늘 자는 정의상 `kis_live`만 존재.

## 9. KIS API 매핑

| 데이터 | KIS REST 엔드포인트 | TR_ID |
|---|---|---|
| 10호가 | `/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn` | `FHKST01010200` |
| 체결 | `/uapi/domestic-stock/v1/quotations/inquire-ccnl` | `FHKST01010300` |
| 거래원 | `/uapi/domestic-stock/v1/quotations/inquire-member` | `FHKST01010600` |
| 분봉 캔들 | `/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice` | `FHKST03010200` |
| 일/주봉 캔들 | `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` | `FHKST03010100` |

- 인증: access_token (24h 유효). 디스크 캐시 `~/.local/share/hoga-ops/kis-token.json`. 매일 08:50 갱신.
- 환경: 실전 계좌만 지원 (`KIS_ENV=real`). 모의계좌는 본 기능에서 지원하지 않음.
- Rate limit: 실전 ~20 calls/sec. watchlist 20종목 × 3 API × (1/10s) = 6 calls/sec (안전 마진 70%).
- 30종목 초과시 cycle_lag_ms가 점차 누적되므로 UI 경고 토스트 (cycle_lag_ms > 30s).

## 10. 운영 / 비기능 요구사항

### 일일 운영 일정 (KST)

| 시각 | 동작 |
|---|---|
| 08:50 | KIS access_token 발급/갱신 |
| 09:00 | Live Poller 시작 (Regular Session) |
| 15:30 | KRX 정규장 종료 (Auction Cross), Poller 계속 (After-hours) |
| 16:00 | After-hours 종료, Poller stop |
| 18:00 | Daily Scheduler: Promote (JSONL→Parquet) → 기존 hogaplay enqueue |

비영업일: 기존 `calendar.trading_days` 재사용, Poller 가동 안 함.
Half-day: 12:30 종료. Poller도 12:30에 stop.

### KIS Rate Limit 보호

- Token bucket per-account (실전 20/s)
- per-call latency 측정 → 누적 lag 모니터링
- cycle 시간이 10s를 넘으면 다음 cycle을 짧게 (자동 catch-up)
- 연속 5 cycle lag 발생시 watchlist 축소 권고 (운영 알림)

### 옵저버빌리티

- structured logging:
  - `live.poller.cycle_start`, `live.poller.cycle_end` (cycle_lag_ms 포함)
  - `live.poller.kis_call` (code, kind, latency_ms, http_status)
  - `live.poller.rate_limited` (backoff_ms)
  - `live.writer.fsync` (jsonl_size_bytes)
  - `live.promote.start`, `live.promote.done` (date, code, source, row_counts)
- `GET /api/live/status` 한 페이지 요약

### 테스트 전략

```
tests/unit/live/
├─ test_kis_client.py        # fixture 기반 응답 파싱
├─ test_poller.py            # cycle timing, rate limit, error recovery
├─ test_writer.py            # JSONL append, crash recovery (truncated)
├─ test_promote.py           # JSONL → Parquet 스키마 패리티
└─ test_source_resolution.py # source_pref fallback 룰

tests/integration/live/
├─ test_live_loop_e2e.py     # mock KIS server로 09:00~10:00 시뮬
└─ test_promote_e2e.py       # 실제 JSONL → Parquet 검증

frontend/test/live/
├─ LivePage.test.tsx
├─ useLiveSeries.test.ts     # SSE mock
└─ WatchlistPanel.test.tsx
```

- Mock KIS server: tests/fixtures/kis-mock/ 에 작은 FastAPI 서버, pytest fixture로 start/stop.
- 회귀 가드: hogaplay 단독 경로(source 분기 이전과 동일하게 작동) 통합 테스트는 유지.

### CLI / 운영 제어

- `hoga live start | stop | status` 커맨드 추가 (기존 `hoga serve` 패턴)
- uvicorn lifespan에 자동 통합 (`start_live_poller` ↔ `start_capture_pool` 옆)
- watchlist가 비어 있으면 poller 가동 안 함

### 환경변수 (`.env`)

```
KIS_APP_KEY=...
KIS_APP_SECRET=...
KIS_ENV=real            # paper 미지원
# 계좌번호는 시세 조회에 불필요하므로 생략
```

## 11. CONTEXT.md / ADR 영향

- **CONTEXT.md**: §3에서 정의한 5개 새 용어(Live Capture, Live Snapshot, Live Session, Source, Promotion) 추가
- **ADR**: 새 ADR 후보 — "Live Capture write-path: JSONL append + 18:00 promote"
  (decision rationale: crash-safe, hogaplay 2-stage 패턴과 일관)
- **기존 ADR**: ADR-0019 (manifest persistence), ADR-0036 (event publish) 영향 없음

## 12. 기존 captures 도메인 영향

### Disk State 확장 (plan 단계에서 자세히 다룸)

기존 `DiskState`는 한 Stock-Date 전체 상태. 이제 source별로 분리되므로:
- 옵션 A: per-source DiskState + aggregate 함수 (left list dot 등)
- 옵션 B: DiskState 자체에 source-aware 값 추가 (`HOGAPLAY_ONLY`, `KIS_LIVE_ONLY`, `BOTH`, …)
- 결정은 plan에서 (현재 `STATE_SEVERITY` SSOT와의 호환성 검토 필요)

### Inventory 페이지 영향 (plan 단계)

- Stock-Date row 아래 source별 child row 추가 vs 통합 표시 — UX 결정
- 어느 source의 size_bytes를 totalSizeBytes로 합산할지

### `build_range_bundle` 변경

- `source_pref` 인자 추가
- per-segment에서 source 디렉토리를 선택하는 helper 추가
- 응답에 `segments[i].source` 포함

### 회귀 방지

- hogaplay 단독 데이터에 대해 source_pref 무관하게 기존 출력과 동일해야 함 (golden file 테스트)

## 13. 범위 (Scope)

### IN

- 새 백엔드 모듈 `hoga/live/` (poller, kis_client, writer, promote, api)
- 새 프론트엔드 페이지 `/live` (Candle/Indicator pane, Live Sidebar, Watchlist panel)
- captures 폴더 source 서브폴더 도입 + read-path source_pref
- `/replay` Settings popover에 sourcePreference 토글
- CONTEXT.md 용어 추가, 새 ADR 1개

### OUT (이번 spec 밖)

- KIS WebSocket 실시간 구독 (장래 확장 여지로만 기록)
- 거래원 데이터 정제 (KIS 거래원 응답이 한계가 있음 — top10 회원사 누적만 공개)
- 알림/알람 (가격 임계치 도달시 push 등) — 별도 spec
- 백테스트 / 분석 도구 통합 — 별도 spec
- 다중 watchlist (사용자별, 그룹별)

### Deferred to plan

- Disk State / Inventory 확장 상세
- Promote 후 JSONL 파일 정책 (archive vs delete)
- KIS WebSocket fallback 가능성 (Phase 2)
- 30+ 종목 대규모 watchlist 운영 정책

## 14. 성공 기준

1. 장 중 `/live` 페이지를 열면 watchlist active 종목의 호가 지표 3종(Quote Totals, 호가비, FillStrength)이 09:00부터 현재까지 그려진다.
2. 10s 주기로 차트가 자동 갱신된다 (SSE).
3. Live Sidebar 3카드(10호가/거래원/체결)가 최신 상태를 표시한다.
4. ⭐ 토글로 Watchlist 패널이 열리고, 종목 클릭시 active code가 전환된다.
5. 캔들 차트가 호가 지표 차트와 X축 동기화된다.
6. 18:00에 promote가 실행되어 `<data_dir>/raw/{date}/{code}/kis_live/*.parquet`이 생성된다.
7. 다음 날 `/replay`에서 같은 Stock-Date를 열면 sourcePreference 토글로 hogaplay/kis_live 사이를 전환할 수 있다.
8. KIS 토큰 만료시 자동 갱신, 갱신 실패시 UI 배너로 사용자에게 알린다.
9. 30종목 watchlist에서 cycle_lag_ms가 5초 미만으로 유지된다 (rate limit 안전 마진).
10. 기존 hogaplay 캡쳐/Replay Viewer가 본 변경으로 회귀하지 않는다 (golden file 테스트 통과).
