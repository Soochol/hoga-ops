# 0085 — DuckDB Resource Bounds + Peak-Query Concurrency Guard

**Status:** accepted (2026-07-07)

**Related:**
- ADR-0084 — Event-based peak wall classification (the query this guards/​rewrites)
- ADR-0043 — Today indicators recompute live, never persisted (why today's peak is uncached)
- ADR-0057 — Factor store (another `duckdb.connect(":memory:")` consumer bounded here)

## Context

`/live` 페이지에서 백엔드 uvicorn 워커가 CPU/메모리 폭주로 반복 OOM-kill 되는
장애가 보고되었다. 2026-07-07 조사로 다음을 확정했다.

- 커널 OOM 로그: 하루 3회(01:25/10:38/12:41) python 워커가 anon-rss **87~90GB**(램 91GB)까지
  부풀어 강제 종료. 물증으로 메인 체크아웃 `.tmp/`에 DuckDB 스필 파일 **356GB**(7/5 장 마감
  직전 생성)가 남아 있었다.
- 근원 쿼리: `hoga/tables/snapshots.py::query_day_ask_bid_peak_dual` (ADR-0084로 도입된
  이벤트 기반 피크 월 분류). 비등가 조인 `JOIN … ON t.price {>=|<=} p.price`(당일 전체
  거래 틱 × 분류 가격 레벨의 부분 카르테시안 곱)과 `ROWS BETWEEN UNBOUNDED PRECEDING …`
  윈도우를 ask/bid × rep/cont 4세트로 물질화한다.
- 실측(2026-07-07):
  - 삼성 20260619(스냅샷 6.4만 × 거래 51만): 8GiB 상한에서 RSS 3.56GB / 15.7초.
  - 최악의 날 20260623/000660(distinct 803 × 거래 55만): 8GiB 상한에서 RSS **17.16GB** / **155.56초**.
- 두 가지 구조적 사실이 OOM을 만든다.
  1. **`memory_limit`은 soft** — 비등가 조인이 8GiB를 뚫고 17GB까지 감. 상한만으로는 단일
     최악 쿼리를 못 가둔다. 게다가 기존 코드는 `duckdb.connect(":memory:")`에 상한을 아예
     설정하지 않아 기본 80%(~73GB) + `temp_directory` 기본 `<cwd>/.tmp`로 356GB를 스필했다.
  2. **커넥션 동시성** — `QueryEngine.conn`은 접근마다 독립 커서(하나의 :memory: DB 공유)를
     반환하고 `/api/range`는 sync 라우트(스레드풀)라 쿼리가 진짜 병렬 실행된다. `memory_limit`은
     그 공유 DB의 **단일 soft 예산**이라 N개 병렬이 집합적으로 초과한다. 과거 날짜 피크는
     `PastIndicatorsCache`(디스크)로 캐시되지만 오늘 날짜는 ADR-0043로 캐시하지 않아 sidecar
     폴링·focus/reconnect refetch 버스트마다 재계산이 병렬 누적된다. 관측된 87GB ≈ 17GB × 5.

## Decision

### 1. 모든 in-process DuckDB 연결은 `hoga.duck.connect_bounded()` 경유

기본 `memory_limit=8 GiB`(`HOGA_DUCKDB_MEMORY_LIMIT`), `temp_directory=<data_dir>/duckdb-tmp`,
`max_temp_directory_size=50 GiB`(`HOGA_DUCKDB_MAX_TEMP_SIZE`). 6개 기존 호출 지점을 모두 교체.
이유: 스필이 repo가 아닌 데이터 디렉터리로 가고(그리고 `.tmp/`는 gitignore), 상한 없는 80%
기본값을 제거한다. **단, `memory_limit`은 soft이며 공유 예산이라 이 자체가 보증은 아니다.**

### 2. 무거운 dual-peak 쿼리에 동시성 가드 (`hoga.api.peak_slice_guard`)

프로세스 전역 `BoundedSemaphore`(기본 2, `HOGA_PEAK_QUERY_CONCURRENCY`)가 동시에 실행되는
무거운 피크 계산 수를 제한하고, 키 `(code, date, source, bucket_ms)`별 single-flight가 동일
계산의 동시 중복을 하나로 합친다. single-flight는 in-flight 창 밖에서 아무것도 보존하지
않으므로 **staleness 0** — ADR-0043의 "오늘은 캐시하지 않는다" 계약을 지킨다. `build_ask_bid_peak_slices`의
쿼리 호출을 이 가드로 감싼다(오늘·과거-첫계산 모두 커버).

검증(삼성 20260619, 8-병렬, distinct 키): unguarded peak RSS **28.34GB** → guarded(K=2) **6.81GB**.
최악의 날 외삽: unguarded ~85–136GB(OOM) → guarded ~34GB(91GB에서 생존).

### 3. 프론트 refetch 버스트 차단

`QueryClient`에 `refetchOnWindowFocus:false`, `refetchOnReconnect:false`. 탭 재포커스·네트워크
재연결 시 활성 `/live` 폴링이 일제히 재발화하는 버스트를 소스에서 차단한다(인터벌 폴링은 유지).

## Consequences

**보증 범위(정직하게):** 가드는 **동시(N-병렬) OOM을 매우 낮춤 — 강력한 인터림 완화이지
보증이 아니다**. `memory_limit`이 soft라서 미래의 000660보다 나쁜 날은 단일 쿼리로도 17GB를
넘길 수 있다. 그 천장을 없애는 것은 아래의 쿼리 재작성이다.

### 이월(deferred) — 후속 작업

1. **선형 스위프 재작성** (별도 PR): `query_day_ask_bid_peak_dual`의 비등가 조인·UNBOUNDED
   윈도우를 선형 SQL 스캔 + 파이썬 정렬 스위프(Fenwick lifecycle)로 대체해 155초/17GB 단일
   쿼리 비용 자체를 제거한다. 안전망은 hand-written 유닛 테스트가 아니라 **old-vs-new 차등
   테스트**(구 SQL과 신 스위프 출력이 여러 실데이터 날에서 동일함을 assert 후 구 SQL 삭제).
   주의: 2026-07-05에 파이썬 분류기가 시도됐다 기각(`6239f67a`)됐으나 그 구현은
   O(touches×prices) 루프여서 느렸던 것 — 재작성은 반드시 O((N+M) log M) 스위프여야 한다.
2. **알려진 peak-wall 테스트 불일치** (별건, 제품 의도 필요): 분기 기준(main `f56347be`)에 이미
   14개 실패가 존재한다 — `test_api_range.py` 11개(테스트 스텁 `_build_range_bundle_stub` kwarg
   드리프트), `tests/hoga/api/test_bundle.py` 2개(`untraded_peaks`가 가격별 dedup 되지 않기를
   기대 vs 현 SQL은 `(price, is_touched)`로 dedup), `tests/unit/live/test_stream.py` 1개. 이번
   변경은 이들을 건드리지 않는다(재작성 시 "64개 유닛 green + 14개 실패 바이트 동일" 유지).
   `untraded_peaks` dedup 의미론은 제품 결정이 필요하므로 별도로 다룬다.
