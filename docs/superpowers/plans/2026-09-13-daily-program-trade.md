# 종목 일봉 프로그램 매매 pane

## 요청과 지원 범위

종목 일봉에서 기관·외국인 지표처럼 프로그램 순매수, 총매수, 총매도 수량을 선택한다. 사용자는 일봉 구현을 요청했고 분봉은 가능 여부 검토 대상으로 한정했다.

키움 공식 ka90013 문서: https://openapi.kiwoom.com/m/guide/apiguide/01/ka90013

- `/api/dostk/stkinfo`, `stk_daly_prm_trde_trnsn` 응답 배열, 날짜 `dt`.
- 요청 `stk_cd`는 KRX 종목 코드, `date`는 조회 기준일, `amt_qty_tp=2`는 수량.
- `prm_netprps_qty`, `prm_buy_qty`, `prm_sell_qty`는 모두 주 단위다. 금액 필드는 백만원이며 이번 pane에서 사용하지 않는다.
- 세 값을 같은 응답에서 받으므로 표시 기준 변경은 로컬 선택이며 추가 조회가 없다.
- 공식 명세와 모의 응답으로 검증한다. 실자격증명으로 벤더 결과를 검산하는 작업은 하지 않는다.

## 구현 계획과 결과

1. `daily_program_trade.py`에 파서와 백필을 두고 기존 일봉 배치/누락 구간 캐시 및 당일 TTL을 재사용한다. 각 연속 페이지는 키움 거버너를 통과하고 동시 동일 종목 조회는 직렬화하여 캐시를 재사용한다. 페이지 상한 도달은 완료 캐시로 저장하지 않는다.
2. `/api/live/daily-program-trade`에 Pydantic 응답 모델과 FE 미러를 추가한다. 세 수량을 보존하며 빈 값은 null로 남기고 경고한다. REST 우회는 캐시만 읽는다.
3. `program-daily` pane을 종목 일봉에서만 선택적으로 표시한다. 기본은 꺼짐, 설정 패널 이름은 ‘프로그램 순매수량’. 기존 분봉 `program-trade` pane과 별도 식별자를 사용한다.
4. 매매 기준과 켜짐 상태를 기존 창/타임프레임별 지표 저장 경로에 추가한다. 범례에 선택한 기준, 조회 중/실패/부분 데이터/없음 상태를 표시한다. 설정은 외국인·기관과 독립적이다.
5. 단위 테스트, HTTP 직렬화, 연속 조회·캐시, 브라우저 옵션 변경·재조회 없음·창별 격리·새로고침 복원을 검증한다. 전체 FE/BE 및 Playwright 회귀 검증 후 PR을 머지한다.

## 분봉 검토

분봉 확장도 가능하다. `ProgramTradeByStockRow` 원본과 디스크 sidecar에는 `buy_qty`, `sell_qty`, `buy_amount`, `sell_amount`가 이미 있다. 다만 `ProgramTradePoint` wire와 `build_program_trade_series`, 라이브 tail 투영은 현재 순매수/증감만 전달한다. 총매수·총매도를 지원하려면 저장분의 버킷 마지막 누적값, 0w 라이브 전달, FE tail 병합 및 누적 선 프로젝터까지 함께 확장해야 한다. 과거 파일에서 누락된 값은 순매수만으로 복원할 수 없다. 이번 일봉 구현은 이 분봉 경로를 변경하지 않는다.
