# 관심종목 드래그 테스트의 히트맵 응답 오류 수정

기준 main: `8d733cbc7108c1e0206b67ab7afbc159c6e84720` (PR #2380).
2026-11-02 KST, 사용자 요청으로 이전 검증에 남은 관심종목 테스트 오류를 수정했다.

`WatchlistDrawer.drag.test.tsx`는 일반 `apiCall`을 시세 응답으로 대체했다.
드래그 중 우클릭 메뉴를 열면 `StockGroupPicker`가 히트맵 등록 개수를 읽는데,
히트맵 전용 mock이 없어 `{ phase, quotes }`를 받아 `entries.filter`에서 예외가 났다.
수정 전 단독 실행은 31개 assertion이 통과해도 unhandled error 1개로 종료 코드 1이었다.

- `getHeatmap`에 타입이 검사되는 빈 히트맵 응답을 명시했다.
- 메뉴를 연 뒤 히트맵 탭의 등록 개수 0이 나타나는 것을 기다린다. 오류를 무시하거나
  실제 메뉴를 mock으로 제거하지 않는다.
- 드래그 중 서버의 정렬 갱신을 캐시에 넣는 테스트에서 `getWatchlist`도 같은 최신
  응답을 반환하게 했다. 메뉴가 마운트되며 재조회해도 옛 응답으로 되돌아가지 않는다.
- 메뉴 조회가 완료된 뒤에도 드래그 중에는 기존 행 순서를 유지하고, 종료 뒤에는
  갱신된 순서로 바뀌는 기존 검증을 유지했다.

## 검증

- `npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx`: **31 passed**, 처리되지 않은 오류 0개.
- `npx vitest run`: **764 files, 9,802 passed**, 69.67초, 처리되지 않은 오류 0개.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과. 최종 테스트의 await/검증 순서를
  정리한 뒤 `npx tsc -p tsconfig.test.json --noEmit`도 다시 통과했다.
- `.venv/bin/ruff check .`, `git diff --check`: 통과.

제품 소스·API·의존성·lockfile·검증 설정 변경이 없어 빌드·E2E는 PR #2380의 통과
결과를 재사용한다. 이전 스크리너 수정의 검증 기록:
[조회·감시 분리](2026-11-02-screener-query-monitor-control.md).
서버는 기동·재시작하지 않았다.

Node 24.13.1, npm 11.8.0, Vitest 4.1.7, TypeScript 6.0.2.
최종 frontend 소스·테스트·픽스처·설정·의존성 선언 및 lockfile을 포함한 tracked/
nonignored untracked 파일 2,119개를 경로순 `경로\0내용\0`으로 연결한 SHA-256:
`c370ee78fc9d94687741d73f06afdf3b267b80ba0d0b627fcaf0785070ce9228`.
이 문서 추가는 검사 입력을 바꾸지 않는다. 최종 fetch 시 main은 위 base와 동일하며,
열린 PR #1927/#1726에는 수정한 테스트 파일이 없다.
