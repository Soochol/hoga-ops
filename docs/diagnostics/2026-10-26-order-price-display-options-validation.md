# 호가주문 가격 표시 옵션 검증

- Base / 최종 fetch한 main: `74ca9c97ea70ec3d7fed1a83f3f8430524c3fd43`.
- 검증: 2026-10-26 KST, 이 base 위의 작업 파일. 기존 주문창 설정에 boolean 두 개를
  추가했으며 백엔드·wire·주문 처리 로직은 변경하지 않았다.
- `호가 가격 구분선`: 기본 false, 중앙 가격·등락률 열에 테마 `--border`의 1px 선.
- `호가 등락률 표시`: 기본 true, false이면 숫자·숨은 샘플 열·폭 예약을 함께 제거한다.
- 창별 즉시 반영·저장, 구 저장값 보완, 명시적 false 유지. 일반/전체 호가 모두 적용한다.

## 검사와 결과

`frontend/`에서 실행:

```sh
npm run typecheck
npx tsc -p tsconfig.e2e.json --noEmit
npx vitest run src/state/orderWindowSettings.test.ts src/state/workspace.test.ts src/live/workspace/OrderWindow.test.tsx src/live/workspace/useBookPriceLayout.test.ts
npx playwright test tests/e2e/live-orders.spec.ts --grep '호가 표시 옵션은|등락률 숨김은|전체 호가|호가주문 금액은|주문 설정은 즉시|평단가 표시 체크박스|호가주문 고정 열|호가주문 67200원|호가주문 1469000원' --reporter=list
```

- 앱·단위·E2E TypeScript 검사 통과. 마지막 E2E 단언 수정 후 E2E 타입 검사도 통과.
- Vitest 4개 파일 / 227개 통과.
- Playwright 11개 통과. 서버 기동 단계의 Vite production build 통과.
- `git diff --check` 통과.
- 구분선의 실제 그림자, 24px 행, 등락률 DOM 제거와 가격열 축소, 숨김/복원 시 폭,
  큰 가격·평단가 칩의 범위 내 표시, 현재가 강조, 두 테마, 새로고침 복원과 다른 주문창의
  기본 설정 독립성을 확인했다. 등락률 숨김 상태에서 동일 가격·수량의 주문 요청도 확인했다.
- 설정 팝오버 스크린샷을 확인했으며 기존 항목 뒤에 두 토글이 순서대로 표시된다.

실행 환경은 Node v24.13.1, npm 11.8.0, TypeScript 6.0.3, Vitest 4.1.7,
Vite 8.0.16, Playwright 1.60.0, 시스템 Chrome 156.0.8078.47, Python 3.14.7이다.
워크트리 슬롯 378의 포트 20378/21378과 전용 데이터·dist를 사용했다. workers=1과
빈 벤더 자격증명을 유지했고 시세·주문을 모킹해 실계좌 주문은 실행하지 않았다.

## 입력 지문

SHA-256 `d2dfb03c6e0c1c24ec6102ecc707ceebbbb7223951d5587d8e39cec957ac00b3`, 2,267개 경로.

`2026-10-26-full-price-order-ladder-validation.md`와 같은 방식으로 전체 FE 소스·테스트·
플러그인·public, backend 소스, tiny_tsv_multi 픽스처, package/lockfile 및 TS/Vite/
Playwright/Tailwind/PostCSS 설정과 Python 환경 정의를 포함했다. 정렬한 각 경로의
`UTF-8 경로 + NUL + SHA-256(파일 바이트)`를 이어 붙여 SHA-256을 계산했다.
이 진단 문서는 실행 입력에 포함되지 않는다. PR head의 입력이 일치하면 위 통과
결과를 재사용하며 검증 후 실행 입력이 바뀌면 영향을 받는 검사를 다시 실행한다.
