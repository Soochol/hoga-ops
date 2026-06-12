# 총잔량 Peak 돌파 감지기 (Breakout Detector) — Design

**Date**: 2026-06-12
**Status**: Draft
**Scope**: `hoga/live/breakout.py`(신규 감지 코어), `hoga/live/breakout_seed.py`(신규 시딩, cold path), `hoga/live/buffer.py`(LiveBuffer 구독), `hoga/live/lifecycle.py`(서비스 기동), `hoga/api/breakout_routes.py`(신규 라우트), `hoga/live/breakout_store.py`(신규 이벤트 로그), `frontend/src/live/`(알림 피드 패널·토스트·소리)

## Problem

사용자(트레이더) 표현 그대로:

> "관심 종목 중에서, 총잔량 지표에서 **매도총잔량 또는 매수 총잔량이 이전 peak 수치보다
> 더 큰 수치가 나오는 순간**을 잡는 알고리즘을 개발하고 싶어."

현재 시스템은 단일 `/live` 종목의 호가 패널에서 총잔량을 *표시*할 뿐, 관심종목을
가로질러 "총잔량이 기록을 다시 도전하는 순간"을 **감지·알림**하는 수단이 없다. 매도/매수벽이
당일 최고치 근처로 다시 부풀어오르는 순간은 트레이딩 시그널이 될 수 있는데, 사람이 234개
종목의 호가를 동시에 눈으로 좇는 것은 불가능하다.

대화에서 합의된 핵심 변형:

- "더 큰 수치(돌파)"의 엄격한 정의 대신, **이전 peak의 90%까지 차오르면 '도전(넘김)'으로 간주**
  → 벽이 다 쌓인 뒤가 아니라 **쌓이는 도중에** 더 빨리 경보. (성격: "돌파 감지" → "기록 근접·재도전 감지")

## Invariants

이 spec이 추가하는 분기가 **보존해야 하는** 기존 시스템 속성:

- **ADR-0038 hot-path 순수성**: tick 경로 모듈(`live_session`·`stream`·`buffer` 등 `_HOT_PATH_MODULES`)은
  `pyarrow`/`polars`를 import하지 않는다. 근거: [hoga/live/live_session.py:9](../../../hoga/live/live_session.py),
  `tests/test_adr_invariants.py`.
- **ADR-0067 폴러 디스크 미저장**: `LiveRestPoller`(보는종목 표시폴러)는 디스크에 절대 저장하지
  않는다 — 저장은 WS 경로 전용. 근거: [hoga/live/rest_poller.py:3](../../../hoga/live/rest_poller.py).
- **KIS REST 단일 누수버킷(15 calls/sec)**: 한 `KisClient`의 모든 데이터 호출은 `_TokenBucket(rate=15)`을
  공유한다. 근거: [hoga/live/kis_client.py:56](../../../hoga/live/kis_client.py).
- **LiveBuffer 구독 분리(active-set 필터)**: 구독자는 큐 기반으로 붙고, unsubscribe 직후 in-flight
  잔여는 active 집합 필터로 걸러진다. 근거: [hoga/live/buffer.py:57](../../../hoga/live/buffer.py),
  [hoga/live/stream.py:76](../../../hoga/live/stream.py).
- **총잔량 정의 일관성**: 매도/매수총잔량은 `total_ask_qty`/`total_bid_qty`(KIS `total_askp_rsqn`/
  `total_bidp_rsqn`) 단일 필드다. 근거: [hoga/live/ws_frames.py:91](../../../hoga/live/ws_frames.py),
  [hoga/live/kis_client.py:983](../../../hoga/live/kis_client.py).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| ADR-0038 hot-path 순수성 | preserves | 감지 코어(`breakout.py`)는 순수 파이썬(deque·dict)만 사용, import 금지 목록 준수. 시딩 조회(`breakout_seed.py`)만 cold path(저장소 읽기)로 분리. |
| ADR-0067 폴러 디스크 미저장 | preserves | Phase 2 `WatchlistBreakoutPoller`는 호가를 메모리로만 읽어 감지기에 주입, 디스크 저장 없음. 이벤트 로그(`breakout_store`)는 폴러가 아닌 감지기 출력이며 별도 경로. |
| KIS REST 15/sec 버킷 | preserves (Phase 2에서 공유 부하 ↑) | Phase 2 폴러는 같은 버킷을 공유 — 스크리너 백필·range 조회와 쿼터 경쟁. 폴러는 양보 가능한 background 우선순위로 설계(아래 §Design Phase 2). |
| LiveBuffer 구독 분리 | preserves | 감지기는 기존 구독 큐 계약으로 붙는 또 하나의 소비자. 새 계약 추가 없음. |
| 총잔량 정의 일관성 | preserves | 기존 필드를 읽기만 함. |

