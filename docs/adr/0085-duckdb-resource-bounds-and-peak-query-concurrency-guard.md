# 0085 — DuckDB Resource Bounds + Peak-Query Concurrency Guard

**Status:** accepted (2026-07-07); 이월 항목 1(선형 스위프 재작성) 랜딩(2026-07-07)

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

### 랜딩됨 — 선형 스위프 재작성 (2026-07-07, 이월 항목 1 완료)

`query_day_ask_bid_peak_dual`의 비등가 조인·UNBOUNDED 윈도우를 선형 SQL 스캔(cont/rep
언피벗 + touch) + 파이썬 정렬 스위프로 대체했다. 스위프는 **2패스**다.

- **pass 1 (역방향)**: running future-extreme으로 `is_touched` 계산. 같은 `(ts, seq)` 터치를
  **포함**(구 SQL의 `ORDER BY … is_touch DESC` + `future_max_price >= price`와 동치).
- **pass 2 (정방향)**: touch 가격을 인덱싱한 **Fenwick prefix-max 트리**로 `lifecycle_id`
  (STRICTLY-earlier 지배 터치의 max touch_ord) 계산. `touches_sorted`의 정렬키 `(ts, seq,
  price)`가 구 SQL의 `touch_ord` ROW_NUMBER 순서와 동일해 리스트 1-based 위치가 곧 ordinal.

전체 O((N+M) log M). 2026-07-05에 기각된 파이썬 분류기(`6239f67a`)는 터치마다 활성 가격을
선형 스캔하는 O(touches×prices) 루프여서 느렸던 것 — 이 재작성은 그 함정을 스위프+Fenwick으로
회피한다. 공개 시그니처·반환 dataclass(`AskPeakDualRow`/`BidPeakDualRow`)는 불변.

**안전망 = old-vs-new 차등 테스트**(hand-written 유닛만으론 저자 멘탈모델을 공유해 불충분).
구 SQL을 `_legacy` 오라클로 남긴 채 크기 분포(9KB~6MB)를 가로지르는 **25개 실데이터 날**(무거운
20260619/005930·20260623/000660 포함)에서 신·구 dataclass 전체가 동일함을 assert하고
(비퇴화: touched/None-side/traded+untraded 케이스를 각각 관측했음을 집계) 통과 후 구 SQL을
삭제했다. 결과: **0 불일치**.

실측(8GiB 상한, 단일 쿼리):

| 날짜 | 구 SQL | 신 스위프 |
|---|---|---|
| 삼성 20260619/005930 | 15.7s / 3.56GB | ~4.5s / 0.79GB |
| 최악 20260623/000660 | 155s / 17.16GB | ~4.3s / 0.72GB |

soft `memory_limit`을 뚫던 단일 최악 쿼리의 17GB 천장이 제거됐다(0.72GB, 8GiB 아래).
가드(Decision 2)는 여전히 유효하며 동시 재계산을 계속 제한한다 — 재작성은 per-query 비용만
낮췄고 두 방어는 직교한다. 참고: 조인이 폭발하지 않는 일반적인 날(대다수)은 벡터화 SQL이 파이썬
객체 스위프보다 빨라 신 구현이 소폭 느리다(예: 0.3s→2s). 근본 장애는 **꼬리**(worst-case 폭주)
였으므로 수용하며, 필요 시 `fetchnumpy`/컬럼 스트림 전환이 후속 최적화 경로다.

### v2 — 컬럼형 스위프 전환 + 동시성 가드 은퇴 (2026-07-11)

위 문단이 예고한 "`fetchnumpy`/컬럼 스트림 전환" 후속을 랜딩하고, 그 결과로 Decision 2의
세마포어(`PeakSliceGuard`, `HOGA_PEAK_QUERY_CONCURRENCY=2`)를 **은퇴**시켰다.

**계기 — 가드의 존재 이유가 바뀌어 있었다.** 제거 검토 Phase 0 실측(034020/20260116,
110k rows, bucket 600000)에서 선형 스위프(v1)는 단독 6.4s / +1.0GB RSS였고, 서로 다른
무거운 날 **12개 동시 실행이 wall 94s(개당 p50 77s)로 순차 합계 77s보다 느렸다** — 순수
파이썬 스위프가 GIL-bound라 병렬화가 순손실이었고, 세마포어=2가 우연히 최적에 가까운
처리량 조절기 역할(2-wide 추정 38s, 무제한 대비 2.5×)을 하고 있었다. 즉 "OOM 방지"로
태어난 가드가 "GIL 처리량 보호"로 살아 있었던 것.

