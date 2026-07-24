# 백엔드 성능 병목 분석 보고서

- 분석 기준일: 2026-07-24
- 대상 커밋: `8acf2a49`
- 범위: `hoga/` 백엔드, 백엔드 호출 방식에 직접 영향을 주는 일부 `frontend/` 코드, 관련 ADR·기존 측정 문서
- 원칙: 프로덕션 코드·외부 시스템·실사용자 데이터는 변경하거나 부하를 주지 않았다.
- 판정 표기:
  - **확인됨**: 현재 코드, 저장소에 보존된 측정값, 또는 격리된 합성 벤치마크로 재현됨
  - **가설**: 구조적 위험은 확인됐지만 실제 운영 부하에서의 사용자 영향은 추가 계측이 필요함

## 0. 결론

가장 먼저 처리할 3개 항목은 다음과 같다.

1. **과거 분봉 캐시의 재시작 콜드 미스(F-01)**  
   저장소 실측에서 5거래일 팬이 warm 8ms, cold 1.55~2.57s였다. 사용자 지연이 확인됐고
   원인의 약 99.7%가 KIS 경로였으며, 현재도 캐시가 프로세스 메모리에만 존재한다. 효과가
   가장 직접적이다.
2. **LiveBuffer 전역 메모리 예산 부재(F-02)**  
   코드 자체가 최대 800종목에서 수 GB 가능성을 명시한다. 합성 호가 10,000건도 추적
   메모리 54.75MiB를 사용했다. 먼저 실규모 publish rate/RSS를 계측한 뒤 표시 종목만
   버퍼링하도록 분리해야 한다. 실제 부하 크기는 아직 가설이지만 실패 모드는 프로세스
   전체 메모리 고갈이라 우선 검증 가치가 높다.
3. **넓은 sidecar 범위의 일자별 직렬 조립과 큰 응답(F-03)**  
   기존 측정에서 약 2개월 `mode=sidecar`가 2.50~2.55s, 17.5MB였다. 현재 과거 팬은
   델타 병합으로 개선됐지만 초기 콜드 로드와 캐시 복원 실패 경로는 여전히 같은
   백엔드 구조를 사용한다. 기존 프로파일러가 현재 코드에서 깨져 있으므로, 먼저
   프로파일러를 복구해 current-head 수치를 다시 얻은 뒤 상위 slice를 구조적으로 줄여야 한다.

현재 코드에서 예전의 DuckDB 비등가 조인 OOM을 다시 병목으로 보고하지 않았다. ADR-0085의
최신 v2.1 측정은 최중량 단일 일자를 0.53s까지 낮췄고, 12개 동시 실행도 1.95s wall로
개선됐음을 기록한다. 그 문제는 현재 기준으로 해결된 과거 장애다.

## 1. 코드베이스와 주요 실행 경로

### 기술 스택과 실행

- Python 3.11+ 패키지이며 FastAPI, Uvicorn, DuckDB, Polars, PyArrow, httpx, asyncio를
  사용한다 (`pyproject.toml:1-19`).
- `hoga serve`는 factory 앱을 `127.0.0.1` 단일 Uvicorn 프로세스로 실행한다
  (`hoga/cli.py:84-94`).
- 로컬 단일 사용자 배포가 명시적 제품 전제다
  (`docs/adr/0036-local-deployment-no-resource-caps.md:11-22`).
- 앱 lifespan은 캡처 워커, KIS capacity scheduler/client, 실시간 스트림, Today
  Promoter, screener job을 한 프로세스에서 함께 소유하고 종료한다
  (`hoga/api/app.py:90-189`).

### 주요 요청·작업 흐름

```text
HTTP /api/range (sync route, FastAPI thread pool)
  -> build_range_bundle
     -> Stock-Date 목록/소스 해석
     -> 날짜별 candles / hoga / sidecar slice
     -> QueryEngine.cursor() -> DuckDB -> Parquet
     -> 메모리·디스크 indicator cache
  -> Pydantic JSON -> GZip

HTTP /api/live/past-candles (async)
  -> LiveMinuteCandleBackfill
     -> PastCandlesCache
     -> miss: KIS Capacity Scheduler
     -> persistent httpx.AsyncClient

Kiwoom/KIS WebSocket tick
  -> LiveStream.on_tick
     -> 표시 경로: LiveBuffer
     -> KRX 저장 경로: downsample / JSONL / Today Promotion / Parquet

Capture enqueue
  -> asyncio queue, 기본 3 worker
  -> Hogaplay persistent httpx.Client
  -> raw 저장 -> parse -> Parquet
  -> terminal item을 _done에 보존

POST /api/screener/scan
  -> identical-request single-flight
  -> asyncio.to_thread(run_scan)
  -> DuckDB window CTE + Polars/Pydantic 결과
```

성능상 중요한 설계 사실은 다음과 같다.

