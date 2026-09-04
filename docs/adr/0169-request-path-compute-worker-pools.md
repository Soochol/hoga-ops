# 0169 — 요청 경로의 CPU 작업도 이벤트 루프 프로세스를 떠난다: 컴퓨트 워커 풀 두 벌

**Status:** accepted (2026-09-02)

**Related:**
- ADR-0168 — 규칙의 첫 적용(today-promoter, 워커 1개). 이 ADR 은 같은 풀을 요청 경로에 쓴다.
- ADR-0085 — DuckDB 자원 상한. 워커마다 상한을 다시 건다.
- ADR-0004 — wire 계약은 모델. 워커가 직렬화하는 body 도 모델에서 나온다.
- `hoga/api/routes.py` `_range_gate` — 좁은 요청은 상한 없이 통과한다는 불변식.

## Context

ADR-0168 이 프로모터를 옮긴 뒤에도 같은 자리에서 앱을 세우는 CPU 작업이 남아 있었다.
2026-09-02 장중 로그 기준:

| 경로 | 실행 자리 | 건수(09:00–15:30) | 최대 | 무엇이 CPU 인가 |
|---|---|---|---|---|
| `/api/range` | `anyio.to_thread` | 204 | 22.0초 | 번들 본문 96.7% 순수 파이썬(`_gil_breathe` 주석) |
| `/api/screener/pattern-search` | `asyncio.to_thread` | 33 | 86.3초 | 리샘플·정규화 파이썬 루프 |
| `/api/heatmap/group-flow` | `asyncio.to_thread` | 60 | 12.6초 | JSONL 꼬리 파싱 |
| `/api/brokers/series` | 동기 `def`(anyio 풀) | 8 | 10.3초 | 포인트마다 `model_copy` |

정지 감지기가 잡은 10.25초 정지에서 anyio 워커 스레드 CPU 9.84초, 루프 스레드 0.21초였다.
스레드에 내리는 것으로는 안 된다 — GIL 은 프로세스 단위다(ADR-0168 Context).

한 가지 부수 정지도 같은 자리에서 났다: `/api/range` 응답을 루프 스레드가 pydantic 으로
직렬화하는 `dump_json` 이 250~300ms 정지로 25건 찍혔다.

## Decision

### 1. 네 경로는 `ComputeExecutor` 프로세스 풀에서 돈다

`hoga/compute_executor.py`(ADR-0168 의 풀을 공용화)로 요청 경로용 풀을 만들고,
`hoga/api/compute_jobs.py` 의 **모듈 최상위 작업 함수**를 넘긴다. 워커마다
`QueryEngine` 을 게으르게 만든다. 기본 `HOGA_COMPUTE_EXECUTOR=process`, `thread` 가
종전 동작이다(테스트의 `create_app` 은 인자를 안 받으면 스레드다).

### 2. 풀은 둘이다 — 넓은 요청과 좁은 요청

`_range_gate` 는 30일 미만 요청을 상한 없이 통과시킨다. `/live` 의 하루짜리가 `/study`
의 다섯 달 뒤에 갇히면 안 되기 때문이다. 스레드 시절엔 admitted 요청마다 스레드가
있어 저절로 지켜졌고, 프로세스 풀 하나는 FIFO 라 그걸 깬다. 그래서 **wide**(넓은 range ·
brokers/series · pattern-search · group-flow, 기본 3워커)와 **narrow**(좁은 range, 기본
2워커)로 나눈다. 기존 asyncio 상한(`range_compute_limiter`·모드 레인)은 그대로 admission
을 맡는다.

워커 수 기본값의 근거: 스레드 시절 상한 합(2+2+3=7)은 GIL 하나를 나누던 수다. 프로세스는
각자 GIL 을 가지므로 3+2 로도 종전보다 처리량이 크고, 늘리는 비용은 메모리다(§4).

### 3. 워커가 JSON 까지 직렬화한다

`RangeBundle` 은 수천 개의 pydantic 객체다. 모델을 pickle 로 나르면 부모가 풀고 FastAPI
가 다시 직렬화한다 — 그 `dump_json` 이 위 25건이다. 워커가
`model_dump_json(by_alias=True)` 까지 끝내고 부모는 바이트를 `Response` 에 싣는다.
`response_model`·반환 애노테이션은 모델 그대로라 wire 계약(ADR-0004)의 표면은 변하지
않고, 테스트가 스레드 경로(FastAPI 직렬화)와의 파싱 동등성을 고정한다. 대상 모델에
alias 필드는 없고 `response_model_exclude_none` 도 안 건다.

### 4. 워커의 DuckDB 상한은 따로 건다

