# 실시간 서비스 종료 개선 검토

2026-11-02 검토. 제품 코드와 운영 서버는 변경하지 않았다. 직전 운영 측정은
[실측 원문](../2026-11-02-reload-read-shutdown/live-measurement.json)에 있다.
종료를 줄일 첫 후보는 계정별 연결 정리의 직렬 대기를 겹치는 것이다.
최종 저장과 이전 수집 프로세스 종료 확인은 그대로 유지한다.

## 확인한 사실

운영 1회 측정에서 파일 변경부터 조회 503까지 0.212초, 새 API 준비까지 20.063초,
수집기 준비 확인까지 21.112초였다. `live_runtime` 종료가 13.836초를 차지했다.
조회 정리는 3.1ms, 공용 compute 종료는 1.698초였다. 동일 조건의 전후 비교는 아니다.

`AppStartupRuntime.stop()`은 promoter task·전용 pool, watchdog, sector broadcast,
live stream, scheduler, 야간 futures runtime, REST scheduler/client를 차례로 닫는다.
운영에서 이 하위 단계 각각의 시간은 아직 기록하지 않았다. 따라서 13.836초를 특정
소켓이나 저장 함수 한 곳에 귀속할 수 없다.

`KiwoomSessionManager._stop_locked()`는 US 표시 연결을 닫은 뒤 각 계정의
`_teardown(account_id)`를 하나씩 await한다. 각 `_teardown()`도 subscription task,
WS task, flush task를 차례로 cancel하고 join한다. 앞 계정의 소켓 종료를 기다리는
동안 뒤 계정은 아직 종료 요청을 받지 않는다. 현재 운영 상태의 연결은 5개다.

`KiwoomWsClient`는 native WebSocket `close_timeout=2.0`초와 외부 grace 1.0초를 쓴다.
확인되지 않은 transport는 abort하고, 종료 확인이 불가능하면 교체를 막는다.
여러 연결에서 close 대기가 발생하면 현재 직렬 구조는 각 대기를 누적한다.
이 소스 사실은 운영의 각 close가 실제 timeout을 소진했다는 증거는 아니다.

수집 child의 `Worker.shutdown()`은 다음 순서를 따른다.

1. 모든 연결·진행 flush task 종료.
2. stream별 마지막 부분 봉 seal/flush.
3. 프로그램매매의 진행 batch 완료와 마지막 latch drain.
4. 마지막 호가 저장.
5. 실제 default executor 작업 종료.
6. capture lock 반환과 프로세스 종료.

부모의 stop RPC ACK는 종료 요청 수신을 뜻한다. 실제 종료 확인은 process join이다.
30초 join과 추가 5초 강제 종료 대기는 상한이며, 매번 고정으로 자는 시간이 아니다.
`_lifecycle_lock`과 collector lock의 획득 대기도 아직 개별 계측하지 않았다.

## 격리 재현

실제 `KiwoomSessionManager`, `_teardown`, `KiwoomWsClient`를 사용했다.
외부 WebSocket만 기존 테스트의 fake Socket으로 대체했다. 자격증명·벤더·운영 포트를
사용하지 않았다. 시제품은 실제 `_teardown()` 다섯 개를 함께 시작하고 모두 join한 뒤,
실제 manager의 나머지 종료와 최종 shared flush를 실행한다. 제품 코드는 바꾸지 않는다.

Event barrier를 둔 결정적 검사에서 close를 시작한 계정 수는 기존 **1개**, 시제품
**5개**였다. 모든 transport 종료와 flush task join이 shared final flush보다 앞섰다.

각 소켓 close에 50ms의 합성 대기를 넣고 직렬·병렬을 번갈아 각각 5회 실행했다.

| 모드 | 중앙값 | 범위 |
| --- | ---: | ---: |
| 기존 계정별 직렬 종료 | 252.2ms | 251.6–252.4ms |
| 계정 정리를 겹친 시제품 | 50.6ms | 50.5–51.0ms |

측정의 제한 요인은 의도적으로 주입한 소켓 close 대기다. 모든 transport 종료,
receiver 종료, flush task join과 final flush 순서를 매회 확인했다.
이 수치는 종료 대기를 겹치는 구조를 검증하며 **운영 개선율을 뜻하지 않는다**.
시제품은 실제 disk fsync·lock·프로그램매매 drain의 정합성을 새로 증명하지 않았다.

재현은 저장소 루트에서 실행한다.

```sh
uv run --extra dev python docs/diagnostics/2026-11-02-live-shutdown-review/probe.py.txt
```

[드라이버](probe.py.txt), [결과](probe-results.json), [검증 입력](validation.json).

## 권장 구현 순서

### 1. 부모·자식 종료에 세부 계측을 추가한다

기존 `live_runtime` span 아래를 다음처럼 나눈다. 단계별 elapsed/outcome과 pid·epoch,
계정 번호만 기록한다. 토큰·계좌번호·원문 벤더 응답은 기록하지 않는다.

- 부모: promoter task, promoter pool, watchdog, sector broadcast, lifecycle lock 획득,
  collector lock 획득, stop RPC ACK, channel close, child join, scheduler, futures, REST.
- 자식: US 표시 연결, 계정별 subscription/WS close/flush join, 공용 초봉 final flush,
  stream별 마지막 flush, 프로그램 진행 batch join, 마지막 latch drain, 마지막 호가 저장,
  default executor drain, capture lock 반환.

### 2. 독립된 계정 정리를 함께 시작하고 모두 join한다

전체 manager lock 안에서 등록된 계정 목록을 고정하고, 계정마다 기존 `_teardown()`을
한 번씩 시작한다. 각 계정 내부의 subscription → WS → flush 순서는 유지한다.
모든 계정이 terminal 상태가 된 뒤 공용 초봉 force flush와 장부 초기화를 수행한다.