**전환 내용.** 데이터 플레인을 polars(Rust, GIL 해제)로 이동:

- `_read_peak_wall_streams`(dataclass ~2M개 물질화, +1GB RSS 지배 비용) →
  `_read_peak_wall_frames`(DuckDB→Arrow→polars, SQL 불변).
- pass 1(is_touched) → 병합 타임라인 reverse `cum_max/cum_min` + `forward_fill`
  벡터화(이벤트가 같은 `(ts,seq)` 터치보다 앞에 정렬되어 `>=` 포함 계약 보존).
- 랭킹·dedup 축약(`_peak_scalar`/`_peak_candidates`/`_peak_bucket_dedup`/lifecycle
  distinct) → 프레임 정렬 + `unique(keep="first")`.
- pass 2(lifecycle Fenwick)만 파이썬 루프로 잔존하되 평범한 int 리스트 위에서 동작
  (per-event 객체·함수호출 제거, 가격 랭크는 `search_sorted`로 일괄 계산).

**동등성 증거** — `tests/test_peak_sweep_oracle.py`: v1 구현 전체를 동결 오라클로 복사,
시드 퍼즈 40케이스(동일-키 터치·lifecycle 재개·붕괴책·세션 경계·빈 터치) + 실데이터 3일
(최중량 034020/20260116 포함) 전 필드 일치. 기존 스냅샷 테스트 81개 green 유지.

**실측(백필 active 24 부하 중, 동일 조건 재측정):**

| 지표 | v1 스위프 | v2 컬럼형 |
|---|---|---|
| 단독 최중량일 | 6.4s / +1.0GB | **1.1s / ~450MB transient** |
| 동시 ×12 wall | 94s (순차 77s보다 느림) | **7.1s (순차 13.2s보다 빠름)** |
| 동시 ×12 피크 RSS | +8.1GB | +6.2GB |

**가드 은퇴 근거.** 동시성이 순이득으로 반전됐고(GIL 해제), per-compute 메모리가 DuckDB
예산(8GiB) 대비 소액이며, 요청 내부 per-day 루프가 순차라 동시 peak 계산 수는 동시
`/api/range` 요청 수로 자연 상한된다. 따라서 상한은 정당한 wide-range 첫-터치 작업을
직렬화하는 순비용만 남는다. 모듈은 `hoga/api/slice_coalescer.py`로 개명하고 single-flight
(`SLICE_COALESCER`)만 남겼다 — 동일-키 폭풍 붕괴는 여전히 이것이 담당하며, dual-peak 키는
TTL 키를 미러해 `(kind, code, date, source, bucket_ms, session_open_ms, session_close_ms)`
로 세션 경계를 포함한다(구 가드 키의 경계 누락 잠재 결함 봉합).

### v2.1 — lifecycle 세그먼트 잉여 증명 → pass 2 삭제 (2026-07-11)

v2가 남겨둔 유일한 파이썬 루프(lifecycle Fenwick, 최중량일 1.1s 중 ~0.7s)를 CDQ
벡터화하려다, 더 강한 사실을 증명했다: **lifecycle은 최종 출력에 잉여다.**

정리: 모든 (price, lifecycle) 세그먼트는 touched 값이 순수하다. 가격 p의 지배
터치 키를 d_1 < … < d_K라 하면 count(e)=c<K인 이벤트는 d_{c+1} ≥ key(e)가
존재해 touched, c=K면 어떤 지배 터치도 ≥ key(e)가 아니라 untouched. 따라서
distinct_best[(p, X)]는 "클래스 X 전역 rank-1"과 동치이고(순수 분할의 max-of-
maxes = 클래스 전역 max), per-event lifecycle id도, per-(price,lifecycle) 중간
dedup도 불필요하다. 원 SQL(ADR-0084)의 lifecycle 기계는 이 동치를 모른 채
일반형으로 구현된 것이었다.