`connect_bounded` 의 기본은 인스턴스당 8GiB·전 코어다. N 워커에 그대로 두면 ADR-0085 가
태어난 실패 모드다. 풀이 `worker_env` 로 `HOGA_DUCKDB_MEMORY_LIMIT`(기본 2GiB)를 넘기고,
첫 연결에 `SET threads`(기본 4)를 건다. 둘 다 env(`HOGA_COMPUTE_DUCKDB_*`)로 조절한다.

### 5. 예외는 껍데기로 나른다

Starlette `HTTPException` 은 `args` 를 채우지 않아 pickle 왕복이 안 된다 — 부모의
unpickle 이 실패하면 풀 관리 스레드는 **풀이 깨진 것**으로 처리해 400 하나가 뒤따르는
요청을 전부 죽인다. 작업 함수는 `ComputeHTTPError(status, detail)` /
`ComputeJobError(repr, traceback)` 로 바꿔 던지고 부모가 되돌린다. 테스트가 「400 뒤
같은 풀의 다음 작업이 성공한다」를 고정한다.

### 6. 옮기지 않은 것과 그 이유

- `/api/orderbook` · `/api/candles` · `/api/meta` · `/api/gaps` 등 나머지 동기 라우트:
  DuckDB 가 GIL 을 놓는 짧은 질의다. 커서 호버마다 부르는 스팟 경로에 프로세스
  왕복(수 ms)을 얹을 이유가 없다.
- `/api/live/past-candles` · `past-daily-candles`: CPU 가 아니라 벤더 REST 대기가 본체이고,
  용량 스케줄러·클라이언트가 인프로세스 싱글턴이라 옮길 수 없다. 이쪽의 300ms 급
  정지(`_row_date_bounds`)는 별건이다.

**정정(2026-09-04 실측).** 위 첫 항목에 `/api/stock-dates` 를 넣은 것은 틀렸다 — "짧은
질의" 라는 분류가 이 라우트에만 맞지 않았다. 파케이 트리 전체 순회 + 캐시 미스분 DuckDB
읽기라 **콜드 캐시에서 41.3초**가 나왔고(같은 날 26.2초 1건 더), 그동안 동기 라우트
스레드가 GIL 을 쥐어 앱 전체가 멎었다. 그래서 이 라우트는 wide 레인으로 옮겼다
(`compute_jobs.stock_dates_job`). 인프로세스 상태인 `captures._fail_streaks` 는 부모가
스냅샷을 떠서 인자로 넘긴다 — ADR-0168 의 `nxt_enabled` 와 같은 규율이다.

**정정 2 (2026-09-04, 측정 뒤).** 위 「9.05초를 태우는 스윕」 귀속은 **틀렸다**. 스윕
비용을 실제로 재 보니 고정비 127ms(저장소 4만 행 읽기 36 · 증분 dict 57 · 디렉터리
나열 9 · 전량 쓰기 26) + 피크 질의 4~140ms = 한 번에 **130~270ms** 이고, 그날 1,153회
불려 장중 누적 약 2분이었다. 9초짜리 단일 스레드 소모를 설명할 크기가 아니다. 그 귀속의
근거는 「그 시각 로그에 찍힌 것이 스윕뿐」이었는데, 그것이 바로 이 리포의 `loop_lag`
docstring 이 경계하는 **사후 co-timing 추론**이다.

같은 자로 잰 진짜 범인은 **캡처 파싱**이다(실제 원본, 복사본에서 측정):

| 원본 크기 | wall | CPU |
|---|---|---|
| 56MB | 1.13초 | 1.72초 |
| 144MB(중앙값) | 2.13초 | 3.86초 |
| 171MB | 2.41초 | 4.94초 |

그날 1,153건이 파싱됐고 장중에도 25초에 한 번꼴이라 **장중 누적 CPU 약 30분** — 스윕의
15배다. CPU > wall 인 것은 polars 가 여러 코어를 쓴다는 뜻이고, 실행기가 스레드를
재사용하므로 파싱 몇 건이 같은 스레드에서 이어지면 9초짜리 단일 스레드 소모가 된다.
그래서 파싱도 wide 레인으로 옮겼다(`compute_jobs.capture_parse_job`).

파싱 이관의 함정은 **예외 타입**이었다. 호출자가 타입으로 분기한다 — 검증 실패 두 종은
관대 모드 재시도, `OSError`(ENOSPC 등)는 「머신 탓」이라 fail_streak 를 태우지 않는다.
껍데기로 납작하게 만들면 후자가 죽어 디스크가 찼던 날의 모든 (code,date) 가 영구
차단된다. 확인해 보니 관련 예외가 전부 pickle 왕복에서 타입·args(=errno)를 보존해,
`_crosses_faithfully` 로 **건널 수 있으면 원형 그대로** 던지게 했다. 판정을 타입 목록이
아니라 실제 왕복으로 하는 이유는 새 타입이 조용히 빠지지 않게 하기 위해서다.
`captures.parse_stock_date` import 는 이제 이 모듈에서 직접 불리지 않지만 **하중을
받는다** — 작업 함수가 그 이름을 통해 부르고, 캡처 테스트들이 그 자리에 monkeypatch 를
건다. 지우면 스레드 모드에서 진짜 파서가 조용히 돈다.

