# 주기별 거래대금·기간내 거래대금·등락률

사용자 승인 범위는 세 조건의 주기·봉수·진행 중 봉 및 비교 기준 확장과 개별 테스트다.
기준 main은 `04766c384eb3fea1450e9e3c0065bb8dc75b3112`, 작업 브랜치는
`codex/screener-turnover-change-timeframes`다. 이 기록은 해당 기준의 미커밋 변경을 포함한다.

## 조건 의미

- `trade_value`: 최신 선택 봉의 거래대금 추정치가 `min_eok`억 이상인지 본다.
- `trade_value_period`: 최근 N봉 또는 날짜 범위 중 **개별 봉 하나라도** 기준 이상이면
  통과한다. 기간 전체 합계나 신고거래대금이 아니다. 완전한 N봉 이력이 없어도 확인된
  임계값 도달은 반환하고 부족 이력을 커버리지에 남긴다.
- 현재 스크리너 입력은 OHLCV이며 실제 체결금액 컬럼을 제공하지 않는다. 분봉은
  원본 OHLC 평균가 × 원본 거래량, 일봉은 기존 일별 추정치, W/M은 일별 추정치를
  합산한다. 집계 OHLC 평균 × 주·월 총거래량으로 다시 추정하지 않는다.
  원본 분봉 거래량에 수정된 가격을 곱하지 않는다. API·화면·CSV에 추정 방법을 남긴다.
- 억 단위 문턱을 원으로 바꿀 때 Decimal(str(value))를 사용해 0.00002억 경계가
  2000.0000000000002원으로 바뀌어 동률을 탈락시키지 않는다.
- `change_pct`: 최신 선택 봉 종가의 등락률을 gte/lte/between으로 비교한다.
  `previous_day`는 기본 전일 종가 대비, `previous_bar`는 선택 주기의 바로 앞 봉 종가 대비,
  `bar_open`은 최신 봉 시가 대비다. 주·월 등락률을 ±30%로 제한하지 않는다.
- 주·월봉의 전일 기준은 봉의 마지막 거래일 직전 실제 거래일 종가다. 분봉 전일 기준은
  일봉 원주가 아카이브에서 정확히 직전 거래일의 종가를 읽어 분봉과 같은 현재 기준일의
  수정계수로 보정한다. 더 오래된 보유 행으로 대체하지 않는다. 기준가 0·누락·달력 미확인·
  수정계수 미확인은 정상 미충족과 구분한다. 읽기 실패도 커버리지로 표시한다.
- 진행 중 제외는 최신 봉/최근 N봉 선택 전에 적용한다. 장중 등락률은 충족·해제가 가능하다.

## 계약과 호환

- 세 조건에 `timeframe`과 `include_open_bar`, 등락률에 `change_reference`를 저장한다.
  생략값 D/true/previous_day는 기존 SQL·제외 해시·요청 키를 유지한다.
- 거래대금의 주기 없는 기존 날짜 조건은 기존 과거 일봉 보충 수집을 유지한다.
  주기 지정 날짜 조건은 별도 `BarTradeValueRangeParams`로 평가해 수집 작업에 보내지 않는다.
  봉 시작 날짜로 후보를 고르고 종료일 이후 일별 금액은 합산하지 않는다.
- 같은 일봉 술어여도 수집 경로가 다른 기존/신규 날짜 요청은 프론트 요청 키를 구분한다.
- `bar_trade_value_match`는 금액과 추정 방법(`ohlcv_estimate`/`daily_estimate_sum`),
  `bar_change_match`는 변화율·비교 방식·종가·기준가·기준 시각을 반환한다.
  주기·진행 상태·조회 시각 및 `bar_start_ms`도 보존해 CSV·발생 근거·봉별 제외에 연결한다.
- 기존 가격·거래량과 분봉 캐시·거버너·회전 배치·조회 시간 예산을 공유한다.
  기존 KRX 정규장 범위 및 REST 모니터링이며 NXT/시간외·체결 즉시 탐지는 추가하지 않는다.

## 검증 범위

세 조건 각각 기본값/제외 해시·주기 API 왕복·잘못된 주기·비정상 수치·SQL 우회 방지를
검사했다. 거래대금은 동률·최신 봉·0·잘못된 OHLCV·부분 이력·진행 중 제외를, 기간내는
개별 봉 도달과 전체 합계 구별·N봉 경계·주/월 일별 합산·날짜 끝 이후 데이터 차단을 검사했다.
등락률은 세 비교 방식, 세 연산의 경계, 기준값 누락/0, 진행 중 충족·해제, 완료봉 이동,
주봉의 전일 기준, 분봉과 전일 원주가의 동일 기준 보정, 직전일 결손/손상 대응을 검사했다.
HTTP에서 세 조건 AND·실제 응답 직렬화·제외 후 결과 상한 적용을 확인했다.