검증: 동결 v1 오라클(lifecycle 기계 포함) 대비 시드 퍼즈 **120케이스** + 실데이터
3일(최중량 034020/20260116 포함) 전 필드 일치 — 정리의 경험적 재확인.

실측(백필 부하 중, v2 → v2.1):

| 지표 | v2 | v2.1 |
|---|---|---|
| 단독 최중량일 | 1.1s | **0.53s** (v1 대비 12×) |
| 동시 ×12 wall | 7.1s | **1.95s** (per-day p50 1.79s) |
| 동시 ×12 피크 RSS | +6.2GB | +5.5GB |

이로써 분류기는 파이썬 루프 0개 — DuckDB 스캔 + polars 프레임 연산만 남았다.

### v3 — 라우트 레벨 상한 신설 (2026-08-10). v2 의 은퇴를 되돌리는 것이 아니다

v2 가 은퇴시킨 것은 **peak 쿼리 데이터 플레인**의 가드(`PeakSliceGuard`)다. 그 판단은
지금도 유효하다 — 그 경로는 polars 로 GIL 을 놓아 동시성이 순이득이다. v3 이 새로
거는 것은 **`/api/range` 라우트 전체**의 동시 compute 상한이고, 대상이 다르다:
peak 이 빠져나간 뒤 남은 파이썬 경로, 그중에서도 **행 → pydantic 모델 생성**이다.

**계기 — v2 의 은퇴 근거 한 줄이 사실이 아니었다.** v2 는 이렇게 적었다:

> 요청 내부 per-day 루프가 순차라 동시 peak 계산 수는 동시 `/api/range` 요청 수로
> **자연 상한**된다.

그 "자연 상한" 이 실측 **22** 였다(2026-08-10, `/study` 로딩 지연 조사). 프론트가
창당 4쿼리를 걸고 탭 워밍이 활성화된 탭 전부에 같은 4벌을 한꺼번에 발사한 결과다.
상한이 22면 상한이 아니다.

**실측 — 이 경로는 여전히 GIL-bound 다.**

| 측정 | 값 |
|---|---|
| `build_range_bundle(candles)` 98일·36,276봉 단독 | 0.63s → **0.29s** (아래 `model_copy` 제거 후) |
| 조용한 서버에서 같은 요청 HTTP 왕복 | 0.63s |
| 서버 slow-log median (동시 22건 구간) | candles 8.9s · hoga 8.3s · sidecar 14.6s |
| 같은 로그 max | sidecar 213.2s |
| 스레드 6개 동시 (32코어) | wall **7.1×** — 커넥션 개별 지급 시에도 7.8× |

`build_candles_slice` 내부는 처음 잴 때 DuckDB `query_all` 60% · `model_copy`
재타임스탬프 **38.7%** · 파일시스템 1.4% 였다. parquet 이 날짜당 10KB 라 쿼리 실행
자체는 미미하고, 시간의 대부분이 모델 객체 생성이었다 — 36,276개를 만들고
`model_copy` 로 **다시 36,276개**.

그 두 번째 벌은 이 작업에서 제거했다: `ts_ms` 자정→Unix 보정을 SQL 로 밀고
(`candles.query_all(..., ts_offset_ms=...)`) 호출부의 `model_copy` 를 지웠다.
`build_range_bundle` 단독이 **0.63s → 0.29s**(-54%)로 줄었고, 남은 분해는
`query_all` 96% · 파일시스템 4% 다. 기대치(38.7%)보다 감소폭이 큰 이유는
`model_copy` 가 필드 복사만이 아니라 **pydantic 검증을 한 벌 더** 돌리기 때문이다.

**그래도 이 경로는 여전히 GIL-bound 다** — 남은 96% 도 행→pydantic 모델 생성이라
6-스레드 팽창이 7.1×로 그대로다. 상한의 근거는 유지된다.

**상한을 모두에게 걸면 손해다 — 측정이 설계를 한 번 뒤집었다.** 처음에는 모든
`/api/range` 를 한 큐에 넣었고, **같은 요청 12개**(전부 5개월)로 재면 상한 1이
모든 지표에서 최선이었다(무제한 대비 첫 완료 4.91s → 0.33s, 평균 5.05s → 2.29s).
균일한 작업에 FIFO 단일 큐가 최적인 것은 당연하다.

