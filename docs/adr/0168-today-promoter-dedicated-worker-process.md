# 0168 — 순수 파이썬 CPU 작업은 이벤트 루프 프로세스를 떠난다: today-promoter 전용 워커 프로세스

**Status:** accepted (2026-09-02)

**Related:**
- ADR-0043 — Today Promotion(장중 5분 주기 JSONL→parquet). 이 ADR 이 그 실행 위치를 바꾼다.
- ADR-0085 — DuckDB 자원 상한·GC 임계 튜닝. 워커 프로세스가 같은 GC 임계를 건다.
- #998 — 프로세스 내 싱글턴(키움 WS 세션·스케줄러·DuckDB) 때문에 `--workers` 불가.
- `hoga/api/bundle.py` `_gil_breathe` 주석 — 같은 현상의 이전 처방(불충분했다).

## Context

`/live` 10호가가 다른 앱보다 4~5초 늦게 움직인다는 신고를 2026-09-02 에 실측했다.
지연은 벤더도, 프론트도, 백엔드→브라우저 송신 큐도 아니었다(각각 유휴 시 프레임 나이
0.6초 · 헤드리스 롱태스크 0건 · `WS send queue full` 0건). 원인은 백엔드 **안**이다.

이 앱은 단일 프로세스·단일 이벤트 루프가 키움 WS 5계정 수신과 브라우저 팬아웃을 다
맡는다. 그 프로세스 안에서 **순수 파이썬 CPU 작업이 워커 스레드에서 돌면** 루프는 GIL 을
5ms switch interval 단위로 구걸하는 convoy 에 빠진다. 실측:

| 순간 | 워커 스레드 CPU (2초당) | 루프 GIL 점유 | 키움 소켓 Recv-Q | 프레임 나이 평균 |
|---|---|---|---|---|
| 유휴 | 0.01초 | 90% 이상 | 0 | 0.6~0.7초 |
| 프로모터 사이클 중 | 2.2~3.1초 | 5~11% | 1~9MB | 3.5~6.5초 |
| `/api/brokers/series` 1건(동기 라우트) | 9.84초/10.25초 | 2% | 정지 | 앱 전체 10초 정지 |

정지 스택은 전부 `permessage_deflate encode`·`ssl read`·`mkdir` 같은 **GIL 재획득
지점**이었다 — 루프가 놓은 GIL 을 못 돌려받고 있었다는 지문이다. 기존 `loop_lag`
프로브는 이 상태를 못 본다(5ms 조각이라 250ms 임계에 안 걸린다).

GIL 을 가져가는 작업은 셋이다: ① today-promoter(`asyncio.to_thread`, 5분마다
45~140초, 314종목 하루치 parquet 전량 재작성) ② `/api/range` 번들(`anyio.to_thread`,
96.7% 순수 파이썬, 창마다 5분 폴링) ③ 동기 `def` 라우트 15개. 이 ADR 은 ①을 옮긴다.
②③은 후속(2단계)이다.

## Decision

**규칙: 이벤트 루프가 있는 프로세스에는 순수 파이썬 CPU 작업을 두지 않는다.** GIL 은
프로세스 단위이므로 스레드·양보(`_gil_breathe`)로는 닫히지 않는다. 옮기는 단위는
작업이지 앱이 아니다 — #998 의 싱글턴 구조(단일 앱 프로세스)는 그대로 둔다.

### 1. today-promoter 는 `ProcessPoolExecutor(max_workers=1, spawn)` 에서 돈다

`hoga/live/promote_executor.py` 의 `PromoteExecutor` 가 풀을 든다. 기본
`HOGA_LIVE_TODAY_PROMOTE_EXECUTOR=process`, `thread` 가 종전 동작(테스트 기본).

- **워커 1개**: 증분 파싱 오프셋(`_TODAY_PARSE_STATES`)이 워커 안에 살므로 하나여야
  종전 의미다. 워커가 죽으면 풀을 버리고 다음 호출에서 새로 만든다 — 오프셋이 0 으로
  돌아가 그 사이클만 하루치를 다시 읽고 결과는 같다.
- **`spawn` 명시**: 스레드 250개짜리 프로세스에서 fork 는 불가하고, 3.14 리눅스 기본
  forkserver 에 기대지 않는다. uvicorn `--reload` 아래서는 중첩 spawn 이며 테스트가 그
  구조를 재현한다.
