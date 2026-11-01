# 장전 분봉 검색 기준일

2026-11-02 KST. 기준 main `965267e04f4536c844e636874677b373c70895c3`.
사용자 신고: 월요일 01:36에 오후장 공략을 조회하면 데이터 부족으로 평가 불가.

## 원인과 변경

기존 정책은 거래일 장전에도 당일을 선택했고, 전 대상 검색은 `minute_session_not_started`,
감시는 당일 준비/자료 부족으로 남았다. 운영 달력의 확인된 최종일도 2026-10-30이었다.
이 경우 월요일 당일 선택은 달력 범위 부족으로 실패할 수도 있다. 코드 경로와
로컬 재현으로 확인했으며, 특정 운영 검색 응답의 상세 사유를 수집한 것은 아니다.

사용자가 장전에는 직전 거래일을 사용하도록 승인했다. KST 09:00 전에는 오늘을
제외한 날짜에서 달력으로 마지막 거래일을 확인하고 그날 15:30까지의 자료를 쓴다.
월요일 01:36은 금요일 하루이며, 월요일 달력이 아직 갱신되지 않아도 금요일까지
확인되어 있으면 조회한다. 직전 날짜들에 확인되지 않은 평일이 끼면 계속 거부한다.
09:00부터는 당일 자료만 쓰며 비교 봉 부족을 이전 날로 메우지 않는다.
정규장 외 시간의 기존 고정 과거 스냅샷·차트 날짜 선택은 바꾸지 않는다.

전 대상 수동 조회와 관심종목·히트맵 WS 감시가 같은 선택 함수를 사용한다.
감시 결과의 기존 `bar_coverage.trading_date`도 채워 실제 분봉 기준일을 표시한다.
wire 모델·프런트 타입/컴포넌트·의존성 변경은 없다.

## 검증

- 수정 전 새 장전 검사: **6 failed, 6 passed**. 월요일 대신 금요일을 기대하는
  날짜·전 대상 검색·감시 준비 검사가 기존 동작에서 실패했다.
- 최종 변경 후 아래 전체 관련 범위: **1,720 passed**, 71.02초, 기존 Polars 경고 66개.
  `.venv/bin/pytest -q tests/api/test_screener*.py tests/unit/live/test_volume_state.py tests/unit/live/test_collector_process.py tests/unit/live/test_screener_volume.py tests/unit/live/test_live_candle_backfill.py tests/unit/live/test_minute_day_cache.py tests/unit/live/test_past_candles_cache.py tests/unit/live/test_kiwoom_minute_candles.py tests/unit/api/test_rest_wire_schema_contract.py -m 'not wallclock'`
- 운영 달력이 금요일까지만 있는 경우를 추가 반영한 최종 변경 후:
  `.venv/bin/pytest -q tests/api/test_screener_runs.py tests/api/test_screener_continuous*.py tests/api/test_screener_minute_shared.py tests/unit/api/test_rest_wire_schema_contract.py`:
  **107 passed**, 29.96초, 기존 Polars 경고 1개. 변경된 선택 함수를 호출하는 전 대상
  실행·감시 준비/판정·공유 원본 경로와 wire 계약을 다시 검사했다.
- `frontend/`에서 `npx vitest run src/screener/BarVolumeCoverage.test.tsx src/screener/ScreenerResults.test.tsx`:
  **2파일/8개 통과**. 프런트 구현은 바뀌지 않았다.
- `.venv/bin/ruff check .`, `git diff --check`: 통과.

legacy/v2의 월요일 장전 검색 완료, 금요일 날짜·15:30 cutoff, 재검색 추가 호출 0회를
확인했다. WS 감시는 실제 저장 조건의 3m/40봉·5m/24봉·10m/12봉(lookback 3)으로
금요일 준비 완료·수신 0, 장전 반복 호출 없음, 09:00 무체결 상태에서 전일 자료 차단,
새 당일 체결 후 비교 부족 보류를 확인했다. 휴장일·주말·미확인 평일 거부도 검사했다.
모의 공급자/격리 경로 검사이며 실제 장중 체결·브라우저 클릭 검증은 아니다.

수정 함수에 운영 달력 파일을 읽기만 하여 `2026-11-02T01:36+09:00`을 전달하면
`day=2026-10-30`, `cutoff=2026-10-30T15:30+09:00`, `live=false`가 나온다.
이 검사는 실제 벤더를 호출하거나 달력·저장 조건을 변경하지 않는다.

## 입력과 재사용

최신 main fetch 결과는 위 base와 동일했다. 열린 #1927, #1726과 수정 파일 중복 없음.
워크트리 전용 `.venv`, 빈 `.env`, Python 3.14.7, pytest 9.0.3, Ruff 0.15.13,
Node 24.13.1, npm 11.8.0, Vitest 4.1.7을 사용했다.
최종 `hoga`·`tests` 아래 모든 git 추적 소스·테스트·픽스처와 `pyproject.toml`,
`uv.lock`의 885개 파일을 경로순 `경로\0내용\0`으로 연결한 SHA-256:
`abb5f1122acc84de622fd62178eb449096bddbceb4ac45ed5e5197f06d920d9e`.
같은 방식으로 프런트 추적 파일 2,116개의 SHA-256:
`6b5f57ea4d5f9e7b8be5649f92e693e4803bd6d4f0da0f33100c7cc0c8fdb21a`.
이후 문서 변경은 검사 입력에 영향을 주지 않으며 동일 입력의 통과 결과를 PR head에 연결한다.
