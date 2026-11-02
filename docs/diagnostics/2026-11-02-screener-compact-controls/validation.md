# 스크리너 공통 이탈 제외·간결한 설명 검증

2026-11-02 KST. 기준 main `f1600c63d1d1781d54d69e297db58b0440a7b755`.
사용자 요청: 우측 패널의 이탈 제외를 페이지처럼 통일하고 두 화면의 불필요한
설명을 최소화하거나 기존 SVG와 같은 정보 아이콘으로 전환한다.

## 변경

- 페이지·드로어가 같은 `DismissExitedButton`을 사용한다. 글꼴·패딩·모서리와
  비활성 조건·일괄 제외 동작을 공유하고 좁은 도구줄은 줄바꿈한다.
- `AppIcon`의 기존 viewBox·원·1.6 선 굵기·currentColor 규칙으로 정보 glyph를
  추가했다. 문자열 설명은 공통 `InfoButton`과 기존 포털 `useTextTooltip`으로
  표시한다. 500ms 호버·클릭·키보드 포커스, Escape·blur 해제를 사용한다.
- 결과 시세 설명·조건 실행 안내·순위 부가 설명·일봉 재대조 세부 집계를 도움말로
  옮겼다. 계산 기준은 정보 아이콘을 눌러 펼치며 기존 실행 보존 동작을 유지한다.
- 조회 실패·자료 부족·미제공·잠정/충돌·복구/저장 대기와 현재 진행은 계속 표시한다.
  적용 조건은 접힌 요약을 유지하고 OR 조건에도 표시되던 `모두 충족` 문구를 뺐다.
- 조회/감시·분봉 준비·조건 판정·API/저장 계약은 변경하지 않았다.

## 검증

- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `npx vitest run src/screener src/ui`: **77 files, 648 passed**, 8.14초.
- Playwright **8 passed**, 33.0초:

  ```sh
  npx playwright test tests/e2e/screener-help-and-controls.spec.ts \
    tests/e2e/screener-retained-results.spec.ts tests/e2e/screener-query-monitor-mode.spec.ts \
    tests/e2e/screener-bar-volume.spec.ts \
    --grep 'accessible help|shades departures|bulk dismissal|manual query|open-minute crossing' \
    --reporter=line
  ```

  새 검사는 두 화면의 실제 computed font-size/padding/border-radius 일치,
  260px 패널의 버튼 경계·가시성, SVG, 호버/클릭/키보드 포커스 도움말과 Escape,
  시세 모드별 설명 전환·계산 기준 펼치기·실행 보존 진입점·pageerror 0개를 확인한다.
  기존 검사는 이탈 음영·일괄 제외·재편입·일회 조회/감시 분리와 1/3/5/10분봉을 확인한다.
  첫 검사에서 페이지 전용 테마가 모서리를 4px, 패널은 6px로 만드는 차이를 발견해
  공통 버튼에 radius-md를 명시한 뒤 위 최종 검사를 통과했다.
- 위 E2E 준비 단계의 Vite production build 통과(3.52초).
- `.venv/bin/ruff check .`, `git diff --check`: 통과.
- 최종 스크린샷을 직접 확인했다: [페이지](page.png), [260px 우측 패널](panel.png).

Node 24.13.1, npm 11.8.0, Vitest 4.1.7, Vite 8.0.16, Playwright 1.60.0,
시스템 Chrome. 빈 워크트리 `.env`, 설정의 빈 벤더 자격증명, single worker 유지.
API/UI 20367/21367, 자료 `/tmp/hoga-e2e-data-367`, dist `/tmp/hoga-e2e-dist-367`.
사용자 8000/5173 서버는 재시작하지 않았다. 브라우저 검증은 격리된 저장소 E2E다.

최종 fetch 결과는 위 base와 동일하며 열린 PR #1927/#1726에 변경 파일 중복이 없다.
frontend·hoga·pyproject.toml·uv.lock·VERSION의 tracked/nonignored untracked 입력
2,481개를 경로순 `경로\0내용\0`으로 연결한 SHA-256:
`6b5b07fa792cedba9ae9f6513d3f928cad5513015222b08b75179ac087d9e970`.
이후 추가한 문서·스크린샷은 검사 입력을 바꾸지 않는다.
