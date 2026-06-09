# /live 관심종목 커버리지 — 2계좌 WS + 보는종목 REST 폴링 하이브리드

- **Date**: 2026-06-09
- **Status**: Designed (사장님 검토 대기)
- **Topic slug**: `live-watchlist-coverage-hybrid`
- **Scope**: `hoga/live/*` (인증·오케스트레이션·REST 폴러), `hoga/api/ws.py`, `frontend/src/live·watchlist` (가시성)
- **관련**: ADR-**0067**(본 설계 결정), ADR-0037(소스 서브폴더), ADR-0038(단일 워커), ADR-0039(소스 선호+폴백), ADR-0043(Today Promotion), ADR-0064(poller 침묵사망), spec 2026-06-05(KIS WS 실시간), `lifecycle.py:40-42`(13종목 한도)

---

## ⚠️ Grill 갱신 (2026-06-09) — 아래 본문보다 **이 델타가 우선** (ADR-0067)

grill-with-docs 리뷰로 5건 확정:

1. **보는 종목 = activeCode** (`/live` 차트의 단일 Code, ADR-0052/0053). WS가 커버하는 종목엔 REST 안 함 — `live_set` 멤버십이 배타의 단일 권위.
2. **관심종목 ≤26 = WS(2계좌) = Live Set.** 사용자가 26개로 관리하므로 "14위↓ 장중 미수집" 문제 소멸. 관심종목 밖은 **보는 것만** REST.
3. **REST 폴러는 ADR-0064 교훈** 필수 — 예외 격리 + 사망 감지 + 거짓 health 금지.
4. **REST = 화면 표시 전용(`buffer.publish`), 디스크 저장 안 함.** → 저장은 WS만. 같은 종목 WS·REST 혼합 JSONL·이중계상 위험 구조가 *생길 수 없음* → **7장 위험 #2(BLOCKER 2) 소멸**, **Part C(소스통합/혼합감지) 대부분 불필요**(읽기 경로 무변경, 혼합 감지 삭제).
5. **즉시 표시**(`buffer.publish`, 2초 주기). 관심종목 밖은 저녁 hogaplay 배치 대상도 아니라 저장 실익 없음.

**배지 모델 단순화**: `realtime`(∈Live Set, WS) / `polling`(∉Live Set ∧ 보는 중, REST) / `uncollected`(∉Live Set ∧ 안 봄). `waiting_eod`는 watchlist>26 폴백 시에만.

---

## 1. 문제

`/live` 실시간 수집(KIS WebSocket)은 **appkey당 41건 등록 한도 ÷ 종목당 3등록(호가 H0STASP0 + 체결 H0STCNT0 + 거래원 H0STMBC0) = 최대 13종목**으로 묶인다(`lifecycle.py:40-42`). 사용자 관심종목은 120개라, watchlist 표시순서 **상위 13개만 장중 실시간 수집**되고 나머지 107개는 **호가·거래원·호가지표가 침묵 절단**된다(`_compute_live_set`의 `ordered[:13]`, UI 경고 없음). 저녁 17:00 hogaplay 일배치(`scheduler.py:83-92`)가 전 종목을 사후 채우지만, **장중에 14위 이하 종목을 열면 빈 화면**이다 — 이것이 원래 보고된 증상이다.

## 2. 목표 / 비목표

**목표**
- 장중에 **어느 종목을 열어도** 호가·거래원·지표가 보이게 한다.
- 관심종목 중요 종목(주도주)은 **진짜 실시간**(sub-second)으로 더 많이 본다.
- 수집 상태(실시간/준실시간/미수집)를 **사용자에게 명시**한다.

**비목표**
- 전 종목(120개) 동시 sub-second 실시간 (물리적으로 다중 계좌 다수 필요 — 본 설계 범위 밖).
- 증권사 교체(키움 등). 조사 결과 키움도 동일 류 제약(REST 초당 5건, WS 종목 한도)이라 이득 없음.
- hogaplay 장중 폴링(쿠키 SPOF·종목당 ~88초·차단 위험으로 부적합).

## 3. 핵심 결정 (확정)

| 대상 | 방식 | 속도 |
|---|---|---|
| 관심종목 상위 ~26개 | **2계좌 WS** (계좌1 13 + 계좌2 13, 종목당 3등록 유지) | sub-second 실시간 |
| 그 밖 종목(검색·27위↓ 관심종목) | **보는 종목만 REST 폴링** (화면에 띄울 때) | 1종목 단위라 거의 즉시 |
| 안 본 나머지 | 기존 17:00 hogaplay 일배치 | 저녁 사후 |