브라우저는 세 조건의 서로 다른 주기·진행 설정·금액·80% 문턱을 저장/새로고침하고,
조회·CSV 근거·날짜 방식 전환·비교 방식/연산 전환·768px 입력 경계를 확인한다.
기존 저장 선택 E2E가 전역 option을 세어 새 주기 select 옵션까지 포함한 실패를 발견해
저장 목록(listbox) 안의 option으로 범위를 바로잡았다.
두 새 enum 가드는 임시 프론트 사본에서 값을 하나씩 제거해 실제로 실패함을 확인했다.

검증은 별도 Python/Node 의존성 및 빈 벤더 자격증명으로 진행했다. E2E는 단일 워커,
Chrome, 20332/21332와 `/tmp/hoga-e2e-data-332`를 사용한다. 사용자 5173/8000 서버와
운영 데이터는 변경하지 않는다. 공급자 호출은 모의 데이터로 검증했으며 실제 장중 API
대조·새 PR·운영 배포는 이번 작업에 포함하지 않는다.

## 최종 결과 (2026-10-19 KST)

- `uv run --extra dev ruff check .`: 위반 0건. `git diff --check` 및 신규 파일 끝 공백 확인 통과.
- `uv run --extra dev pytest -q -m 'not wallclock'`: **6,441 passed, 2 skipped**,
  wallclock 13개 제외, 35개 경고, 276.50초. 세 조건 구현과 계약 변경을 포함한 전체 결과다.
- 이후 가격 수정계수 로더에 REST 조회 중지 게이트와 회귀 검사를 추가했다.
  원본 분봉이 캐시에 있어도 조회 중지 상태에서 새 계수를 요청하지 않고,
  이미 캐시된 계수는 사용할 수 있음을 확인했다. 최종 소스에서 다음 관련 검사를 재실행했다.
- `test_screener_bar_threshold.py`, `test_screener_bar_price.py`, `test_screener_bar_volume.py`,
  `test_screener_runner.py`, `test_screener_scan.py`, `test_screener_history.py`,
  `test_screener_history_trade_value.py`, `test_screener_occurrence_exclusions.py`,
  `test_rest_wire_schema_contract.py`, `test_wire_schema_contract.py`, `test_frontend_static.py`:
  **271 passed**, 6.43초. 전체 결과와 최종 관련 결과를 조합해 사용한다.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과. 신규 E2E 추가 후 해당 프로젝트도
  따로 통과했으며 마지막 안내 문구 변경 후 전체 typecheck를 다시 통과했다.
- `npx vitest run`: **665파일, 8,603개 통과**, 51.43초.
- 결과 표가 일봉 거래대금/전일 등락률을 표시한다는 안내와 CSV의 주기별 근거를 구분한 뒤
  `npx vitest run src/screener`: **36파일, 285개 통과**, 3.59초.
- 마지막 `npx vite build` 통과. 기존 700kB 초과 청크 안내가 있다.
- `npx playwright test screener trading-themes --reporter=line`: **19 passed**, 1.4분.
  기존 저장 선택 검사의 option 범위 수정 후 전체 관련 시나리오를 다시 통과했다.
- 마지막 안내 문구와 두 번째 조회 완료 대기 보강 후
  `npx playwright test 'screener-(bar-threshold|column-layout|trade-value-history)' --reporter=line`:
  **4 passed**, 17.1초. 최신 넓은/768px 스크린샷을 확인했다.
- 최종 main은 기준 SHA와 같았다. E2E 종료 후 20332/21332 포트가 비어 있고 사용자
  5173/8000 서버는 유지됨을 확인했다. 검증 서버에 실자격증명을 복사하지 않았다.

실행 환경: CPython 3.14.7, uv 0.11.8, Ruff 0.15.13, Node 24.13.1, npm 11.8.0,
Vite 8.0.16, Chrome 155.0.8059.84. Python/Node 의존성·lockfile·검증 설정은 변경하지 않았다.

최종 입력 지문: Git 추적/비무시 신규 파일을 경로순으로 정렬한 뒤
`path + NUL + SHA256(content)의 32바이트 digest`를 연결해 SHA-256으로 계산했다.
backend는 hoga·tests·pyproject·uv.lock·Python/Ruff 설정,
frontend는 frontend/ 아래 Git 추적/비무시 신규 파일 전체를 포함한다.
설치물·생성 결과·운영 데이터는 Git 무시 대상으로 제외했다.

- backend **764파일**: `c8c7a4035516dd76dffa07b19211df8eaaf2a3f2e8acea7a3f28db13cffdb7a4`.
- frontend **1,743파일**: `aa91b6ab97a1a85a5766554ca6bfd775dec424bc9053de3f0a17d290959d6ae1`.

현재 입력에는 전체 검사 이후 선택 재검증한 REST 중지 처리·표 안내·E2E 선택자/완료 대기를
포함한다. 변경 없는 영역의 전체 결과와 최종 관련 검증의 조합을 재사용 근거로 남긴다.