그러나 **운영 부하는 균일하지 않다.** `/study` 의 5개월과 `/live` 의 하루가 같은
엔드포인트를 탄다. 혼합 부하(무거운 것 6 + 가벼운 것 16 = 22 동시)로 재자:

| 상한 (단일 큐) | wall | 가벼운것 중앙 | 무거운것 중앙 | 전체 평균 |
|---|---|---|---|---|
| 무제한 | 1.95s | 0.25s | 1.73s | 0.62s |
| 1 | 1.87s | **1.85s** | 1.15s | 1.61s |
| 2 | 1.72s | 1.48s | 1.20s | 1.39s |
| 4 | 1.82s | 1.52s | 1.31s | 1.44s |

가벼운 요청의 중앙값이 **7배** 나빠진다. 총 wall 은 어느 쪽이든 비슷하므로 상한은
이득이 아니라 **재분배**였고, 그 재분배가 손해 쪽이었다 — head-of-line blocking,
하루짜리가 5개월짜리 뒤에 갇힌다.

**그래서 큐를 무게로 나눈다.** 요청 구간이 `RANGE_WIDE_SPAN_DAYS`(30일) 이상일
때만 상한을 태우고, 좁은 요청은 예전처럼 곧장 지나간다. 같은 부하 재측정
(2회, 순서 재현됨):

| 상한 (넓은 것만) | wall | 가벼운것 중앙 | 무거운것 중앙 | 전체 평균 |
|---|---|---|---|---|
| 무제한 | 1.93s | 0.25s | 1.81s | 0.62s |
| **1** | **1.90s** | **0.16s** | **1.24s** | **0.44s** |
| 2 | 1.90s | 0.21s | 1.40s | 0.50s |
| 4 | 2.07s | 0.21s | 1.70s | 0.62s |

**모든 열이 개선된다** — 재분배가 아니라 실제 이득이다. 30일 경계는 두 사용처
사이의 빈 구간이며, 틀려도 실패하지 않는다(좁은 것이 상한을 타거나 넓은 것이
안 타는 것뿐).

⚠ **상한 값은 compute 비용의 함수다 — 한 번 바뀌었다.** `model_copy` 로 행을 두 벌
만들던 시절에는 compute 가 지금의 2배여서 **2가 최적**이었다(1이면 넓은 것끼리
완전 직렬이라 그쪽 중앙값이 올라갔다). `ts_ms` 보정을 SQL 로 민 뒤 compute 가
절반이 되자 대기 자체가 싸져, GIL 경합을 아예 피하는 **1이 다시 최적**이 됐다.
이 경로의 비용을 또 바꾸면 이 표를 다시 재라.

교훈으로 남길 것: **균일 부하로 잰 동시성 결론은 혼합 부하에서 뒤집힐 수 있다.**
같은 요청을 N개 복제해 재는 벤치마크는 큐 정책을 결정하기에 부적합하다.

**구현 — 라우트를 `async def` 로 바꾸는 것이 상한의 전제다.** 동기 `def` 였다면
FastAPI 가 요청마다 스레드풀 스레드를 먼저 잡고 **그 스레드 위에서** 상한을 기다려,
대기자들이 40 토큰짜리 공용 풀을 채우고 다른 동기 라우트까지 굶긴다. 이제 대기는
이벤트 루프에서 일어나고(`anyio.CapacityLimiter`), 스레드를 쥐는 것은 실제로 계산
중인 1건뿐이다(`anyio.to_thread.run_sync`). 400 검증은 상한 **밖**이다.

`CapacityLimiter` 를 라우터 팩토리 클로저에 두는 것은 테스트 격리를 위해서다.
그것이 가능한 근거는 실측이다 — 이 객체는 생성 시점에 이벤트 루프를 붙잡지 않아
서로 다른 `asyncio.run` 에서 재사용된다(팩토리는 uvicorn 루프보다 먼저 돌고
`TestClient` 는 인스턴스마다 루프를 만든다).

