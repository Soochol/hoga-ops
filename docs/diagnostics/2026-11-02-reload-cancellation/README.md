# Reload 중 조회 취소 재현 시험

2026-11-02 테스트와 설계 작성 요청의 진단 산출물이다. 제품 코드는 변경하지 않았다.
[설계](../../plans/2026-11-02-reload-cancellation-design.md), [원시 결과](results.json),
[운영 관측 한 건](observed-reload.json)을 함께 읽는다.

## 재현

저장소 루트의 Python 3.14.7 환경에서 실행한다.

```sh
uv run --extra dev python docs/diagnostics/2026-11-02-reload-cancellation/run_probe.py --repeats 5 --duration 2 --output docs/diagnostics/2026-11-02-reload-cancellation/results.json
```

각 실행은 임시 디렉터리·OS 할당 루프백 포트·새 supervisor를 사용한다. 환경변수는
PATH/HOME/locale와 진단 전용 경로만 허용해 구성한다. 실제 앱 factory와 vendor client는
시작하지 않는다. 사용자의 5173/8000, 기존 데이터·서버·바로가기에는 변경을 가하지 않는다.
프로토타입 서버가 감시하는 임시 Python 파일을 실제로 수정해 WatchFiles reload를 일으킨다.
종료는 이 실행이 만든 supervisor에만 보내며 강제 종료가 필요하면 시험을 실패시킨다.

## 측정 대상

- 첫 값은 파일 수정 직전부터 새 PID의 `/health` 200 응답까지다. 단순 lifespan 로그만을
  준비 완료로 쓰지 않는다. 실제 응답의 새 PID도 확인한다.
- HTTP 반환 지연은 구 자식의 `shutdown()` 진입부터 fixture의 `result_returned` 사건까지다.
  이는 route 반환 사건이며 ASGI 최종 바이트 전송 완료 계측은 아니다.
- 실제 `ContinuousMonitors.result/close`와 `ComputeExecutor`를 사용하지만 `_scan_result`는
  합성 2초 작업으로 교체한다. 실제 시장 데이터·전체 앱 startup·증권사 WS 재등록 비용은
  포함하지 않는다. 운영 개선율이나 운영 재시작 시간 보장이 아니다.
- 7개 모드를 순서대로 교차해 5회씩 실행하고 보호할 publication 시험을 1회 추가했다.
  같은 PC의 운영 작업은 계속됐다. 대표값은 중앙값, 범위는 최솟값과 최댓값이다.
  최종 36회 측정 때 별도 pytest는 실행하지 않았다.

## 결과

각 일반 모드는 n=5이며 시간 단위는 초다. 완료 확인은 thread/process가 실제로 끝났거나
협력적 중단을 확인한 경우다. tracked 모드는 보호한 실행 future도 lifespan에서 await한다.

| 모드 | 파일 변경→새 health 중앙값 | 범위 | shutdown→조회 반환 중앙값 | 실제 작업 완료 확인 |
|---|---:|---:|---:|---:|
| 기존 순서·async 조회 | 2.600 | 2.568–2.624 | 1.864 | 5/5 |
| 조기 취소·async 조회 | 0.878 | 0.836–1.024 | 0.101 | 5/5 |
| HTTP만 취소·미추적 thread | 0.858 | 0.835–0.898 | 0.101 | 0/5 |
| 취소 처리에서 thread 완료 대기 | 2.650 | 2.628–2.747 | 1.867 | 5/5 |
| HTTP 먼저 종료·lifespan에서 thread 완료 대기 | 2.546 | 2.510–2.631 | 0.101 | 5/5 |
| 완료 추적·협력적 thread 중단 | 0.938 | 0.879–0.961 | 0.101 | 5/5 |
| 조기 HTTP 종료·process 완료 대기 | 2.808 | 2.732–2.893 | 0.101 | 5/5 |