## Goals

- 관심종목의 매도/매수총잔량이 **당일 기준** 이전 peak의 90% 이상으로 올라오는 순간을 감지해 알림.
- 두 종류의 peak를 **독립** 추적: ① 세션 누적 최고치, ② 롤링 윈도우(기본 30분) 최고치.
- 알림 품질을 위한 가드: **히스테리시스**(90% 발사 / 85% 재무장), **쿨다운**(60초), **콜드스타트 억제**(시딩 + 워밍업).
- 출력 4채널: 전용 알림 피드 패널 + 토스트 + 소리 + 이벤트 로그(디스크).
- 감지 코어는 **순수·단위 테스트 가능**(시계 주입 seam) — 모든 분기를 결정론적으로 검증.

## Non-Goals

- 멀티데이(전일 이월) peak — **당일만**. 자정/세션 경계에서 상태 리셋.
- 총잔량 외 지표(호가비·체결강도 등)의 돌파 — 이번 범위 밖.
- 돌파 이후 가격 움직임의 백테스트·승률 분석 — 이벤트 로그를 남겨 후속 가능하게만 함(§Backlog).
- 매매 자동 주문 연동 — 알림까지만.

## Design

### 단계 구분 (빌드 전략 A안 — 단계적)

- **Phase 1**: `LiveBuffer`(tick) 구독으로 **Live Set**(실시간 상위 종목)만 감지 + 전체 출력 레이어.
  새 폴링 인프라 없음. 정밀(tick) 데이터로 알고리즘을 먼저 검증.
- **Phase 2**: `WatchlistBreakoutPoller`(신규)로 Live Set 밖 관심종목까지 커버리지 확장. 같은 감지 코어 재사용.

각 단계는 독립적으로 동작·배포 가능.

### 데이터 흐름

```
Phase 1:  KIS WS → ws_frames(total_ask/bid_qty) → LiveBuffer(tick) ─┐
                                                                     ├─► BreakoutDetector
Phase 2:  + WatchlistBreakoutPoller(~5~16s, REST) ───────────────────┘        │
                                                                  (seed/warmup/hysteresis/cooldown)
                                                                              │ 돌파 이벤트
                                                                              ▼
                                                              BreakoutStore(JSONL 이벤트 로그)
                                                                              │
                                                          GET /api/live/breakouts?since=<cursor>
                                                                              │ 프론트 폴링
                                                                              ▼
                                                       알림 피드 패널 + 토스트 + 소리
```

프론트는 기존 라이브 데이터와 동일하게 **주기적 폴링**(TanStack Query)으로 알림을 받는다 —
SSE 인프라를 새로 만들지 않는다(기존 패턴 일치).

### 감지 코어 (`breakout.py`) — 핵심 deliverable

**상태: `(code, side)` 쌍마다** (side ∈ {`ask`, `bid`} — 종목당 2 트랙):

```
SymbolSideState:
  session_peak:   int             # 당일 누적 최고 총잔량 (시딩 가능)
  window:         Deque[(ts_ms, value)]  # 롤링 최고치용 단조감소 덱
  armed_session:  bool            # 세션 신호 히스테리시스 무장 상태
  armed_window:   bool            # 윈도우 신호 히스테리시스 무장 상태
  last_fired_ms:  int             # 쿨다운 기준
  samples_seen:   int             # 워밍업 카운터
  seeded:         bool            # 저장소 시드 여부
```

**파라미터(전부 설정 가능, 기본값):**

| 파라미터 | 기본값 | 의미 |
|---------|--------|------|
| `upper_ratio` | 0.90 | 발사 문턱 — `value ≥ upper_ratio × peak`이면 도전(넘김)으로 발사 |
| `lower_ratio` | 0.85 | 재무장 문턱 — `value < lower_ratio × peak`이면 다시 발사 가능(히스테리시스) |
| `window_minutes` | 30 | 롤링 윈도우 길이 |
| `cooldown_s` | 60 | 동일 (code, side) 재발사 최소 간격 — 신호종류 공유(추가 안전 바닥). session·window가 60초 내 둘 다 떠도 1회로 합쳐짐 |
| `warmup_k` | 3 | 미시드 종목에서 발사 전 조용히 채울 샘플 수 |
| `min_abs` | 0 | 총잔량 절대 최소값 필터(0=off) |

