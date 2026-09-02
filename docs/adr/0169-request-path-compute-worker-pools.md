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

- `/api/orderbook` · `/api/candles` · `/api/meta` · `/api/gaps` · `/api/stock-dates` 등 나머지
  동기 라우트: DuckDB 가 GIL 을 놓는 짧은 질의다. 커서 호버마다 부르는 스팟 경로에
  프로세스 왕복(수 ms)을 얹을 이유가 없다.
- `/api/live/past-candles` · `past-daily-candles`: CPU 가 아니라 벤더 REST 대기가 본체이고,
  용량 스케줄러·클라이언트가 인프로세스 싱글턴이라 옮길 수 없다. 이쪽의 300ms 급
  정지(`_row_date_bounds`)는 별건이다.

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