- 거래원 포함 3종 전부 유지(2종으로 줄이면 40종목 가능하나 거래원 양보 → 채택 안 함).
- 27위 이하 관심종목은 **별도 규칙 없이 "검색 종목과 동일 — 볼 때 REST"**로 통합.
- 2번째 계좌: 사용자가 개설/보유 확정.

## 4. 아키텍처 — 2단계 / 5부품

```
[계좌1 WS] ─ 13종목 ─┐
                     ├─ buffer/writer (code-keyed) ─ promote ─ kis_live parquet ─► /live
[계좌2 WS] ─ 13종목 ─┤        ▲ 같은 포맷
[REST 폴러] ─ 보는종목(26밖) ─┘
[hogaplay 17:00] ─ 나머지 ─► (저녁)
```

데이터 머지 경로(`buffer.py`, `writer.py` per-code Lock, `downsampler.py`)는 이미 **code-keyed**라 다중 producer를 구조적으로 견딘다(단일 이벤트루프, ADR-0038). 따라서 확장은 주로 **인증·오케스트레이션·producer 배타성**에 집중된다.

### 부품
1. **2계좌 인증** (`kis_runtime.py`, medium) — 싱글톤을 `account_id`별 dict로. `KIS_APP_KEY_2`/`KIS_APP_SECRET_2`. 토큰 캐시 `kis-token-{id}.json` 분리. 1계좌만 설정 시 기존 13종목 폴백.
2. **이중 WS 오케스트레이션** (`lifecycle.py`, large) — `_State`를 N스트림 리스트로. `partition_live_set(codes, n)`로 종목 분할. `LIVE_SET_MAX_CODES = 13 × N_ACCOUNTS`. watchdog/`get_status`가 N스트림 집계. `stream.py`/`writer.py`/`buffer.py`는 **변경 없음**(이미 code-keyed).
3. **보는종목 REST 폴링** (`rest_poller.py` 신규 ~300줄, medium) — `/api/ws` subscribe 신호 → 그 종목이 WS live_set 밖이면 폴링 시작, unsubscribe/disconnect 시 중단. `kis_client.py`에 `fetch_orderbook`(FHKST01010200)/`fetch_trades`(FHPST01060000)/`fetch_brokers`(FHKST01010600) **복원**(폴러 은퇴 때 제거됨), `kis_models.py`·`snapshot.py` 빌더 복원. **account 0의 기존 15콜/초 버킷 사용 → 2번째 계좌 불필요.**
4. **소스 통합 읽기** (`sources.py`/`bundle.py`, small) — WS·REST 결과를 같은 `kis_live` 소스명으로 통일. 읽기 경로는 이미 per-(date,code) `resolve_source`라 **변경 거의 없음**. 배타성은 producer 쪽에서 강제(7장).
5. **수집 상태 가시성** (`frontend`, small) — `liveStatus.ts`에 누락된 `live_set` 필드 추가(백엔드는 이미 emit). 3-state(실시간WS / 준실시간폴링 / 미수집) 배지를 `LiveStatusBar`·watchlist 행·빈 패널 안내에 표시.

## 5. Producer 배타성 상태머신 (★ 핵심 — 두 BLOCKER 해결)

적대적 검토의 BLOCKER 2(소스 혼합 무방어)와 downsampler 이중계상(HIGH)은 **동일 뿌리** — 한 종목이 producer를 바꿀 때 깔끔한 핸드오프가 없다. 단일 권위로 해결:

> **`live_set` 멤버십이 "누가 이 종목을 수집하는가"의 유일 권위.**
> - 종목 ∈ WS live_set → **WS만** produce, REST 폴러는 skip.
> - 종목 ∉ WS live_set → **REST 폴러만** produce(보고 있을 때).
> - 전환(예: watchlist 재정렬로 종목이 26 안↔밖 이동) 시 **stop → flush → start** 경계로 원자 핸드오프(중첩 ingest 윈도 제거).
> - 안전망: `promote` 시 동일 (date,code) JSONL에 두 producer 흔적이 섞이면 **감지·경고**.

`stream.set_active_codes` → `rest_poller.set_excluded_codes(active_codes)` 동기화로 구현.