**관측** — 대기 시간은 TTFB 에 그대로 포함되므로, 그것만 보면 다음 조사자가 **큐
대기를 계산 시간으로 읽는다**. `queue_wait_ms` 가 1초를 넘으면 `perf_debug` 게이트와
무관하게 로그를 남기고, 성공·실패 로그 양쪽에 `queue_wait_ms` 와 `compute_ms` 를
`duration_ms`(전체)와 나란히 싣는다.

**이 상한이 못 보는 것.** (1) 무게 대리(proxy)가 **일수**다 — 실제 비용은 그 구간에
캡처가 얼마나 있느냐인데, 데이터 없는 넓은 구간도 줄을 선다(빨리 끝나므로 뒤를
오래 막지는 않는다). (2) 넓은 것끼리는 여전히 단일 FIFO 라, 5개월과 2년이 섞이면
같은 head-of-line 문제가 그 안에서 재현된다. (3) 프로세스 안에서만 상한이다 —
워커를 늘리면(README 가 금지한다) 상한도 그만큼 배수가 된다.

### v3.1 — "polars 로 옮기면 상한이 불필요해진다" 는 **측정으로 반증됐다** (2026-08-10)

v3 을 쓸 때 이 절은 "이 경로도 v2 처럼 컬럼 지향으로 옮기면 GIL 이 풀려 상한 자체가
불필요해진다" 로 닫혔다. 그 문장을 검증하려 재 보니 **사실이 아니다.** 근거를 남긴다.

**(a) candles 경로에서 polars 의 이득은 "모델을 안 만들 때만" 있다.** 95일·36,276행:

| 변형 | 단독 | 6-스레드 wall | 팽창 |
|---|---|---|---|
| 현재 (DuckDB fetchall + `ApiCandle`) | 0.121s | 0.491s | 4.0× |
| `model_construct` (검증 생략) | 0.182s | 0.724s | 4.0× |
| **polars 컬럼만 (모델 0개)** | 0.120s | 0.263s | **2.2×** |

`model_construct` 는 **더 느리다**(dict/zip 오버헤드가 검증 절약분을 넘는다) — 기각.
polars 로 읽되 끝에서 `ApiCandle` 을 물질화하면 0.163s → 0.136s, **16%** 에 그친다.
팽창이 2.2× 로 떨어지는 유일한 변형은 `ApiCandle` 을 **아예 만들지 않는** 것이고,
그건 `RangeBundle.candles` 라는 wire 계약 자체를 컬럼→JSON 바이트 경로로 바꾸는
일이다(ADR-0004 손 미러 · 계약 테스트 3층 · `JSON_RESPONSE_ROUTES` 가 막는 자리).

**(b) ~~남은 GIL 무게는 candles 에 있지 않다~~ — 이 주장은 측정 조건 오류였다.**

처음 실은 표는 이랬다(**폐기**):

| 모드 | 단독 | 6-스레드 wall | 팽창 | |
|---|---|---|---|---|
| candles (1m) | 0.29s | 1.91s | 6.5× | ⚠ |
| hoga (5m) | 0.18s | 2.61s | 14.5× | ⚠ |
| sidecar (5m) | 1.24s | 15.34s | 12.4× | ⚠ |

⚠ **이 프로브는 스레드마다 `QueryEngine` 을 새로 만들었다.** `PastIndicatorsCache`
는 `engine.indicators_cache` 라 engine 마다 하나이므로, 그 구성은 메모리 캐시를
**6벌로 쪼개** 디스크 JSON 재파싱을 6배로 만든다. 실제 서버는 라우터 클로저가
engine **하나**를 쥐고 모든 요청이 공유한다. 즉 위 수치는 운영 조건이 아니다.

engine 을 공유해 다시 재면 **순서가 뒤집힌다**(2회, 괄호는 개별 engine):

| 모드 | 단독 | 6-스레드 팽창 (공유 = 운영) | 참고: 개별 engine |
|---|---|---|---|
| candles (1m) | 0.24~0.25s | **6.7× / 6.8×** | 7.3× |
| hoga (5m) | 0.16~0.21s | 6.1× / 8.0× ※ | 11.0~14.9× |
| **sidecar (5m)** | 0.80~0.84s | **3.8× / 3.7×** | 16.4~16.5× |

※ hoga 는 단독이 0.16~0.21s 로 짧아 비율 노이즈가 크다 — 6~8× 대역으로 읽을 것.

