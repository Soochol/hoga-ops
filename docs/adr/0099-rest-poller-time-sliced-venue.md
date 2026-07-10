# 0099 — REST 표시 폴러 시분할 venue (WS 미러)

**Status:** accepted (2026-07-11)

**Related:**
- ADR-0067 (rest_poller = 보는 종목 표시 폴러, 디스크 저장 없음) — 이 폴러에 시분할 venue를 얹는다.
- ADR-0096 (통합 venue 하이브리드) · #524/#525 (WS 시분할 구독: 정규장 KRX / 장전·장후 NXT) — REST가 미러하는 원본 정책.
- ADR-0098 (REST 호가 전용 통일) — 호가 1콜 전제를 상속(체결·거래원은 여전히 WS 전용, 시분할 비대상).
- `hoga/live/rest_poller.py`(게이트+스레딩) · `hoga/live/kis_endpoints.py:1017`(per-call div) · `hoga/live/live_rest_capture_access.py:37`(프록시 key) · `hoga/live/rest_buffer_build.py:19`(venue 태그).
- `hoga/live/session_gate.py:100,135` `ws_connection_window`/`target_ws_venue` — 재사용하는 시간·venue 정책의 단일 진실.

## Context

WS(관심종목)는 연결 창(거래일 08:00–20:00) 안에서 시분할 구독한다 — 08:50–15:31 KRX, 그 외(장전 08:00–08:50, 장후 15:31–20:00) NXT(#524). 반면 REST 표시 폴러(`LiveRestPoller`, 2초)는 `fid_cond_mrkt_div_code`가 모듈 상수 `"J"`(KRX) 고정이고, `market_phase=='closed'`(정규장 09:00–16:00 밖) 게이트로 종목당 1회 스냅샷 후 정지한다.

결과: 장전·장후에 관심종목(WS)은 NXT 호가가 실시간 갱신되는데, REST 종목(보는 종목 스필오버·히트맵)은 화면에서 멈춘다 — 같은 화면 안의 비대칭.

KIS 호가 REST(`FHKST01010200`)가 `fid_cond_mrkt_div_code` J/NX/UN 3종을 모두 수용함은 실측 확정(2026-07-11, J≠NX 별개 호가장). 파라미터 차원의 선결 미지수는 해소됐다.

## Decision

**표시 폴러(`LiveRestPoller`)만 WS 시분할 정책을 미러한다 — 저장 레코더(`Rest30sRecorder`)는 불변(저장은 정규장 KRX만, WS 저장 정책과 이미 파리티).**

1. **활성 창 게이트.** `_poll_once`에서 `ws_connection_window`(거래일 08:00–20:00)를 재사용해 창 안이면 매 사이클 폴링 + `target_ws_venue`로 시분할 venue 선택, 창 밖이면 기존 `market_phase` closed-once 게이트 유지. `ws_connection_window`는 캘린더 캐시 미스 시 동기 KIS HTTP가 가능한 blocking 계약이라 `asyncio.to_thread`로 봉인한다(`KisWsClient gate_fn` 패턴 미러). 예외는 `_run_loop`의 사이클 격리가 흡수.
2. **venue는 default-`"KRX"` kwarg로 스레딩.** `fetch_orderbook(code, *, venue)` — 엔드포인트에서 `kis_venue_div(venue)`로 div 계산, 프록시는 venue를 실호출과 코얼레스 key에 함께 전달. 미지정 호출부(레코더·체결·거래원)는 바이트 단위로 동작 불변.
3. **표시 스냅샷 venue 태그(optional).** `ob_to_snapshot(..., venue=None)` — 값이 있으면 payload에 `"venue"` 키를 실어 WS 경로(`stream.py`)와 동일 shape으로 프론트 venue 매칭(`liveVenueAllowsTradeOverlay`)이 동작. `None`(레코더)이면 키 자체를 안 넣어 디스크 JSONL 스키마 불변.
4. **phase taxonomy 불변.** WS 표시 경로도 같은 `market_phase`를 스탬프하므로 NXT 시간대 `phase="closed"`가 정확히 WS 파리티(프론트는 phase가 아닌 venue 태그·구조로 게이팅). 별도 처리 없음.
5. **코얼레스 key에 venue 포함.** 스왑 경계에서 느린 KRX in-flight에 NX 요청이 코얼레스되어 1사이클 잘못된 venue 호가가 표시되는 것을 막는다. `cooldown_scope=(endpoint, scope)`는 venue와 무관 — EGW00201 쿨다운 의미론 불변.
6. **UN이 아닌 시분할.** 사용자 결정: WS 미러. J≠NX 별개 호가장이라 UN(통합)은 표시 의미가 모호(정규장 KRX 표시가 WS 구독 venue와 어긋날 위험).

## Consequences

- **표시 파리티 복원:** 장전 08:00–09:00·장후 15:31–20:00에 REST 종목도 NXT 호가/총잔량이 2초 주기로 갱신 — WS 종목과 동일 거동.
- **부하(작음):** 활성 창이 정규장 밖으로 넓어진 만큼 보는 종목 1개당 ~0.5콜/s 추가(background priority, 그 시간대는 백필·사용자 경쟁이 적어 15콜/s 여유 충분). 하루 첫 사이클에 `to_thread` 내 캘린더 HTTP 1회(이후 날짜별 캐시).
- **경계 전환:** venue/phase는 사이클마다 프레시 호출 — 08:50/15:31 스왑은 다음 사이클(≤2초)에 반영. 창 재진입(월요일 08:00) 시 `_snapshotted_once` clear로 폴링 자연 재개.
- **저장 무변경:** 레코더는 venue 미전달이라 JSONL byte-불변. 기존 closed-gate 테스트군은 "활성 창 밖" 시나리오로 재해석되어 무수정 통과.
- **되돌림:** `window_fn=lambda: False` 주입(또는 기본값 복귀)이면 기존 정규장-only 거동으로 즉시 회귀.

## 미검증 (다음 장중)

FHKST01010200의 NX **파라미터 수용·별개 호가장**까지는 실측했으나, NXT 세션 **장중**(16:00–20:00) 실시간 갱신은 미실증(`aspr_acpt_hour` 변화로 확인 예정). 갱신이 없더라도 폴링 자체는 무해(값 불변 스냅샷).

## 비범위

`Rest30sRecorder` 저장 레코더, trades/brokers venue 시분할, `capture_aux`의 NXT 확장, UN div, WS 구독 로직, 폴러 `user_visible` 승격(ADR-0098 비범위 유지).
