# 호가주문 금액 줄바꿈 수정 검증

- Base: `714c92ebbda983f045c0db0d47f92882213284ab` (PR #2293).
- 원인: 전체 호가 버튼이 더해진 입력 줄에서 금액 값의 고정 `18ch` 폭과 flex 줄바꿈이
  함께 남아 금액을 다음 줄로 보냈다.
- 수정: 금액 값은 실제 내용 폭과 오른쪽 정렬을 사용하고 입력 줄은 줄바꿈하지 않는다.
  560px 미만에서는 그룹 간격을 2px로 압축한다. 실제 내용이 넘을 때만 입력 줄 안에서
  가로 스크롤하며 숫자를 생략하지 않는다.

## 최종 검증

2026-10-26 KST, `frontend/`에서 다음을 실행했다.

```sh
npm run typecheck
npx playwright test tests/e2e/live-orders.spec.ts --grep '호가주문 금액은|전체 호가|576px 압축형|넓은 창은 상세|호가주문 고정 열|주문창 반응형 간격' --reporter=list
```

- 세 TypeScript 프로젝트 검사 통과.
- Playwright 8개 통과. E2E 기동 단계의 Vite production build도 통과.
- 수량/금액 프리셋 모두 696·576·560·504·420·360px에서 입력·버튼·금액의 세로 중심이
  일치한다. 504px 이상에서는 기본 수량의 전체 내용이 가로 스크롤 없이 보인다.
- 아주 좁은 창의 긴 금액(`67,200,000,000,000원`)은 줄바꿈·생략 없이 가로 탐색한다.
- 전체 호가 신규 주문·정정·현재가 복귀와 기존 고정 열·반응형 배치 검사를 통과했다.
- 기존 전체 호가 E2E는 모의 주문 요청을 관측한 뒤 처리 중 잠금이 해제되기 전에
  End 키를 누르던 경쟁 상태가 있어, 버튼 재활성화를 기다린 후 다음 조작을 수행한다.
- CSS와 E2E/설명만 변경했다. 주문 로직·wire·백엔드는 변경하지 않았다.

Node v24.13.1 / npm 11.8.0 / TypeScript 6.0.3 / Vite 8.0.16 / Playwright 1.60.0 /
시스템 Chrome 156.0.8078.47 / Python 3.14.7. 슬롯 378의 격리된 포트·데이터와
기존 빈 자격증명, workers=1을 유지했다. 실제 주문은 전송하지 않았다.

## 입력 SHA-256

나머지 소스·픽스처·검증 설정은 위 base와 같다. 아래 최종 입력으로 검증했으며
PR head와 동일한 해시를 확인한 뒤 결과를 재사용한다.

| 파일 | SHA-256 |
| --- | --- |
| frontend/src/live/workspace/OrderWindow.css | 68ad8288b5714c92ed86d335cd0a6682eb15118e3b4dfd08f4e406665b156779 |
| frontend/tests/e2e/live-orders.spec.ts | 9435bef34c45a7cc65a72264c4766e88142e1b5607c71469b29e2058ef2cf21b |
| frontend/package-lock.json | bc691053d9524b4732fa741dfd3f2bafa10fd18afa73eb7f1e147dcdbd8ece76 |
| frontend/playwright.config.ts | 96fbc6be03ae9d24c9eb3f247ae0b8c014da9e4b150477600c9177f7bd556911 |
| frontend/vite.config.ts | d20f8e0008a370e5df6b97bb20135ffd418e1ad7c67a53dc3883777a37202244 |
