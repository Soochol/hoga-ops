# 우측 스크리너 보조 안내 제거

2026-11-02 KST. 기준 main `29e62730b3cd09f6821748da2c30d9d52c2257b7`.
사용자가 첨부한 우측 패널의 계산 기준·차트 가격 버전·분봉 판정 집계·상세 사유·
실시간 수집 집계와 정보 아이콘을 모두 제거해 달라고 요청했다.

우측 `ScreenerDrawer`에서 계산·분봉·일봉·순위 기준 등 보조 상세와 정보 아이콘,
이전 조회/저장본/갱신 안내, 긴 시작 설명을 제거했다. 결과·정렬·이탈 제외·감시 조작과
실제 작업 진행·조회 오류·빈 결과의 짧은 상태는 유지했다. 공유 컴포넌트와 페이지를
바꾸지 않아 스크리너 페이지의 도움말·계산 기준·분봉 집계는 그대로다.
판정·수집·WS·시세 구독·응답 및 결과 저장 메타데이터는 변경하지 않았다.

## 검증

- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과. 최종 테스트의 안내 표시 기대를
  조정한 뒤 `npx tsc -p tsconfig.test.json --noEmit`도 다시 통과했다.
- `npx vitest run src/screener`: **57 files, 551 passed**, 6.47초.
  제거된 문구의 기존 양성 검증은 결과 행 유지·보조 문구 부재 검증으로 갱신했다.
  자동 갱신 시 경고·상한·시각·거래대금과 EOD fallback 메타데이터 보존도 확인한다.
- Playwright **8 passed**, 29.0초:

  ```sh
  npx playwright test tests/e2e/screener-help-and-controls.spec.ts \
    tests/e2e/screener-retained-results.spec.ts tests/e2e/screener-query-monitor-mode.spec.ts \
    tests/e2e/screener-bar-volume.spec.ts \
    --grep 'auxiliary details|shades departures|bulk dismissal|manual query|open-minute crossing' \
    --reporter=line
  ```

  계산·분봉 상세가 담긴 응답에서 페이지 집계·도움말·계산 기준 펼치기는 표시되고,
  260px 패널에는 상세/정보 아이콘 없이 종목 행·정렬·이탈 제외만 나타나는지 확인했다.
  이탈 제외·재편입과 단일 조회/감시 분리, 1/3/5/10분봉 동작도 통과했다.
- 위 E2E 준비 단계 Vite production build 통과(4.92초).
- `.venv/bin/ruff check .`, `git diff --check`: 통과.
- [최종 260px 패널 스크린샷](panel.png)을 직접 확인했다.

Node 24.13.1, npm 11.8.0, Vitest 4.1.7, Vite 8.0.16, Playwright 1.60.0,
시스템 Chrome. 빈 워크트리 `.env`·설정의 빈 벤더 자격증명·단일 worker를 유지했다.
API/UI 20367/21367, 자료 `/tmp/hoga-e2e-data-367`, dist `/tmp/hoga-e2e-dist-367`.
사용자 서버 8000/5173은 재시작하지 않았다. 검증은 격리된 저장소 E2E다.

최종 fetch 결과는 위 base와 동일하며 열린 PR #1927/#1726에 변경 파일 중복이 없다.
frontend·hoga·pyproject.toml·uv.lock·VERSION의 tracked/nonignored untracked 입력
2,481개를 경로순 `경로\0내용\0`으로 연결한 SHA-256:
`2e95d0664e969d4dad6bacdfd62b6a7584f0c98de0e6ab1d8dd228f8afc26cb4`.
이후 추가한 문서·스크린샷은 검사 입력을 바꾸지 않는다.
