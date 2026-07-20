# 키움 0F(거래원)·0w(프로그램매매) 실시간 전환 — ADR-0118 PR-F 실행 플랜

- 날짜: 2026-07-20
- 선행: [2026-07-20 T2 실채록](../research/2026-07-20-kiwoom-0f-0w-t2-capture.md) —
  스모크 정방향, PR-F 언블록. 골든 픽스처
  `tests/fixtures/kiwoom_t2/golden_frames_20260720.json` (0B 3 · 0F 5 · 0w 5),
  원본 5.6MB jsonl(0F 24건 · 0w 205건).
- 관련: ADR-0111(거래원 REST 30s 컷오버 — 이번에 되돌린다), ADR-0118(브로커 완전
  특화 — 마지막 남은 조각이 이 PR-F).

## 목표

거래원·프로그램매매의 **출처**를 KIS REST 폴링에서 키움 WS push로 옮긴다.
전달 통로는 이미 키움 스트림이다(ADR-0111이 합성 WsTick으로 주입) — 바꾸는 건
그 틱을 만드는 쪽뿐이므로, 하위 소비자(버퍼·표시·저장)는 무변경이 원칙.

| | 현재 | 전환 후 |
|---|---|---|
| 거래원 | KIS REST 30s · 계좌당 19종목(ADR-0111) | 키움 0F push · 저장셋 전 종목 |
| 프로그램매매 | KIS REST(`fetch_program_trade_by_stock`) | 키움 0w push |
| KIS 유량 | 거래원·프로그램이 소모 | 캔들·지수로 환원 |

## 왜 지금인가

- 스모크가 오늘 끝났다: 5종목 전부에서 0F(각 4~5회/5분)·0w(각 38~43회/5분) 유입 확인.
- 구독 비용이 0이다: 키움 한도는 **종목 단위**(연결당 200종목, 타입무관 — 2026-07-16
  실측). 이미 구독 중인 종목에 타입만 추가하는 것이라 슬롯을 더 먹지 않는다.
- 같은 세션에서 0B additive 확장(prev_close·OHLC) 패턴과 parity 테스트 규율을 이미
  깔아뒀다 — 0F/0w는 같은 틀에 얹는다.

## 단계

의존성: F1 → (스모크 게이트) → F2, F3 → F4. F1과 F3은 병렬 가능.

### PR-F1 — 0F 파서 + 구독 (바로 가능)

1. `kiwoom_fields.py` — 0F FID 상수. 채록 확정분만:
   - 매도 1~5위: 이름 141–145 · 누적수량 161–165
   - 매수 1~5위: 이름 151–155 · 누적수량 171–175
   - **미소비**: 146–160(회원사 코드) · 166–180(증감) · 261–268 · 271–285(외국계,
     의미 미확정 `"!!!!"` 센티넬) · 337. 소비 필드를 넓히는 건 후속 — 처음은
     BROKER 계약 shape-compat 최소만.
2. `kiwoom_frames.py` — `_parse_member`: 0F → `SnapshotKind.BROKER`.
   - **payload 계약**(rest_buffer_build.brokers_to_snapshot 과 byte 동일):
     `{code, t_ms, sell_top[{name,qty}], buy_top[{name,qty}], phase?}` —
     phase 는 stream.on_tick 이 덧붙이므로 파서는 나머지만.
   - **t_ms = now_ms(수신 시각)**: 0F 채록 프레임에 시각 FID가 없다. REST 합성
     경로도 수신 시각을 쓰므로 규약 일치. `parse_real_row` 의 미사용 `now_ms`
     파라미터가 드디어 소비된다.
   - 골든테스트: 픽스처 0F 5건. 상위 5 미만인 프레임(빈 슬롯) 처리 확인.
3. `kiwoom_ws_client.py` — `DEFAULT_TYPES = ("0B", "0D", "0F")`.
   - REG 는 타입 리스트 1회 전송이라 REG 유량(5/s) 부담 없음.
4. 유닛: parity 테스트에 BROKER payload 키 셋 고정 추가(0B 와 동일 규율).

### 스모크 게이트 (F1 머지 전, 장중 필수)

워크트리 백엔드 스왑(이 세션에서 2회 검증된 절차) 후:

- [ ] 0F 프레임이 스트림에 도착, BROKER 틱으로 파싱되는지
- [ ] `/api/ws` 로 broker kind 프레임이 나가고 거래원 카드가 갱신되는지
- [ ] **타입 추가 후 킥·슬롯 재확인**: 2계정 connected 유지, subscribed_count 불변
- [ ] REST 폴러와 0F 가 공존하는 동안 표시 이중화 없는지(같은 BROKER kind 로
  버퍼에 섞임 — 최신 우선이라 무해 예상, 실측 확인)

