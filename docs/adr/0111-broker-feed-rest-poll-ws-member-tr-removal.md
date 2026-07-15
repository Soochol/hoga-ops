# 0111 — 거래원(회원사) 피드 WS→REST 전환: WS 등록 여유로 계좌당 13→19종목

**Status:** accepted (2026-07-15)

**Related:**
- ADR-0101 (WS 등록 상한 41 + venue 스왑 순서) — 이 결정이 바꾸는 산식의 전제. 연결당 등록 상한 41(실측)·예산 39가 종목당 TR 수에 나뉘어 계좌당 종목 수가 나온다.
- ADR-0067 (Live Coverage: WS 저장 + REST 표시 분리) — REST 폴러가 WS 세션 밖 lifecycle 소유라는 패턴의 원류. BrokerRestPoller가 rest_poller의 소유/생명주기를 미러한다.
- ADR-0099/0102 (rest30 REST 폴러 골격) — 벽시계 정렬 사이클·거래일 게이트·코드별 격리·EGW00201 바운스 관측 패턴의 원본.
- ADR-0100 (앱키별 독립 토큰버킷) — REST 예산 산식(계좌당 ~15/s)의 근거.
- `hoga/live/broker_rest_poller.py` (신규 구현), `hoga/live/ws_fields.py` (TRS_KRX), `hoga/live/coverage.py` (사이징 파생).

## Context

KIS WebSocket은 연결당 등록 상한 41(OPSP0008 실측, ADR-0101)이고, 종목 하나가 실시간 TR 3개
(호가 H0STASP0 · 체결 H0STCNT0 · 거래원 H0STMBC0)를 소비해 계좌당 `39//3 = 13`종목이 한계였다.
4계좌 운영에서 `13×4 = 52`종목. 관심종목이 이를 넘으면 rest30(REST 30초)로 밀려 실시간성이 떨어진다.

거래원(회원사) 데이터는 성격상 REST 대체가 가장 안전한 스트림이다:
- 이미 다운샘플러에서 **10초 창당 마지막 값(last-wins) + carry-forward**로 축약 저장된다
  (`downsampler.py`). 즉 WS로 받아도 저장 해상도는 이미 10초다 — per-tick이 아니다.
- 거래원등장(late-entry) 마커 검출은 백엔드가 **저장된 `brokers.parquet`**를 스캔한다
  (`tables/brokers.py` `query_late_entry_events`) — 라이브 틱이 아니다.
- REST `fetch_brokers`(FHKST01010600, inquire-member)가 이미 구현되어 있고(표시폴러 ADR-0067),
  WS `H0STMBC0`와 동일한 top-5 매수/매도 스냅샷을 반환한다.

호가·체결은 per-tick 정보가치가 커 REST 샘플링 손실이 크지만, 거래원은 "상위 5 스냅샷"이라
이벤트 손실 개념이 약하다 — KIS가 NXT용 거래원 TR을 아예 만들지 않은 것과 같은 이유다.

## Decision

거래원 TR(`TR_MEMBER = H0STMBC0`)을 WS 구독 집합 `TRS_KRX`에서 제거하고, 그 피드를 신규
`BrokerRestPoller`(REST `fetch_brokers` 폴링, 30초)로 대체한다.

**용량 효과**: 종목당 TR 3→2 → 계좌당 `39//2 = 19`종목(구 13). 4계좌 `19×4 = 76`종목(구 52, +24).
`_PER_ACCOUNT_MAX`·`LIVE_SET_MAX_CODES`·파티션·live_set 절단은 `TRS_KRX` 튜플에서 원소 하나 빼면
`len(TRS)` 파생으로 전부 자동 보정된다(사이징 단일 진실원, ADR-0101). NXT는 원래 거래원 미구독
(2 TR)이라 venue 스왑 worst-case도 종목당 2로 줄어 상한 41 안에 여유가 더 생긴다.

**아키텍처(소비자 무변경 계약)**: 폴러는 `fetch_brokers` 결과를 `ws_frames._parse_member`와
byte-identical한 합성 `WsTick(kind=BROKER, venue="KRX")`로 만들어 스트림의 `on_tick`에 주입한다.
데이터가 LiveBuffer 표시 → 다운샘플러(BROKER last-wins) → JSONL(live root) → promote →
`kis_live/brokers.parquet`의 **기존 파이프라인을 그대로** 타므로 `/api/brokers/series`·거래원등장
마커·사이드바 카드 등 소비자는 한 줄도 바뀌지 않는다. payload 키 순서(`code, t_ms, sell_top,
buy_top`)까지 `_parse_member`와 일치시켜 저장 JSONL이 byte-identical함을 특성화 테스트로 실증한다.

