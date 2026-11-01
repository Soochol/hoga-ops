# 기간내 등락률

사용자가 승인한 개별 봉 도달 방식으로 `change_pct_period`를 추가했다. 기존
`change_pct`의 최신 봉 의미·저장 조건·제외 키는 유지한다. 카탈로그 등락률 그룹에서
추가하고 기본값은 일봉·최근 20봉·전일 종가 대비 10% 이상이다.

## 평가와 저장

- 최근 `lookback` 1~1,000봉 또는 `mode=date_range`의 시작일~종료일을 선택한다.
  날짜 전환 기본 범위는 KST 이번 달 1일~오늘이며 D/W/M과 기존 분봉 주기를 지원한다.
- 각 후보 봉의 종가와 그 시점의 전일 종가·직전 선택 봉 종가·해당 봉 시가를 비교한다.
  이상·이하·범위는 경계를 포함하고 음수와 30% 초과 문턱도 허용한다. 기간 전체의
  누적 수익률이나 여러 봉 등락률 합계는 계산하지 않는다.
- 날짜는 봉 시작일 기준이다. 종료일 뒤 데이터는 봉 집계에서 차단하며 시작일 전의
  비교 봉·전일 종가는 읽는다. 진행 중 봉을 포함하되 API의 완료봉 전용 호환도 유지한다.
- 기존 가격 보정·자동 기준·장중 일봉 대체·분봉 요청 예산을 공유한다. 확인된 발생은
  부분 이력에서도 반환하고 부족 이력·비교가격·수정계수는 커버리지로 구분한다.
- legacy/v2의 봉 평가를 재사용한다. v2의 날짜 방식은 각 비교 윈도우에서 마지막 후보
  하나만 판정해 직전 봉을 별도 후보로 다시 평가하지 않는다. 날짜 조건을 기존 과거
  거래량·거래대금 수집 경로로 보내지 않는다.
- `bar_change_match`와 `bar_start_ms`로 실제 발생 근거를 보존한다. 제외 키는 검색
  기간을 포함하지 않으므로 기간을 바꿔도 동일 조건·종목·발생 봉의 제외가 유지된다.

페이지·드로어에서 이 조건의 발생만 `등락률 발생 N건` 버튼으로 연다. 기존 발생 상세
모달을 재사용해 날짜·시각·당시 등락률·종가·비교가격과 봉별 제외를 제공한다. 상세를
열어도 종목 이동·드래그를 시작하지 않으며, 제외 후 갱신된 결과를 같은 모달에 반영한다.
드로어의 메모된 행에는 안정된 조건 ID 집합과 열기 콜백만 전달한다.

## 검증

기준과 최종 확인 main은 `6c4589ba2`다. 워크트리의 미커밋 구현을 검증했으며 의존성·
lockfile·검증 설정은 변경하지 않았다. 테스트용 가격·공급자 모의 응답으로 검증했고
실계좌나 실벤더 자격증명을 사용하지 않았다.

- `uv run --extra dev ruff check .`: 위반 0건.
- `uv run --extra dev pytest -q tests/api tests/unit/api -k 'screener or wire_schema_contract' -m 'not wallclock'`:
  1,004개 통과, 범위 밖 1,264개 제외, 기존 Polars 경고 76건, 53.16초.
- `npm run typecheck`: 앱·단위·E2E 프로젝트 통과.
- `npx vitest run src/screener src/pages/Screener.test.tsx src/api/screener.test.ts`:
  50파일·446개 통과, 6.46초.
- Playwright `screener-change-pct-period`, `screener-bar-threshold`,
  `screener-occurrence-exclusions`: 5개 통과, 21.4초. 기동 시 Vite production build도 통과했다.
  새 조건 추가·저장 완료·새로고침·주기/비교기준/날짜/연산 전환·발생 근거·동일 날짜의
  서로 다른 봉 제외를 확인하고 1,280px/768px 스크린샷을 검토했다.
- 후속 `screener-change-pct-period`·`screener-drawer-occurrence-layout`: 2개 통과,
  12.2초. 새 조건의 우측 패널 상세 열기·Escape 닫기와 기존 조건의 조밀한 행 유지까지
  확인했다. 최종 E2E 프로젝트 타입 검사도 통과했다.
- 조건 처리 범위 가드에서 `change_pct_period` 처리를 임시 제거했을 때 실패하고
  원복 후 통과함을 확인했다. 신규 기간 조건 자체도 봉 평가를 반드시 요구한다.
- 기존 전체 카탈로그 입력 검사의 순위 필드 기대값을 `lookback`에서 실제 `top_n`으로
  수정했다. 신규 조건에는 첫 입력인 `lookback` 수정 검사가 그대로 적용된다.

검증 서버는 단일 워커·빈 벤더 자격증명·포트 20016/21016·
`/tmp/hoga-e2e-data-16`·`/tmp/hoga-e2e-dist-16`을 사용한다. 사용자 5173/8000 서버는
유지한다. 빌드의 기존 큰 청크 안내와 Browserslist 갱신 안내는 남아 있다.
환경은 CPython 3.14.7·Ruff 0.15.13·uv 0.11.8·Node 24.13.1·npm 11.8.0,
브라우저는 Playwright 설정의 시스템 Chrome이다. 종료 후 검증 포트가 비어 있음을 확인했다.

입력 지문은 Git 추적/비무시 신규 파일을 경로순으로 정렬한 뒤
`path + NUL + SHA256(content)`를 연결해 SHA-256으로 계산했다. 문서·설치물·산출물은
제외한다. 후속 E2E 시나리오 추가는 제품 소스를 바꾸지 않는다.

- backend(hoga·tests·pyproject·uv.lock·Python/Ruff 설정), 863파일:
  `77bf34554ba47af04031d51f2678ee3a55bb65cc711646e1627c0b51a0557e40`
- frontend, 2,052파일:
  `8984c87f6b0fb0ed45fc7ce29a4cdc143f7afe5ff30435ec97bd3e5d3dc2a9ba`
