# 과거 매매내역 날짜별 재사용 검증

2026-10-29 사용자 승인: 이미 조회한 과거 날짜는 유지하고 화면에 새로 들어오는 미조회
페이지만 추가로 받는다. 오늘이 보일 때의 15초 갱신을 유지한다.

최종 기준 main과 HEAD: `ec0d03d6050bc96156b8ff9a2b19bbcb10157a0d`. 작업 트리의 변경을 포함해 검사했다.
PR 전 main을 다시 fetch해 같은 기준임을 확인했다. 입력 지문이 기존 통과 결과와 같아
그 결과를 재사용한다. 변경 파일이 겹치는 열린 PR은 없다. 운영 배포는 하지 않았다.

## 변경

- 과거 쿼리는 계좌·Code·가격 시장·날짜·커서별로 분리한다. 완료된 빈 페이지도
  브라우저 QueryClient 메모리에 유지하며 범위 이동·봉 주기 변경·다른 창·계좌 복귀·OFF/ON에서 재사용한다.
- 성공한 페이지는 5분이 지나도 다시 조회하지 않는다. 메모리 캐시는 새로고침하면 사라진다.
- 미조회 페이지만 최신 날짜부터 하나씩 읽고, 이동 시 진행 중 요청만 AbortSignal로 취소한다.
  조회 실패·중간 페이지·취소된 페이지는 완료로 간주하지 않는다.
- 해당 범위에서 새로 받은 성공 페이지 128개 뒤에는 `더 조회`로 이어간다. 동시에 같은 범위를
  보는 창은 공유된 성공 페이지 수로 한도를 계산해 중복 조회가 누적되지 않는다.
- 만료된 커서는 해당 날짜 첫 페이지를 갱신해 새 서명 체인을 공유하며 다른 완료 날짜는 유지한다.
- 오늘만 기존 15초 갱신을 적용한다. KST 자정 이후에는 전날을 과거 이력으로 한 번 더 조회한 뒤 보관한다.
- 같은 위치의 마커가 추가 페이지로 갱신될 때 클릭 영역을 유지하고 최신 상세를 연결한다.
  시간·가격·방향이 바뀌거나 OFF이면 이전 클릭 영역을 즉시 제거한다.
- BE API·wire 필드·마커 모양과 가격/시각 기준은 변경하지 않았다.

## 최종 결과

- `cd frontend && npm run typecheck`: 앱·단위·E2E 세 TypeScript 프로젝트 통과.
- 프런트 관련 5개 파일 **201 passed**. 그중 API 조회 회귀는 **14개**다.
- `npx playwright test account-executions.spec.ts --reporter=line`: **4 passed**.
- 일봉 계좌 교체/클릭 반복 검사 `--grep 'D:' --repeat-each=3`: **3 passed**.
- wire 계약 `uv run --extra dev pytest -q tests/unit/api/test_rest_wire_schema_contract.py`: **12 passed**.
- E2E webServer의 Vite production build 통과, `git diff --check` 통과.

프런트 단위 명령:

```sh
cd frontend
npm run typecheck
npx vitest run src/api/accountExecutions.test.tsx \
  src/chart/projectors/accountExecutions.test.ts src/chart/AccountExecutionsPrimitive.test.ts \
  src/live/workspace/ChartTradeAccountControl.test.tsx src/live/LiveChartRoot.test.tsx
```

과거 날짜·빈 결과 재방문/6분 경과/재마운트, 여러 창의 중복 요청과 계좌·종목·시장 격리,
중단된 다음 페이지 재개, 실패 페이지 재시도, 커서 만료 복구, 동시 창의 자동 128페이지
상한과 수동 재개, 오늘만 갱신/화면 이탈 시 중단, 순환 커서 거절, KST 자정 전환을 검사했다.

브라우저에서는 일봉의 보이는 범위를 5/26~27 → 5/25~26 → 5/26~27로 바꾸었을 때
실제 HTTP 요청이 `20260527`, `20260526`, `20260525` 각 1번뿐임을 확인했다.
매매가 없던 날짜도 다시 조회하지 않고 복귀 후 B/S를 복원한다.
기존 일봉·1분봉·3분봉의 실제 Canvas 좌표와 토스 평균가 상세·계좌 전환·OFF도 유지된다.

중간 회귀 검사에서 동시 창이 각각 요청 수를 세면 자동 한도를 넘길 수 있음을 검출해
공유된 성공 페이지 수로 계산하도록 보완했다. 일봉 계좌 전환 직후 클릭 누락도 한 번
검출했고, 같은 위치의 마커 갱신 시 클릭 영역이 사라지지 않도록 보완한 뒤 위 전체 검사와
일봉 3회 반복을 통과했다. 최초 실패 결과를 통과로 재사용하지 않았다.

## 실행과 입력

[입력 manifest](input-manifest.json): 소스·테스트·픽스처·설정·lockfile 2,836개 파일,
SHA256 `08e213fb7b006c348e520581b1be3f9ee95ac6ac36ca7c8d420e7919fe60fd42`.
BE 소스·테스트의 전체 입력 지문은 이전 검증과 일치한다. 이번에는 wire 계약 검사를 실행했으며
BE 전체 검사를 새로 수행했다고 주장하지 않는다.
Python 3.14.7 / uv 0.11.8 / Node 24.13.1 / npm 11.8.0 / TypeScript 6.0.3 /
Vitest 4.1.7 / Playwright 1.60.0 / Vite 8.0.16, Linux 시스템 Chrome.

기존 빈 `.env`와 E2E의 빈 벤더 자격증명을 유지했다. 슬롯 224, 포트 20224/21224,
데이터 `/tmp/hoga-e2e-data-224`, dist `/tmp/hoga-e2e-dist-224`를 사용했고 서버는 종료되었다.
사용자 서버 5173/8000과 기존 브라우저 저장소는 변경하지 않았다.
증권사 HTTP/WS는 가짜 응답이며 실계좌 조회·주문 전송은 하지 않았다.