- `QueryEngine.conn`은 동시 sync route가 부모 DuckDB connection을 공유해 충돌하지 않도록
  접근마다 독립 cursor를 만든다 (`hoga/api/queries.py:95-105`).
- 모든 프로덕션 DuckDB 연결은 현재 `connect_bounded()`를 거쳐 기본 메모리 8GiB,
  temp 50GiB 상한을 설정한다 (`hoga/duck.py:18-38`).
- KIS client는 요청마다 client를 만들지 않는다. persistent `httpx.AsyncClient`,
  10초 timeout, rate limit·retry·backoff를 갖는다 (`hoga/live/kis_client.py:245-283`,
  `hoga/live/kis_client.py:285-330`).
- KIS scheduler는 계정당 기본 8 worker, 최소 4/최대 64, pending unique key 1,000으로
  제한한다 (`hoga/live/kis_capacity_runtime.py:16-20`, `hoga/live/kis_capacity_scheduler.py:88-151`).
- `/api/range`는 1KiB 이상 응답을 GZip으로 압축한다. 코드 주석의 저장소 실측은
  246KB에서 27KB다 (`hoga/api/app.py:206-213`).
- 프론트의 현재 live 과거 팬은 hoga/sidecar를 delta로 요청하고 병합한다
  (`frontend/src/api/range.ts:510-590`). 따라서 넓은 전체 범위를 매 팬마다 다시
  받는다고 해석하면 안 된다.

## 2. 측정과 검증 결과

### 이번 분석에서 실행한 검사

| 검사 | 결과 |
|---|---:|
| `pytest --collect-only` | 2,688 tests 수집 |
| 관련 경로 targeted pytest | 116 passed / 14.52s |
| 전체 pytest | 2,686 passed, 2 skipped / 83.69s |
| `ruff check hoga` | 기존 456건으로 실패; 주로 import/line length/complexity 규칙 |
| 기존 range profiler 실행 | 현재 코드에서 `AttributeError`로 즉시 실패 |

Ruff 결과는 이번 변경으로 생긴 회귀가 아니라 현재 저장소의 정적 검사 베이스라인이다.
성능 판정의 근거로 사용하지 않았다.

### 격리 합성 벤치마크

실사용 데이터가 아닌 임시 synthetic corpus만 사용했고 종료 후 삭제했다.

| 대상 | 입력 | 결과 | 해석 제한 |
|---|---|---|---|
| LiveBuffer | 20 codes × 500 호가 ticks, 10-level ask/bid | 10,000 entries, current/peak 54.75MiB, 약 5,741 bytes/entry, publish 0.507s | Python `tracemalloc`과 합성 payload 값; 실 RSS·실 tick rate가 아님 |
| Screener | 2,000 codes × 500 days = 1,000,000 rows | base 108.7ms; MA20 118.4ms; MA20+60 173.1ms; MA 4개 270.5ms | warm OS cache, 압축 잘 되는 합성 parquet |
| Inventory | meta-only Stock-Date 1k/5k/10k | warm median 8.64/56.93/119.34ms | parquet aggregate miss 비용을 제외한 파일 탐색 하한 |
| Capture done | terminal item 1k/5k/10k | snapshot median 2.06/11.71/22.91ms; JSON 0.25/1.28/2.56MB | 단순 terminal row, 실제 result/error payload 제외 |

### 저장소에 보존된 실측

- 과거 분봉 5거래일: cold 1,552~2,570ms, warm 8ms. 같은 2,570ms 표본에서
  KIS 경로가 약 99.7%를 차지했다
  (`docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md:18-33`).
- 같은 팬 경로의 `/api/range`: hoga 26~35ms, sidecar 169~184ms
  (`docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md:18-26`).
- 약 2개월 range: hoga 0.11s/0.7MB, sidecar 2.50~2.55s/17.5MB
  (`docs/superpowers/plans/2026-07-05-live-range-performance-plan.md:25-56`).
- Hogaplay full capture는 rate 0.2에서 0.05로 조정 후 003490 303s→123s,
  005930 396s→169s였고 throttle 0회였다
  (`docs/superpowers/measurements/2026-05-23-throughput/verify/VERIFY.md:7-35`).

## 3. 성능 병목 상위 5개

| 순위 | 발견 | 심각도 | 상태 | 주요 영향 | 구현 비용 |
|---:|---|---|---|---|---|
| 1 | F-01 과거 분봉 캐시 재시작 콜드 미스 | High | 확인됨 | latency, network, KIS quota | 중간 |
| 2 | F-02 LiveBuffer 전역 메모리 예산 부재 | High | 구조 확인 / 실부하 가설 | memory, CPU, event-loop latency | 높음 |
| 3 | F-03 넓은 sidecar의 직렬 조립·대형 응답 | High | 과거 실측 확인 / current-head 재측정 필요 | latency, CPU, DB, memory, network | 중간~높음 |
| 4 | F-04 Screener 조건별 반복 window scan | Medium | 합성 벤치 확인 | latency, throughput, CPU, DB | 중간 |
| 5 | F-05 Inventory가 매 호출 전체 파일 트리를 재탐색 | Medium | 합성 벤치 확인 | latency, filesystem I/O, CPU | 중간 |

