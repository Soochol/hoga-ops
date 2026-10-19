# Trading Desk 적용 검증

- 확인 시각: 2026-10-19T19:55:41+09:00
- 기준 HEAD / origin/main: `0b85b9e639d808e75b4d5497916b8fc9f31da087` (최종 검사 전 fetch 후 동일함 확인).
- 작업 브랜치: `codex/trading-desk-live`.
- 검사 입력 지문 SHA-256: `13e876cace1f3868f39689d574c3ab799a1c5dbc8d66313ade1109bcf8233fa4`.
  `git ls-files --cached --others --exclude-standard`의 frontend, hoga, tests, pyproject.toml, uv.lock, .python-version, VERSION 파일을 경로와 내용 SHA-256으로 정렬·해시했다.
- 실행 도구: node `v24.13.1`, npm `11.8.0`, python `Python 3.14.7`, playwright `Version 1.60.0`, chrome `Google Chrome 155.0.8059.84`.

## 최종 검사

`frontend/`에서 실행했다.

- `npm run gen:tokens`: 성공. 9px 창 모서리 토큰 및 문서/생성 산출물 동기화.
- `npm run typecheck`: 성공. 앱·단위 테스트·E2E TypeScript 프로젝트 모두 검사.
- `npx vitest run`: 662개 파일, 8,576개 테스트 통과.
- `npx vite build`: 성공. 청크 크기 권고 경고는 남음.
- `npx playwright test trading-themes live-window-actions live-window-ux live-orders --grep "제목보다|체결 기본|창 최대화|좁은 작업|first paint|saved windows|증권사 계좌 전환은|종목별 주문수량 기억은|왼쪽 매도·오른쪽 매수 더블클릭|드래그 주문이 커서를|고액 실계좌 신규|기본 576px에서도|주문창 반응형 간격은" --reporter=line`: 27개 모두 통과.
- E2E 자원: slot 295, backend 20295, frontend 21295, data `/tmp/hoga-e2e-data-295`. 단일 워커·설정의 시스템 Chrome·빈 벤더 자격증명을 유지.
- 검사 범위: 일곱 테마 선택·첫 페인트·차트 캔버스 색·탭 간 동기화, 저장 창/배치/그룹/핀 보존 및 새로고침, 13종 창 버튼·리사이즈·최대화·Escape, 모의 계좌 전환·수량 기억·더블클릭 주문·드래그 정정/취소·고액 확인·긴 가격/반응형 호가. 실제 주문 요청은 E2E 응답으로 격리했다.

## 사용 환경 적용

- 실행 중인 5173 Vite의 체크아웃 `/home/dev/code/hoga-ops`에 변경 패치를 `git apply --check` 후 반영했다. 위 변경 파일 전체의 내용 해시가 검증 워크트리와 같음을 확인했다.
- 기존 서버를 중지/재시작하지 않고 HMR로 반영했다. 사용자 `CLAUDE.md`의 기존 수정과 진단 파일은 보존했다.
- 사용 중인 Chrome의 `/live` 탭에서 설정 → Trading Desk를 선택했다. `aria-pressed=true`, `<html data-theme="trading-desk">`를 확인했다. 다른 테마 및 전역 동기화도 계속 사용할 수 있다.
- 적용 전후 DOM 기준 7개 창의 id·x·y·폭·높이를 비교해 모두 동일했다. 현재 종목·창·지표를 초기화하지 않았다.
- 실제 화면: `/home/dev/.codex/visualizations/2026/10/19/01a153b0-ec8a-7aa2-aa99-d7bcaa2efa37/trading-desk-applied.png`.
- 저장소 지정 `/browse` 실행 파일/스킬은 이 환경에 없어서, 브라우저 회귀는 허용된 저장소 E2E로 수행하고 사용 탭 테마 선택/확인은 연결된 Chrome UI 도구로 수행했다.

## 변경 파일 내용 지문

```json
{
  "DESIGN.md": "4a7db44ad30cd824b9db2c44f9926a91183d765f8dcff37bd0154df499b78999",
  "frontend/index.html": "ed132e14560734bdd3c569f576c499d98fa2dca1d1ccf9a3bda95ed393eccf34",
  "frontend/src/live/LiveWorkspace.css": "95943a0b9da7c4f1dc0650a73ceaa889944e2e50dc3941a90d593d518cdd894d",
  "frontend/src/live/TradingDesk.css": "1415e6f229caacbd0da06c5aa8f065bc125e5ef2e8059355faf817f42e7c60d2",
  "frontend/src/live/settings/AppInfoSections.test.tsx": "ef2408708fd35d09c9a3990658fd97bbcb67759e18ee7d7c8e69a749c49f8f98",
  "frontend/src/live/settings/AppInfoSections.tsx": "15a7eaa68e71f5d1039ce1f2432dd86e58d6f07767a04a76fa1b349adb49f1b7",
  "frontend/src/live/workspace/TitleBarSymbolRow.tsx": "fa94df2a126adc343ac1a4e03c8cea00746237ee4b9967965403211998077a6d",
  "frontend/src/live/workspace/WorkspaceLiveToolbar.tsx": "844f7cc9d0b4d8f707db39a59fdac8ec72ba1e1d95b6e59234dab269c077e0f2",
  "frontend/src/nav/TopNav.tsx": "9c161a7bc8bd81134e6bbe17652c4150c05d098521d6ff705328bbc305e12f2e",
  "frontend/src/state/themePrefs.test.ts": "0cfe5aaea5baa232e0b1d88b7c679c96818f5399cd3ba30701cd7f05ff808a9b",
  "frontend/src/state/themePrefs.ts": "6520bef2b49c6833f569e03631c26912c27fa4ff9f331ffbf17ca70bbd90dd60",
  "frontend/src/styles/design-tokens.ts": "ecfc8c3ed0a1ba1d1cbf8e8b5a05322b18d886915a9aca2ba3af376f247d1bdc",
  "frontend/src/styles/tokens.css": "3f6c2aa26b56c7731efa81fbe40a7d5c5b0484ccfa0bb5a54b4f04391e511e4c",
  "frontend/src/styles/tokens.generated.ts": "9bb188a6589ce3711f34493807d257069b1f1de3fc275f919f14467fb6f6a79a",
  "frontend/src/util/maColor.test.ts": "b0d0e786793522f7be46a06ffa5f06c730a441bf2764f7e90b7eb34ab3a9a0fc",
  "frontend/src/util/maColor.ts": "911755b919abfb5c1170e176faec974fe97e2510f3d78944c1ebe5f4207a28db",
  "frontend/tests/e2e/trading-themes.spec.ts": "8c4629cc266d9241416e721bd30b3e2a99badb9425ba74fee2e2d4c353756d33"
}
```

