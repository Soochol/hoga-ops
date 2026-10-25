# 초봉 공통 분석 도구 — 구현·검증 기록

2026-10-25 사용자 승인 범위: 제안 1·2단계. 국내 주식 초봉의 관측 체결 원천과 과거
조회는 유지하고 분봉의 분석 도구·가격/거래량 지표 편집·패널 조절을 공유한다.
초봉 1·5·10·30초 설정은 창별 `seconds` 버킷으로 저장하며 `minute`과 분리한다.

이 문서는 1·2단계 당시 기록이다. 이후의 구간 이동·저장 학습뷰·관측 체결강도와
최신 main 통합·검증은 [후속 구현 기록](2026-10-25-second-chart-navigation.md)을 따른다.

## 변경

- `SecondChartWindow`는 관측봉을 렌더 번들로 연결하고 기존 `LiveChartRoot`를 사용한다.
- 도구는 `ChartAnalysisActions`로 공유한다. 드로잉·PNG/복사·복기 노트 추가·지표·
  레전드·호버 연동을 제공하고 기존 좁은 창 접힘/줄바꿈을 따른다.
- 이동평균선·볼린저·엔벨로프·슈퍼트렌드·거래량과 추가 지표 항목을 지원한다.
  초 단위 원천이 없는 호가·프로그램·일별 지표는 카탈로그와 추가 항목에서 제외한다.
- 기존 두 지표 저장소와 패널 높이 프로필의 정규화·시드·초기화·복원에 `seconds`를
  추가한다. 기존 분봉·D/W/M 저장값을 유지한다.
- 최초 최근 관측 240봉·다일 탐색·필터/과거 추가 시 배율 보존·KST 초 표시와
  호가·매물대 커서 연결을 유지한다. 고정 MA 전용 writer는 제거했다.
- 기간 점프·저장 학습뷰의 초봉 지원은 후속 범위다. API 계약·수집/저장은 변경하지 않았다.

## 검증

- 기준 HEAD/base: `cf51438a22c5ebf483c6c563467fa56ef475487c` (최종 확인한 origin/main과 같음).
- 최종 관련 입력 SHA-256: `2927b20678daec01c91772d35ecdabbbede21bc59784769729d6a86e1a52f615`.
  경로를 정렬해 각 경로 + NUL + 파일 내용 + NUL을 해시했다. 대상은 frontend/src·
  frontend/tests·테스트 픽스처·hoga 소스와 package/lock·TS/Vite/Playwright 설정·
  Python 프로젝트/lock/버전 파일이며 삭제 파일은 제외한다. 문서는 제외한다.
- 환경: Node v24.13.1, npm 11.8.0, Chrome 156.0.8078.47, Python 3.14.7,
  워크트리 전용 의존성. E2E worker 1, 무자격, 포트 20054/21054·데이터
  `/tmp/hoga-e2e-data-54`. 사용자 서버 5173/8000은 변경하지 않았다.
- `cd frontend && npx vitest run`: 707파일·9,031테스트 통과. 이 결과 이후
  구 초봉 writer/테스트를 제거하고 초봉 일자 드로잉 준비 조건을 확장했다.
  이에 영향받는 렌더러·드로잉·패널·페이지 조회와 새 초봉 회귀 검사를 다시 실행했다:
  아래 8파일·231테스트 통과. 그 밖의 기존 결과는 입력/동작 영향이 없어 재사용한다.
- `npx vitest run src/live/LiveChartRoot.test.tsx src/live/LiveChartRoot.drawingHover.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx src/live/workspace/SecondChartWindow.viewport.test.tsx src/live/workspace/secondsIndicatorSettings.test.tsx src/live/indicators/IndicatorPanel.catalog.test.tsx src/live/indicators/VolumeConfig.test.tsx src/live/usePagedChartHistory.test.tsx`: 8파일·231테스트 통과.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `npx vite build`: 통과. 기존 큰 청크 안내는 남아 있다. 최신 E2E 서버 준비에서도
  같은 빌드를 통과했다.
- Playwright: `chart-legend-toggle.spec.ts` 1건,
  `regular-session-candle-spacing.spec.ts` 4건, `second-candles.spec.ts` 3건 통과.
- 새 `second-chart-tools.spec.ts`: 지표/분봉 분리·초봉 간 공유·새로고침 복원·
  레전드·호버 버튼·실제 선 생성/복원·PNG 바이트·160px 도구 배치 통과.
- 교체한 `second-chart-updates.spec.ts`: 실제 초봉 공통 렌더러에서 1만 봉의
  지연 체결·새 봉·과거 추가 후 MA 계산과 시간 앵커/배율 유지 통과.
- 최종 수정에서 남은 변경은 주석·들여쓰기·문서와 테스트의 상태 대기 보완뿐이다.
  실제 가격 공급자 연결은 테스트하지 않았으며 기존 초봉 API의 모의 응답으로 검증했다.