## 4. 상세 발견 사항

### F-01. 과거 분봉의 process-only 캐시가 재시작·축출 때 KIS 비용을 다시 지불한다 — High

- **상태 / 확신:** 확인된 문제 / 높음
- **근거 위치:**
  - `hoga/live/past_candles_cache.py:1-9` — past와 today 모두 process memory 전용
  - `hoga/live/past_candles_cache.py:31-38` — 최대 2,048일, 약 270MB 예산
  - `hoga/live/past_candles_cache.py:83-140` — miss 시 메모리 외 read-through 계층 없음
  - `hoga/live/live_candle_backfill.py:100-105` — restart 후 fresh fetch 증가와 disk persistence ROI를 명시
  - `hoga/live/live_candle_backfill.py:326-387` — miss 날짜를 KIS scheduler로 fetch
  - `docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md:18-33`
- **현재 동작과 병목 이유:** 과거 날짜는 사실상 불변인데도 캐시 수명이 Python 프로세스와
  같다. restart나 LRU eviction 뒤 같은 날짜를 보면 네트워크, scheduler, token bucket
  pacing, KIS quota를 다시 소비한다.
- **영향받는 요청/작업:** `/api/live/past-candles`, live chart 최초 진입, 좌측 팬,
  종목 순환 후 재방문.
- **예상 영향:** latency, throughput, network, KIS quota.
- **개선 방법:** 과거 날짜만 대상으로 schema-versioned disk read-through cache를 둔다.
  `(venue, code, date, adjustment/source version)`을 키로 하고 atomic write, size/age budget,
  corruption fallback을 적용한다. 오늘 데이터는 기존 TTL 메모리 캐시를 유지한다.
- **예상 효과 / 난이도:** 기존 실측은 5거래일 2.57s→8ms warm 경로의 상한을 보여준다.
  현재 head에서도 같은 효과인지는 재측정해야 한다. 구현 난이도 중간.
- **회귀·운영 위험:** 기존 문서에는 한때 “KIS candle cache를 disk에 쓰지 않는다”는
  제약이 있었다. 데이터 보존 정책·라이선스·schema 변경·수정주가 의미를 ADR로 다시
  결정해야 한다. stale/corrupt cache가 차트를 오염시키지 않도록 version과 검증이 필수다.
- **검증 방법 / 지표:** restart 전후 동일 5/20/60 거래일 요청의 p50/p95, TTFB,
  `fresh_past_fetches`, KIS HTTP call count, disk hit ratio, bytes, corruption fallback count.

### F-02. LiveBuffer는 per-deque cap만 있고 프로세스 전역 byte/entry 예산이 없다 — High

- **상태 / 확신:** 전역 상한 부재와 엔트리 비용은 확인됨; 800종목 실운영 영향은 가설 / 중간
- **근거 위치:**
  - `hoga/live/buffer.py:14-26` — 코드 주석이 최대 800종목·수 GB 가능성을 명시
  - `hoga/live/buffer.py:39-55` — 종목×kind별 60,000 cap, 전역 cap 없음
  - `hoga/live/buffer.py:78-103` — payload의 nested dict/list를 엔트리로 보존
  - `hoga/live/buffer.py:119-135` — entry count만 관측, byte·rate·drop 없음
  - `hoga/live/stream.py:345-375` — active code의 모든 tick을 표시 버퍼에 publish
  - `hoga/live/kiwoom_frames.py:179-207` — 한 호가 payload에 ask/bid 20개 nested dict
- **현재 동작과 병목 이유:** 화면은 보통 한 종목을 읽지만 active Live Set 전체가 15분간
  표시 버퍼에 쌓인다. cap은 `(code, kind)`별이라 active code 수가 늘면 총량이 선형 증가한다.
  합성 10,000 호가 엔트리는 `tracemalloc` 기준 54.75MiB였다.
- **영향받는 요청/작업:** Kiwoom/KIS WS ingest, `/api/live/snapshot`, `/api/live/series`,
  같은 프로세스의 DuckDB·capture·screener 작업 전체.
- **예상 영향:** memory, CPU, event-loop latency, GC pause, 최악의 경우 process OOM.
- **개선 방법:** 먼저 publish rate와 RSS를 실계측한다. 이후 저장 경로와 표시 경로를 더
  분리해 현재 조회·구독 종목만 full-fidelity buffer에 두고, 나머지는 최신값 latch 또는
  compact typed/columnar ring만 유지한다. 프로세스 전역 entry/byte budget과 drop reason,
  high-water mark도 둔다.
- **예상 효과 / 난이도:** active code 수에 비례하는 dead-weight 제거가 기대되지만 실제
  절감률은 실 tick mix 측정 전 숫자로 단정할 수 없다. 구현 난이도 높음.
