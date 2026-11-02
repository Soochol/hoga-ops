# 오후장 공략 감시 연결 안정성

우측 패널에서 오후장 공략의 실시간 감시를 시작해도 연결을 유지하고, 종료된 감시의 조회 작업을 남기지 않는 것이 목표다.

## 확인한 원인과 수정

기존 WS 수신 루프는 종목 구독 RPC 완료를 기다린 다음 메시지를 읽었다. 느린 구독 요청이 연속되면 Uvicorn의 입력 큐32개가 차고, 클라이언트가 보낸 pong도 읽지 못했다. 실제 라우터와 TCP 연결에서 운영 기본 ping20초와 timeout20초를 유지한 채 같은1011 오류를 재현했다. HTTP health는200이었다. 운영 로그의 traceback과 같지만, 운영 당시 각 구독 RPC의 지연 시간까지 측정한 것은 아니다.

수신 루프는 정규화한 명령을 제한된 FIFO에 넣는다. 하나의 별도 작업이 기존 순서대로 구독을 적용한다. ACK는 실제 적용 이후에 보낸다. 국내512개와 미국200개에 대해 초기 구독, 전체 해제, 전체 재구독의2136개 명령을 수용한다. 이를 넘으면1013으로 명시적으로 닫는다.

감시 결과의 동시 GET은 감시별 하나의 실행을 공유한다. 각 응답은 별도 복사본이다. DELETE, 교체, 만료, 종료는 해당 실행을 취소한다. 마지막 호출자도 취소되면 실행을 취소하고, 다음 호출자는 이전 정리가 끝난 뒤 새 실행을 시작한다. 종료한 감시의 결과는404이며 후속 분봉 평가를 진행하지 않는다. 공급자가 소유하는 공유 캐시 작업과 이미 실행 중인 스레드 작업은 기존 소유권을 유지한다.

취소 시 부모 세션의 구독 참조를 동기적으로 지운다. 독립 검토에서 늦게 완료된 자식 RPC가 구독을 다시 남기는 경우를 추가로 재현했다. 참조 해제 revision과 마지막 동기화 revision을 비교해 설정 값이 같아도 필요한 재대조를 생략하지 않게 했다. 동기화 중 발생한 해제는 다음 동기화에 남긴다. 다른 탭의 참조는 보존한다.

## 검증

- 최종 소스 `bc4700b82`에서 WS, 수집 세션, 감시, 분봉, 실행, wire 계약 관련223개 테스트가 통과했다. 경고1개는 기존 Polars join_asof 정렬 확인 안내다.
- Git에 추적된 전체 Python 파일 Ruff 검사와 diff 검사가 통과했다.
- 96개 구독과15ms 지연을 준 TCP 실험은 수정 전1011로 끊겼고, 수정 후5회 모두96개의 작업과 ACK를 순서대로 완료했다. ACK가 해당 작업보다 먼저 도착하지 않는지도 검사했다.
- 기본20초 ping과 timeout에서214개 구독과500ms 지연을 주었다. 수정 전79개 ACK 후1011이었다. 수정 후214개 모두 완료했고 연결과 health200을 유지했다. 이 실험은 연결 결함의 재현이며 운영 검색 속도 측정이 아니다.
- 실제 RpcPeer socketpair, CollectorWorker, KiwoomSessionManager, WS 라우터를 사용하는 테스트에서 취소 후 늦게 실행된 자식 구독도 watchdog이 제거했다. 같은 종목을 보는 다른 탭은 남았다.
- 실제 HTTP 라우터와 v2 runner를 사용하고 공급자 응답만 fixture로 주입한 실험에서 DELETE204 뒤 기존 GET은404가 되었고 후속 분봉 API 평가에 진입하지 않았다.

TCP 관측값은 [before.jsonl](before.jsonl), [after.jsonl](after.jsonl)에 있다. HTTP 관측값은 [http-after.jsonl](http-after.jsonl)에 있다. 환경과 최종 입력 지문은 [runtime.json](runtime.json)에 있다.

```sh
.venv/bin/pytest -q tests/api/test_ws_control_ownership.py tests/api/test_ws.py tests/api/test_screener_continuous.py tests/api/test_screener_continuous_multiframe.py tests/api/test_screener_runs.py tests/unit/live/test_collector_process.py tests/unit/live/test_kiwoom_session.py tests/unit/api/test_rest_wire_schema_contract.py -m 'not wallclock'
git ls-files -z '*.py' '*.pyi' | xargs -0 .venv/bin/ruff check
.venv/bin/python docs/diagnostics/2026-11-02-afternoon-monitor-stability/reproduce_ws.py --repeats 5
.venv/bin/python docs/diagnostics/2026-11-02-afternoon-monitor-stability/reproduce_ws.py --full-scale --repeats 1
```

TCP 드라이버는 운영 포트 대신 OS가 고른 루프백 포트를 사용한다. 구독 RPC만 지연 fixture로 대체하며 벤더 요청은 하지 않는다. 같은 드라이버의 `--expect-disconnected` 옵션은 수정 전 커밋에서1011 재현을 확인한다.

독립 최종 검토는 소스 `bc4700b82`에서 새로운 결함을 확인하지 않았다. 별도 환경의 기존48개 테스트, 실제 RPC 경합 검사3개, 감시 실행 경계 검사3개가 통과했다.

## 전체 검사와 남은 범위

중간 구현의 전체 백엔드 실행은8232개 통과,2개 실패,2개 건너뜀,13개 제외였다. 최종 WS 해제 보완 전 시작한 실행이므로 최종 커밋의 전체 통과 결과로 취급하지 않는다. 변경 경로는 최종223개 검사로 다시 확인했다.

장전 주문 BUY와 SELL 실패2개는 변경 없는 main `ef1adbd1e`에서도 같은 명령으로 재현했다. [별도 이슈2385](https://github.com/Soochol/hoga-ops/issues/2385)에 기록했다. 실제 계좌 주문 장애를 확인한 것은 아니다.

운영에서 관측한109~170초 조회의 특정 지연 단계는 아직 확정하지 않았다. 감시와 실행 ID별 ranks, snapshot, inputs, overlay, calendar, minute, rows, daily_contract, total 단계의 시간과 취소·실패를 기록하도록 추가했다. 이 수정으로 운영 조회가 몇 배 빨라졌다고 주장하지 않는다.

검색식, 가격 판정, 분봉 거래일과 봉 부족 보류 규칙은 바꾸지 않았다. 운영 중인8000·5173 서버, 기본 체크아웃, 사용자 데이터와 자격증명은 수정하거나 재시작하지 않았다. 서버 반영 후 실제 감시와 새 단계 로그 확인은 남아 있다.

## 설계 선택

Fix Root Causes는 수신과 RPC의 결합, 종료된 조회 소유권을 고치는 선택에 적용했다. Model the Domain은 명령 FIFO, 실행별 호출자 소유권, 참조 해제 revision을 고르는 데 적용했다. Laziness Protocol은 새 전역 actor와 WS 가격 자료 확장을 제외하는 데 적용했다. Prove It Works는 실제 TCP와 프로세스 간 RPC로 재현·검증하는 데 적용했다.