- **워커 initializer** 는 부모와 같은 GC 임계(`hoga.gc_tuning`, 리프 모듈로 내림)와
  `hoga.log` 용 `WatchedFileHandler` 를 건다. `hoga.api.app` 은 import 하지 않는다.

### 2. 자식은 빈 프로세스다 — 인프로세스 상태에서 나오는 입력은 부모가 계산한다

`nxt_enabled`(심볼 마스터 `_cache`)는 부모의 `promote_kiwoom_today` 가 구해 인자로
넘긴다. 자식에서 조회하면 전 종목이 「모름」이 돼 meta 의 `expected_venues` 판정이
조용히 바뀐다. 같은 이유로 워커에서 도는 함수는 인자만 보는 모듈 최상위 함수다.

### 3. 17:00 일배치(`promote_one`)도 같은 실행기를 탄다

같은 순수 파이썬 파싱이고 자기 docstring 이 「배치 동안 HTTP·WS 가 통째로 언다」고
적어 둔 경로다. 배선이 달라(scheduler) 모듈 기본 실행기(`install_default`)로 받는다.
프로모터가 비활성이거나 소유권을 못 얻은 기동에서는 설치된 것이 없어 종전대로 스레드다.

## Consequences

- 지연: 프로모터 사이클 중 루프 GIL 점유가 회복되고 Recv-Q 가 0 을 유지해야 한다.
  판정은 `ss -tn | awk '$5 ~ /:10000$/'` 의 Recv-Q 와 프레임 나이 평균(1초 미만).
- 메모리·기동: 워커 1개가 순증한다 — 실측(3.14, 20종목 86MB JSONL 반복 승격 중)
  VmRSS **≈510MB**, `hoga.live.promote` import 0.3초/135MB. 풀은 첫 승격에서 게으르게
  뜨므로 앱 기동 시간은 그대로다. `ps --ppid <앱 pid>` 로 자식 하나를 확인한다.
- 루프 스레드로 옮겨 온 일이 하나 있다: `nxt_enabled` 조회(`_nxt_enabled_now`)가 부모에서
  돈다. 실측 0.12ms/호출 → 314종목 사이클당 **37ms**, 5분에 한 번. 무시할 크기다.
- 직렬화: 17:00 일배치(`promote_one`)와 today-cycle 이 **같은 워커 하나**를 쓴다. 종전엔
  별개 스레드였다. 장중에는 배치가 오늘을 건너뛰어 놀지만, 크래시 뒤 재기동처럼 과거일
  JSONL 이 많이 밀린 부팅에서는 첫 today-cycle 이 그 배치 뒤에 줄을 선다. 받아들인다 —
  그 배치는 어차피 종전에도 루프를 얼리던 경로라 늦게 끝나는 것이 더 나은 실패다.
  분리가 필요해지면 배치용 `PromoteExecutor` 를 하나 더 두면 된다(한 줄).
- 프로세스 수명: 앱 종료(`AppStartupRuntime.stop`)가 풀을 내린다. 부모가 SIGKILL 로
  죽으면 풀 워커는 **스스로 끝나지 않는다**(실측: 20초 뒤에도 subreaper 에 입양된 채
  생존 — 호출 큐 파이프를 워커도 쥐고 있어 EOF 가 안 온다). 그래서 워커 initializer 가
  ppid 감시 스레드를 띄워 부모가 사라지면 1초 안에 `os._exit` 한다. 테스트가 부모를
  `kill -9` 해 이 동작을 고정한다.
- 남는 것(2단계): `/api/range` 번들과 동기 라우트는 여전히 같은 프로세스에서 GIL 을
  쥔다. 종목 전환·팬·5분 폴링 순간의 멈춤은 이 ADR 로 사라지지 않는다.

## 검증 레시피

1. `tests/unit/live/test_promote_executor.py` — 스레드/프로세스 결과 동등성(polars 프레임
   비교), 부모가 계산한 `nxt_enabled` 가 자식 결과에 실리는지, 깨진 풀 재생성, 중첩 spawn.
2. 운영 확인: 프로모터 사이클 중 `/proc/<앱 pid>/task/*/stat` 의 스레드별 CPU 에서
   `ThreadPoolExecu` 가 0 근처이고 자식 프로세스가 코어 하나를 쓴다. `today_promote_last_ms`
   는 계속 전진한다.
