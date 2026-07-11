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

### 이월(deferred) — 후속 작업

1. **알려진 peak-wall 테스트 불일치** (별건, 제품 의도 필요): 분기 기준(main `f56347be`)에 이미
   14개 실패가 존재한다 — `test_api_range.py` 11개(테스트 스텁 `_build_range_bundle_stub` kwarg
   드리프트), `tests/hoga/api/test_bundle.py` 2개(`untraded_peaks`가 가격별 dedup 되지 않기를
   기대 vs 현 SQL은 `(price, is_touched)`로 dedup), `tests/unit/live/test_stream.py` 1개. 이번
   변경은 이들을 건드리지 않는다(재작성 시 "64개 유닛 green + 14개 실패 바이트 동일" 유지).
   `untraded_peaks` dedup 의미론은 제품 결정이 필요하므로 별도로 다룬다.