`gather(return_exceptions=True)` 등으로 한 계정의 오류가 다른 계정의 완료 확인을
생략하지 않게 한다. 오류나 외부 취소가 있어도 실제 transport와 write의 소유권을
잃지 않아야 한다. bulk cancel 뒤 기존 `_teardown()`을 그대로 재호출하면 같은 task를
두 번 cancel할 수 있으므로 이 방식은 쓰지 않는다.

### 3. 남은 대기는 계측 결과에 따라 겹친다

먼저 계정 정리를 바꾸고 남은 시간을 확인한다. 그 뒤 후보는 다음과 같다.

- child의 프로그램 주기 task 중단·진행 batch join을 연결 종료와 겹친다.
  두 작업이 모두 끝난 뒤 마지막 프로그램 latch를 한 번 더 drain한다.
  마지막 drain과 기존 cycle을 동시에 실행하지 않는다.
- API의 신규 생산 task를 먼저 멈춘 뒤, 진행 promoter 작업의 완료와 collector 종료가
  독립적인지 검증한다. 검증되면 두 완료 대기를 겹친다.
- US 표시·계정 WS·야간 WS는 재연결 producer를 먼저 멈췄다는 증거가 있을 때만
  독립 그룹으로 닫는다. 저장을 사용하는 REST client와 IPC는 사용자의 종료 뒤 닫는다.

세 후보는 추가 검증 대상이며 이번 격리 재현의 입증 범위에 들어 있지 않다.

## 구현 검증 조건

- 계정 하나의 close를 막아도 다른 계정들이 종료 요청을 받는다.
- close·abort·외부 취소·반복 stop에서 consumer와 transport를 모두 회수한다.
  종료 미확인 연결 위로 replacement를 만들지 않는다.
- 실제 진행 disk write를 Event로 잡은 동안 final flush, lock 반환과 새 child 시작이
  진행하지 않는다. 모든 쓰기 완료 뒤에만 다음 단계로 간다.
- 실제 spawn child에서 부분 봉, 초봉 journal, 프로그램 tape, 마지막 호가를 저장하고
  재시작 후 같은 데이터로 복구되는지 확인한다.
- 한 계정이 실패해도 다른 계정 완료와 필수 finalizer를 회수한다.
- 추가 취소가 진행 write와 cleanup을 두 번 취소하지 않는다.
- 같은 입력·부하의 임시 서버에서 5회 이상 반복하고 오류·누락·semaphore 경고를 센다.
  운영 측정에서는 단계 시간과 API/collector 준비를 따로 기록한다.

기존 종료·저장 계약의 관련 테스트 106개가 통과했다. 이는 현재 코드의 회귀 확인이며,
제안한 제품 변경의 실제 저장 정합성은 위 조건으로 다시 확인해야 한다.

이번 검토는 [ADR-0174](../../adr/0174-dedicated-python-live-capture-process.md)의
단일 소유·flush 완료·lock 반환·이전 child 종료 후 교체와
[ADR-0168](../../adr/0168-today-promoter-dedicated-worker-process.md)의 실행 future 완료
계약을 유지한다. 저장을 생략하거나 `wait=False`로 바꾸거나 종료 timeout을 줄여 얻는
시간 단축은 권장안에 포함하지 않는다. 전체 종료 시간의 목표치는 하위 계측 후 정한다.

## 구현 후 검증

`codex/live-shutdown-drain`에서 계정별 실제 `_teardown()`을 함께 시작하도록 구현했다.
계정 내부 subscription → WS → flush 순서와 모든 계정 종료 후 공용 초봉 final flush를
유지한다. API·live 양쪽에서 쓰는 종료 도구는 `hoga/util/shutdown.py`로 옮겼다.

종료 호출자의 취소는 owned cleanup task로 전달하지 않는다. 반복 취소가 있어도
cleanup과 lock 소유권을 유지하고, 완료 뒤 호출자의 취소를 전파한다. API runtime의
반복 stop은 같은 완료 task를 공유하며, 수집기 proxy는 실제 child join이 끝난 뒤
lock과 process handle을 해제한다.

구현한 세부 시간은 runtime promoter/task/pool·watchdog·sector·live stream·scheduler·
futures·REST, lifecycle/collector/manager lock 대기, stop RPC·channel close·child join,
US 표시와 계정별 subscription/WS/flush, 초봉 final flush, stream별 final flush,
프로그램 batch/final drain, 마지막 호가 저장, executor drain, capture lock 반환이다.
각 기록의 `pid`, `epoch`, `account_id`, `stream_index`로 부모·자식 단계를 구분한다.

추가 회귀 검사에서 계정 상태 알림의 `ConnectionError`가 소켓의 `_end_session()`을
건너뛰는 기존 경로를 재현했다. 알림의 성공 여부와 관계없이 receiver·transport 종료와
retirement 정리가 실행되도록 finally 경계를 고쳤다. 오류 자체는 호출자에게 보존한다.

[구현 비교 드라이버](implementation-probe.py.txt)는 `e16041ff2`의 manager 모듈을
별도로 읽어 현재 구현과 번갈아 비교한다. 5개 계정이 각 50ms close를 기다리는 동일한
합성 조건에서 각각 5회 실행했다. 직렬 중앙값 251.8ms, 구현 후 50.8ms였다.
이는 운영 속도 개선율이 아니며, 실제 API/collector 준비는 배포 후 별도로 측정한다.

실제 spawn 수집기의 native write를 붙잡은 검사에서 반복 취소 후에도 capture lock이
유지됐고, 새 sync는 기존 write와 child 종료 뒤에만 새 프로세스를 만들었다.
배포 전 검증 명령·입력·결과는 `implementation-validation.json`에 기록한다.
