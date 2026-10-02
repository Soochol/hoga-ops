# 세션 종료·복구 1차 구현

계획의 P0와 P1 제어 진단을 구현했다. GC 발생원 최적화(P2)와 프로세스 분리(P3)는 이 변경에 포함하지 않는다. 최초 REMOVE/후속 REG 응답 시간 초과와 1006의 공급사·네트워크 원인은 적용 후 증거가 필요하다.

## 동작

- 외부 구독 태스크는 control 실패 시 세션별 종료 Event를 설정한다. `run()` 소유자가 그 신호와 수신 종료를 함께 기다리고 reader/consumer를 취소·join한다. 큐 대기·처리 중 중단 프레임은 폐기 수치에 포함한다.
- control 송신 backpressure와 ACK 대기를 하나의 10초 예산에 넣는다. 실패한 세션의 후속 송신과 REAL 전달을 차단한다. REMOVE 거부도 새 구독 완료로 오인하지 않고 세션 소유자에게 복구를 요청한다.
- native socket adapter는 close와 강제 abort 모두 `wait_closed()`를 기다린다. 라이브러리 close 제한 2초에 앱 여유 1초를 더하며, 외부 제한·예외·종료 취소 시 abort로 TCP transport 종료를 확인한다. 이후 기존 backoff로 최신 desired 종목을 재등록한다.
- custom adapter가 종료를 증명할 abort 경로를 제공하지 못하면 `close_unconfirmed`를 남기고 새 소켓을 만들지 않는다. 명시적 shutdown까지 소유 태스크를 유지한다. 기본 native adapter는 abort 후 transport 종료를 기다리는 계약을 제공한다.
- 실패 시각은 외부 control 실패 시점에 즉시 기록하며, 나중의 수신 정리가 그 시각을 덮어쓰지 않는다. 새 세션의 등록 완료가 복구 관측을 갱신한다.

## 진단 로그

`live.kiwoom.retiring`에 PID·계정·연결 세대·실패 단계를 기록한다. `evidence`에는 세션 시작 시각, commit/Live 시작/GC를 제공하는 기존 runtime context, 최근 최대 32개의 control 사건을 보존한다. request/sent/completed/timeout/failed, ACK matched/orphan을 구분하며 요청 순번·항목 수·시각·경과·정수 return_code만 담는다. 토큰·종목 목록·원문 payload·자유 형식 vendor 메시지를 저장하지 않는다. 정상 수신마다 로그를 쓰지 않는다.

이 로그는 ACK가 앱에 도착했는지와 송신 단계가 끝났는지를 구분한다. 공급사가 ACK를 보내지 않았다는 결론을 이 로그의 부재만으로 확정하지 않는다. 공식 REMOVE 응답 계약의 상세 대조는 아직 미완료이며 wire 형식은 변경하지 않았다.

## 검증

`tests/unit/live/test_kiwoom_session_retirement.py`는 외부 REMOVE 시간 초과, 종료 미응답, transport abort 완료 전 재연결 금지, 늦은 이전 소켓 ACK/REAL, 중단·대기 프레임 폐기 집계, 초기 LOGIN/REG 시간 초과, shutdown 중 close 취소, 송신 backpressure, REMOVE 거부, 다른 5계정의 독립성을 검증한다.

실제 websockets 16.0와 임시 loopback peer를 이용한 close 미응답 테스트도 포함했다. peer는 HTTP upgrade에만 응답하고 CLOSE를 무시한다. 앱과 라이브러리 제한을 동률로 만들어도 transport 종료를 확인한다. 실행 시간이 특정 창 안에 들어가는지 단언하지 않고 종료 결과를 단언한다.

운영 서버·다른 worktree는 수정하거나 재기동하지 않았다. 로컬 테스트는 이 worktree의 Python 3.14.7 환경과 빈 `.env`를 사용한다. 병합·운영 적용 이후 정규장 실제 수신과 자연 gen2 GC를 다시 검증해야 한다.