주의: 실측상 0F 는 종목당 ~60초 간격이다(REST 30초보다 **덜** 빈번). 거래원 집계
자체가 느린 데이터라 실효 신선도는 동급이고, push 라 갱신 시점 즉시 반영이 장점.
"실시간 전환 = 더 자주"가 아님을 기대치로 명시해 둔다.

### PR-F2 — BrokerRestPoller 컷오버 (게이트 통과 후)

1. `lifecycle.py` — `_ensure_broker_poller` 배선 제거, `broker_rest_poller.py` 삭제.
   ADR-0118 규율대로 칼 컷오버·fix-forward(병행 운영 기간 없음).
2. `live_rest_capture_access.py` — fetch_orderbook/fetch_trades 는 이미 죽은 코드로
   확인됨(이 세션 조사). fetch_brokers 소비가 사라지면 모듈째 삭제 검토.
3. KIS `fetch_brokers`·`LIVE_BROKERS` 엔드포인트 enum — 호출처 0 확인 후 제거.
4. 확인: 계좌당 19종목 제한(ADR-0111)이 사라지므로 거래원 커버리지가 저장셋
   전 종목으로 확대된다 — 문서(ADR-0111 상태 갱신)에 명시.

### PR-F3 — 0w 수급 FID 확정 연구 (파서 선행 조건, F1 과 병렬 가능)

**최대 리스크 지점.** 0w 의 202/204/206/208/210/212(매도/매수 수급 계열 추정)와
211/213(미확정)은 채록 문서가 "시계열 대조로 확정할 것"이라 명시했다.

- 원본 205건으로: (a) 202−204=순매수 검산, (b) KIS 프로그램 REST 응답과 동시각
  대조, (c) 금액/수량 쌍 판별(자릿수·틱사이즈 배수).
- 산출물: research 문서 갱신 + FID 확정표. **확정 실패 필드는 파서에서 미소비** —
  0B 의 FID 12 를 안 쓰는 것과 같은 규율(추정값을 화면에 올리지 않는다).
- 20/10/11/12/13 은 0B 와 동일 의미로 이미 확정 — 이것만으로도 최소 파서는 가능.

### PR-F4 — 0w 파서 + 컷오버 (F3 완료 후)

1. 소비 경로가 0F 와 다르다: 프로그램매매는 표시 버퍼가 아니라
   **program_trade_store → `/api/range` 번들**로 흐른다. 따라서:
   - `_parse_program`: 0w → 새 kind(가칭 `SnapshotKind.PROGRAM`) 또는 파서 밖에서
     store 직행 — stream.on_tick 에서 store ingest 배선(FILL/피크 ingest 와 동형).
   - `/api/range` 응답 shape 는 불변(소비 프론트 무변경).
2. `DEFAULT_TYPES` 에 "0w" 추가.
3. KIS `fetch_program_trade_by_stock`·`PROGRAM_TRADE` enum 소비 제거.
4. 스모크: range 번들의 program_trade 포인트가 장중 실시간으로 자라는지 +
   KIS 최종값과 EOD 대조.

## 리스크와 완화

| 리스크 | 완화 |
|---|---|
| 0w FID 매핑 오판 → 틀린 수급 표시 | F3 확정 연구 선행, 미확정 필드 미소비. F4 는 F3 게이트 뒤 |
| 앱키당 세션 1 — 스모크가 운영 연결 킥 | 유휴 키(`KIWOOM_APP_KEY_3`)로 별도 채록, 운영 스왑은 F1 게이트 때만 |
| 8050 유동 IP 토큰 락(발급 실패 ≠ conn dead) | 아침 발급 토큰 재사용 규율 유지, 스왑 시 status 로 connected 확인 |
| 타입 추가가 실은 슬롯을 먹는 경우(실측 반례) | 게이트 체크리스트에 subscribed_count 불변 확인 포함, 반례면 F1 rollback 후 재설계 |
| 0F 상위5 미만·빈 거래원 프레임 | 골든테스트 + `_signed_opt` 류 방어(선택 필드가 필수 경로를 죽이지 않는다) |
| 장외 시간대 0F/0w 무발화 | 당일 집계 데이터라 장외 갱신 무의미 — 마지막 값 유지가 올바른 동작. 컷오버 후 장외 빈 화면 회귀만 확인 |

## 하지 않는 것

- 0F 의 증감(166–180)·외국계(261–285)·회원사 코드 소비 — 표시 요구가 생기면 후속.
- 0w 의 미확정 FID(211/213) 소비.
- KIS 캔들·지수·투자자·검색·거래일 경로 — 이 플랜 범위 밖(ADR-0118 절단선 유지).
- quotes 10초 폴링 변경 — 주기 유지 결정(2026-07-20 세션).