- **회귀·운영 위험:** 처음 종목을 열 때 promotion interval만큼 intraday tail이 비는
  정합성/UX 위험이 있다. 보존창을 단순 축소하면 `retention > 2 × promote interval`
  불변식을 깰 수 있다.
- **검증 방법 / 지표:** 1/50/200/800 code replay에서 RSS current/peak, entries/code/kind,
  bytes/entry 표본, publish p50/p95/p99, event-loop lag p99, GC pause, subscriber drop,
  first-view coverage gap.

### F-03. 넓은 sidecar 범위가 날짜별 여러 slice를 직렬 조립하고 큰 JSON을 만든다 — High

- **상태 / 확신:** 구조와 과거 실측은 확인됨; 현재 head의 절대 시간은 재측정 필요 / 중간
- **근거 위치:**
  - `hoga/api/routes.py:335-441` — sync `/api/range`, 하나의 `RangeBundle` 반환
  - `hoga/api/bundle.py:1404-1439` — 날짜 목록 뒤 단일 `for d in dates`
  - `hoga/api/bundle.py:1502-1673` — 날짜마다 candle, peak, POC, broker, distribution,
    heatmap, delta를 순차 호출
  - `frontend/src/api/range.ts:510-590` — 현재 과거 팬은 delta 병합
  - `docs/superpowers/plans/2026-07-05-live-range-performance-plan.md:25-56`
- **현재 동작과 병목 이유:** cache hit이어도 N개 Stock-Date의 여러 slice를 Python 객체로
  조립하고 전체 JSON을 만든다. cold면 각 slice가 Parquet/DuckDB 계산을 수행한다.
  기존 약 2개월 측정은 sidecar 2.50~2.55s/17.5MB였다.
- **영향받는 요청/작업:** live chart 최초 분봉 로드, 깊은 범위 복원 실패, study/replay의
  넓은 sidecar 요청. 일반 좌측 팬은 현재 delta라 영향이 더 작다.
- **예상 영향:** latency, throughput, CPU, DB, memory, network. GZip은 wire bytes를
  줄이지만 JSON 생성과 압축 CPU·peak object memory는 제거하지 않는다.
- **개선 방법:** 먼저 깨진 profiler(F-07)를 복구해 slice별 current-head 비용을 찾는다.
  그 뒤 (a) immutable Stock-Date sidecar를 versioned materialized bundle로 합치거나,
  (b) 초기 요청도 고정 폭 chunk/gap API로 제한하거나, (c) 실제 상위 1~2개 slice만
  별도 lazy endpoint로 분리한다. 날짜 간 무제한 병렬화는 DuckDB/RSS 측정 없이 하지 않는다.
- **예상 효과 / 난이도:** 과거 측정상 최대 개선 여지는 수 초와 수십 MB지만, 현재 delta/cache
  효과를 반영한 수치는 재측정 전 확정할 수 없다. 난이도 중간~높음.
- **회귀·운영 위험:** source preference, capture mtime invalidation, today freshness,
  원자적 차트 reveal, 날짜 정렬/중복 제거가 깨질 수 있다. endpoint 분리는 프론트 로딩
  정합성을 복잡하게 한다.
- **검증 방법 / 지표:** 5/20/60 Stock-Date cold/warm, hoga/sidecar/candles별 TTFB,
  end-of-body, raw/gzip bytes, JSON serialization/GZip CPU, slice별 wall/CPU, DuckDB
  scanned rows/bytes와 temp spill, process RSS peak.

### F-04. Screener의 각 window 조건이 전체 `adj` 이력을 별도로 스캔한다 — Medium

- **상태 / 확신:** 확인됨 / 중간
- **근거 위치:**
  - `hoga/api/screener_scan.py:107-120` — MA leaf마다 독립 window CTE
  - `hoga/api/screener_scan.py:18-37` — breakout도 독립 row-number/max window
  - `hoga/api/screener_scan.py:176-195` — base LAG 후 조건마다 CTE·JOIN 추가
  - `hoga/api/screener_runner.py:84-94` — 요청 전체를 worker thread에서 실행
  - `hoga/api/screener.py:291-296` — 동일 body 동시 요청만 single-flight
- **현재 동작과 병목 이유:** 조건 수가 늘면 같은 parquet 이력에 대해 유사한 partition/order
  window가 반복된다. 다른 조건 body는 coalescing되지 않는다.
- **영향받는 요청/작업:** 전체 시장 EOD/intraday screener scan, 다중 MA·신고가 조건.
- **예상 영향:** latency, throughput, CPU, DB.
- **개선 방법:** 같은 source/order를 쓰는 MA 기간들을 한 window projection에서 함께
  계산하고 latest row를 한 번만 고른다. breakout/high-off-peak도 공통 latest/history
  relation과 필요한 최대 lookback으로 묶을 수 있는지 `EXPLAIN ANALYZE`로 검증한다.
  watchlist/heatmap scope를 선택한 요청은 현재 semi-join을 계속 활용한다.
