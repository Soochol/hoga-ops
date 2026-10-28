# 계좌별 차트 매매내역 검증

> 이 문서는 최초 키움 개별 체결 구현의 과거 검증 기록이다. 토스 주문 평균가 지원과 최신 main 통합 후의 최종 결과는 [후속 검증](toss-chart-validation.md)을 따른다.

기준과 최종 확인 origin/main: `7d30930d844f4684cf73a40aabb35704d41c3a1a`.
작업 트리 변경을 포함한 검사다. 최신 main과의 차이는 0/0이며 서버 배포·실계좌 조회는 하지 않았다.

입력 지문은 [input-manifest.json](input-manifest.json)에 기록했다. 소스·테스트·픽스처·의존성과
lockfile·검증 설정 2,825개 파일의 전체 지문은
`6e669ebb726b47e95911203728e7ce5b16b8a55ad7ac04e6250eafcc4b62f462`이다.
JSON에 재계산 규칙, 변경 입력과 설정의 개별 SHA256을 함께 남겼다.

환경: Python 3.14.7, uv 0.11.8, Node 24.13.1, npm 11.8.0, TypeScript 6.0.3,
Vitest 4.1.7, Playwright 1.60.0, Vite 8.0.16, Linux 시스템 Chrome.
워크트리의 빈 `.env`와 기존 E2E의 빈 벤더 환경변수를 사용했다. 사용자 서버 5173/8000은 변경하지 않았다.

## 결과

- `uv run --extra dev ruff check .`: 통과, 위반 0.
- 아래 백엔드 관련 검사: **121 passed**.
- `cd frontend && npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- 아래 프런트 관련 단위 검사: 55개 파일의 799개 테스트 범위. 첫 실행에서 798개가 통과하고
  새 페이지네이션 테스트의 마지막 React Query 알림을 기다리지 않은 1개가 실패했다.
  가짜 타이머의 대기 단계를 수정한 후 해당 API·프로젝터·primitive **9개 테스트가 모두 통과**했다.
  나머지 파일의 검사 입력은 동일해 기존 통과 결과를 재사용했다. 제품 소스 수정으로 실패를 가리지 않았다.
- `cd frontend && npx playwright test account-executions.spec.ts --reporter=line`: **3 passed**.
  이 실행의 webServer가 `vite build`를 성공한 뒤 검증용 배포 사본을 준비했다.
- `git diff --check`: 통과.

백엔드 명령:

```sh
uv run --extra dev pytest -q \
  tests/unit/api/test_account_executions.py \
  tests/unit/api/test_rest_wire_schema_contract.py \
  tests/unit/api/test_broker_trading.py \
  tests/unit/api/test_toss_trading.py \
  tests/unit/api/test_trading_v2_wire.py \
  tests/unit/live/test_kiwoom_trading_design_evidence.py -m 'not wallclock'
```

프런트 단위 범위(모든 명령은 `frontend/`에서 실행):

```sh
npx vitest run \
  src/chart/AccountExecutionsPrimitive.test.ts \
  src/chart/projectors/accountExecutions.test.ts \
  src/live/workspace/ChartTradeAccountControl.test.tsx \
  src/api/accountExecutions.test.tsx src/api/trading.test.tsx src/state \
  src/live/workspace/ChartWindowSettings.test.tsx \
  src/live/workspace/ChartWindow.test.tsx src/live/settings/SettingsSections.test.tsx
```

실패 수정 후 재검증:

```sh
npx vitest run src/api/accountExecutions.test.tsx \
  src/chart/projectors/accountExecutions.test.ts src/chart/AccountExecutionsPrimitive.test.ts
```

## 확인한 동작과 한계

- 일봉·1분봉·3분봉에서 Canvas 실제 `fillText` 좌표를 캔들 시간축·가격축의 기대 좌표와 대조했다.
  과거 일봉은 원주가 대비 0.5배의 표시 가격에서도 올바른 높이에 B/S가 표시된다.
- 설정 ON 후 계좌 선택, 계좌 미선택, 분할 체결 2건의 상세, 토스 미지원 안내,
  계좌 변경 시 이전 상세 제거, 새로고침 후 선택 복원을 확인했다.
- 360px 차트에서 선택창이 창 안에 들어가는지 확인했고 OFF 후 계좌 선택·상태 안내를 제거하고
  재페인트해 B/S 그리기 호출이 더 발생하지 않는 것을 확인했다.
- 시각 누락·주문 시간만 있는 행·다른 계좌/종목·0 체결번호·잘못된 가격/수량을 거절한다.
  실제 체결은 동일 초·동일 가격·동일 수량이어도 체결번호로 구별한다.
- 날짜/종목/시장을 바꾼 커서 재사용을 거절하고 확인된 체결의 서버 재시작 후 보존을 검사했다.
  첫 개별 체결이 연속조회 다음 페이지에 있을 때도 일봉 가격 보정 기준을 준비한다.
- 모든 HTTP/WS 증권사 응답은 가짜 응답이다. 증권사 운영 서버의 과거 제공 기간,
  실제 계좌에서의 조회 권한·갱신 지연·매매내역 완전성은 이번 검사로 확인하지 않았다.
  토스의 주문 평균가/최종 체결 시간은 개별 체결로 표시하지 않는다.
- E2E는 slot 224, backend 20224, frontend 21224, `/tmp/hoga-e2e-data-224`,
  `/tmp/hoga-e2e-dist-224`를 사용했다. 검사 후 두 서버는 종료되었다.

가짜 계좌로 확인한 실제 UI: [3분봉](chart-3m.png), [일봉](chart-D.png).
