# 장전 분봉 조건 통과 종목이 결과에서 누락됨

2026-11-02 KST. 기준 main `74301bafc18babedae47b39e69066a8a92f91885`.

## 운영 응답과 재현

오후장 공략의 실제 `/api/screener/monitors/{id}/result` 응답은 대상 350종목,
평가 완료 115종목, 결과 0종목이었다. `vendor_price_unavailable`은 서로 다른
233종목에 붙었고, `insufficient_minute_history` 5개 항목은 2종목이었다.
`_rows`는 최종 조건을 통과한 뒤 표시 가격이 없을 때만 전자의 사유를 추가하므로
233종목이 조건 통과 후 표시 단계에서 누락된 것이다. 전체 0건을 조건 미충족으로
설명할 수 없다. 별도 heartbeat는 준비 348, 부족 2, 오류 없음이었으며 수집도 ready였다.

해당 응답의 v2 snapshot 수정 기준일은 10월 30일이고, 삼성전자 표시 가격의 마지막
확정일은 10월 29일이다. 월요일 장전의 분봉은 금요일로 준비되지만, 분봉 전용 요청의
`calendar_evaluate`가 월요일 직전 거래일(금요일)부터 일봉을 읽어 목요일을 누락했다.
읽힌 Series의 가격·원본 날짜가 모두 빈 것을 동일 스냅샷의 단일 종목으로 재현했다.
이것은 분봉 비교 자료 부족과 별개의 표시용 가격 조회 오류다.

## 수정

일봉 조건의 요구 날짜가 없는 분봉 전용 요청은 일봉 fallback 기준일까지 함께 읽는다.
분봉·일봉 조건의 판정 창, 가격 검증·잠정/격리 가드, 확정 시각은 그대로 사용한다.
행의 `price_date`는 실제 표시 가격 날짜를 보존하며, 분봉 발생 날짜와 혼동하지 않는다.
표시용 데이터가 실제로 없는 경우의 `vendor_price_unavailable`은 유지한다.

또한 v2 조립 과정에서 빠지던 기존 분봉 `trading_date`와 `realtime` 메타데이터를
최종 `bar_coverage`에 전달한다. 전체 조건의 complete/실패 집계는 원래 방식대로 계산한다.
응답 모델·프런트 미러 필드·의존성·저장 조건은 바꾸지 않는다. 추가 REST 호출은 없다.

## 검증

- 수정 전 실제 monitor HTTP 경로 회귀 검사 2개 실패. 준비된 금요일 분봉의 양성 종목이
  목요일 표시 가격을 찾지 못했고, 최종 응답에서 분봉 날짜/수신 메타데이터도 누락됐다.
- 수정 후 `.venv/bin/pytest -q tests/api/test_screener_runs.py -k http_preopen_volume`:
  **2 passed**, 0.13초.
- `.venv/bin/pytest -q tests/api/test_screener*.py tests/unit/live/test_volume_state.py tests/unit/live/test_collector_process.py tests/unit/live/test_screener_volume.py tests/unit/live/test_live_candle_backfill.py tests/unit/live/test_minute_day_cache.py tests/unit/live/test_past_candles_cache.py tests/unit/live/test_kiwoom_minute_candles.py tests/unit/api/test_rest_wire_schema_contract.py -m 'not wallclock'`:
  **1,722 passed**, 70.32초, 기존 Polars 경고 66개.
- `.venv/bin/ruff check .`, `git diff --check`: 통과.

HTTP 검사는 실제 v2 runner·확정 일봉 스냅샷·ContinuousAdapter·모의 분봉 준비를
함께 사용한다. 3m/40봉·5m/24봉·10m/12봉, lookback 3, OR 조건의 금요일 발생과
목요일 표시 가격이 모두 응답에 남고, 결과 읽기에 추가 준비 호출이 없음을 확인한다.
가격을 아예 제공하지 않는 경우는 여전히 결과 0/가격 미제공으로 보류한다.

운영에서 표시 가격 누락으로 분류된 3종목의 **동일 고정 스냅샷**을 수정 함수로
읽는 별도 검사에서도 10월 29일 표시 가격과 유효 거래대금이 복원됐다. 읽기 전용이며
벤더 호출·사용자 저장 데이터 변경은 없다. 이 검사를 실제 장중 WS 검증이나 배포 후
전체 조건 재조회 결과로 표현하지 않는다.

## 입력

최종 main fetch는 기준과 동일하며, 열린 #1927·#1726과 수정 파일 중복 없음.
Python 3.14.7, pytest 9.0.3, Ruff 0.15.13, 워크트리 전용 `.venv`와 빈 `.env`.
`hoga`, `tests` 아래 추적 파일과 `pyproject.toml`, `uv.lock`의 885개 파일을 경로순
`경로\0내용\0`으로 연결한 SHA-256:
`f1dcee87c089c478d678c9ba5ed80327d80a6397da3b9d7fe4a83c37ff5ac45e`.
이후 진단 문서만 추가했으므로 동일 소스 입력의 결과를 최종 PR head에서 재사용한다.
