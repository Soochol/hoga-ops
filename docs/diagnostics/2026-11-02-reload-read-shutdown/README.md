# Reload 조회 정리 구현 검증

[설계와 구현 경계](../../plans/2026-11-02-reload-cancellation-design.md)에 따른 제품 코드 검증이다.
[validation.json](validation.json)에 최종 명령·결과·기준 SHA·입력 지문·환경을 기록한다.
앞선 [합성 성능 실험](../2026-11-02-reload-cancellation/README.md)의 시간과 구분한다.

## 재현

저장소 루트에서 실행한다. reload 시험은 자체 임시 포트·데이터·빈 `.env`를 쓰고
벤더 환경변수를 상속하지 않는다. 사용자 서버 8000·5173을 재시작하지 않는다.

```sh
uv run --extra dev pytest -q tests/unit/api/test_read_shutdown.py tests/unit/api/test_request_coalescer.py tests/unit/test_server.py tests/api/test_screener_read_cancellation.py tests/api/test_screener_continuous.py tests/integration/test_reload_read_shutdown.py tests/integration/test_reload_compute_ownership.py
uv run --extra dev ruff check .
uv run --extra dev pytest -q -m 'not wallclock'
cd desktop
npm run typecheck
npm run lint
npm test
```

## 확인하는 동작

- 새 실행기와 실제 앱의 lifespan·router를 사용한다. 스캔 부하만 barrier로 대체하고,
  cooperative·noncooperative 각각 파일 변경 reload를 5회 실행한다.
- 조회는 503으로 먼저 끝나고 실제 thread 완료 후 volume runtime을 해제한다.
  동시에 실행한 `_finish_disk_write`의 atomic publication은 200으로 완료한다.
- 새 PID의 `/health`가 성공하고 이전 PID가 종료된다. supervisor에서 앱 팩토리를
  호출하지 않으며 정상 종료 뒤 semaphore 경고와 traceback이 남지 않는다.
- 종료 전에 완료된 성공·오류를 보존한다. 중단 후 늦게 반환된 결과는 게시하지 않는다.
  외부 caller 취소와 감시 삭제의 404를 서버 재시작 안내로 바꾸지 않는다.
- 두 독자의 공유, 마지막 독자 취소, 취소 중 재진입, cancellation-resistant coroutine,
  실제 thread 보유, 실패한 worker와 다른 worker의 완료 확인을 Event로 검사한다.
- 실제 `CommandJournal`·`dispatch_command`와 fake gateway를 사용해 주문 완료와
  재기동 후 중복 전송 방지를 확인한다. 실주문은 보내지 않는다.
- 실제 process pool의 조회가 slot을 보유한 상태에서 capture parse를 대기시킨다.
  조회 중단 후에도 slot은 실제 실행 완료까지 유지되고 capture parse와 depth save는
  정상 완료한다. 풀 전체를 취소하지 않는다.
- 데스크톱 실행 명령과 기존 uvicorn·신규 hoga reload 프로세스의 안전한 식별·종료를
  격리된 프로세스 트리로 검사한다. 사용자 바로가기의 설치 경로는 바꾸지 않는다.

## 테스트 보완

스크리너 ranking 대체 함수 두 곳을 새 `operation` 인자에 맞췄다. 장전 주문 테스트의
고정 조회 날짜는 실제 저장된 주문 날짜로 바꿨다. 이 날짜 불일치 두 건은 변경 전
main `a712f83d0`의 별도 임시 checkout에서도 재현했다. 주문 유형 보존·정정 거절·취소의
기존 단언을 유지한다.

## 적용과 한계

공식 개발 명령은 다음과 같다.

```sh
uv run --frozen hoga serve --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

기존 uvicorn supervisor는 새 명령으로 한 번 다시 실행해야 연결 drain 전 중단이
적용된다. 제품 코드를 pull하여 앱 자식만 reload하는 것으로 실행기 자체는 바뀌지 않는다.
데스크톱에서 시작할 때는 갱신된 서버 관리 앱 빌드가 필요하다. 이번 작업은 운영 서버나
설치된 사용자 앱을 재시작하지 않았다.

운영 데이터의 개선율이나 전체 종료 시간 상한을 측정하지 않았다. native query와 이미
실행한 process 작업은 완료를 기다린다. API 준비와 증권사 WS 재등록 완료는 다르다.
강제 반복 SIGINT와 부분 startup, 실자격 collector 전체의 종료 시간은 새 통합 검증의
범위에 포함하지 않는다. 단계별 `reload.shutdown_phase` 로그로 남은 대기를 확인한다.
