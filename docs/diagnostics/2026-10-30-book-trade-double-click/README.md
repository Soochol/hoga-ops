# 10호가·호가주문 체결 영역 더블클릭

2026-10-30 사용자 승인. 최근 체결 영역의 가격·수량·빈 공간에서 같은 종목·링크 그룹의
체결창을 열거나 기존 창을 앞으로 가져온다. 추가 호버 안내는 표시하지 않는다.

`tradeWindowNavigation.ts`는 클릭 시 실제 창 종목을 읽어 대상을 고른다. 고정 종목은 새
체결창에도 고정하고, 다른 그룹·다른 고정 종목·기존 금액 필터·크기를 변경하지 않는다.
시장 선택과 차트 커서는 기존 체결창의 공통 경로를 유지한다. 체결강도는 열기 영역에서
제외하며, 일반 클릭은 기존대로 유지하고 키보드 Enter/Space도 지원한다.

10호가는 기존 9행 높이 안에서 빈 공간을 포함한다. 호가주문은 기존 체결 셀을 행 높이에
맞춰 늘려, 값이 없는 행도 실제 브라우저에서 더블클릭을 받을 수 있게 한다. 숫자·색·
사다리 위치와 주문 입력·드래그는 유지한다. 백엔드·API 계약 변경은 없다.

## 검증 입력

- base/HEAD: `d31eeb2396e7c669b2900c05f3f6330d4f953aa4` + 이번 작업 변경.
- 최종 검사 중 `git fetch origin main`으로 base와 origin/main 일치를 확인했다.
- Node v24.13.1, npm 11.8.0. 워크트리 전용 `npm ci` 의존성.
- Playwright는 설정의 시스템 Chrome·단일 워커·빈 공급자 자격증명·페이크 응답을 사용했다.
  포트 20500/21500, 데이터 `/tmp/hoga-e2e-data-500`, 배포 사본 `/tmp/hoga-e2e-dist-500`.
  실행 전 포트가 비어 있었고 실행 후 테스트 서버가 종료됐음을 확인했다.
- 검증 입력 SHA-256: `59936b8e7c57145f424087b17161b62b8b9b8dcdc592c5a8ee51504fe3ba38af`.
  `git ls-files --cached --others --exclude-standard -- frontend hoga tests pyproject.toml uv.lock ruff.toml .python-version docs/agents/chart-sync-qa.driver.js`의
  중복 없는 경로를 정렬하고 각 `경로 + NUL + 파일 내용 + NUL`을 이어 계산했다.

## 더블클릭 단계 결과 (아래 스크롤 확장 전)

아래 명령은 `frontend/`에서 실행했다.

```sh
npm run typecheck
npx vitest run src/live/workspace/BookPanel.test.tsx src/live/workspace/OrderWindow.test.tsx src/live/workspace/DataWindow.test.tsx src/live/workspace/TradeWindow.test.tsx src/live/workspace/tradeWindowNavigation.test.ts src/state/workspace.test.ts src/live/tradeSpotScope.test.ts src/live/tradeBrowse.test.ts
npx playwright test tests/e2e/trade-history-window.spec.ts tests/e2e/book-fluid-spacing.spec.ts tests/e2e/trade-cursor-spot.spec.ts --grep-invert '실제 ka10003' --reporter=line
npx eslint src/live/workspace/TradeWindowTrigger.tsx src/live/workspace/tradeWindowNavigation.ts src/live/workspace/tradeWindowNavigation.test.ts src/live/workspace/BookPanel.tsx src/live/workspace/DataWindow.tsx src/live/workspace/OrderWindow.tsx
```

- 앱·단위 테스트·E2E 타입 검사 통과, 단위 475개·브라우저 25개 통과.
- E2E 기동의 `vite build` 통과. 기존 청크 크기 안내가 남는다.
- ESLint 오류 0건. OrderWindow의 기존 `react-hooks/refs` 경고 6건은 base도 동일하다.
- `git diff --check` 통과.
- 실제 공급자 호출 테스트는 제외했으며 사용자 서버의 코드·프로세스는 변경하지 않았다.

브라우저 검증은 두 화면의 가격·수량·빈 공간 더블클릭, 단일 클릭·체결강도 제외,
체결창 중복 방지·포커스 복귀, 주문 요청 0건과 기존 체결 필터·시장·커서 연동·호가
반응형 배치를 포함한다. 초기 검사에서 발견한 빈 주문 체결 셀의 높이 0 문제는
셀을 기존 행 높이에 맞춰 해결한 뒤 전체 선택 범위를 다시 통과시켰다.

## 후속: 체결 목록 내부 세로 스크롤

같은 날 사용자 요청으로 `BookTradeList`를 두 화면의 공통 목록으로 만들었다.
보이는 높이는 10호가 198px(9×22px), 호가주문 216px(9×24px)로 유지하며,
기존 초기 조회와 실시간 수신을 합친 최근 최대 200건만 보관·표시한다. 추가 페이지
요청이나 폴링은 추가하지 않는다. 실제 수신 건수가 적으면 받은 만큼 표시한다.

스크롤 중에는 그 목록을 유지해 새 체결이 읽던 행을 밀어내지 않는다. 맨 위로 돌아오면
최신으로 복귀하고 종목·날짜·시장·표시 세션 변경에는 목록과 읽는 위치를 초기화한다.
안쪽 스크롤 끝의 휠이 호가 사다리를 움직이지 않게 했다. 9건 이하일 때 기존 폭을
유지하고, 실제 스크롤바가 필요한 때만 숫자와 스크롤바의 공통 최소 폭을 확보한다.
더블클릭 열기와 추가 호버 안내 없음은 유지한다.

최종 검증 입력 지문은 `6ec09c155df289868f5e6fb0757c3910fc158cfe27d75a98f80cd72e9643330f`이며,
위와 같은 경로·방법으로 계산했다. base와 최신 origin/main은 동일하다. 환경과
격리 포트·데이터·공급자 차단 설정도 앞 단계와 동일하다.

```sh
npm run typecheck
npx vitest run src/live/workspace/BookTradeList.test.tsx src/live/workspace/useRecentBookTrades.test.tsx src/live/workspace/BookPanel.test.tsx src/live/workspace/OrderWindow.test.tsx src/live/workspace/DataWindow.test.tsx src/live/workspace/TradeWindow.test.tsx src/live/workspace/tradeWindowNavigation.test.ts src/state/workspace.test.ts src/live/tradeSpotScope.test.ts src/live/tradeBrowse.test.ts
npx playwright test tests/e2e/trade-history-window.spec.ts tests/e2e/book-fluid-spacing.spec.ts tests/e2e/trade-cursor-spot.spec.ts --grep-invert '실제 ka10003' --reporter=line
```

단위 486개 통과 후 스크롤바 폭을 실제 오버플로 시에만 예약하도록 마지막 조정했다.
영향받는 `BookTradeList.test.tsx`·`BookPanel.test.tsx` 115개를 다시 통과시켰고 나머지
동일 입력의 결과는 재사용했다. 최종 타입 검사, 브라우저 27개와 E2E 기동의 프로덕션 빌드를 통과했다.
두 화면의 실제 휠·맨 위 복귀·새 체결 도착의 양성 대조·사다리 좌표 유지·추가 조회
0건·더블클릭 재사용을 검증했다. ESLint 오류 0건이며 OrderWindow의 기존 경고 6건은
동일하다. 사용자 서버에는 아직 반영하지 않았다.