**옮긴 것: 캡처 파싱 훅의 `depth_daily` 증분 스윕.** 라우트가 아니라
`captures.py` 가 `loop.run_in_executor(None, …)` 로 앱 스레드 풀에 내리던 백그라운드
작업이라 이 ADR 의 원래 목록에 없었다. 정지 순간 스레드별 CPU 측정에서 이 스윕이
**9.05초** 를 태우는 동안 이벤트 루프가 0.1초만 얻어 앱이 8.9초 멎는 것을 잡았다(전형적
convoy). 풀을 인자로 받을 자리가 없어 모듈 기본 풀(`compute_pools.install_default`)을
쓴다 — `promote_executor` 와 같은 패턴이고, 설치된 것이 없으면 종전대로 스레드다.

**규칙의 교훈**: 「무엇이 CPU 인가」를 코드 모양(동기 라우트냐 백그라운드 작업이냐)으로
분류하면 틀린다. 판정은 정지 순간의 **스레드별 CPU 측정**이다 — 루프 스레드가 태우면
GC·온루프 작업, 다른 스레드가 태우면 convoy 다.

### 7. 남은 절반은 GC 다 — 그래서 재는 눈을 붙였다 (`hoga.api.gc_probe`)

2026-09-04 장중 분류 실측 11건: **convoy 9 · GC 2**. convoy 쪽은 위에서 닫혔고 GC 쪽이
남는다. 그런데 그 크기를 밖에서 볼 수단이 없었다(ptrace 차단, py-spy 불가) — 그래서
정지를 손으로 재야 했다. 같은 일을 두 번 하지 않도록 앱 안에 계측을 넣는다.

`loop_lag` 와 같은 구조이고 층이 둘이다:

- **정지 계측(상시)**: `gc.callbacks` 로 수집마다 소요를 재고, 임계
  (`HOGA_GC_PAUSE_WARN_MS`, 기본 250ms)를 넘으면 `hoga_perf gc_pause` 로 남긴다.
  누적 통계는 `GET /health?deep=1` 의 `gc` 절. 콜백은 수집당 뺄셈 하나라 비용이 없다.
  **GC 임계를 거는 곳(lifespan)에서 함께 설치한다** — 그 값이 정지 시간을 좌우하는데
  지금까지 결과를 보는 눈이 없었다.
- **객체 조사(옵트인)**: `GET /health?deep=1&gc_objects=1` + `HOGA_GC_INTROSPECT_ENABLED=true`.
  `gc.get_objects()` 를 훑어 타입별 상위 25종과 총 추적 객체 수를 준다. 이 호출 자체가
  **앱을 수 초 멈춘다**(응답의 `elapsed_ms` 가 그 시간이다) — 장 마감 뒤 한 번 부르는
  용도이고, 감독자 폴링 경로에 절대 넣지 말 것. 게이트가 둘인 이유는 서로 다르다:
  env 는 「이 인스턴스에서 허용하는가」, 파라미터는 「지금 이 호출이 의도한 것인가」.

**왜 객체 수인가**: 오프라인 재현(앱 링버퍼와 같은 중첩 dict)에서 gen2 정지는 바이트가
아니라 **추적 객체 개수**에 비례했다 — 5.8M 에 2.0초, 23M 에 6.6초, 69M 에 20초.
관측 정지가 3~10초였으니 앱은 수천만 규모로 추정되는데, 링버퍼는 그중 5~10%뿐이다.
즉 **줄일 대상을 고르려면 나머지가 어디 있는지 알아야 하고**, 그 표가 이 조사다.
추정을 측정으로 바꾸기 전에는 GC 쪽을 고치지 않는다.

## Consequences

- 지연: range·brokers·pattern·group-flow 가 도는 동안 루프의 GIL 점유가 유지돼야 한다.
  판정은 `/health` RTT(ms 단위)와 앱 프로세스 `AnyIO worker`·`ThreadPoolExecu` 스레드
  CPU ≈ 0, 키움 소켓 Recv-Q 0.
