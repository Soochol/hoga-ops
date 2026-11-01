# 오후장 공략 검색 후 수집 IPC 종료

## 확인한 사실과 원인 재현

2026-11-02 KST, main `7235b29695b15f47f5a95aa5a73f9c929107dc7d`에서 조사했다.
저장된 오후장 공략은 관심종목·히트맵의 3/5/10분 거래량 조건이다.
운영 상태 API는 collector `alive=true`, `ready=false`, `state_reason=ipc_closed`,
재시작 8회를 보고했고 서버 로그에는 약 30초 간격으로 새 capture PID가 나타났다.
야간 공급자 연결은 정상적으로 `paused` 상태였다.

히트맵에 등록된 `0158S0`을 VolumeSource → JSON wire → VolumeReplica에 전달하면
기존 숫자 6자리 전용 검증에서 `ValueError: invalid volume state`가 재현된다.
공통 `hoga.api.params.CODE_PATTERN`은 이미 영숫자 6자리와 Q+숫자 6자리를 허용한다.
거래량 수신 task 종료를 IPC 단절로 처리하는 watchdog 경로와 운영 증상이 일치한다.
기존 종료 정리는 task 예외를 수거하되 기록하지 않아 운영 로그에 이 예외의 traceback은
없었다. 운영에서 관찰한 상태와 로컬에서 재현한 예외를 구분한다.

## 수정과 검증

거래량 replica도 공통 코드 문법을 사용한다. revision·타임스탬프·epoch·프레임 크기·
봉 품질 검증은 유지한다. 잘못된 프레임은 계속 거부하고 예외 원인만 로그에 남긴다.
전체 payload는 기록하지 않는다. 사용자 종목이나 저장 조건을 변경하지 않는다.

- 수정 전 `pytest -q tests/unit/live/test_volume_state.py -k alphanumeric`:
  새 `0158S0` 회귀 검사 1개 실패, `invalid volume state` 확인.
- `.venv/bin/pytest -q tests/unit/live/test_volume_state.py tests/unit/live/test_collector_process.py`:
  **52 passed**, 12.00초.
- `.venv/bin/pytest -q tests/unit/live/test_collector_process.py -k spawn_volume_monitor`:
  **1 passed, 30 deselected**, 2.29초.
- `.venv/bin/pytest -q tests/unit/live/test_volume_state.py tests/unit/live/test_volume_process.py tests/unit/live/test_collector_process.py tests/unit/live/test_collector_readiness.py tests/unit/live/test_collector_state_frames.py tests/unit/live/test_collector_peak_delta.py tests/unit/live/test_collector_large_transfer.py tests/api/test_screener_continuous*.py tests/unit/api/test_rest_wire_schema_contract.py`:
  **154 passed**, 33.69초.
- `.venv/bin/ruff check .`, `git diff --check`: 통과.

실제 spawn 자식과 네 개 IPC 소켓을 사용하는 회귀 검사에서 `0158S0`, `Q500093`을
감시에 추가하고 두 번 이상의 프레임 갱신, 모든 reader task 생존, 같은 PID/epoch,
재시작 0회와 ready 상태를 확인했다. 모의 공급자를 사용했으며 실제 벤더 호출은 없다.
잘못된 길이·소문자·전각·경로 문자열은 별도 매개변수 검사에서 계속 거부한다.
실제 장중 체결·부하 및 브라우저 화면을 검증한 결과는 아니다.

## 검증 입력

최신 main을 fetch하여 위 base와 동일함을 확인했다. wire 모델·프런트·의존성·검증
설정은 변경하지 않았다. 같은 파일을 수정하는 열린 PR은 없다(#1927, #1726 확인).
Python 3.14.7, pytest 9.0.3, Ruff 0.15.13, Linux x86_64/glibc 2.43,
워크트리 전용 `.venv`와 빈 `.env`를 사용했다.

현재 수정 소스·테스트를 포함한 `hoga/**/*.py`, `tests/**/*.py`, `pyproject.toml`,
`uv.lock`의 852개 파일을 경로순으로 나열하고 각 `경로\0내용\0`을 이어 SHA-256:
`4fd34cf5aaaaf6e3010b753be9237dc73595ea185bd179413efadf35a3ed9e2f`.
이후 변경은 이 진단 문서뿐이며, 동일한 입력의 위 결과를 PR head에서 재사용한다.
