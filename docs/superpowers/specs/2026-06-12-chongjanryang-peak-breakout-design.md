# 총잔량 급증 (Quote Totals Surge) 감지기 — Design

> 용어: 신호 = **총잔량 급증(Quote Totals Surge)**, CONTEXT.md 등재. "돌파/Breakout"은 Screener EOD
> 신고가 조건 전용이라 백엔드 모듈·타입·엔드포인트 전부 `surge` 네이밍을 쓴다(realm 충돌 회피, Q1).

**Date**: 2026-06-12
**Status**: Draft
**Scope**: `hoga/live/surge.py`(신규 감지 코어), `hoga/live/surge_seed.py`(신규 시딩, cold path), `hoga/live/buffer.py`(LiveBuffer 구독), `hoga/live/lifecycle.py`(서비스 기동), `hoga/api/surge_routes.py`(신규 라우트), `hoga/live/surge_store.py`(신규 이벤트 로그), `frontend/src/live/`(알림 피드 패널·토스트·소리)

## Problem

사용자(트레이더) 표현 그대로:

> "관심 종목 중에서, 총잔량 지표에서 **매도총잔량 또는 매수 총잔량이 이전 peak 수치보다
> 더 큰 수치가 나오는 순간**을 잡는 알고리즘을 개발하고 싶어."

현재 시스템은 단일 `/live` 종목의 호가 패널에서 총잔량을 *표시*할 뿐, 관심종목을
가로질러 "총잔량이 직전 최고치를 크게 넘어서는(급증) 순간"을 **감지·알림**하는 수단이 없다. 매도/매수벽이
당일 최고치를 크게 갱신하는 순간은 트레이딩 시그널이 될 수 있는데, 사람이 234개
종목의 호가를 동시에 눈으로 좇는 것은 불가능하다.

대화 + 2026-06-12 실데이터 검증(§Validation)으로 확정된 트리거:

- **래칫(단조증가) 고가를 유의미한 마진(기본 +50%)만큼 초과**하는 순간 발사. 사용자의 "이전 peak 고가를
  넘어서고, 신고가가 나오면 기준 고가를 갱신" 직관(래칫)을 그대로 쓰되, 트리거는 마진 초과로 둔다.
- (검토 중 폐기) "이전 peak의 90% 재접근" 안 — 노이즈 과다 + 폭발적 신고가를 disarm으로 놓침이 실증돼 폐기.

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
| ADR-0038 hot-path 순수성 | preserves | 감지 코어(`surge.py`)는 순수 파이썬(dict·int 4필드 상태)만 사용, import 금지 목록 준수. 시딩 조회(`surge_seed.py`)만 cold path(저장소 읽기)로 분리. |
| ADR-0067 폴러 디스크 미저장 | preserves | Phase 2 `WatchlistSurgePoller`는 호가를 메모리로만 읽어 감지기에 주입, 디스크 저장 없음. 이벤트 로그(`surge_store`)는 폴러가 아닌 감지기 출력이며 별도 경로. |
| KIS REST 15/sec 버킷 | preserves (Phase 2에서 공유 부하 ↑) | Phase 2 폴러는 같은 버킷을 공유 — 스크리너 백필·range 조회와 쿼터 경쟁. 폴러는 양보 가능한 background 우선순위로 설계(아래 §Design Phase 2). |
| LiveBuffer 구독 분리 | preserves | 감지기는 기존 구독 큐 계약으로 붙는 또 하나의 소비자. 새 계약 추가 없음. |
| 총잔량 정의 일관성 | preserves | 기존 필드를 읽기만 함. |

## Goals

- 관심종목의 매도/매수총잔량이 **당일 기준** 이전 고가(래칫 high-water mark)를 **유의미한 마진(기본 +50%)
  만큼 초과**하는 순간을 감지해 알림. (트리거 확정 근거: §Validation)