- **예상 효과 / 난이도:** 100만행 합성에서 base 108.7ms, MA 2개 173.1ms, MA 4개
  270.5ms였다. 실제 corpus/조건 분포의 효과는 재측정 필요. 난이도 중간.
- **회귀·운영 위험:** MA별 `wc=N`, breakout의 exact window, intraday overlay,
  NULL/짧은 history 의미가 달라질 수 있다. 기존 condition compiler 확장성도 저하될 수 있다.
- **검증 방법 / 지표:** 실제 익명화 corpus의 condition 0/1/2/4/8개, 전체시장과 scoped
  각각 p50/p95, CPU time, rows scanned, DuckDB operator time/peak memory. 기존 결과와
  row-by-row differential test.

### F-05. Inventory cache hit도 모든 Stock-Date 디렉터리와 meta mtime을 다시 순회한다 — Medium

- **상태 / 확신:** 확인됨 / 높음
- **근거 위치:**
  - `hoga/api/queries.py:132-191` — 매 호출 전체 date/code 디렉터리 정렬·순회·stat
  - `hoga/api/queries.py:214-272` — cache miss는 meta read와 parquet aggregate까지 수행
  - `hoga/api/routes.py:151-175` — `/api/stock-dates`가 전체 목록 반환
  - `frontend/src/api/stock-dates.ts:6-15` — SSE invalidation 기반, polling은 아님
- **현재 동작과 병목 이유:** 값 cache는 DuckDB 재계산을 피하지만 inventory membership과
  mtime 확인은 O(전체 Stock-Date)다. 디렉터리 수가 늘수록 cache hit latency도 선형 증가한다.
- **영향받는 요청/작업:** Inventory와 Capture 화면의 `/api/stock-dates`, capture 완료 후
  SSE invalidation 재조회.
- **예상 영향:** latency, filesystem I/O, CPU. 네트워크 응답 크기도 row 수에 비례한다.
- **개선 방법:** capture/promote event가 갱신하는 versioned inventory manifest 또는
  in-memory index를 source of truth로 두고, startup/recovery 때만 filesystem reconciliation을
  수행한다. API pagination/filter도 별도로 고려한다.
- **예상 효과 / 난이도:** meta-only 합성 warm hit가 1k 8.64ms, 5k 56.93ms, 10k
  119.34ms였다. 실제 disk/cache 상태에서는 달라진다. 난이도 중간.
- **회귀·운영 위험:** 외부 파일 복사·수동 삭제·부분 capture를 manifest가 놓치면 inventory가
  stale해진다. watchdog/event 손실 대비 startup reconcile과 repair 명령이 필요하다.
- **검증 방법 / 지표:** 1k/10k/30k Stock-Date cold/warm p50/p95, stat/open count,
  response bytes, event-to-visible delay, manifest-vs-filesystem differential.

### F-06. Capture terminal `_done` 목록과 queue 응답은 사용자 dismiss 전까지 무제한 증가한다 — Medium

- **상태 / 확신:** 증가와 선형 비용은 확인됨; 일반 세션에서 10k 도달 여부는 가설 / 중간
- **근거 위치:**
  - `hoga/api/captures.py:219-224` — `_done` list, DELETE 전까지 보존
  - `hoga/api/captures.py:677-685` — 모든 row를 매 snapshot에서 wire model로 변환
  - `hoga/api/captures.py:993-1014` — finalize append와 drain 때 전체 목록 4회 scan
  - `hoga/api/captures.py:1519-1525` — enqueue마다 전체 `_done` index 재생성
  - `hoga/api/captures.py:1853-1876` — cancel 선형 검색, 명시적 dismiss만 clear
- **현재 동작과 병목 이유:** long-lived 로컬 서버에서 완료 이력을 dismiss하지 않으면
  memory, queue JSON, enqueue/dedupe 비용이 누적된다.
- **영향받는 요청/작업:** `/api/captures/queue`, enqueue/retry/cancel, queue SSE invalidation 뒤 refetch.
- **예상 영향:** memory, CPU, latency, network.
- **개선 방법:** UI 표시 이력은 bounded deque/page로 제한하고, 누적 통계는 별도 O(1)
  counter로 유지한다. dedupe에 필요한 최신 terminal state는 `(code,date)` bounded map으로
  분리한다. 사용자가 전체 이력을 기대한다면 disk log와 pagination을 사용한다.
- **예상 효과 / 난이도:** 합성 10k row에서 snapshot 생성 22.91ms, JSON 2.56MB였다.
  실제 result/error payload는 더 클 수 있다. 난이도 낮음~중간.
- **회귀·운영 위험:** implicit retry/dedupe, attempt badge, dismiss semantics가 달라질 수 있다.
  어떤 terminal 이력을 얼마나 보존할지 제품 결정이 필요하다.
