# Obsidian Pro / Ledger Studio 검증 — 2026-10-17

## 범위

사용자 승인 시안 두 개를 기존 전역 테마 설정에 추가했다. 테마 ID는
`obsidian-pro`, `ledger-studio`이며 기본값은 기존 `toss-light`를 유지한다.
테마는 공통 워크스페이스의 색상만 바꾸며 글꼴·밀도·창 배치는 유지한다.
Ledger Studio는 Ledger의 밝은 이동평균 팔레트와 그림자를 공유한다.
뉴스 날짜 입력의 네이티브 밝기는 테마명 분기 대신 `--color-scheme`을 읽는다.

## 입력

- 기준: 최신 `origin/main`의
  `3e0989ea3071a54eec6f93877d7178d553721497`까지 fast-forward한 작업 트리.
- Node.js `v24.13.1`, npm `11.8.0`; `frontend/package-lock.json`으로 `npm ci`.
- TypeScript `6.0.3`, Vite `8.0.16`, Vitest `4.1.7`, Playwright `1.60.0`.
- Python은 E2E 설정이 `.python-version`의 `3.14.7`로 설치·실행했다.
- Chromium 프로젝트, 시스템 Google Chrome `155.0.8059.84`, `workers: 1`.
- E2E slot `63`: 백엔드 `20063`, 프론트 `21063`, 데이터
  `/tmp/hoga-e2e-data-63`, 배포 사본 `/tmp/hoga-e2e-dist-63`.
- E2E 설정의 빈 벤더 자격증명을 유지하고 실시간 API는 기존 fixture로 모킹했다.
- 검증 입력 SHA256:
  `8f87eb300679dfd9130a9f8f60793bb64ec48be76b5fe4af950614d9bc1283bb`.
  입력은 `frontend/src`, `frontend/tests`의 Git 추적 파일 및 새
  `trading-themes.spec.ts`, package/lockfile, index.html, Tailwind/Vite/Playwright/
  TypeScript 설정이다. 경로를 정렬·중복 제거한 1,641개 파일 각각에
  `경로 UTF-8 + NUL + 파일 내용 + NUL`을 SHA256으로 누적했다.

## 결과

- `npm run typecheck`: 앱·단위 테스트·E2E 세 프로젝트 통과.
- 변경 TS/TSX 파일 대상 `npx eslint`: 오류·경고 없이 통과.
- `npx vitest run src/state/themePrefs.test.ts src/state/settingsTransfer.test.ts
  src/state/crossTabSync.test.tsx src/live/settings/AppInfoSections.test.tsx
  src/live/workspace/NewsWindow.test.tsx src/util/tokens.test.ts`:
  **6개 파일, 52개 테스트 통과**.
- `npx playwright test tests/e2e/trading-themes.spec.ts
  tests/e2e/live-news.spec.ts --grep 'first paint|좁은 뉴스' --reporter=list`:
  **6개 테스트 통과 (40.9초)**.
- 위 Playwright 실행의 `webServer`가 수행한 Vite 프로덕션 빌드 통과.
  기존 live-workspace 청크의 700kB 초과 안내는 남는다.
- `git diff --check` 통과.

새 테마 각각의 저장값 첫 로딩, UI 선택, 다른 열린 탭의 동기화, 새로고침 후 복원,
320/390/1440px 설정 선택기 줄바꿈을 확인했다. 창 ID로 고른 실제 차트의 배경,
크로스헤어 축 라벨, 상승·하락 캔들 옵션이 새 테마와 일치한다.
뉴스 날짜 입력은 기존 Toss Light/Dark와 새 두 테마에서 네이티브 밝기와 좁은 창
레이아웃을 확인했다. 단위 테스트는 설정 내보내기/가져오기도 포함한다.

## 대비와 시각 확인

`--bg-card` 기준 WCAG 상대 휘도 대비:

| 항목 | Obsidian Pro | Ledger Studio |
| --- | ---: | ---: |
| 본문 | 14.30:1 | 14.02:1 |
| 보조 텍스트 | 7.35:1 | 5.24:1 |
| 날짜 경계선 | 4.79:1 | 3.79:1 |
| 상승 | 6.69:1 | 5.50:1 |
| 하락 | 7.80:1 | 6.23:1 |
| 강조 버튼 글자/배경 | 9.11:1 | 6.78:1 |

Playwright의 `frontend/test-results/trading-themes-*/`에 저장한 두 테마의
`*-settings.png`, `*-workspace.png`를 열어 배경·패널·텍스트·캔들 배색을 확인했다.
시세는 fixture이며 실제 거래·운영 서버 변경은 수행하지 않았다.

## PR 머지 전 재검증

최신 main의 `81be9166db3424136b9530dfc08d3f9976fe0535`를 반영했다.
추가된 변경은 주문 프리셋 Ctrl 단축키 제거이며 테마 수정 파일과 충돌하지 않았다.
같은 파일을 수정하는 다른 열린 PR도 없었다.

- 위와 같은 1,641개 프론트 검증 입력의 새 SHA256:
  `8f1159c24d4f972a10e598334c31d43353261a5b8781105b50eb6af0ac3aba7d`.
- `npm run typecheck`와 변경 TS/TSX 파일 대상 ESLint 재검증 통과.
- 위 단위 테스트 목록에 `src/live/workspace/OrderWindow.test.tsx`를 포함해
  **7개 파일, 180개 테스트 통과**.
- 동일 E2E 명령 재실행으로 **6개 테스트 통과**; 해당 실행의 프로덕션 빌드 통과.
- 백엔드 소스·API·Python 의존성 변경은 없어 백엔드 전체 검사는 대상이 아니다.
- 이 입력을 포함하는 PR head SHA는 PR 본문의 검증 기록에 연결한다.