- peak는 **세션 누적 최고치(래칫, 단조증가)** 단일 추적. 롤링 윈도우 신호는 노이즈 주범으로 확인돼 코어에서 제외(§Backlog).
- 알림 품질을 위한 가드: **마진 자체가 디바운스**(발사 후 고가 래칫 → 다음엔 더 높은 고가를 또 초과해야), **쿨다운**(60초), **콜드스타트**(시딩 + 워밍업; 마진 방식이라 startup 스퓨리어스 구조적 불가).
- 출력 4채널: 전용 알림 피드 패널 + 토스트 + 소리 + 이벤트 로그(디스크).
- 감지 코어는 **순수·단위 테스트 가능**(시계 주입 seam) — 모든 분기를 결정론적으로 검증.

## Non-Goals

- 멀티데이(전일 이월) peak — **당일만**. 자정/세션 경계에서 상태 리셋.
- 총잔량 외 지표(호가비·체결강도 등)의 급증 — 이번 범위 밖.
- 급증 이후 가격 움직임의 백테스트·승률 분석 — 이벤트 로그를 남겨 후속 가능하게만 함(§Backlog).
- 매매 자동 주문 연동 — 알림까지만.

## Design

### 단계 구분 (빌드 전략 A안 — 단계적)

- **Phase 1**: `LiveBuffer`(tick) 구독으로 **Live Set**(실시간 상위 종목)만 감지 + 전체 출력 레이어.
  새 폴링 인프라 없음. 정밀(tick) 데이터로 알고리즘을 먼저 검증.
- **Phase 2**: `WatchlistSurgePoller`(신규)로 Live Set 밖 관심종목까지 커버리지 확장. 같은 감지 코어 재사용.

각 단계는 독립적으로 동작·배포 가능.

### 데이터 흐름

```
Phase 1:  KIS WS → ws_frames(total_ask/bid_qty) → LiveBuffer(tick) ─┐
                                                                     ├─► SurgeDetector
Phase 2:  + WatchlistSurgePoller(~5~16s, REST) ───────────────────┘        │
                                                                  (seed/warmup/margin/cooldown)
                                                                              │ 급증 이벤트
                                                                              ▼
                                                              SurgeStore(JSONL 이벤트 로그)
                                                                              │
                                                          GET /api/live/surges?since=<cursor>
                                                                              │ 프론트 폴링
                                                                              ▼
                                                       알림 피드 패널 + 토스트 + 소리
```

프론트는 기존 라이브 데이터와 동일하게 **주기적 폴링**(TanStack Query)으로 알림을 받는다 —
SSE 인프라를 새로 만들지 않는다(기존 패턴 일치).

### 감지 코어 (`surge.py`) — 핵심 deliverable

> **2026-06-12 실데이터 검증으로 트리거 확정**: 17종목 bake-off(아래 §Validation)에서
> "90% 재접근 + 히스테리시스"(이전 초안)는 (a) 종목당 ~32건으로 과다하고 (b) peak 근처
> 출렁임마다 울리면서 (c) **폭발적 신고가는 disarm 때문에 오히려 놓치는**(테크윙 14:28
> 매도벽 277k 누락) 역설이 확인됐다. → **래칫(단조증가) 고가 + 유의미 마진 초과** 방식으로
> 전환. 같은 high-water-mark를 쓰되 트리거를 "90% 근접"→"**고가를 마진만큼 초과**"로 바꾼다.

**상태: `(code, side)` 쌍마다** (side ∈ {`ask`, `bid`} — 종목당 2 트랙):

```
SymbolSideState:
  session_peak:   int    # 당일 누적 최고 총잔량 = 래칫 고가 (단조증가, 시딩 가능)
  last_fired_ms:  int    # 쿨다운(디바운스) 기준
  samples_seen:   int    # 워밍업 카운터
  seeded:         bool   # 저장소 시드 여부
```

**파라미터(전부 설정 가능, 기본값):**