- **검증 방법 / 지표:** 1k/10k/50k terminal row에서 snapshot/serialize p95, response bytes,
  enqueue latency, RSS, retry/dedupe correctness.

### F-07. 요청 관측성이 threshold slow-log에 치우쳐 있고 range profiler는 현재 깨져 있다 — Medium

- **상태 / 확신:** 확인됨 / 높음
- **근거 위치:**
  - `hoga/api/request_timing.py:1-13` — TTFB만 측정, 기본 2,000ms threshold
  - `hoga/api/request_timing.py:52-73` — 로그만 남기며 histogram/body bytes/stage 없음
  - `hoga/api/routes.py:389-440` — range 상세 로그는 `HOGA_PERF_DEBUG`일 때만
  - `tools/profile_live_range.py:12-26` — 존재하지 않는 함수 2개를 wrapping
  - `tools/profile_live_range.py:59-66` — 현재 금지된 `mode=full` 포함
  - `hoga/api/routes.py:355` — 현재 mode는 hoga/sidecar/candles뿐
- **현재 동작과 병목 이유:** 2초 미만의 반복 회귀, end-of-body, response bytes, queue wait,
  DB/slice breakdown을 지속적으로 비교할 수 없다. 실제 profiler는
  `build_volume_profile_slice` AttributeError로 시작도 못 한다.
- **영향받는 요청/작업:** 모든 HTTP 요청, 특히 range/past-candles/screener/inventory와
  혼합 부하 원인 분석.
- **예상 영향:** 직접 latency보다 탐지 시간과 잘못된 최적화 위험. 간접적으로 throughput,
  CPU, memory, DB, network 전부.
- **개선 방법:** profiler를 현재 mode/function map에 맞추고 고정 fixture 또는 명시적
  `--data-dir`에서 JSON 결과를 출력하게 한다. 저비용 metric으로 route별 count,
  TTFB/end-to-body histogram, response bytes, range slice time, cache hit/miss,
  scheduler queue wait, RSS/high-water를 추가한다.
- **예상 효과 / 난이도:** 이후 최적화의 go/no-go 판단이 가능해진다. 난이도 낮음~중간.
- **회귀·운영 위험:** 모든 요청 상세 로그는 I/O와 민감 query 노출을 늘린다. sampling,
  bounded labels, query value 비수집이 필요하다.
- **검증 방법 / 지표:** profiler CI smoke test, known fixture output schema, 계측 on/off
  overhead 비교(<목표 budget은 측정 후 결정), label cardinality와 log volume.

### F-08. PastIndicatorsCache의 generation map은 LRU와 함께 prune되지 않는다 — Low

- **상태 / 확신:** 코드상 확인됨; 유의미한 메모리 영향은 가설 / 중간
- **근거 위치:**
  - `hoga/api/past_indicators_cache.py:141-157` — `_gen`은 일반 dict
  - `hoga/api/past_indicators_cache.py:184-190` — 실제 value cache만 LRU prune
  - `hoga/api/past_indicators_cache.py:225-242` — 접근한 `(code,date,source)` token을 계속 보존
- **현재 동작과 병목 이유:** long-lived 프로세스가 매우 많은 Stock-Date를 훑으면 value는
  축출돼도 작은 generation metadata는 남는다.
- **영향받는 요청/작업:** 장기간 여러 종목/날짜를 탐색한 `/api/range`.
- **예상 영향:** memory, 매우 작은 dict lookup CPU.
- **개선 방법:** `_gen`도 충분히 큰 bounded LRU로 만들거나, 어떤 value cache에도 같은
  prefix가 없을 때 token을 제거한다.
- **예상 효과 / 난이도:** 효과는 작고 구현은 낮은 난이도다.
- **회귀·운영 위험:** 너무 일찍 지우면 다음 접근에서 prefix purge가 누락될 수 있으므로
  stale correctness test가 필요하다.
- **검증 방법 / 지표:** 10k/100k unique Stock-Date 접근 뒤 `_gen` size/RSS와 recapture
  stale invalidation differential test.

## 5. 영향도 × 구현 비용 정렬

| 우선 | 항목 | 영향도 | 비용 | 추천 |
|---:|---|---|---|---|
| 1 | F-01 과거 분봉 disk read-through | 높음 | 중간 | 정책 확인 후 구현 후보 |
| 2 | F-02 LiveBuffer 실규모 계측·global high-water | 높음 | 낮음 | 즉시 계측 |
| 3 | F-07 profiler 복구와 stage metrics | 중간~높음 | 낮음 | 즉시 |
| 4 | F-06 `_done` bounded history/summary 분리 | 중간 | 낮음~중간 | Quick Win |
| 5 | F-03 sidecar 상위 slice materialization/chunk | 높음 | 중간~높음 | 재측정 후 |
| 6 | F-04 Screener window 공유 | 중간 | 중간 | 실제 corpus EXPLAIN 후 |
| 7 | F-05 Inventory manifest/index | 중간 | 중간 | Stock-Date 규모 임계 도달 시 |
| 8 | F-08 generation map prune | 낮음 | 낮음 | 다른 cache 작업과 묶기 |

