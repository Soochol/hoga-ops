# 2026-10-02 키움 세션 복구 조사

운영 대상은 포트 8000, API PID 1556062, 커밋 beef04d6e, Live 시작 1790850474483이다. reload supervisor PID 3364457과 구분했다. 운영 재기동·배포·코드 변경·강제 GC·전체 힙 스캔·공급사 연결 추가 없이 조사했다.

- `observations.json`: 09:29:31, 09:30:58, 09:31:59, 09:39:41 KST의 읽기 API 표본. 연결/등록, 수신 완료 카운터, 큐, GC를 포함한다. 앞 두 표본에서 계정 0–4는 미연결 표시지만 모두 dispatch 카운터가 증가한다.
- `events.log`: 기존 로그에서 API PID가 명시된 GC 정지와 해당 시간대 계정별 구독 실패를 선택했다. 구독 실패 줄 자체에는 PID가 없으므로 이 파일 단독으로 프로세스를 판정하지 않는다. API 표본의 단계·시간·계정·세대와 코드 경로를 함께 대조했다. 원문 token/payload는 포함하지 않았다.
- `probe_retirement.py.txt`: 기존 제품 코드를 호출하는 독립 재현 스크립트. 현재 client 코드와 Python 3.14.7/websockets 16.0에서 실행했다. 운영 앱을 시작하거나 공급사에 연결하지 않는다.
- `reproduction.json`: 재현 3회의 동일 결과와 실행 환경·소스 커밋. source commit a726b5b9c는 PR #1915의 소스이며 운영 merge commit beef04d6e와 관련 client 구현은 동일하다.

## 재현

원본 소스 커밋 `a726b5b9c`의 repo root에서 다음 명령으로 실행한다. 앱 환경변수·토큰은 필요 없다. 수정된 client에서는 이 과거 결함 재현 스크립트를 실행하지 않고 `tests/unit/live/test_kiwoom_session_retirement.py`의 회귀 테스트를 실행한다.

```sh
PYTHONPATH=. /home/dev/code/hoga-ops/.venv/bin/python docs/diagnostics/2026-10-02-kiwoom-session-recovery/probe_retirement.py.txt
```

첫 실험은 가짜 peer가 LOGIN/REG에 응답하고 REMOVE에 응답하지 않게 한다. close도 끝나지 않는다. 테스트 프로세스에서만 제한을 10ms로 줄인다. timeout 후 REAL 3건을 주입하면 `connected=false`, `_ws=None`, `run()` 생존, connect 호출 1회, 후속 tick 3건이 재현된다. finally에서 태스크를 취소·회수한다.

두 번째 실험은 실제 설치된 websockets의 `Connection`/`Protocol`에 가짜 transport를 붙인다. peer의 close 응답이 없는 상황에서 내부·외부 제한을 20ms로 동일하게 설정한다. 앱 `_safe_close()` 경로는 transport abort=0, CLOSING으로 반환한다. 내부 제한만 적용한 `conn.close()` 경로는 abort=1, CLOSED로 끝난다. 측정 후 남은 transport는 직접 정리한다.

가짜 peer/transport이므로 공급사의 최초 ACK 미응답 원인, 실제 TCP 종료 시각, 실제 재연결 소요 시간은 증명하지 않는다. 기존 코드의 세션 종료 누락과 동률 close 제한에 따른 정리 취소 경로를 증명한다. 개선 시 별도 loopback peer 통합 테스트를 추가해야 한다.

## 판단

세션 종료·복구 결함은 재현됐다. 최초 REMOVE/후속 REG 실패·1006의 원인은 아직 구분되지 않았다. 09:39 표본도 연결 5/6, 등록 완료 3/6, capture_healthy=false다. 야간 gen2 최대 7193.1ms와 정규장 gen1 1029.9ms를 구분한다. 큐 초과/폐기 0만으로 전체 개선을 선언하지 않는다.

[개선 계획](../../plans/2026-10-02-kiwoom-session-retirement-and-gc.md)에 우선순위, 변경 대상, 회귀 테스트, 정규장·자연 GC 검증 조건을 정리했다.