| 파라미터 | 기본값 | 의미 |
|---------|--------|------|
| `margin` | 0.50 | 발사 문턱 — `value ≥ session_peak × (1+margin)`, 즉 이전 고가를 50%↑ 초과해야 발사 (전 종목 공통 비율; 종목별 튜닝 불필요) |
| `cooldown_s` | 60 | 동일 (code, side) 재발사 최소 간격(디바운스 바닥) |
| `warmup_k` | 3 | 미시드 종목에서 발사 전 조용히 채울 샘플 수 |
| `min_abs` | 0 | 총잔량 절대 최소값 필터(0=off; 종목별 스케일 차이 때문에 상대 마진을 기본 신뢰) |

**틱 처리** — 관측 `(v, ts)` 도착 시 `(code, side)` 트랙에 대해:

1. **절대 필터**(옵션): `v < min_abs`면 상태만 갱신, 발사 안 함.
2. **워밍업 게이트**: `not seeded and samples_seen < warmup_k` → `samples_seen += 1` 후 발사 없이 래칫만.
3. **발사 판정** (이전 peak 고가 = 래칫 전 `session_peak` 기준):
   - `session_peak > 0 and v ≥ session_peak × (1+margin) and (ts - last_fired_ms ≥ cooldown_ms)` →
     이벤트 emit(`prev_peak = session_peak`, `pct_over = v/session_peak - 1`), `last_fired_ms = ts`.
4. **래칫 갱신**: `if v > session_peak: session_peak = v`. (신고가면 기준 고가를 갱신 — 사용자 규칙)

> **마진이 곧 디바운스**: 발사 후 `session_peak`가 `v`로 래칫되므로, 다음 발사는 *갱신된 더 높은
> 고가*를 다시 `margin`만큼 초과해야 한다. → peak 근처 출렁임은 자동으로 무시되고(이미 넘은 기록을
> 또 50% 넘을 순 없음), 발사할 때마다 직전보다 **50% 이상 큰 진짜 에스컬레이션**만 잡힌다.
> 히스테리시스(arm/disarm)·윈도우 덱이 불필요해져 상태가 4필드로 축소됐다.

> **강도 태그**: `pct_over`로 `strength` 부여 가능(예: `pct_over ≥ 0.5`면 `STRONG`). 기본은
> `pct_over`만 기록하고 표시는 프론트가 결정.

### 콜드스타트 ③ — S2 전환으로 대폭 단순화

90% 재접근 방식의 까다로운 "시작 시 존 안이면?" 엣지케이스가 **사라졌다**. "고가를 마진만큼 초과"는
*사건 자체가 startup 상태와 무관*하기 때문:

- **시딩(상황 A — 장중 재시작)**: 기동 시 `surge_seed.py`(cold path)가 오늘 저장된 WS 스냅샷에서
  종목·side별 당일 최고 `total_ask/bid_qty`를 읽어 `session_peak` 시드, `seeded = True`. → 재시작 후
  시드된 고가를 `margin` 초과하는 진짜 사건이 올 때만 발사. **스퓨리어스 startup 발사가 구조적으로 불가.**
- **워밍업(상황 B — 저장 이력 없는 종목, Phase 2 폴링 종목)**: `seeded = False` → 처음 `warmup_k`개는
  래칫만(발사 금지). 첫 관측이 `session_peak`를 0→v로 채우고, 그 자체로는 `(1+margin)×0` 비교가 무의미해
  발사 안 됨 → startup spam 없음.

> `coldstart_mode` 토글·arm 상태 초기화 등 이전 초안의 복잡성은 전부 제거.

### 출력 레이어

> **평가-우선 출력(먼저 구현)**: 보고 있는 종목의 총잔량 지표 위 마커 표시 —
> [`2026-06-12-chongjanryang-breakout-live-marker-design.md`](./2026-06-12-chongjanryang-breakout-live-marker-design.md).
> 프론트가 이미 가진 `quote_ratio.points`로 클라이언트 계산 → 백엔드 없이 종목 전환하며 평가 가능.
> 아래 피드/토스트/소리/로그는 그 평가 후 프로덕션 단계.

