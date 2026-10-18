# 토스·키움 호가주문

호가주문 창의 **주문 계좌**에서 증권사와 실전/모의 계좌를 선택한다. 토스의 기존
신규·정정·취소·전체 취소는 같은 명령 엔진을 사용하며 구 API도 유지한다.
키움은 국내 현금 지정가 신규 주문, 잔량 전체 정정·취소, 계좌 미체결·이력·잔고를 지원한다.
화면의 시세 거래소와 주문 거래소는 독립적이다. 정정·취소는 원주문에 저장된 거래소를 따른다.

## 인증과 기본 동작

- 실전: 기존 `KIWOOM_APP_KEY` / `KIWOOM_APP_SECRET`, 두 번째부터 `_2`, `_3` 순서.
- 모의: 별도의 `KIWOOM_MOCK_APP_KEY` / `KIWOOM_MOCK_APP_SECRET`, 같은 번호 규칙.
- 실전 `api.kiwoom.com`, 모의 `mockapi.kiwoom.com`으로 고정한다. 모의 키가 없으면 실전으로 대체하지 않는다.
- 기존 런타임 토큰 소유자를 공유한다. 모의 토큰 캐시는 별도 파일과 환경 태그를 사용한다.
- `ka00001`로 확인한 실제 계좌를 불투명한 `account_ref`에 영속 연결한다.
  같은 인증 별칭이 다른 실제 계좌를 가리키면 주문을 차단한다.

**키움 주문은 기본 비활성화다.** 연결된 계좌는 조회할 수 있다. 현재 구현·테스트 과정에서
실계좌 주문을 보내거나 활성화 파일을 생성하지 않았다. 로컬 가짜 응답 테스트는 벤더의
실제 주문 수용·정정 연결·NXT/SOR 운용을 증명하지 않는다.

실제 수용 검증을 마친 운영자는 해당 계좌·환경·거래소의 증거를 확인한 후 데이터 디렉터리의
`trading/kiwoom-acceptance.json`에 기록한다. 이 파일은 앱이 자동 생성하지 않는다.
형식은 다음과 같다. 아래 값은 예시이며 실제 계좌에 사용하지 않는다.

```json
{
  "schema_version": 1,
  "accounts": {
    "acc_00000000000000000000000000000000": {
      "environment": "mock",
      "routes": ["KRX"],
      "verified_at": "2026-10-19T10:00:00+09:00",
      "evidence": "수용 검증 보고서 경로 또는 식별자"
    }
  }
}
```

계좌·환경이 맞지 않거나 형식·검증 시각·증거가 없으면 활성화하지 않는다.
모의는 KRX만 허용한다. 실전은 수용 검증을 마친 KRX/NXT/SOR만 개별 허용한다.

## API와 영속 기록

새 계약은 `/api/trading/v2`다. `/accounts`, `/state`, `/account-orders`, `/holdings`는 조회다.
`POST /orders`, `/orders/{order_ref}/modify`, `/orders/{order_ref}/cancel`, `/cancel-all`은
`X-Hoga-Order: 1`, `account_ref`, `command_id`, `code`가 필요하다. 신규에는 `route`도 필요하다.
명령 상태 조회는 `GET /commands/{command_id}?account_ref=...`다.

`account_ref`는 계좌, `order_ref`는 영업일을 포함한 주문, `operation_ref`는 정정·취소 접수다.
키움의 7자리 번호는 앞자리 0을 보존한다. 전일 주문 참조로 당일의 같은 번호를 변경할 수 없다.
화면은 키움의 명시적 잔여수량을 사용하고 불명확한 체결수량·여력은 `null`로 유지한다.
동일 종목의 현금 잔고 행은 합산하고 신용 잔고와 거래소별 중복 잔고를 합치지 않는다.

명령은 기존 `trading/commands.sqlite3` 저널을 공유한다. 전송 전 `prepared → sending`을
커밋하고 쓰기는 한 번만 시도한다. 응답 유실·잘못된 접수·전송 후 기록 실패는 `unknown`으로
남긴다. 재시작·동일 명령 재조회·대기자 취소가 재주문을 만들지 않는다. 수동 확인은 시각을
남기고 차단만 해제하며 원요청을 재전송하지 않는다. 계좌·주문 참조는 별도 `accounts.sqlite3`에 보관한다.

키움 `00`/`04`는 기존 시세 WebSocket 소유자를 공유하되 별도 큐와 수집기 제어 채널을 사용한다.
큐 초과는 연결을 종료하고 REST 대조를 유도한다. 이벤트는 계좌를 검증해 조회를 무효화하며,
불완전한 이벤트만으로 최종 체결을 추정하지 않는다. REST는 연결 계좌를 고정하고 기존 시세와
공유하는 호출 예산을 적용한다. 주문 대기 만료와 전송 후 타임아웃은 구별한다.

## 외부 주문 없는 재현 검증

```sh
python scripts/run_kiwoom_trading_validation.py -q
cd frontend
npm run typecheck
npm run test -- --run --maxWorkers=3 src/api/trading.test.tsx src/api/tradingOrderEvents.test.ts src/live/workspace/OrderWindow.test.tsx src/live/workspace/AccountTradingPanel.test.tsx src/live/workspace/useOrderQuantity.test.ts src/live/workspace/orderReceiptSound.test.ts src/state/orderWindowSettings.test.ts
npx playwright test live-orders.spec.ts --reporter=line
```

Python 검증기는 인증 환경변수·`.env` 재로딩을 차단하고 프로세스의 외부 TCP 연결을 금지한다.
WebSocket 검증용 루프백은 허용한다. OS 전체 방화벽은 아니다. 브라우저 주문 테스트는 HTTP/WS
가짜 응답을 사용하며, Playwright 서버도 실전·모의 인증정보를 비워 시작한다.
워크트리에서 독립 실행할 때는 빈 `.env`로 메인 체크아웃 설정 상속을 막는다.