## 6. 마일스톤 (구현 순서)

**출시 1 — 원래 불만 해결 (2번째 계좌 불필요)**
- **가시성/배지** (부품5, small, 백엔드 0) — `live_set` 노출 + 3-state 배지 + 빈 패널 "장중 미수집, 17시 후 채워짐" 안내. 독립·즉시 출시.
- **보는종목 REST 폴링** (부품3, medium) — account 0만으로. kis_client REST 메서드 복원 + `rest_poller.py` + `/api/ws` 연동 + 배타성(5장).
- **소스 통합** (부품4, small) — 폴링과 함께. 읽기 경로 검증.
- → **체감: 어느 종목을 열어도 장중에 데이터가 나온다.**

**출시 2 — 26종목 실시간 (2번째 계좌 후)**
- **2계좌 인증** (부품1, medium) — 인프라.
- **이중 WS** (부품2, large) — 26종목 실시간. **2번째 계좌 생긴 뒤 동일-IP 2소켓 스모크 테스트 통과가 선결**(7장 위험1).
- → **체감: 주도주 26개가 sub-second 실시간.**

의존성: 가시성 독립 / 인증 → 이중WS·폴링 / 소스통합 ← 폴링 / 이중WS·폴링 병렬 가능.

## 7. 위험 + 대응

| # | 위험 | 심각도 | 대응 |
|---|---|---|---|
| 1 | **동일 IP에서 2 appkey WS 2연결 동시 유지** 가능 여부 미확정 | BLOCKER | 다중 appkey→다중 세션은 외부 사례로 입증(hky035 41→82). 단 동일 appkey로는 사전 테스트 불가 → **2번째 계좌 발급 후 10줄 스모크 테스트**로 확정. 실패 시 M3만 보류(M1·M5 무관). |
| 2 | WS·REST가 같은 종목 동시 수집 → JSONL 혼합·이중계상 | BLOCKER→해결 | **5장 배타성 상태머신**(live_set 단일 권위 + stop→flush→start + promote 감지). |
| 3 | 2계좌 토큰 동시 재발급 경합(KIS app_key당 1/분) | HIGH | 계좌별 독립 쿨다운 + **쿨다운 시 재시도**. |
| 4 | 26슬롯 파티션이 watchlist 드래그마다 대량 재구독(churn) | MEDIUM | 안정 배정(display-order 13/13 고정), 전환만 diff 재구독. |
| 5 | REST 폴러 3콜/주기가 백필과 15콜/초 버킷 경합 | MEDIUM | 폴링 주기 보수적(2~3초), 보는 종목 소수만 폴링. |
| 6 | env 변수 네이밍 불일치(`KIS_APP_KEY2` vs `_2`) | LOW | **`KIS_APP_KEY_2`로 통일**, account_id 0-based. |

## 8. 오픈 퀘스천 (구현 착수 전 확정)

- 토큰 캐시 마이그레이션: `kis-token.json` → `kis-token-0.json` 개명 vs account 0만 기존 경로 유지.
- M3 watchdog 재시작: (A) 전체 재시작(보수) vs (B) per-connection 격리 복구.
- M5 폴링 주기 최종값(2초 vs 10초) + unsubscribe 시 즉시중단 vs 사이클완료.
- M5 폴링 결과를 `buffer.publish`도 할지(`/api/live/snapshot` 즉시 표시 경로).
- M1 배지 라벨 문구("미수집" vs "18시 후") + watchlist 패널이 `/live` 미마운트 → 배지 위치.

## 9. 테스트 전략 (TDD)

- **인증**: account 부재 폴백(`account_id=1` None), 계좌별 독립 캐시 경로/쿨다운, backward compat(account_id=0 기본).
- **파티션**: `partition_live_set(26, 2)` → 13/13, 안정 배정(재정렬 시 churn 최소).
- **배타성**: 종목이 WS↔REST 전환 시 중첩 ingest 0(stop→flush→start), promote 혼합 감지.
- **이중 WS**: 2스트림 기동/감시/집계 status, 1계좌 폴백 시 기존 동작 무변경.
- **REST 폴러**: subscribe→폴링 시작, unsubscribe→중단, WS live_set 종목은 skip(배타).
- **가시성**: 3-state 파생 순수함수, `live_set` 미수집 종목 배지 렌더.
- **스모크(수동, 2계좌 후)**: 동일 IP 2소켓 동시 연결·구독 확인.
