# 주가 비교·기간내 주가 비교

사용자 승인안대로 가격 그룹에 `price_compare`와 `price_compare_period`를 추가했다.
기본은 일봉·0봉 전 종가 > 1봉 전 고가이며 기간내는 최근 20봉이다.

## 계약과 평가

- 양쪽 `left/right`에 독립적인 `offset`(0~1,000 정수)과 `source`(시·고·저·종가)를
  저장한다. 관계는 `gt/gte/lt/lte/eq`이며, 같음은 반올림·허용오차 없이 비교한다.
- 주가 비교는 최신 선택 봉 하나, 기간내는 최근 1~1,000봉 또는 날짜 범위 안의 후보를
  평가한다. 양쪽 봉 위치는 각 후보를 기준으로 이동하며 연속 충족도 각각 기록한다.
  순간적인 교차·돌파 판정은 추가하지 않는다.
- 비교 이력은 `max(left.offset, right.offset) + 1`봉이다. 필요한 구간의 누락·손상은
  후보를 판정하지 않고 커버리지로 알린다. 누락 봉을 제거해 위치를 당기지 않는다.
- 분·일·주·월봉의 기존 집계·가격 보정·자동 조회 기준을 사용한다. 진행 중 봉을
  포함하며 API의 기존 완료봉 전용 옵션도 지원한다. 진행 중 종가는 마지막 가격이다.
- 날짜는 후보 봉 시작일로 고른다. 시작일 전 비교 이력은 읽고 종료일 뒤 값은 집계에서
  제외한다. 새 날짜 조건은 기존 과거 거래량·거래대금 수집 작업으로 보내지 않는다.
- legacy/v2가 같은 비교 함수를 사용한다. v2 날짜 윈도우는 마지막 후보 하나만 판정해
  이전 비교 봉을 후보로 중복 평가하지 않는다. 기존 AND/OR는 종목 단위 조합이다.

새 `bar_price_compare_match`는 주기·관계·조회 시각·후보 진행 여부와 양쪽 가격의
위치·종류·값·봉 시각·진행 여부를 보존한다. Python/TypeScript 모델을 함께 추가하고
응답 필드·관계 enum 가드에 등록했다. 복구 전후 대조에서는 조회 시각만 제외하고
실제 비교가격의 변화는 계속 감지한다.

페이지·드로어의 `주가 비교 발생 N건`은 두 주가 비교 조건의 발생만 기존 모달로 연다.
날짜·분봉 시각·당시 양쪽 가격과 비교식을 보여주고 봉별 제외를 제공한다. 기간 길이·
날짜 변경은 동일 발생의 제외 키를 바꾸지 않는다. 기존 기간내 등락률 상세와 공유하는
모달·버튼 코드는 `PriceOccurrenceDetails`로 확장했다. 행에는 안정된 조건 분류 맵과
열기 콜백을 전달하며 상세 버튼이 종목 이동·드래그를 시작하지 않도록 했다.

## 검증 기록

기준 및 최종 확인 main: `7783d0429890c44770bb1b49c696ec2ef6116e1d`.
워크트리 `codex/screener-price-comparison`의 미커밋 구현을 검증했다. 의존성·lockfile·
검증 설정은 변경하지 않았다. 모의 데이터로 검증했으며 실벤더 조회는 수행하지 않았다.

- `uv run --extra dev ruff check .`: 위반 0건. `git diff --check` 통과.
- `uv run --extra dev pytest -q tests/api tests/unit/api -k 'screener or wire_schema_contract' -m 'not wallclock'`:
  1,129개 통과, 1,264개 범위 밖 제외, 기존 Polars 경고 76건, 50.60초.
- 최종 추가 테스트 후 `uv run --extra dev pytest -q tests/api/test_screener_price_compare.py tests/unit/api/test_rest_wire_schema_contract.py`:
  142개 통과(가격 비교 130개·계약 12개), 3.06초. 위 전체 검증 이후 백엔드 제품 코드의
  변경은 없고 테스트 추가·보강만 있어 나머지 검사 결과를 재사용한다.
- 테스트는 OHLC 16조합×5관계, 후보별 양쪽 위치, 연속 충족, 정확한 같음, 잘못된 입력,
  부족·손상 이력, 진행 봉, 날짜 경계, 동일 수정 기준의 분봉, legacy/v2 실제 runner,
  AND/OR, HTTP 응답·봉별 제외·결과 상한, 복구 대조를 확인한다.
- 새 관계 enum에서 같음 값을 임시 제거하면 계약 가드가 실패하고, 새 근거 모델에서
  왼쪽 가격 필드를 임시 제거해도 실패한다. 두 경우 원복 후 모두 통과했다.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `npx vitest run src/screener src/pages/Screener.test.tsx src/api/screener.test.ts`:
  51파일·452개 통과, 6.51초. 최종 근거 표시 줄바꿈 변경 후 관련 두 파일 5개 재통과.
- Playwright `screener-price-compare`, `screener-change-pct-period`,
  `screener-drawer-occurrence-layout`: 3개 통과, 17.8초. 최종 표시 변경 후
  `screener-price-compare` 1개 재통과, 11.6초. 각 기동의 production build도 통과했다.
- 조건 추가·독립 입력 변경·저장 완료·새로고침·날짜 모드·양쪽 근거·봉별 제외·
  우측 패널 상세·Escape와 기존 기간내 등락률 동작을 확인했다. 넓은 화면/768px과
  근거 모달 스크린샷을 검토했다. 이후 프론트 제품 코드는 바뀌지 않았다.

검증 환경은 CPython 3.14.7·Ruff 0.15.13·uv 0.11.8·Node 24.13.1·npm 11.8.0,
Playwright 설정의 시스템 Chrome이다. 단일 워커·빈 벤더 자격증명·20016/21016 포트·
`/tmp/hoga-e2e-data-16`·`/tmp/hoga-e2e-dist-16`을 사용했다. 종료 후 검증 포트가
비어 있고 사용자 5173/8000 서버가 유지됨을 확인했다. 기존 큰 청크/Browserslist
안내는 유지한다.

최종 입력 지문은 Git 추적/비무시 신규 파일을 경로순으로 정렬해
`path + NUL + SHA256(content)`를 연결한 SHA-256이다. 문서·설치물·산출물은 제외한다.

- backend(hoga·tests·pyproject·uv.lock·Python/Ruff 설정), 865파일:
  `2f2522750e3e3aaa625124adbb1d8545a7e8caefacb9a47f6f65a3e96204c291`
- frontend, 2,056파일:
  `e150520d152b55217007e444b6125520ad7387717dbf8a259edf7e5a4fe81742`
