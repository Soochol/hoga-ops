# 캡처 헬스 가시화 — 단일 술어 + 구독 ACK 추적 + 일경계 상태 리셋

- **Date**: 2026-06-08
- **Status**: Approved (brainstorming 2026-06-08 — findings·코드·advisor 검증)
- **Scope**: `both` — `hoga/live/{ws_client,lifecycle,stream}.py` + `frontend/src/live/*` (pill)
- **Topic slug**: `capture-health-visibility`
- **관련 리뷰**: 2026-06-07 멀티에이전트 리뷰 #4(watchdog rt_cd 무검사)·#7(cycle_lag UI 블라인드)·#15(R1 데일리 경고) + ship 스킵분(stream.py:116 재개방 fill 라벨)
- **관련 ADR**: [ADR-0064](../../adr/0064-live-poller-silent-death-and-calendar-gate.md) (watchdog silent-death)

---

## 1. 문제 (코드 검증 2026-06-08)

캡처가 죽어도 **사용자·watchdog 모두 모른다**:

| # | 문제 | 근거 |
|---|------|------|
| #7 | `get_status`가 `cycle_lag_ms=0` 하드코딩(lifecycle.py:203)인데 프론트 pill(LivePage.tsx:102)이 여전히 이 값으로 캡처 헬스를 렌더 → KIS WS가 정지해도 UI는 영구 'lag 0ms' 정상 | last_tick_ms/ws_connected는 wire에 있으나 pill이 미소비 |
| #4 | watchdog 신호가 `last_recv_ms`(PINGPONG 포함) 단독 — 구독 거부/상실 시 소켓은 살아 PINGPONG이 last_recv를 갱신, 캡처만 죽은 상태를 무감지 | ws_client.py:160 control 프레임 INFO 로그만, rt_cd 미검사 |
| #15 | R1 일경계 백스톱 WARNING(stream.py:105-111)이 매 거래일 아침 무조건 발화 — 전일 drain이 `_last_flush_date`를 어제로 래치하고 개장 시드 없음 → suspend/시계점프 탐지 신호가 일상 소음화 | |
| ship 스킵 | 같은 날 게이트 재개방(반장일 등) 시 `last_flush_ms`가 drain 시각이라 첫 재개방 윈도 fill 라벨이 수시간 과거 | stream.py:116 |

**advisor 핵심 통찰**: #4와 #7은 별개가 아니다. `now - last_recv_ms`로 pill을 만들면 #4의 버그(구독 죽어도 PINGPONG이 last_recv 갱신)를 **UI 거짓-그린**으로 재현한다. `last_tick_ms` 단독은 한산한 종목을 거짓-레드로 만든다. 둘 다 단독으로는 틀리다 → **단일 헬스 술어**를 watchdog과 pill이 공유해야 한다.

## 2. 설계

### 2.1 구독 ACK 추적 (`ws_client.py`) — #4의 누락 입력 생산

KIS 구독 ACK는 control 프레임의 `body.rt_cd`로 온다 (2026-06-08 녹화 control.txt 확인: 성공 = `{"body":{"rt_cd":"0","msg_cd":"OPSP0000",...}}`, tr_id는 데이터 TR id). KisWsClient가 **이번 연결**의 구독 확인을 카운트:

- `sub_expected: int` — 연결 시 보낸 구독 수 (= `len(codes) * len(_TRS)`).
- `sub_acked: int` — `rt_cd == "0"` ACK 수신 수.
- `sub_rejected: int` — `rt_cd != "0"` 수신 수 (거부 — 로그 WARNING).
- 연결 수립 시 3개 전부 0 리셋, `_send_subscriptions` 후 `sub_expected` 설정. control 프레임(PINGPONG 외)에서 `rt_cd` 파싱해 카운트.

> ⚠️ **미관측 와이어 가정**(advisor): 거부 ACK의 정확한 rt_cd/msg_cd 형태는 미검증 — 2026-06-08 녹화는 41한도 미만이라 성공 ACK만 담겼다. 그래서 거부를 특정 코드 패턴으로 잡지 않고 **"기대한 N개 rt_cd==0 ACK의 부재"**로 설계한다(`sub_acked < sub_expected`). 부분 구독(일부 성공·일부 실패)도 "전부 확인" 술어가 자연히 처리.

### 2.2 단일 헬스 술어 (`lifecycle.py`) — watchdog·pill 공유

순수 함수 `_capture_health(*, running, ws, now_ms, ref_ms, stale_after_ms) -> tuple[bool, str]` → `(healthy, reason)`:

```
running=False(미기동/creds 없음)         → (False, "offline")
ws.connected=False                       → (False, "reconnecting")   # 백오프 중 — 정상 자가치유
sub_acked < sub_expected:
    grace 내(now-ref ≤ stale_after)      → (False, "subscribing")    # 연결 직후 ACK 대기 — 정상
    grace 경과                           → (False, "sub_failed")     # 구독 미확인 — 이상(거부/상실)
last_recv 없음 or now-last_recv > grace  → (False, "stale")          # silent stall
else                                     → (True,  "healthy")
```

`get_status`가 `capture_healthy: bool` + `capture_reason: str`을 LiveStatus에 추가 노출. `cycle_lag_ms=0`은 wire 호환 위해 유지(차기 정리 후보, 주석).

### 2.3 watchdog 재시작 정책 (`_ws_watchdog_check`)

기존 `(dead OR stale)` 재시작에 헬스를 합류시키되 **재시작은 소켓 문제만**:

- `dead`(task 종료) OR `reason=="stale"`(silent stall) → 재시작 (기존 유지).
- `reason=="sub_failed"` → **재시작 안 함** + WARNING 로그. 구독 거부(예: 공유 appkey 한도 잠식)는 재연결로 안 풀려 재시작 폭풍만 유발 — 가시화(pill 빨강 + 로그)가 올바른 대응. `capture_healthy=False`로 이미 화면에 드러난다.
- `subscribing`/`reconnecting`은 정상 진행 — 무동작.

### 2.4 일경계 상태 리셋 (`stream.py`) — #15 + ship 스킵분

open→closed drain 분기(run_flush_loop, stream.py:149-155)에서 `_ds.reset()` 옆에 추가:

```python
self._last_flush_date = None   # #15: 개장 첫 flush가 어제 날짜와 비교해 경고하지 않도록
self.last_flush_ms = None      # ship 스킵분: 재개방 첫 윈도 fill 라벨이 now−FLUSH_INTERVAL 폴백
```

R1 백스톱은 보존된다: 정상 drain 경로만 리셋하므로, **drain 없이** 날짜가 바뀌는 진짜 케이스(프로세스가 게이트를 못 본 suspend/시계점프)에선 `_last_flush_date`가 어제로 남아 경고가 정상 발화.

## 3. 데이터 흐름

```
KIS control 프레임 ──rt_cd──▶ ws_client(sub_acked/rejected/expected)
                                      │
                  ┌───────────────────┴───────────────────┐
            _capture_health(ws, now, grace)         (공유 순수 함수)
                  │                                         │
        watchdog: dead|stale→재시작            get_status: capture_healthy+reason
        sub_failed→로그(재시작 X)                      │
                                              LiveStatus(wire) ──▶ 프론트 pill
```

## 4. 테스트 전략 (TDD)

1. **ws_client 구독 카운트**: FakeWs로 성공 ACK 2건+거부 1건 재생 → `sub_acked==2, sub_rejected==1`; 재연결 시 0 리셋.
2. **_capture_health 분기**: 6개 reason 각각 (offline/reconnecting/subscribing/sub_failed/stale/healthy) 단위 테스트 — ws 스텁 + now/ref/grace 주입.
3. **watchdog 정책**: `stale`→재시작(`_spy_start_stream` 호출), `sub_failed`→재시작 안 함+WARNING, `subscribing`→무동작.
4. **get_status 노출**: healthy/unhealthy 상태에서 capture_healthy/capture_reason 값.
5. **stream 일경계**: drain 후 개장 첫 flush에 R1 경고 미발화(caplog) + 재개방 fill 라벨이 now−FLUSH_INTERVAL.
6. **프론트 pill**: capture_healthy/reason별 pill 상태(색·라벨) 단위 테스트(captureHealthPill). cycle_lag 임계 로직 대체.

> 한계(advisor): pill이 *실제로* 빨강으로 렌더되는 것은 트리거된 장애가 필요(구독 거부를 보려면 41한도 의도 초과) — 단위(임계 로직)+타입 수준 검증, 실렌더는 closed-phase와 같은 caveat 클래스.

## 5. 수용한 트레이드오프

- `cycle_lag_ms` 필드는 0으로 유지(제거는 wire 변경 — 차기 정리). 의미는 `capture_healthy`로 이전.
- 거부 와이어 형태 미검증 — 부재 기반 설계로 우회, 모의 한도 초과 실측은 후속.
- sub_failed 재시작 안 함 — 거부는 재시작 불응이라 가시화로 충분. dead/stale만 재시작.

## 6. 비범위

- 나머지 P1 데이터 손실 클래스 #8(반장일 12:30)·#11(flush 내구성)·#14(mixed-day fills) — **다음 묶음**(severity 우선). #10(브로커 canonical)·#9(거래원 궤적 15분) cleanup은 그 후.
- #3(30초 개장 sleep)은 이 묶음의 헬스와 무관 — 별도(게이트 닫힘 폴링 주기 단축).