**sidecar 가 가장 잘 병렬화된다** — peak 데이터 플레인이 polars 라 GIL 을 놓기
때문이고, 이는 v2 가 의도한 바가 실제로 동작하고 있다는 뜻이다. 반대로 candles 가
가장 나쁘다(순수 파이썬 물질화).

**(a) 와 결론은 그대로 선다.** polars 이득이 모델-free 에서만 나온다는 것과 wire
계약 충돌은 이 정정과 무관하고, candles 가 최악 팽창이라는 새 사실은 오히려
candles 컬럼화의 논거를 **강화**한다 — 그러나 (a) 의 계약 장벽이 그대로라 판정은
움직이지 않는다.

**결론: 현재 wire 계약 아래서 이 상한은 영구적이다.** 없애려면 `/api/range` 응답을
컬럼→직렬화 경로로 재설계해야 하고, 그건 이 리포가 조용한 필드 스트립 사고를 겪고
세운 계약 기계를 걷어내는 일이다. **하려면 별도 ADR 로 의도를 먼저 세울 것.**

⚠ 상한 값(1)의 근거인 혼합 부하 sweep 은 **영향받지 않는다** — 그 측정은 실제 HTTP
로 단일 서버 프로세스를 때렸으므로 처음부터 engine 공유(운영 토폴로지)였다.

### v3.2 — 팽창의 절반은 GIL 이 아니라 **GC** 다 (2026-08-10)

v3.1 이 "왜 6× 를 넘나" 를 캐시·메모리 대역폭 경합으로 **추정**했는데, 재 보니 답이
따로 있었다. 같은 부하를 스레드 수를 바꿔 가며(engine 공유):

| N | candles wall | 팽창 | N 대비 | sidecar wall | 팽창 | N 대비 |
|---|---|---|---|---|---|---|
| 1 | 0.37s | 1.3× | 1.32 | 1.34s | 1.1× | 1.13 |
| 2 | 0.68s | 2.4× | 1.21 | 2.19s | 1.9× | 0.93 |
| 4 | 1.21s | 4.3× | 1.08 | 3.37s | 2.9× | 0.71 |
| 6 | 2.00s | 7.1× | 1.19 | 3.43s | 2.9× | 0.49 |
| 12 | 5.25s | 18.8× | **1.56** | 7.22s | 6.1× | **0.51** |

("N 대비" = 팽창/N. 1.0 이 완전 직렬, >1 은 초선형 = 직렬화 말고 추가 경합.)

- **candles 는 초선형**이고 N 이 클수록 심해진다(12스레드에서 1.56).
- **sidecar 는 부선형**이다(0.49~0.71) — 즉 동시성이 **실제 이득**이다. peak polars.

초선형의 정체를 `gc.disable()` 로 갈랐다(N=6, 2회):

| 모드 | GC 켬 | GC 끔 | GC 몫 |
|---|---|---|---|
| candles | 2.29s / 2.24s | 1.36s / 1.14s | **+40.7% / +49.2%** |
| sidecar | 4.52s / 5.20s | 2.09s / 2.54s | **+53.8% / +51.1%** |

**팽창의 약 절반이 GC 다.** CPython 의 세대별 GC 는 stop-the-world 라, 스레드를
늘리면 객체 생성 속도가 올라가 수집이 더 자주 돌고 매 수집이 **모든 스레드를**
멈춘다. 36,276개 모델을 만드는 경로에서 이것이 GIL 직렬화 위에 얹힌다.

**함의 둘.** (1) GC 임계 상향은 코드 구조를 안 건드리고 이 몫을 겨냥한다 — polars
재설계보다 훨씬 싸다. **아래 v3.3 에서 랜딩했다.** (2) sidecar 가 부선형이라는
사실은 무게 분리 기준(요청 **일수**)이 최적이 아닐 수 있음을 시사한다 — 비용이
아니라 **모드**로 가르면 sidecar 는 상한 밖에 둘 수 있다. 이쪽은 미착수.

### v3.3 — GC gen0 임계 상향 랜딩. `gc.freeze()` 는 **근거 부족으로 뺐다** (2026-08-10)

