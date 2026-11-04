# 스크리너 감시 수명과 이전 조회 오류

스크리너 감시의 404를 재현하고, 정상 감시가 끊기거나 이전 조회 오류가 현재 화면에
남는 경로를 수정했다. 운영 사건의 구체적인 사용자 동작은 확인되지 않았다.

## 확인한 원인

2026-11-04 15:01:23.447 KST에 대상 감시의 DELETE가 204로 끝났고, 진행 중 검색은
calendar 단계에서 취소됐다. 같은 결과 GET은 15:01:23.450에 404로 끝났다.
당시 관측한 `/health` commit은 `16c37574e`다. 삭제 중 결과 조회가 404를 반환하는
백엔드 계약은 정상이며, 결과 파일 소실을 의미하지 않는다. 감시 ID는 서버 메모리에 산다.

격리된 실제 Chrome에서 세 경로를 확인했다.

- 저장 조건을 바꾸면 이전 감시가 정상 해제되지만, 늦은 404가 새 선택에 표시됐다.
- 패널의 선택 조건에서 이름과 수정 시각만 바꾸어도 같은 요청의 감시가 해제됐다.
  수명은 `id:updated_at_ms`, 조회 주기 루프는 선택 ID를 사용해 서로 어긋났다.
- 페이지의 첫 감시 결과를 기다리는 동안 이탈하면 감시가 해제되지 않았다.
  당시 `continuous`는 아직 false여서 기존 정리 effect가 등록되지 않았다.

이 재현들은 가능한 원인 경로다. 당시 운영 DELETE를 이름 변경이나 특정 클릭으로
단정하지 않는다. 삭제·만료된 활성 ID와 일반 라우트 누락도 성공한 빈 결과로 처리하지 않는다.

## 수정한 소유권

`useScreener`가 실행 scope, 현재 invocation, 감시 lease를 소유한다. scope 정리는
첫 결과의 성공 여부와 무관하게 등록하며, lease는 자신이 획득한 client와 heartbeat를
해제한다. heartbeat는 첫 결과 대기 중에도 시작한다. 30초 주기와 서버의 5분 lease는 유지한다.

페이지는 기존 요청 내용 기반 신원을 유지한다. 패널은 선택 ID와 전체 실제 요청으로
신원을 정한다. 이름과 수정 시각은 신원에 포함하지 않는다. 패널의 주기 루프도 같은
scope key로 재앵커하므로 같은 ID의 실제 조건 변경은 바로 반영한다.

TanStack mutation observer는 훅 내부에 둔다. 폐기된 실행의 observer만 분리하고,
진행·완료 결과는 현재 scope의 최신 publisher를 통해 발행한다. 호출처의 독립적인
post-await 발행을 없앴다. 정상 종료는 완료 결과와 현재의 실제 오류를 보존하며,
이전 감시 정리가 새 일반 조회를 취소하거나 오류를 덮지 않는다.

`ContinuousClient`는 읽은 ID와 세대를 함께 확인한다. 이전 ID의 늦은 404가 새 ID를
지우지 않는다. 현재 404는 원래 파싱한 오류를 전달하므로 서버의 감시 부재 안내와
일반 `Not Found`가 구분된다. 공용 파서는 문자열 detail도 보존하며 기존 구조화 detail과
422 검증 처리는 유지한다. 본문 없는 DELETE 204에는 기존 `apiAction`을 사용한다.

## 검증

실패 테스트를 먼저 커밋했다. 수정 전에는 폐기 후 `isError`가 false라는 기대에 true가
반환됐고, 첫 결과 전 이탈에 필요한 DELETE가 없었다. 문자열 detail 두 경우까지
총 네 테스트가 의도한 이유로 실패했다.

최신 main `1236005c6c6fc808371129fa19d55ae8e19bfbb0`을 반영한 코드에서 확인했다.

- `npm run typecheck`의 앱·단위·E2E 세 프로젝트 통과.
- `npx vitest run` 전체 768파일, 9,922개 통과.
- `npx playwright test tests/e2e/screener-monitor-ownership.spec.ts tests/e2e/screener-query-monitor-mode.spec.ts tests/e2e/screener-automatic-preparation.spec.ts --workers=1 --reporter=list` 16개 통과. 시스템 Chrome과 소스 Vite build를 사용했다.
- `tests/unit/api/test_rest_wire_schema_contract.py` 12개 통과. 백엔드 wire 변경은 없다.

Chrome 검사는 이름 변경 후 현재 메타데이터 발행, 지연된 이전 오류와 새 성공·실패,
첫 POST·결과 대기 중 이탈, 일반 조회로 전환하는 동안의 지연 DELETE, 현재 404,
빈 결과·준비 상태·재연결·자동 종료를 포함한다. 독립 검증자의 부모·최종 head 비교와
정확한 revision 판정은 PR 검증 댓글에 기록한다.

전체 Ruff의 기존 보관 진단 스크립트 세 파일, 37건은 별도 실패다.
`docs/diagnostics/2026-09-29-memory/harnesses/`의 해당 입력은 변경하지 않았다.
스크리너 수정과 분리해 기록하고 예외나 규칙을 바꾸지 않았다.

검증은 빈 `.env`, 빈 벤더 환경변수, 별도 의존성·포트·자료와 단일 backend에서 수행했다.
운영 API의 감시 시작·종료·재시도나 사용자 상태 복구, 앱 배포는 수행하지 않았다.