**틱 처리** — 관측 `(v, ts)` 도착 시 `(code, side)` 트랙에 대해:

1. **절대 필터**: `v < min_abs`면 상태만 갱신, 발사 안 함.
2. **peak 갱신**: `session_peak = max(session_peak, v)`; 윈도우 덱에 append, `ts - window_ms` 이전 항목
   evict, 단조감소 유지 → `window_peak = window[0].value`.
3. **워밍업 게이트**: `not seeded and samples_seen < warmup_k` → `samples_seen += 1` 후 발사 없이 종료.
4. **신호별 판정** (T ∈ {`session`, `window`}, peak `P_T`):
   - `upper = upper_ratio × P_T`, `lower = lower_ratio × P_T`
   - **재무장**: `v < lower` → `armed_T = True`
   - **발사**: `v ≥ upper and armed_T and (ts - last_fired_ms ≥ cooldown_ms)` →
     이벤트 emit, `armed_T = False`, `last_fired_ms = ts`
5. **STRONG 분류**: `window` 발사가 동시에 *새 세션 최고치 갱신*(`v == session_peak` 이고 이번 틱에서
   session_peak가 전진)과 겹치면 이벤트에 `strength = STRONG` 태그.

> **수식 정합성**: `session_peak = max(session_peak, v)`이므로 새 세션 신고가일 때 `v == peak` →
> `v ≥ 0.9·peak`가 항상 참 → (무장 상태라면) 발사된다. 지속 상승 구간에서는 `v`가 `peak`를 따라가
> 한 episode당 1회 발사 후 disarmed, `v`가 `0.85·peak` 아래로 빠져야 재무장 → 도배 없음.

### 콜드스타트 ③ — 추천안 (설정으로 둠, 구현 후 실동작 보고 조정)

이벤트 관점("방금 일어난 사건"으로서의 알림)으로 **재시작 노이즈 0**을 목표:

- **시딩(상황 A — 장중 재시작)**: 기동 시 `breakout_seed.py`(cold path)가 오늘 저장된 WS 스냅샷에서
  종목·side별 당일 최고 `total_ask/bid_qty`를 읽어 `session_peak` 시드, `seeded = True`.
- **무장 상태 초기화**: 첫 관측 시 `armed_T = (v < lower_ratio × P_T)`. 즉 시작 시 값이 이미 존 안(≥85%)이면
  **disarmed로 시작**(조용) → 값이 85% 아래로 빠졌다 90% 재돌입할 때부터 발사.
- **워밍업(상황 B — 저장 이력 없는 종목, Phase 2 폴링 종목)**: `seeded = False` → 처음 `warmup_k`개는
  기록만. 윈도우 신호는 첫 샘플에서 `window_peak == v`라 자연히 disarmed로 시작 → startup spam 없음.

> 설정 토글 `coldstart_mode ∈ {quiet(기본), announce}` 로 "시작 시 1회 알림" 대안도 지원.

### 출력 레이어

- **`BreakoutStore`** (`breakout_store.py`): 당일 돌파 이벤트를 JSONL append(후속 분석·백테스트용).
  레코드: `{ts_ms, code, name, side, signal_type(session|window), strength(normal|strong), prev_peak, value, pct_of_peak}`.
  당일 파일, 자정 롤오버.
- **`GET /api/live/breakouts?since=<cursor_ms>`** (`breakout_routes.py`): 커서 이후 신규 이벤트를 시간순 반환.
  프론트가 폴링.
- **프론트** (`frontend/src/live/`):
  - **알림 피드 패널**: 시간 역순 이벤트 리스트(종목·방향·신호종류·이전peak·현재값·peak대비%). DESIGN.md 토큰 준수.
  - **토스트**: 신규 이벤트 도착 시 일시 알림.
  - **소리**: 신규 이벤트 시 비프(설정 토글, 기본 off로 안전).

### Phase 2 — `WatchlistBreakoutPoller`