v3.2 의 첫 측정에는 결함이 있었다: **base 에만 워밍 후 `gc.collect()` 가 없었다.**
튜닝 변형은 freeze 앞에서 collect 를 하므로 막 정리된 힙에서 측정을 시작했고, 그
비대칭이 단독 시간 차이를 부풀렸다. 모든 변형이 같은 지점에서 collect 하도록 고쳐
3회 median 으로 다시 재고, **gen0 수집 횟수**를 함께 셌다(가설의 직접 증거):

| 변형 | candles 6스레드 | gen0 수집(단독/6T) | sidecar 6스레드 | gen0 수집(단독/6T) |
|---|---|---|---|---|
| 기본(700) | 2.263s | 144 / 869 | 3.778s | 613 / 1442 |
| **gen0 상향** | **1.428s (+37%)** | **2 / 12** | **1.705s (+55%)** | **2 / 7** |
| `gc.freeze()` 만 | 1.929s (+15%) | 144 / 869 | 3.600s (+5%) | 613 / 1673 |
| freeze + 상향 | 1.655s (+27%) | 2 / 12 | 1.925s (+49%) | 2 / 6 |

**수집 횟수가 869 → 12, 1442 → 7 로 떨어진다** — v3.2 의 "팽창의 절반은 GC" 가
직접 증거로 확인됐다. 단독 시간도 개선된다(sidecar 0.738s → 0.410s) — 즉 이 이득은
동시성 상황에만 오는 것이 아니라 **모든 요청**에 온다.

**`gc.freeze()` 는 채택하지 않았다.** 수집 횟수를 전혀 바꾸지 않고(869→869,
613→613), 상향과 조합하면 오히려 나빴다(1.428 → 1.655). 스캔 집합에서 상주 객체를
빼는 것이 이 워크로드에서는 값을 못 한다. 근거 없이 넣으면 다음 사람이 그것을
"검증된 최적화" 로 읽는다.

**값은 둔감하다.** gen0 2,000~200,000 이 전부 +28~45% 대역이고 서로의 차이는
노이즈다. 중요한 것은 "임계를 올린다" 는 사실이지 정확한 값이 아니다. 기본
50,000(`HOGA_GC_GEN0_THRESHOLD`, `0` = 끔).

**메모리** — 이 ADR 이 OOM 에서 태어났으므로 같이 잰다. peak RSS 는 446→448MB
(candles) · 501→514MB(sidecar) 로 사실상 변화 없다. ⚠ 다만 이것은 **한 워크로드의
peak** 이지 장기 운영 RSS 가 아니다. 운영 RSS 가 예전보다 뚜렷이 높아지면 이 값을
먼저 의심할 것.

**배선** — `create_app` 의 lifespan 에서 기동이 끝난 뒤 적용하고, **종료 시 원복**
한다. 원복은 프로덕션이 아니라 테스트를 위한 것이다: `TestClient` 는 한 pytest
프로세스에서 앱을 수백 번 만들므로, 남기면 이 전역 설정이 GC 동작에 의존하는 다른
테스트로 샌다.

⚠ **`RANGE_COMPUTE_CONCURRENCY=1` 은 이 변경 전에 튜닝된 값이다.** 상한은 compute
비용의 함수이고 그 비용이 또 줄었으므로(v3.1 의 `ts_ms` SQL 이관에 이어 두 번째),
혼합 부하 sweep 을 다시 돌려 최적값을 확인해야 한다.

### 이월(deferred) — 후속 작업

1. **알려진 peak-wall 테스트 불일치** (별건, 제품 의도 필요): 분기 기준(main `f56347be`)에 이미
   14개 실패가 존재한다 — `test_api_range.py` 11개(테스트 스텁 `_build_range_bundle_stub` kwarg
   드리프트), `tests/hoga/api/test_bundle.py` 2개(`untraded_peaks`가 가격별 dedup 되지 않기를
   기대 vs 현 SQL은 `(price, is_touched)`로 dedup), `tests/unit/live/test_stream.py` 1개. 이번
   변경은 이들을 건드리지 않는다(재작성 시 "64개 유닛 green + 14개 실패 바이트 동일" 유지).
   `untraded_peaks` dedup 의미론은 제품 결정이 필요하므로 별도로 다룬다.
