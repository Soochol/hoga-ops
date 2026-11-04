# 키움 실전 묶음 가격정정

키움 실전의 독립 미체결 주문은 검증된 계좌 owner별 최대 2건의 검증·전송을 겹친다.
이는 앱의 보수적인 병행 한도다. 벤더의 동시 처리 보장이나 최적값을 뜻하지 않는다.
모의는 기존 같은 계좌·Code 직렬화와 FE worker 1을 유지한다. 토스 정책은 변경하지 않는다.

## 소유권과 잠금

`BrokerTradingService`가 기존 journal과 명령 수명을 소유한다. 계좌는 실전/모의와 확인한
계좌번호에서 만든 기존 `account_ref`에 고정된다. 같은 계좌의 credential alias는 같은
owner 슬롯과 기존 조회/주문 budget을 공유하고, 다른 계좌는 독립 슬롯을 쓴다.

`KiwoomCodeGate`는 같은 계좌·Code에 FIFO 순서를 부여한다. 실전 정정은 최대 두 명령의
유한한 묶음에 진입한다. 첫 명령의 필수 fresh snapshot에서, 첫 전송 전에 확인한 정확한
주문 신원만 두 번째 명령의 진입 근거로 사용한다. 수량·금액·잔량 검증은 공유하지 않는다.
각 명령은 계좌와 미체결·이력의 모든 페이지를 새로 읽는다. 두 명령이 모두 끝나기 전에는
세 번째 명령으로 자리를 채우지 않는다.

진입 순서는 Code gate, 실전 정정 owner 슬롯, 기존 원주문 lock이다. gate의 상태 변경·신원
공개·해제는 단일 이벤트 루프에서 await 없이 실행한다. 대기자는 mutex를 쥐지 않는다.
신규·취소는 Code에서 배타적으로 검증·전송·결과 기록을 마치며 새 owner 슬롯을 쓰지 않는다.
앞에 신규·취소 또는 합류할 수 없는 주문이 기다리면 뒤의 정정은 이를 추월하지 않는다.

원주문과 확인된 parent/root가 겹치는 주문은 같은 묶음에 합류하지 못한다. 정정 ACK 전에
새로 보인 주문번호는 첫 snapshot에 없으므로 기존 묶음이 끝날 때까지 기다린다. ancestry가
없는 정정 행을 독립 원주문으로 추정하지 않는다. ACK 이후 확인된 lineage와 fresh editable
후속 주문은 새 정정의 대상이 될 수 있다.

## 접수·결과 불명·재시도

ACK는 정정·취소의 접수 번호를 뜻한다. 원주문의 정정 완료를 뜻하지 않는다. 기존 accepted
명령 중 같은 원주문을 대상으로 한 각 operation은, fresh canonical 조회가 그 동작의 정확한
거절을 확인할 때만 원주문의 재시도를 허용한다. 정정은 `REPLACE_REJECTED`, 취소는
`CANCEL_REJECTED`이며 operation ID·원주문 관계·거래일·route도 맞아야 한다. 해당 operation이
OPEN에 남아 있으면 이력의 거절을 재시도 근거로 사용하지 않으며, 동일 ID의 모든 이력 행이
서로 일치해야 한다. 성공 확인,
누락, pending, 다른 동작의 거절은 원주문을 다시 전송할 근거가 아니다. 이 검사는 journal에
남은 accepted 기록을 사용하며 별도의 ACK 기반 영구 폐기 상태를 만들지 않는다.

같은 operation이 성공으로 보인 뒤 나중에 모순된 거절로 바뀌는 경우의 단조성은 새로
보장하지 않는다. 그 계약이 필요하면 canonical 성공의 별도 영속 근거가 필요하다.

신규·정정의 결과가 불명확하면 새 working native가 생겼는지 알 수 없다. 이때 새로 진입한
실전 정정·취소는 같은 Code의 해당 unresolved 요청을 먼저 확인해야 한다. 이미 진입한
독립 두 번째 명령은 기존 신원 근거로 완료할 수 있다. 결과 불명 취소는 새 working native를
만들지 않으므로 다른 독립 취소를 Code 전체에서 막지 않는다. 같은 원주문의 불명확한 요청과
신규 주문의 기존 Code 전체 차단은 그대로다. 기존 수동 확인은 원요청을 재전송하지 않는다.

prepared/SENDING/accepted/rejected/unknown 기록과 중복 명령 공유를 유지한다. 모든 결과는
Code 등록·슬롯·원주문 lock을 해제하기 전에 기록한다. HTTP 대기자 취소는 owned task를
취소하지 않는다. owned task 자체가 취소되면 미전송은 rejected, SENDING 이후는 unknown으로
기록하고 자원을 해제한다. 종료는 기존 명령과 전체 취소의 하위 명령을 drain한 뒤 gateway를
닫고, 새 외부 키움 명령은 받지 않는다.

## 조회·기한·화면

10초는 전송 전 admission 기한이다. gate·슬롯·원주문 lock과 필수 조회 대기를 포함한다.
정정·취소의 계좌 확인과 snapshot 각 페이지에 같은 절대 기한을 전달한다. 기한이 지난 뒤
추가 페이지나 전송을 시작하지 않는다. 이미 시작한 bounded read는 끝날 수 있고, 기한 내
전송한 주문의 ACK는 이후에 올 수 있다. 전송 후 timeout은 결과 불명이며 자동 재전송하지 않는다.
전송 직전 observed fill/잔량 재검사와 SENDING commit도 유지한다.

조회/주문 budget과 모의 동일 TR 간격을 바꾸지 않는다. [키움 공식 소개](https://openapi.kiwoom.com/intro?dummyVal=0)는
국내 계좌·토큰의 주문/조회 각각 초당 5회와 모의 같은 TR 초당 1회를 안내한다. 이 값은
in-flight 한도가 아니다. [공식 API 정의](https://raw.githubusercontent.com/Kiwoom-Securities/Kiwoom-REST-API/953e5dbff123f437ab4d11a78a95191a685eb51f/kiwoom/_data/kiwoom_api_spec.json)의
kt10002는 원주문 하나를 정정한다. 한 동작으로 묶어도 각 주문의 접수 시점과 결과는 다를 수 있다.

FE는 explicit 키움 실전 metadata에만 worker 2를 적용한다. 모의·환경 미확인은 1이며
토스의 numeric legacy fallback은 그대로다. 하위 command ID·부분 실패·재시도·한 번의 접수음·
계좌별 refresh pause를 유지한다. 키움 WS는 invalidation이며 실제 수량·가격은 canonical
REST 확인으로 반영한다. 응답 10건이 끝났어도 REST가 일부만 반영하면 확인된 수량만 표시한다.

## 검증 경계

실제 FastAPI→명령 엔진→fake gateway 및 production FE build→Chrome의 mock HTTP/WS로
첫 ACK 보류와 유한 병행을 확인한다. 같은 입력의 부모/변경 버전, production pace와 제한 0의
인과 실험을 구분한다. 호출 수·페이지 완전성·journal 결과·canonical 사다리 반영을 함께 확인한다.
실계좌 API·토큰·운영 서버를 사용하지 않으며 합성 RTT로 실사용 개선 초수를 예측하지 않는다.

회귀는 `tests/unit/api/test_kiwoom_amend_concurrency.py`와 기존 키움 검증기,
`frontend/tests/e2e/live-orders.spec.ts`의 묶음 가격정정 시나리오에 있다.