- 메모리: 워커당 인터프리터 + import + DuckDB 상한. 실측(격리 백엔드, 3종목 × 45거래일
  sidecar 동시 3건): 바쁜 wide 워커 **2.0~2.6GB** — DuckDB 상한 2GiB 를 **넘는** 몫
  (~0.5GB)은 파이썬 객체와 pyarrow 버퍼다. narrow 워커 0.26GB, 가벼운 hoga 요청만 받은
  워커 0.2~0.28GB. 상한 봉투: wide 3개가 동시에 바쁘면 워커만 ~8GB, 앱 프로세스(실측
  ~9GB)와 합쳐 **~17GB**. 스레드 시절엔 같은 계산 메모리가 앱 프로세스 안에 있었으므로
  순증은 워커 수 × (인터프리터 + 중복 캐시)이지만, 봉투는 이 합으로 잡아야 한다. 작은
  머신은 `HOGA_COMPUTE_WIDE_WORKERS=1~2`, `HOGA_COMPUTE_DUCKDB_MEMORY_LIMIT=1 GiB` 로
  시작한다.
- 직렬화 동등성의 범위: 테스트 픽스처는 snapshots 슬라이스만 갖는다(호가비·체결강도
  계열). 그 위에서 워커 바이트 == 스레드 경로 HTTP 응답을 확인했고, alias 필드 없음과
  `response_model_exclude_none` 미사용은 모델 introspection 으로 확인했다. trades·
  brokers·peaks 슬라이스의 float 표기는 같은 pydantic 직렬화기를 쓰므로 같아야 하지만
  픽스처로 직접 잰 것은 아니다 — NaN/Inf 를 싣는 필드가 생기면 그때 다시 본다
  (FastAPI 는 `allow_nan=False` 로 500, pydantic-core 는 `null`).
- 첫 요청 비용: 워커의 spawn + `hoga.api.bundle` import + DuckDB 엔진 생성이 첫 요청에
  붙는다(실측 +0.4~0.6초). 기동 시 예열 태스크가 풀마다 워커 하나를 띄우고 엔진까지
  만들어 둔다 — 감독 목록 밖의 태스크다(one-shot 이 `dead` 로 읽히면 안 되므로).
- 캐시 중복: `SLICE_COALESCER`·`TODAY_TTL`·패턴 코퍼스·group-flow 증분 오프셋은 프로세스
  전역이라 워커마다 따로 데워지고, 동시에 같은 스캔이 워커 수만큼 돌 수 있다. 디스크
  지표 캐시(`kis-past-indicators`)는 워커 간에 공유된다(원자적 rename). affinity 는
  두지 않는다 — 비용이 성능이지 정합성이 아니다.
- 취소: 계산 중인 작업은 종전과 같이 취소되지 않는다. 진입 전 `client_gone` 검사는 그대로.
- 남는 것: 위 §6. 그리고 **규칙**은 ADR-0168 그대로다 — 앞으로 CPU 작업을 추가하면
  `compute_jobs` 에 작업 함수를 두고 풀로 보낸다. 루프 프로세스에 두면 이 두 ADR 이
  잰 증상이 그대로 돌아온다.

## 검증

- `tests/unit/api/test_compute_pools.py`: 워커 바이트 ↔ 인프로세스 번들 동등성, 스레드/
  프로세스 바이트 동등성, 400 왕복 뒤 풀 생존, 넓은/좁은 풀 선택, 프로세스 모드 라우트
  응답 동등성, 거래원 라우트 shape.
- 격리 백엔드 A/B(무자격, 심볼릭 링크 파케이 3종목 × 45거래일, 매번 비운 지표 캐시,
  키움 스트림 없음). 같은 요청 묶음(넓은 sidecar 3건 동시 + 좁은 1건)을 두 모드로:

  | 측정 | thread | process |
  |---|---|---|
  | `/health` RTT p50 / p90 / max (요청 중) | 5 / 24 / 91 ms | 1 / 2 / 10 ms |
  | 앱 프로세스 CPU 합(요청 창 21초·18초) | **172,320 ms**(AnyIO 11,070 · polars 스레드들) | **230 ms** |
  | 루프 스레드 CPU | 350 ms | 200 ms |
  | 요청 시간 3건 | 14.6 / 14.5 / 21.1 s | 13.0 / 17.8 / 8.7 s |
  | 부모 `kill -9` 뒤 워커 | (없음) | 4/4 종료 |

  이 백엔드에는 키움 수신·팬아웃이 없어 RTT 차이는 작게 나온다. 사용자 dev 서버에서
  같은 172초의 스레드 CPU 가 초당 400프레임 × 탭 수의 루프 작업과 GIL 을 나눌 때
  나타난 것이 ADR-0168 의 5~6.5초 지연이다 — 여기서 증명하는 것은 **그 CPU 가 앱
  프로세스에서 사라졌다**는 사실(172,320 → 230 ms)이다.
