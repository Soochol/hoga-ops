# 스크리너 이탈 종목 유지 검증

2026-11-01 KST, `codex/screener-retained-results`의 작업 트리에서 검증했다.
HEAD와 fetch한 origin/main은 모두 `afddfc58c2512b7c69ae3bcf66436fa246ca11cf`다.
아래 결과는 커밋 전 변경 사항을 포함하며, 변경 후 검사를 다시 실행했다.

## 입력과 환경

- 입력 SHA-256: `b90730cbca5f5bbd5b6d626391c00905674258bc3d3c54f8e8a67cb9bb894d57`
- 입력: git의 tracked/untracked 비무시 파일 중 `frontend/`, `hoga/`, `tests/fixtures/`,
  `.python-version`, `pyproject.toml`, `uv.lock`, `ruff.toml`의 2,488개 파일.
  경로를 정렬하고 각 `경로 UTF-8 + NUL + 파일 bytes + NUL`을 이어 해시했다.
  프론트 소스·단위/E2E 테스트·픽스처·설정·lockfile과 E2E 백엔드를 포함한다.
- Linux 7.0.0-42 / glibc 2.43, Node 24.13.1, npm 11.8.0, Python 3.14.7,
  Playwright 1.60.0, 시스템 Google Chrome 156.0.8078.79.
- 워크트리별 `npm ci --no-audit --no-fund` 사용. E2E는 기존 설정의 빈 자격증명을 유지했다.
- E2E 슬롯 13: backend 20013, frontend 21013, 데이터 `/tmp/hoga-e2e-data-13`,
  dist `/tmp/hoga-e2e-dist-13`. 사용자 5173/8000 서버는 변경하지 않았다.

## 통과 결과

모든 프론트 명령의 실행 디렉터리는 `frontend/`다.

- `npm run typecheck`: 앱·단위·E2E TypeScript 검사 통과.
- `npx vitest run src/screener src/state/screenerPanel.test.ts src/rightrail src/pages/Screener.test.tsx`:
  67개 파일 / 704개 테스트 통과.
- `npx playwright test tests/e2e/screener-retained-results.spec.ts tests/e2e/screener-occurrence-exclusions.spec.ts tests/e2e/screener-drawer-occurrence-layout.spec.ts tests/e2e/screener-panel-layout.spec.ts --reporter=list`:
  7개 테스트 통과. 같은 실행의 webServer 준비 단계에서 `npx vite build` 통과(3.40초).
- `git diff --check`: 통과.

## 확인한 동작

같은 요청에서 사라진 종목 유지, 재충족 시 음영 해제, 상단 `이탈 제외`의 일괄 제거,
제거 후 미충족 응답에서 재등장하지 않음, 새 충족 시 재편입, 새로고침 후 복원,
검색으로 숨긴 이탈 종목도 일괄 제거, 명시적 봉별 발생 제외와의 독립성을 확인했다.
부분 평가·조회 상한·준비 중 응답은 새 이탈로 단정하지 않는다.

260px 우측 패널에서 기존 행 높이·위치·열과 스크롤을 확인했다. 상태 문구·시각·개별
제외 버튼을 추가하지 않고 기존 테마의 중립 음영만 적용했다. 실제 렌더 스크린샷을
확인했고, 300종목 가상화 결과의 발생 건 제외 복원도 확인했다.

검증은 무자격 API 모킹 E2E이며 실거래 벤더의 장중 체결을 재현한 검사는 아니다.
백엔드 구현과 wire 계약은 변경하지 않아 백엔드 전체 검사는 실행하지 않았다.