`early_thread`는 의도적으로 잘못된 대조군이다. 5회 모두 완료 사건 없이 구 프로세스가
사라졌다. 빠른 새 health를 안전한 취소 성공으로 세지 않는다. coroutine만 취소하고
미추적 동기 작업을 남기는 설계를 기각하는 근거다. 내부 SIGTERM 재발생과의 인과는
설치 소스로 추론한 것이며, 작업 종료 명령을 따로 계측한 결과는 아니다.

`early_thread_joined`와 `early_thread_tracked`는 모두 실제 작업 완료를 기다린다.
후자는 HTTP 반환만 앞당기고 전체 reload에는 남은 계산 시간이 그대로 붙는다.
`early_cooperative`는 token과 checkpoint로 실제 작업까지 중단하므로 합성 지연을
계속 기다리지 않는다. `early_process`는 실제 executor의 wait=True 계약 때문에
실행 중인 process 완료를 기다린다. 병목이 제거됐는지와 다른 종료 단계로 옮겨졌는지를
이 두 지표로 구분한다.

동시 publication 1회는 조회 503, write HTTP 200, 완성된 atomic replace 결과,
실제 작업 완료 확인을 검증했다. 파일 변경→새 health는 1.373초였다.
이 시험은 실제 `_finish_disk_write` wrapper를 사용하지만 synthetic write이며 fsync,
실제 체크포인트 복구, 주문 journal, shared-wide capture writer의 통합 검증을 대신하지 않는다.

## 성공·실패 확인

모든 실행에서 WatchFiles 변경 감지 로그, 새 PID의 health, 관측된 구 API/계산 PID의
소멸, supervisor exit 0을 확인했다. stdout은 `communicate()`로 EOF까지 수집해 늦은
resource_tracker 경고와 traceback 패턴도 검사한다. 전체 OS 자원 누수의 부재를 증명하는
검사는 아니며, semaphore 관련 기존 실제 reload 통합시험을 별도로 실행했다.

기존 테스트는 다음 60개가 통과했다.

```sh
uv run --extra dev pytest -q tests/api/test_screener_continuous.py tests/api/test_screener_history_shutdown.py tests/unit/api/test_request_coalescer.py tests/unit/api/test_compute_pools.py tests/integration/test_compute_shutdown.py -m 'not wallclock'
```

`test_screener_history_shutdown`은 publication 완료 전 소유권 반환 방지를,
`test_compute_shutdown`은 실제 reload와 SIGINT/SIGTERM의 pool semaphore 정리를
검증한다. 이들은 기존 계약의 회귀 근거이며 신규 pre-drain 조립 구현의 통과 결과는 아니다.

## 프로토타입 한계와 다음 gate

- fixture는 full `ContinuousMonitors.close()`와 no-op targets를 사용한다. 실제 partial
  retirement, volume target·preparation·observer 보존은 설계의 신규 통합 gate다.
- lifespan state를 통한 전달은 fixture에서 검증했다. 실제 앱의 여러 root/router lifespan
  병합, state 누락·잘못된 타입 fallback, startup 실패는 아직 검증하지 않았다.
- fixture의 넓은 closed-flag 503 변환은 제품 설계로 채택하지 않는다. 실제 실패와
  shutdown 원인을 구별하는 race·shared waiter·caller cancellation 시험이 필요하다.
- 최종 driver의 read response 사건은 응답 전송 완료보다 앞선다. 제품 계측은 실제 ASGI
  response completion도 기록해야 한다.
- 주문 처리, collector flush·writer lock, 실행기 이관, signal 없는 종료,
  지원 Uvicorn 버전 gate는 제품 구현 때 검증한다. 이번에는 운영 실행을 변경하지 않았다.
- 운영 lifespan 13.2초는 여전히 미분해다. 이 시험으로 compute 또는 collector가
  그 시간을 차지했다고 결론 내리지 않는다.

초기 smoke의 완료 확인 실패로 미추적 thread 위험을 발견했다. 이후 실제 future를
추적하는 모드와 EOF 수집을 추가한 최종 36회 결과만 위 표에 사용했다. 중간 31회
결과와 단일 smoke 수치는 최종 비교에서 사용하지 않는다.
