# 스크리너 조회·실시간 감시 분리 검증

2026-11-02 KST. 기준 main `b32261d5454f2de360f6e4bd71dfd703a49eda46`.
사용자 승인: “네, 두 버튼 역할을 분리해줘”.

## 원인과 동작

기존 스크리너 페이지의 조회는 관심종목·히트맵 분봉 조건에 대해 연속 감시도
시작했다. 운영 로그에서 감시 결과 GET이 약 0.5초 간격으로 반복되는 것을 확인했다.
09:27 KST의 오후장 공략 감시는 350종목 모두 비교 봉 부족 상태였고 수집기는
정상이었다. 이 조건은 3분봉 40기간/3봉, 5분봉 24기간/3봉, 10분봉 12기간/3봉이다.

- `조회`: 자료 준비를 포함해 한 번 검색한다. 실행 중인 감시는 해제한다.
- `실시간 감시 시작`: 첫 결과 이후 WS·기존 주기 기반 자동 갱신을 활성화한다.
- `실시간 감시 종료`: 서버 감시를 해제하고 이후 결과 조회를 멈춘다.
- 조건 변경도 감시를 해제한다. 만료된 감시의 DELETE 404는 정상 해제로 취급한다.
- 연속 분봉 알림은 첫 250ms 묶음 이후 요청 시작 사이를 최소 2초로 제한한다.
  실행 중 도착한 마지막 알림은 다음 요청에 반영한다. 진행 중 GET의 늦은 응답은
  종료된 감시의 결과로 발행하지 않는다.

장 초반 자료 부족은 당일 분봉 대기로 안내하고 필요한 비교 봉 수를 표시한다.
현재 오후장 공략은 각각 42/26/14개다. 과거 거래일 부족에는 분봉이 더 쌓인다고
안내하지 않는다. 거래일 선택·09:00 전환·당일 자료 한정 규칙과 백엔드 API 계약은
바꾸지 않았다. 완료된 partial 조회를 준비 중으로 계속 표시하던 페이지 분기도 수정했다.

## 최종 검증

- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `npx vitest run src/screener`: **57 files, 551 passed**, 6.44초.
  일반 조회/명시적 감시, 연속 이벤트 제한과 마지막 알림, 종료 후 늦은 응답,
  만료 감시 해제, 분봉 부족 안내를 포함한다.
- 전체 Vitest 최초 실행: **763 files passed, 1 failed; 9,801 passed, 1 failed**,
  별도 unhandled error 1개. 새 종료 경합 테스트가 임의 microtask 횟수에 의존한
  실패는 GET 시작 신호를 명시적으로 기다리도록 수정했다. 해당 테스트 포함
  스크리너 전체를 위 최종 입력으로 재실행해 통과했다.
- 남은 unhandled error는 변경하지 않은 `WatchlistDrawer.drag.test.tsx`의
  `StockGroupPicker.tsx:36` heatmap mock에 entries가 없는 오류다. 기준 main을
  `/tmp/hoga-query-mode-base-d1ls55f2`에 `git archive`로 풀어 같은 의존성 버전으로
  단독 실행해 **31 passed, 동일 unhandled error 1개**를 재현했다.
  전체 프론트 검사를 완전 통과한 것으로 보고하지 않는다.
- 관련 Playwright **6 passed**, 26.1초. 일반 조회 후 30개 WS 알림과 31초가 지나도
  추가 검색 0회, 명시적 감시 후 알림 반영, 종료 후 31초간 추가 결과 조회 0회를
  검증했다. 기존 1/3/5/10분봉 감시 및 전체 시장 단일 조회·재개도 통과했다.
  명령:

  ```sh
  npx playwright test tests/e2e/screener-query-monitor-mode.spec.ts \
    tests/e2e/screener-bar-volume.spec.ts tests/e2e/screener-full-minute-scan.spec.ts \
    --grep 'manual query|open-minute crossing|single click|full minute|minute search' \
    --reporter=line
  ```

- 위 E2E의 prepare-dist 단계에서 최종 코드 Vite production build도 통과했다.
- `.venv/bin/ruff check .`, `git diff --check`: 통과.

Node 24.13.1, npm 11.8.0, Vitest 4.1.7, Playwright 1.60.0, 시스템 Chrome.
워크트리의 빈 `.env`와 설정의 빈 벤더 자격증명을 유지했다.
E2E는 단일 worker, API 20367/UI 21367, 자료 `/tmp/hoga-e2e-data-367`,
dist `/tmp/hoga-e2e-dist-367`을 사용했다. 사용자 8000/5173 서버는 재시작하지 않았다.
브라우저 검증은 격리된 저장소 E2E이며 사용자 Electron 창을 직접 클릭한 검사는 아니다.

main fetch 결과는 위 base와 동일했다. 열린 PR #1927/#1726에 같은 변경 파일이 없다.
최종 입력 지문은 다음 동반 JSON에 기록한다. 문서만 추가한 커밋에는 위 결과를 재사용한다.
