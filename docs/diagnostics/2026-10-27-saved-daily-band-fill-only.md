# 일봉 저장 기간 밴드의 경계선 제거

사용자 승인 범위는 일봉 저장뷰다. `LiveChartRoot`가 일봉 밴드에만
`showEdges=false`를 전달하고, 호스트는 같은 값을 모든 pane의 primitive에 전달한다.
밴드는 첫·마지막 봉의 바 폭까지 기존 범위와 테마 틴트·채움 농도로 표시한다.
일봉에서 채움 농도 0%면 선·영역을 모두 그리지 않는다. 주·월봉과 다른 호출자는
기존 양끝 1px 경계선을 유지한다. 저장 파일·API·기본 농도·팬/줌 좌표 계산은 바꾸지 않는다.

## 검증

기준 HEAD/base는 `19a609ae79942a8c4a2e7198a8f9afce2a6fd7ab`이다.
검증 직후 `git fetch origin main`으로 기준이 같은 것을 확인했다. Node v24.13.1,
Python 3.14.7, 워크트리 전용 의존성과 빈 `.env`를 사용했다.

- `npm run typecheck`: 앱·단위·E2E 타입 검사 통과.
- `npx vitest run src/chart/StudySavedRangeBandPrimitive.test.ts src/studyViews/StudySavedRangeBandHost.test.tsx src/live/LiveChartRoot.test.tsx`: **202 passed**.
- `npx playwright test saved-view-date-restore.spec.ts --reporter=line`: **9 passed**.
- E2E 시작 과정의 Vite 프로덕션 빌드 통과. `git diff --check` 통과.

단위 검증은 농도 0/40/100%에서 일봉의 선 비생성과 모든 pane 전달·재부착 없는
변경을 확인한다. 브라우저 검증은 실제 캔버스에서 일봉 경계 위치의 accent 색 세로선이
없고 주·월봉에는 유지되는 것을 픽셀로 검사하며, D→W→M→D 전환을 포함한다.
기존 저장 날짜·배율 복원과 밝은/어두운 테마의 농도 조절·저장·되돌리기도 통과했다.

브라우저 테스트는 격리된 `20428/21428` 포트와 무자격 환경을 사용했다. 운영 서버와
사용자 창 설정은 수정하지 않았다. 검증 입력의 SHA-256은 인접 inputs.json에 기록한다.
