# 전체 호가 주문창 검증 — 2026-10-26

- 검증 시각: 2026-10-26 17:10 KST.
- 작업 트리: `/home/dev/.codex/worktrees/0af5/hoga-ops`.
- HEAD/base 및 최종 fetch한 origin/main: `ef63ac158ec4047131e96526efe741a10f4e4dda`.
  최종 검증 후 재확인한 차이는 `0 0`이다. 변경은 이 SHA 위의 미커밋 작업 파일이다.
- Node v24.13.1, npm 11.8.0, TypeScript 6.0.3, Vitest 4.1.7,
  Vite 8.0.16, Playwright 1.60.0, 시스템 Chrome 156.0.8078.47,
  Python 3.14.7. 의존성은 워크트리 안에 `npm ci`, `uv sync --extra dev --frozen`으로 설치했다.

## 통과한 검사

`frontend/`에서 실행:

```sh
npm run typecheck
npx vitest run src/live/workspace/OrderWindow.test.tsx src/live/workspace/orderPriceRange.test.ts src/live/workspace/useOrderColumnLayout.test.ts src/live/workspace/useOrderQuantity.test.ts src/live/krxTick.test.ts
npx playwright test tests/e2e/live-orders.spec.ts --grep '전체 호가|주말 REST|호가 empty에서도|호가 failed에서도|드래그 중 호가|576px 압축형|주문창 반응형 간격|호가주문 버튼은' --reporter=list
```

- 앱·단위·E2E의 세 TypeScript 프로젝트 검사 통과.
- Vitest 5개 파일, 194개 테스트 통과.
- Playwright 11개 테스트 통과. 실행의 webServer 단계에서 `vite build`와 dist 사본 준비도 통과.
- `git diff --check` 통과.
- 변경 파일 ESLint: 오류 0. OrderWindow의 기존 `pending()` 렌더 중 ref 읽기에서
  파생된 경고는 기존 파일 5개, 전체 호가 렌더 호출을 포함한 현재 파일 6개다.
  경고 억제나 린트 설정 변경은 하지 않았다.

브라우저 검증은 워크트리 슬롯 378의 backend 20378 / frontend 21378과
`/tmp/hoga-e2e-data-378`, `/tmp/hoga-e2e-dist-378`을 사용했다. 기존 설정의 빈 자격증명과
workers=1을 유지했고, 주문·시세는 테스트 라우트로 대체했다. 사용자 서버 5173/8000은
수정·재시작하지 않았다. 실행 종료 후 테스트 포트가 비워진 것을 확인했다.

## 확인한 동작

- 버튼은 기존 수량 입력 줄에 있고 모드 전환으로 줄 높이가 변하지 않는다.
- 상·하한가를 포함한 유효 가격으로만 탐색한다. 주식 가격대 경계와 ETF/ETN의
  2천원 경계, 매우 큰 가격 범위를 별도로 검사했다.
- 잔량 없는 가격의 매수·매도 요청이 선택 수량·가격으로 기존 주문 API에 전달된다.
- 기존 주문을 10호가 밖의 잔량 없는 가격으로 드래그 정정한다.
- 빈 잔량은 빈 문자열이며 휠·가격열 드래그는 주문 요청을 만들지 않는다.
- 시세 갱신은 탐색 위치를 유지하고 현재가 복귀는 전체 호가 모드를 유지한다.
- 창 복원·크기 변경에서 렌더 행 수가 실제 사다리 높이에 맞게 줄어든다.
- 오래된 호가, 누락·다른 종목·전날 상하한가를 차단하며 시장을 전환했다가 돌아와도
  전체 호가 모드를 자동 복원하지 않는다.
- REST 마지막 호가, 부분 호가, 기존 주문 드래그, 압축형·좁은 배치의 회귀 검사를 통과했다.

## 검증 입력 지문

SHA-256: `a85c8d80b4ce6c0475521ca3ea29c924f86cf6085438000d136fd39145d05376` (2,267개 경로).

`git ls-files -co --exclude-standard`의 중복을 제거하고 정렬한 다음 아래 경로를 선택했다.
각 일반 파일의 `UTF-8 경로 + NUL + 파일 바이트의 SHA-256 digest`를 순서대로 합쳐
다시 SHA-256을 계산했다. 진단 문서는 실행 입력에 포함되지 않는다.

- `frontend/{src,tests,plugins,public}/`, `hoga/`, `tests/fixtures/tiny_tsv_multi/` 전체.
- `frontend/{index.html,package.json,package-lock.json,vite.config.ts,playwright.config.ts}`.
- `frontend/tsconfig{,.app,.test,.e2e,.node}.json`, Tailwind/PostCSS 설정(존재하는 파일).
- `pyproject.toml`, `uv.lock`, `.python-version`.

호가단위의 ETP 분기는 [한국거래소 ETF 매매절차](https://regulation.krx.co.kr/contents/RGL/03/03060101/RGL03060101.jsp)와
[ETN 매매제도](https://regulation.krx.co.kr/contents/RGL/03/03060201/RGL03060201.jsp)를 확인했다.
백엔드·wire·주문 서비스는 변경하지 않았으며 실계좌 주문은 실행하지 않았다.
