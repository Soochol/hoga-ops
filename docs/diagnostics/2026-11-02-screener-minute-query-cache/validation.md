# 분봉 공유 캐시·변경 종목 판정 검증

2026-11-02 KST. 작업 기준 `bb0e1eaddb31311d7544d63045c34302da289bd8`.
기존 3/5/10분봉 WS 구현 `6edb2ec8a` 위에 최신 main
`05dcb648a`(자정 이후 장전 순위 유지)를 합친 작업 트리를 검증했다.

## 통과한 검사

- `.venv/bin/ruff check .`: 통과.
- `.venv/bin/pytest -q tests/api/test_screener*.py tests/unit/live/test_volume_state.py tests/unit/live/test_screener_volume.py tests/unit/live/test_live_candle_backfill.py tests/unit/live/test_minute_day_cache.py tests/unit/live/test_past_candles_cache.py tests/unit/live/test_kiwoom_minute_candles.py tests/unit/api/test_rest_wire_schema_contract.py tests/unit/live/test_ranking_session_history.py -m 'not wallclock'`:
  **1,724개 통과**, 60.39초. 기존 Polars sortedness 경고 66개.
- 마지막 변경은 재생성된 감시 이력의 버전 토큰을 Python 객체 주소 대신 독립 식별자로
  구분한 것이다. 이에 영향을 받는 아래 검사를 새 입력으로 다시 실행했다.
  `.venv/bin/pytest -q tests/api/test_screener_continuous*.py tests/api/test_screener_minute_shared.py tests/unit/live/test_minute_day_cache.py`:
  **53개 통과**, 19.70초. 변경 없는 나머지 범위는 위 통과 결과를 재사용한다.
- `npx playwright test tests/e2e/screener-full-minute-scan.spec.ts tests/e2e/screener-bar-volume.spec.ts --grep 'open-minute crossing|single click|full|minute search' --reporter=line`:
  **5개 통과**, 20.2초. 전 대상 검색·재접속·페이지/패널의 1/3/5/10분봉 갱신과 버스트 합치기를 확인했다.
- `git diff --check`: 통과. wire 모델·프런트 소스·의존성·검증 설정 변경 없음.
  동일 프런트 입력의 타입 검사·4파일/74개 단위 검사·Vite 빌드 통과 결과는
  [이전 검증](../2026-11-02-scoped-multiframe-ws/validation.md)에서 재사용한다.

## 호출 수와 계산량

`uv run python tools/measure_screener_minute_cache.py`와 같은 워크트리 Python으로
모의 공급자/메모리 상태만 측정했다. [측정 원본](measurements.json).

- 2,808종목 × 391분 × 3/5/10분 조건: 첫 준비 **2,808회**, 같은 검색 반복 **추가 0회**.
  주기별 독립 조회의 산술 기준 8,424회에 비해 첫 호출이 2/3 감소한다.
- 캐시에 2,808종목을 유지했다. 압축 행과 부가 예약치 합은 **57,771,792 bytes**이며
  기존 512항목 제한에 의한 전 대상 순환 축출이 재현되지 않았다.
- 338종목/3조건 판정 변화 확인: 전체 계산 **50.236ms**, 무변경 알림 비교 **0.371ms**,
  1종목 변경 시 **0.512ms**(각 12회 중앙값).

위 CPU 수치는 알림의 판정 변화 확인 부분만 잰 것이다. 전체 검색·네트워크·렌더링,
모든 종목이 계속 거래되는 부하나 실제 장중 공급자 성능을 측정한 수치가 아니다.
API 호출 수는 분봉 준비만 세며 일봉·표시 시세·순위 등 다른 요청은 포함하지 않는다.

## 정확성·정리

legacy/v2의 새 전 대상 실행 2개가 각각 130종목을 판정하면서 3개 주기에 총 130회만
조회함을 검사했다. 차트→검색과 검색→차트, 조회 cutoff 전진·미래 진행값 거부,
세션/거래소/프로젝트 격리, REST 우회, 동시 요청 합류·취소, 강제 복구 중 지연 응답 차단,
빈 완료 자료 재확인, 중복 원본 시각·불량 행 차단·15:30 종가 체결을 검증했다.
원본 파일이나 실제 거래 구독을 새로 만들지 않는다.

WS 검사는 동일 결과 읽기의 중복 계산 0회, 한 종목 변경 시 그 종목만 추가 판정,
연결 단절 시 양성 캐시 무효화, 응답 근거 복사, 봉 경계/거래일/복구 알림을 포함한다.
기존 338종목·390분 장중 재생 회귀도 통과했다.

워크트리의 빈 `.env`와 전용 `.venv`/`node_modules`, Playwright의 기존 빈 벤더
자격증명을 사용했다. E2E slot367의 20367/21367 포트는 종료 후 비워졌다.
운영 서버·사용자 데이터·실제 벤더 연결을 변경하지 않았다.
입력 지문·환경·재사용 근거는 [inputs.json](inputs.json)에 기록한다.