## 6. Quick Wins

1. `tools/profile_live_range.py`의 제거된 함수와 `mode=full`을 고치고 fixture smoke test를 붙인다.
2. `/api/range`에 일자뿐 아니라 slice별 elapsed, cache result, result count를 sampled metric으로
   남긴다. `HOGA_PERF_DEBUG` raw 로그만 의존하지 않는다.
3. LiveBuffer status에 publish count/rate, per-code high-water, queue drop, process RSS를
   추가한다. byte는 처음에는 표본 추정치로 두고 정확한 deep-size를 hot path에서 매번
   계산하지 않는다.
4. Capture `_done`의 UI history와 누적 counter/dedupe state를 분리하고 응답 pagination 또는
   보존 상한을 둔다.
5. Inventory API에 `row_count`, build duration, stat count를 계측해 실제 설치 규모가
   manifest 전환 임계에 도달했는지 확인한다.

## 7. 구조적 개선 과제

1. **Immutable past-minute cache 계층화:** memory LRU 앞에 versioned disk cache.
2. **Live display plane 축소:** 모든 active code의 full payload 보존을 중단하고
   viewed/subscribed code와 persisted storage plane을 분리.
3. **Sidecar 일자 산출물 materialization:** 동일 Stock-Date의 여러 JSON cache 파일과
   객체 조립을 하나의 versioned day bundle 또는 필요한 overlay별 lazy chunk로 정리.
4. **Screener window plan 공유:** condition compiler가 leaf마다 전체 window를 만드는 대신
   공통 history/latest projection과 필요한 기간 집합을 계획.
5. **Event-driven inventory index:** capture/promote/watchdog event로 증분 갱신하고 startup에
   filesystem reconcile.

## 8. 추가 계측·부하 테스트가 필요한 가설

- 실제 Kiwoom 4×200 활성 종목에서 LiveBuffer가 어느 tick mix로 얼마나 빨리 증가하는가.
- current head에서 20/60일 sidecar의 상위 slice가 무엇인지. 2026-07-05 수치는 구조 근거지만
  최신 절대 성능은 아니다.
- 서로 다른 `/api/range` 요청이 동시 실행될 때 DuckDB shared memory 예산과 Polars transient
  RSS가 어느 동시성에서 throughput 역전/OOM 위험을 만드는가.
- 실제 screener corpus에서 다중 MA/window가 합성 2.5배 증가와 같은 형태를 보이는가.
- 실사용 Stock-Date 수와 `/api/stock-dates` 응답 크기가 manifest/pagination을 정당화하는가.
- 사용자가 `_done`을 dismiss하지 않는 세션에서 terminal row가 실제로 얼마나 누적되는가.
- KIS scheduler의 background requeue(`hoga/live/kis_capacity_scheduler.py:206-233`)가
  user-visible saturation 때 event-loop CPU를 의미 있게 소비하는가. 현재는 문제로 단정할
  측정이 없다.

## 9. 추천 벤치마크 시나리오와 핵심 지표

### A. Range cold/warm matrix

- 입력: 1개 표준 종목 + 1개 heavy 종목, 5/20/60 Stock-Date, 1m/3m/10m,
  hoga/sidecar/candles.
- 단계: 새 프로세스 cold 1회, 같은 process warm 5회, 1/4/12 concurrent distinct keys.
- 지표: TTFB, end-of-body, p50/p95, slice별 wall/CPU, raw/gzip bytes, RSS peak,
  DuckDB temp bytes, cache hit/miss.

### B. Past-candles restart benchmark

- 입력: 5/20/60 거래일, 동일 종목 재조회, process restart 전후.
- 외부 KIS에 반복 부하를 주지 않도록 mock/recorded transport를 기본으로 하고,
  승인된 개발 계정의 소수 실호출만 별도 실행한다.
- 지표: p50/p95, `fresh_past_fetches`, scheduler queue wait, HTTP count, disk hit ratio,
  corruption/stale fallback.

### C. LiveBuffer soak

- 입력: recorded/synthetic WS로 1/50/200/800 codes, 실제 관측된 kind별 rate,
  최소 20분(15분 retention 안정상태 포함).
- 지표: RSS curve/high-water, entries and estimated bytes/code/kind, publish p99,
  event-loop lag p99, GC time, subscriber drops, `/series` p95, first-view data gap.

### D. Screener plan scaling

- 입력: 실제 schema의 1M+ rows, condition 0/1/2/4/8, 전체시장 vs watchlist/heatmap scope.
- 지표: wall/CPU p50/p95, `EXPLAIN ANALYZE` operator time, scanned rows, peak memory,
  temp spill, result differential.

### E. Inventory와 capture queue cardinality