## 후속 요청: 캔들 차트 제목줄 한 줄 (2026-10-19)

- 사용자 요청에 따라 Trading Desk의 2행 quote grid와 큰 현재가 재정의를 제거했다. 종목명·현재가·등락률·창 버튼이 기존 flex 제목줄에서 수직 중앙에 정렬된다. 기능 코드와 저장 데이터는 변경하지 않았다.
- 기준 HEAD / origin/main은 재 fetch 후에도 `0b85b9e639d808e75b4d5497916b8fc9f31da087`로 동일하다. 도구·의존성·E2E 설정은 위 검사와 같다.
- 최종 입력 지문: `95b73ae0b77d7154f9e144762af400465f69039e9b2e19865a65cafcc6a1ad65` (위와 같은 계산 방식).
- `npx tsc -p tsconfig.e2e.json --noEmit`: 통과. CSS 및 E2E assertion만 변경하여 기존 앱 타입·단위 검사 결과를 재사용했다.
- `npx playwright test trading-themes live-window-actions live-window-ux --reporter=line`: **20개 통과 (1.2m)**. E2E 서버의 Vite 프로덕션 빌드도 성공(기존 청크 크기 권고 유지). 새 assertion은 종목명·현재가·등락률·최대화·고정 버튼의 수직 중심 차이 ≤ 1px와 제목줄 높이 ≤ 36px를 검증한다. 기존 테마 전환·좁은 창 버튼·최대화/Escape·저장 배치 검사도 통과했다.
- 로그: `/tmp/hoga-cd06-header-e2e.log`, `/tmp/hoga-cd06-header-typecheck.log`.
- 실행 체크아웃 파일의 기존 내용 해시 일치를 확인한 뒤 이번 CSS·설계 문서·E2E 변경만 복사했다. 서버를 재시작하지 않았다.
- 실제 Chrome `/live`의 두 캔들 차트 제목줄 높이 각각 36px, 이름·주가·등락률·버튼 수직 중심 일치를 확인했다. 7개 창의 id·좌표·크기는 적용 전후 동일했다.
- 화면: `/home/dev/.codex/visualizations/2026/10/19/01a153b0-ec8a-7aa2-aa99-d7bcaa2efa37/trading-desk-single-line-header.png`.
- 이번 변경 파일 SHA-256:

```json
{
  "DESIGN.md": "17ca5798ddcf169867d2403d75c39bf6c21ebcd72024244b2516aac06c18a43c",
  "frontend/src/live/TradingDesk.css": "ad18b02fc1f308081bf895bbe1b7072e0b2af1c0c0058caa5c014815c17c7449",
  "frontend/tests/e2e/trading-themes.spec.ts": "4cc3226fe21a137cfe945c8a9239b2583de80ae35ff46d9a06de4607fa56c0cc"
}
```

## 후속 요청: 상단 테마 라벨 제거 (2026-10-19)

- 워크스페이스 툴바의 ‘트레이딩 데스크’ 텍스트·장식 점과 전용 CSS를 제거했다. 거래소 선택·창 목록·창 추가·프리셋·단축키·캡처 상태는 유지한다.
- 기준 HEAD / origin/main: `f4c10325759e4be9c3be0b4e10ea389f00fc0ee6`. PR 전 fetch 후 동일함 확인. 위 기록과 같은 입력 경로/해시 방식의 SHA-256: `b6e02d87896dd81d55ed4645f6987f589a052458cccee5c3275ed9d82d845910`. 의존성·도구 버전은 위 검사와 동일하다.
- `cd frontend && npx vitest run src/live/LiveToolbar.test.tsx`: 1개 파일 / 16개 테스트 통과. 로그: `/tmp/hoga-remove-desk-label-pr-test.log`. 표시 요소와 미사용 CSS 삭제에 맞춰 기존 툴바 테스트를 재실행했으며 새 테스트는 추가하지 않았다.
- 실제 Chrome `/live`에서 상단 라벨 DOM이 0개이고 나머지 툴바 조작 요소가 표시됨을 확인했다. 서버 재시작 없이 반영했다.
- 화면: `/home/dev/.codex/visualizations/2026/10/19/01a153b0-ec8a-7aa2-aa99-d7bcaa2efa37/trading-desk-label-removed.png`.
