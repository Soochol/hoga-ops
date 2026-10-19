# Trading Desk 피처 페이지 적용 검증

- 확인 시각: 2026-10-19T22:51:14+09:00
- 기준 HEAD / origin/main: `484f832c85a80ed8ee0bd9ef5a92d702e70108a6`. 최종 검사 전 fetch 후 동일함 확인.
- 브랜치: `codex/trading-desk-pages`.
- 최종 입력 지문 SHA-256: `f3c1a88e905871da8a44e4bc32cdf7dc1eb34facf77186ea9d6afff87fe934b1`. `git ls-files --cached --others --exclude-standard` 중 frontend, hoga, tests, pyproject.toml, uv.lock, .python-version, VERSION을 경로와 내용 해시로 정렬해 계산했다. 의존성·검증 설정을 변경하지 않았다.
- 실행 도구: Node v24.13.1, npm 11.8.0, Python 3.14.7, Playwright 1.60.0, 시스템 Chrome 155.0.8059.84.

## 변경 범위

- 공통 PageContainer·PanelCard·ToolbarButton에 스타일 선택자를 제공하고, Trading Desk에서만 여섯 피처 페이지의 패널·입력·선택 버튼·표 헤더를 정리했다.
- 라이브 전용 파일의 브랜드·상단 메뉴 규칙을 공통 CSS로 옮겼다. 창 헤더·차트·주문·데이터 수집 로직은 수정하지 않았다.
- 스크리너 기준 버튼의 선택 상태를 `aria-pressed`로 알린다. 저장 조건·조회와 정렬 코드는 유지한다.
- 카드 경계는 inset shadow로 그려 기존 패널 치수·열 폭·행 높이를 바꾸지 않는다. 히트맵 드롭 강조와 온도 틴트·콜/풋 색 의미는 유지한다.

## 검사

`frontend/`에서 실행했다.

- `npm run typecheck`: 앱·단위·E2E 프로젝트 모두 통과. 최종 로그 `/tmp/hoga-desk-pages-typecheck-final.log`.
- `npx vitest run src/ui/PageShell.test.tsx src/layout/PageContainer.test.tsx src/nav/TopNav.test.tsx src/pages/Heatmap.test.tsx src/pages/Screener.test.tsx src/pages/Sentiment.test.tsx src/pages/Inventory.test.tsx src/pages/Capture.test.tsx src/market`: 17개 파일 / 198개 테스트 통과. `/tmp/hoga-desk-pages-vitest-final.log`.
- 별도 `src/ui/DataSurface.test.tsx` 포함 시장 관련 단위 실행도 10개 파일 / 121개 통과했다. 위 결과와 중복되므로 합산하지 않는다.
- `npx playwright test market-ux heatmap-uiux heatmap-column-layout screener-column-layout capture-queue-scroll trading-themes --reporter=line`: 29개 통과 (1.7m). 시장 카드 600/800/1440px·키보드·모드 전환·스크롤·오류 안내, 히트맵 검색/수집, 숫자 열·밀도, 대기열 가상 스크롤, 테마 동기화/저장 창 보존을 검사했다. `/tmp/hoga-desk-pages-e2e.log`.
- 이후 히트맵 드롭 배경이 테마에 덮이지 않게 예외 조건을 추가하고 사용하지 않는 클래스 두 개를 제거했다. 영향이 없는 시장/스크리너/캡처/테마 검사 결과는 재사용하고 타입·관련 단위 검사는 위와 같이 재실행했다.
- `npx playwright test heatmap-uiux heatmap-column-layout heatmap-panel-drag --reporter=line`: 최종 코드에서 43개 통과 (1.3m). 히트맵 검색·반응형 숫자 열 및 그룹 이동/복제·되돌리기·키보드·저장 실패 회귀를 검사했다. `/tmp/hoga-desk-pages-heatmap-e2e-final.log`.
- E2E의 최종 Vite 빌드 성공. 기존 청크 크기 권고는 유지된다. 실행 중 일시적인 `ResizeObserver loop completed with undelivered notifications` 메시지가 기록됐지만 관련 검사와 위치/스크롤 단언은 통과했다.
- E2E는 slot 295 / backend 20295 / frontend 21295 / data `/tmp/hoga-e2e-data-295`, 단일 워커와 빈 벤더 자격증명을 유지했다. 사용자 5173/8000은 종료·재시작하지 않았다.

## 사용 화면

- 변경 전 내용 해시를 확인한 뒤 실행 중인 `/home/dev/code/hoga-ops`에 해당 파일만 복사했다. 최종 파일 내용 일치를 확인했다.
- 연결된 Chrome의 별도 탭에서 여섯 실제 페이지와 데이터·공통 상단 메뉴·카드 경계를 확인했다. 사용자 기존 탭과 라이브 배치는 변경하지 않았다.
- 보관함은 재고 로딩 완료 후 표 표시 및 검색·검색 해제를 확인했다. 캡처 요청·취소·재시도와 주문 조작은 실행하지 않았다.
- `/browse` 스킬/실행 파일은 이 환경에 없어 저장소 E2E와 연결된 Chrome UI 도구를 사용했다(앞선 Trading Desk 검증과 동일한 대체 경로).
- 적용 화면은 `/home/dev/.codex/visualizations/2026/10/19/01a153b0-ec8a-7aa2-aa99-d7bcaa2efa37/`의 `trading-desk-heatmap.png`, `trading-desk-market.png`, `trading-desk-screener.png`, `trading-desk-sentiment.png`, `trading-desk-inventory.png`, `trading-desk-capture.png`에 저장했다.

## 변경 파일 지문

```json
{
  "DESIGN.md": "1bd0acda25b27aef61c2fcc73c4ddc05f0012925eef7f19fbd864086cdafb99f",
  "frontend/src/layout/PageContainer.tsx": "f4fec65b37bc4bbd28d93af63357cbc591d4e3877dbc5b374f7099e2752f9801",
  "frontend/src/live/TradingDesk.css": "d6b527c552ee176f265cfdade46e8256b97746cf699b924ebdca661f0187d8f0",
  "frontend/src/market/marketCardBits.tsx": "c55054aaf49e5b89ca03d7bf3ef9b5ba496e57fa61dacee59f9194a909fd6ccc",
  "frontend/src/nav/TopNav.tsx": "8d5330d54f3720452418e826919c4c5aee4ef1842dc41612046bc35aa728cd1d",
  "frontend/src/pages/Screener.tsx": "5f23094a322da23c09d315d404a89df9ec5cc3c01cf208399b98d6b608480cef",
  "frontend/src/styles/global.css": "664a0d0288559912a0c9f5eb927ebed02446f9f2cabaa0254e1c2397395a6c7e",
  "frontend/src/ui/PageShell.tsx": "24929614f9534ffb176a5342b28255dd5e3a29ab18cef23675725d94c8937ecc",
  "frontend/src/styles/trading-desk.css": "2f0f1aea7e5db5ba771f2b62d3d12de401ae15ad2e686372c2e9779450b9443d"
}
```