- **`SurgeStore`** (`surge_store.py`): 당일 급증 이벤트를 JSONL append(후속 분석·백테스트용).
  레코드: `{ts_ms, code, name, side, prev_peak, value, pct_over, strength}`.
  당일 파일, 자정 롤오버.
- **`GET /api/live/surges?since=<cursor_ms>`** (`surge_routes.py`): 커서 이후 신규 이벤트를 시간순 반환.
  프론트가 폴링.
- **프론트** (`frontend/src/live/`):
  - **알림 피드 패널**: 시간 역순 이벤트 리스트(종목·방향·신호종류·이전peak·현재값·peak대비%). DESIGN.md 토큰 준수.
  - **토스트**: 신규 이벤트 도착 시 일시 알림.
  - **소리**: 신규 이벤트 시 비프(설정 토글, 기본 off로 안전).

### Phase 2 — `WatchlistSurgePoller`

- Live Set 제외 관심종목을 호가 조회로 순회, `total_ask/bid_qty`만 추출해 같은 `SurgeDetector`에 주입.
- 사이클 시간: 1계좌 ~16s, 3계좌 분산 ~5s(15/sec 버킷 공유). 폴링 종목은 **시드 불가** → 워밍업 억제 의존.
- 쿼터 경쟁 완화: background 우선순위(스크리너 백필·foreground range 조회에 양보), 사이클 시간을 status로 노출.

## Testing

### Unit tests (감지 코어 — 시계 주입 seam)

| Case | Setup | Expected |
|------|-------|----------|
| 단순 급증 | peak=100 시드, v=160(=+60%) | 발사 1회, prev_peak=100, pct_over=60% |
| 마진 미달 | peak=100, v=140(=+40%, margin=0.50) | 발사 없음 |
| 래칫 디바운스 | peak=100, v=160(발사,래칫→160)→180→150 | 발사 1회만(다음 발사는 160×1.5=240 필요) |
| 연속 에스컬레이션 | peak=100, v=160(발사)→250(=160×1.56) | 발사 2회(각각 직전 고가 50%↑ 초과) |
| 폭발 누락 안 함 | peak=100, v=99→…→250 급등 | 250에서 발사(이전 방식이 놓치던 케이스 회귀) |
| 쿨다운 | 발사 직후 같은 트랙 30s 뒤 또 +50% 초과 | 60s 전엔 발사 안 함 |
| 워밍업 억제(미시드) | seeded=False, 첫 3샘플 v=10→200→150 | 첫 3샘플 발사 0(래칫만) |
| 재시작 무발사 | 시드 peak=100, 관측 v=95→130→149 | 모두 발사 0(시드 고가 ×1.5=150 미달) |
| 절대 필터(옵션) | min_abs=1000, v=500 | 발사 없음 |
| ask/bid 독립 | 같은 종목 ask 발사, bid 무관 | 트랙 분리 — bid 상태 불변 |

**Invariant 회귀 테스트**:
- ADR-0038: `tests/test_adr_invariants.py`의 `_HOT_PATH_MODULES`에 `surge`(코어) 등재, import 금지 검증.
- 래칫 단조성: `session_peak`가 어떤 입력 시퀀스에도 비감소(monotonic non-decreasing) 프로퍼티 테스트.

### Manual verification

- `/live` 실장중: Live Set 종목 매도/매수벽이 직전 고가 대비 크게 급증할 때 피드/토스트/소리 동작 확인.
- 백엔드 장중 재시작: 재시작 직후 알림 피드에 **스퓨리어스 급증이 쏟아지지 않음** 확인(시딩).
- Phase 2 배포 후: Live Set 밖 종목도 ~사이클 지연 내 감지되는지 + KIS rate-limit 경고 미발생 확인.

## Risks / Open questions

- **`margin` 기본값**: 17종목 검증으로 **+50% 채택**(종목당 ~1.9건). 30~80% 사이 평가 손잡이로 조정 가능
  (50%→~2건, 80%→~1건). chartPrefs 노출. (검증: §Validation)