- Live Set 제외 관심종목을 호가 조회로 순회, `total_ask/bid_qty`만 추출해 같은 `BreakoutDetector`에 주입.
- 사이클 시간: 1계좌 ~16s, 3계좌 분산 ~5s(15/sec 버킷 공유). 폴링 종목은 **시드 불가** → 워밍업 억제 의존.
- 쿼터 경쟁 완화: background 우선순위(스크리너 백필·foreground range 조회에 양보), 사이클 시간을 status로 노출.

## Testing

### Unit tests (감지 코어 — 시계 주입 seam)

| Case | Setup | Expected |
|------|-------|----------|
| 단순 돌파 | peak=100 시드, v=95 도착(armed) | session 발사 1회, pct_of_peak=95% |
| 살짝 미달 | peak=100, v=89 | 발사 없음(<90%) |
| 도배 방지(히스테리시스) | peak=100, v=95→96→94→95(85% 미하락) | 발사 1회만 |
| 재무장 후 재발사 | peak=100, v=95→발사→84(<85%)→재무장→95 | 발사 2회 |
| 쿨다운 | 발사 직후 다른 트랙 무관, 같은 트랙 30s 뒤 재돌입 | 60s 전엔 발사 안 함 |
| 워밍업 억제(미시드) | seeded=False, 첫 3샘플 v=10→200→150 | 첫 3샘플 발사 0(기록만) |
| 재시작 quiet-start | 시드 peak=100, 첫 관측 v=95 | disarmed 시작 → 발사 0, 이후 84로 하락 후 95 재돌입 시 발사 |
| 롤링 윈도우 evict | window=30m, 오래된 큰 값이 윈도우 밖으로 | window_peak가 정확히 하락(단조덱 정합) |
| STRONG 태그 | window 발사 + 동시 세션 신고가 | strength=STRONG |
| 절대 필터 | min_abs=1000, v=500 | 발사 없음 |
| ask/bid 독립 | 같은 종목 ask 발사, bid 무관 | 트랙 분리 — bid 상태 불변 |

**Invariant 회귀 테스트**:
- ADR-0038: `tests/test_adr_invariants.py`의 `_HOT_PATH_MODULES`에 `breakout`(코어) 등재, import 금지 검증.
- 단조덱 정합: 임의 시퀀스에 대해 `window_peak == max(윈도우 내 값들)` 프로퍼티 테스트.

### Manual verification

- `/live` 실장중: Live Set 종목 매도/매수벽이 기록 근처로 부풀 때 피드/토스트/소리 동작 확인.
- 백엔드 장중 재시작: 재시작 직후 알림 피드에 **스퓨리어스 돌파가 쏟아지지 않음** 확인(quiet-start).
- Phase 2 배포 후: Live Set 밖 종목도 ~사이클 지연 내 감지되는지 + KIS rate-limit 경고 미발생 확인.

## Risks / Open questions

- **③ 콜드스타트 최종 정책**: 추천안(quiet-start)으로 시작하되, 실장중 동작 관찰 후 `coldstart_mode`·
  `warmup_k`·문턱(90/85)을 튜닝. announce 모드 유용성은 실사용으로 판단.
- **Phase 2 쿼터 경쟁**: 234종목 연속 폴링이 스크리너 백필·range 조회와 15/sec 버킷을 경쟁 →
  실측으로 background 우선순위·사이클 cap 조정 필요. 최악의 경우 폴링 universe를 "당일 활성(거래량/변동)
  종목"으로 축소하는 안(§Backlog) 검토.
- **윈도우 시드 한계**: 롤링 윈도우(30분)는 거친 저장 데이터로 정밀 시드 불가 → 재시작 시 윈도우 신호는
  quiet-start로 시작(세션 신호만 시드). 수용 가능한 한계로 판단.
- **세션 경계/장 마감**: 자정 롤오버·동시호가 구간(08:50~)에서 상태 리셋·게이팅 타이밍은 기존
  `session_gate`와 정합 맞춰야 함.

## Out of Scope (Backlog)

- 돌파 이벤트 → 이후 N분 가격/수익률 라벨링(이벤트 로그 기반 신호 품질 백테스트).
- 폴링 universe 적응형 축소(당일 활성 종목 우선) — Phase 2 쿼터 압박 시.
- 총잔량 외 지표(호가비·체결강도)로 같은 감지 프레임워크 일반화.
- 종목·그룹별 파라미터 오버라이드(주도주는 더 민감하게 등).
- 알림 push(브라우저 Notification API / 모바일) — 현재는 피드 폴링 + 소리까지만.