- Inventory 1k/10k/30k Stock-Date, done 1k/10k/50k.
- 지표: stat/open count, snapshot/serialization time, response bytes, RSS,
  event invalidation에서 화면 갱신까지의 시간.

### F. 혼합 부하

- 동시 workload: live WS ingest + today promotion + 3 capture workers + range 4개 +
  screener 1개.
- 지표: request p95/p99, event-loop lag, RSS, CPU, DuckDB temp, capture sec/page,
  KIS scheduler queue wait/reject. 개별 benchmark가 빠르더라도 한 프로세스 자원 경합을
  놓치지 않기 위한 최종 검증이다.

## 10. 단계별 실행 계획

### 1단계 — 낮은 위험·높은 효과

1. 깨진 range profiler를 current mode와 함수 목록에 맞추고 fixture smoke test를 추가한다.
2. route/stage/cache/queue/RSS의 bounded-cardinality metric을 추가한다.
3. LiveBuffer 실규모 soak와 current-head range matrix를 실행한다.
4. Capture `_done` 보존 정책을 결정하고 bounded history 또는 pagination을 적용한다.

### 2단계 — 계측 및 검증

1. past-candles restart 전후 `fresh_past_fetches`와 latency를 재측정한다.
2. 실제 heavy Stock-Date 2개로 sidecar slice breakdown과 1/4/12 동시 부하를 측정한다.
3. screener 실제 corpus에 `EXPLAIN ANALYZE`를 수집한다.
4. 실제 inventory/done cardinality를 관찰해 manifest와 pagination의 go/no-go를 정한다.

### 3단계 — 구조적 개선

1. 정책 승인을 거쳐 immutable past-minute disk cache를 구현한다.
2. LiveBuffer를 viewed/subscribed display plane 중심으로 재설계하고 first-view backfill을 붙인다.
3. 측정상 지배적인 sidecar slice를 materialize 또는 lazy chunk로 분리한다.
4. screener 공통 window plan과 event-driven inventory index를 각각 differential test와 함께
   도입한다.

각 단계는 이전 단계의 baseline과 같은 corpus·명령으로 before/after를 비교해야 한다.
정합성 test green만으로 성능 개선을 선언하지 않는다.

## 11. 측정 전 최적화하면 안 되는 항목

1. **Uvicorn worker 수 증가:** queue, buffer, scheduler, lifecycle singleton과 queue ownership
   계약을 깨고 메모리를 복제할 수 있다.
2. **DuckDB memory limit 상향 또는 per-day 무제한 병렬화:** 과거 OOM 장애의 재발 위험이 있다.
3. **KIS worker/pending/rate 값을 더 공격적으로 변경:** 계정별 rate limit과 user-visible
   starvation을 먼저 측정해야 한다.
4. **LiveBuffer retention 단순 축소:** promotion/refetch seam coverage 불변식을 깨뜨릴 수 있다.
5. **오늘 데이터의 장기 캐시:** Today Promotion과 recapture mtime invalidation 정합성을
   훼손할 수 있다.
6. **GZip threshold 변경 또는 압축 제거:** 현재 코드에 9배 압축 실측이 있으므로 CPU와
   wire time을 함께 측정해야 한다.
7. **Parquet에 일반적인 DB index를 추가하려는 시도:** 이 저장소의 주 read path는 날짜별
   Parquet scan과 DuckDB analytic query다. 먼저 partition pruning·projection·materialization을
   측정해야 한다.
8. **JSON 라이브러리 교체:** sidecar의 지배 비용이 query인지 객체 조립인지 serialize인지
   profiler 복구 전에는 알 수 없다.
9. **현재 peak-wall 알고리즘 재최적화:** ADR-0085 v2.1에서 이미 큰 구조 개선과 동시성
   검증을 마쳤다. 최신 profile에서 다시 상위에 나타날 때만 다룬다.
10. **모든 경고를 이유로 Ruff 456건을 일괄 수정:** 성능과 무관한 대규모 churn이 회귀 분석을
    어렵게 한다. 성능 변경과 분리해야 한다.

## 12. 문제로 판정하지 않은 항목

- **N+1 ORM / missing relational index:** ORM이나 서버형 RDB를 사용하지 않는다. 확인된 반복
  스캔은 F-03/F-04처럼 DuckDB/Parquet 실행계획 문제로 분류했다.
- **KIS connection 생성 반복:** persistent AsyncClient와 timeout/retry가 이미 있다.
- **무제한 KIS pending queue:** unique inflight key 1,000에서 reject한다.
- **무압축 대형 range 응답:** GZip middleware가 이미 적용돼 있다. 다만 serialize/object
  비용과 초기 응답 총량은 F-03에 남는다.
- **shared DuckDB connection race:** `cursor()` 분리와 30-concurrent 회귀 테스트가 있다.
- **과거 peak-query OOM:** 현재 코드는 bounded connection과 v2.1 vectorized sweep를 사용한다.