**소유·생명주기**: rest_poller와 동일하게 lifecycle이 직접 소유(WS 세션 밖). start/refresh가
live_set을 확정한 직후 `set_targets(live_set)`로 동기화, stop/`kis_rest_bypass_enabled`에서 정지.
`ScheduledLiveRestCaptureClient(source="live-broker-poller")`로 KIS Capacity Scheduler에 background
우선순위로 제출 — user-visible 호가/캔들에 양보한다. 코드→계정 소유는 폴러에 복제하지 않고
전 스트림(≤4개)에 브로드캐스트하며, 각 스트림의 활성집합 필터가 소유 스트림 1개로 라우팅한다
(파티션 disjoint + refresh Pass 0 원자 스왑 → 이중 수락 레이스 없음, 이중-write 방지 불변식과 동일 근거).

**게이팅(WS 파리티)**: 거래일(캘린더 SSOT `is_trading_day_now`) && `target_ws_venue == "KRX"`
(08:50–15:31). 거래원 TR은 KRX 전용이라 WS 시절에도 이 창에서만 프레임이 도착했다. 저장 컷오프
(정규장 09:00–15:30)는 스트림의 `_gate_open`이 자동 처리한다 — 08:50–09:00·15:30–15:31 폴 결과는
표시만 되고 저장 안 됨(WS member 프레임과 동일).

**폴링 주기 30초**: 76종목@30s = 2.5 req/s(4키 합산 ~53/s의 5%). 10초(다운샘플러 해상도 일치)도
후보였으나 REST 예산 절약을 우선해 30초 채택. 트레이드오프: 거래원등장 마커 검출·사이드바 갱신의
시간 해상도가 최대 30초(구 WS는 사실상 10초). 30초 사이에 top-5에 등장했다 사라진 거래원은
저장·검출되지 않는다 — 수용된 손실.

## Rollout & Rollback

2단계 배포(별도 커밋):
1. **PR① — 폴러 추가(enabled)** → WS+REST 이중 공급. 다운샘플러 last-wins라 저장 안전. 유일한
   일시 현상: 사이드바 라이브 카드가 클라이언트 집계 시 WS 원본명 vs REST 정규화명을 잠깐 두 행으로
   표시 가능(정규화 비대칭 — 저장 parquet/series는 query-time 정규화라 무해). 검증 창 한정.
2. **PR② — TR_MEMBER 제거** (≥1거래일 실검증 후). live_set 19/계좌로 확대.

롤백: PR②만 revert하면 `TR_MEMBER`를 `TRS_KRX`에 다시 넣어 WS 피드가 되살아난다 — 파서
(`_parse_member`)·필드 인덱스(`MBC_*`)·`_TR_VENUE` 항목을 전부 보존했기 때문. PR①은 폴러 배선만
제거. 런타임 토글(LiveSettings)은 두지 않는다 — 토글은 REST를 끌 수만 있고 WS TR 복원은 어차피
코드 revert라, 2단계 배포가 안전장치로 충분하다.

## Consequences

- **긍정**: 계좌당 13→19종목(4계좌 52→76). 거래원 데이터가 WS 재연결 중에도 살아남는다(폴러가 WS
  전송과 독립 — flush 루프가 별도). 관측: `/api/live/status`의 `broker_poll_*` 필드.
- **부정**: 거래원 실시간성이 sub-second push → 30초 샘플로 하락. 순간 등장 미검출 가능. REST 예산
  +2.5 req/s(히트맵 500종목 풀가동과 겹치면 ~57.6/s > ~53/s로 사이클 신축 — 백그라운드 우선순위라
  우아하게 저하, `broker_poll_last_cycle_ms`로 관측).
- **정규화 비대칭**(기존 상태 유지): WS 경로는 원본명, REST `fetch_brokers`는 fetch 시점 정규화명을
  저장한다. 저장 스키마·쿼리(series/late-entry/cursor)가 query-time에 재정규화하므로 다운스트림 출력은
  동일하다. 전환 후 라이브 경로도 정규화명 유입 — 역사 데이터의 원본명 시대와 query-time 정규화가 공존.
