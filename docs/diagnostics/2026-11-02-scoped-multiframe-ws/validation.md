# 범위 제한 3·5·10분봉 WS 감시 검증

2026-11-02 KST. Base/main: `9365bf28117c00e59e91b3c2d200047122f6ae02`.
해당 main의 관심종목·히트맵 등록 탭 변경을 fast-forward한 작업 트리를 검증했다.

## 검증 범위

- `ruff check .`: 통과.
- Python: `pytest -q tests/api/test_screener*.py tests/unit/live/test_volume_state.py tests/unit/live/test_screener_volume.py tests/unit/api/test_continuous_before_cache.py tests/unit/api/test_rest_wire_schema_contract.py -m 'not wallclock'`.
  **1,563개 통과** (54.21초), 기존 Polars sortedness 경고 66개.
- Frontend: `npm run typecheck`: 앱·단위·E2E 타입 검사 통과.
- `npx vitest run src/screener/continuousClient.test.ts src/screener/useScreener.preparation.test.tsx src/screener/ScreenerDrawer.test.tsx src/screener/useScreenerMonitor.test.tsx`:
  **4파일·74개 통과**. `npx vite build`: 통과.
- `npx playwright test tests/e2e/screener-bar-volume.spec.ts --grep 'open-minute crossing' --reporter=line`:
  **4개 통과** (19.3초). 각 1·3·5·10분봉에 페이지/드로어의 모니터 생성·WS 도달·버스트 합치기를 확인하고,
  전체 검색 `/runs`·`/scan` 호출 0회를 검사했다. 3분봉 좁은 화면과 10분봉 드로어 캡처를 직접 확인했다.
- `git diff --check`: 통과. 기존 API wire 필드 변경 없음.

## 회귀 증거

단일 1분봉 API 준비를 공유하는 3개 주기의 raw WS 도달, 결과 경로의 API 호출 0회,
20분 IPC 공백 후 잘못된 신고거래량 차단·해당 종목 보충, 진행 묶음의 하한과 종료 후 복구,
새 체결 없이 끊긴 분의 시계 종료·API 복구, 다음 거래일 초기화·전날 지연 응답 거부, 장전·주말·휴장일·종가 체결의 완료 처리,
잘린 묶음의 비교 제외, 서로 다른 주기의 독립적인 봉 교체 알림을 검증했다.

09:00~15:30의 391개 실제 관측 분을 넣고 3·5·10분봉의 각 최근 후보를 독립적인
전체 당일 집계 정답과 비교했다. API 준비는 총 1회이며 정상 자료가 충분해진 이후
추가 API 요청은 0회다. 기존 338종목·390분 공유 이력/재연결 회귀도 당일 자료만으로 검증한다.
합성 체결·mock API/WS 검사이며, 실제 장중 공급자 지연과 전 시장 성능 측정은 아니다.

## 환경과 재사용

Python 3.14.7 / Node v24.13.1 / npm 11.8.0. 워크트리 전용 의존성과 빈 `.env`,
Playwright의 기존 빈 벤더 자격증명을 유지했다. E2E slot367의 20367/21367 포트와
전용 임시 데이터·dist를 사용했고 종료 후 두 포트가 비워진 것을 확인했다.
운영 서버·사용자 데이터·실제 벤더 구독은 변경하지 않았다.

Frontend 검사 후 변경은 Python 소스/테스트와 이 문서뿐이다. 브라우저 검사는 mock API/WS
화면 동작에 대한 결과를 재사용하며, 마지막 Python 변경은 최종 backend 검사에 포함한다.
정렬한 전체 소스·테스트·lockfile·검증 설정의 파일 SHA-256과 환경을 `inputs.json`에 기록한다.