- **완만한 빌드업 누락**: 마진 방식은 *급격한 점프/폭발*은 잡지만, 기록을 찔끔찔끔(<마진) 갱신하며
  완만히 쌓이는 벽은 놓칠 수 있다(테크윙 정오 매수벽 51k가 예). 필요 시 §Backlog의 급등(surge) 신호를
  보조로 추가 검토.
- **Phase 2 쿼터 경쟁**: 234종목 연속 폴링이 스크리너 백필·range 조회와 15/sec 버킷을 경쟁 →
  실측으로 background 우선순위·사이클 cap 조정 필요. 최악의 경우 폴링 universe를 "당일 활성(거래량/변동)
  종목"으로 축소하는 안(§Backlog) 검토.
- **세션 경계/장 마감**: 자정 롤오버·동시호가 구간(08:50~)에서 상태 리셋·게이팅 타이밍은 기존
  `session_gate`와 정합 맞춰야 함.

## Validation (2026-06-12, 오늘 live 17종목)

throwaway 하네스(`$CLAUDE_JOB_DIR/tmp/`의 strategies.py·causal_surge.py·prominence.py 등)로
같은 실데이터에 다수 전략 bake-off:

| 전략 | 종목당 발사 | 테크윙 14:28 매도벽 277k |
|------|------------|-------------------------|
| 신고가(마진0) | 21.7 | 잡음(다수에 묻힘) |
| 90% 재접근+히스(폐기) | 35.8 | **놓침**(폭발 직전 disarm) |
| 돌출도(prominence) 산-경신(causal, 폐기) | 3.8~26 | 잡되 작은벽 노이즈 + disarm 함정 재현 |
| **running max + 마진 50% (채택)** | **1.9** | **잡음(onset 14:27:39, +125%)** |
| running max + 마진 80% | 1.1 | 잡음 |

핵심 결론:
- 90% 재접근·히스테리시스: 과다 + 폭발적 신고가를 disarm으로 놓침 → 폐기.
- 돌출도(prominence) "산 선별": 직관적이나 봉우리 크기가 **연속체**라 자동 임계가 불안정(MAD 90·Otsu 342·gap 1~612),
  causal 버전도 "직전 산" 기준이라 작은벽 노이즈 + disarm 함정. **결국 '가장 큰 산 = running max'라 단순 마진으로 수렴** → 폐기.
- **running max + 50% 마진** 채택: 가장 단순·조용(종목당 ~2건)·폭발 항상 포착. margin은 비율이라 종목 규모
  3,895~514,127(130배)에 **종목별 튜닝 없이 그대로** 일반화. 매도/매수 독립 트랙.
- (주의: 17종목 = Live Set 최활발군이라 234 환산은 상한; 조용한 종목은 0건.)

## Out of Scope (Backlog)

- **급등(surge) 보조 신호**: `value ≥ k × 최근 30분 중앙값`(검증의 S4, 종목당 ~4.5건). 규모 불변이라
  "벽이 갑자기 나타나는 순간"에 강함. 마진 방식이 놓치는 완만한 빌드업 보완용으로 병행 검토.
- **롤링 윈도우(30분) 재접근 신호**: 이전 초안의 ②. 노이즈 주범으로 코어에서 제외. 종목별 관점에서
  유용할 여지가 있으면 옵션으로 재도입 검토.
- 급증 이벤트 → 이후 N분 가격/수익률 라벨링(이벤트 로그 기반 신호 품질 백테스트).
- 폴링 universe 적응형 축소(당일 활성 종목 우선) — Phase 2 쿼터 압박 시.
- 총잔량 외 지표(호가비·체결강도)로 같은 감지 프레임워크 일반화.
- 종목·그룹별 파라미터 오버라이드(주도주는 더 민감하게 등).
- 알림 push(브라우저 Notification API / 모바일) — 현재는 피드 폴링 + 소리까지만.
