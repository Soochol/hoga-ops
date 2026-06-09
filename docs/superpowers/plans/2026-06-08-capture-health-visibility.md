# 캡처 헬스 가시화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 캡처가 죽으면 watchdog과 /live pill이 같은 "캡처 헬스" 술어로 감지·표시 — 구독 ACK 추적(#4) + capture_healthy 필드+pill(#7) + 일경계 상태 리셋(#15 + ship 스킵분).

**Architecture:** ws_client가 연결별 구독 ACK(rt_cd==0)를 카운트 → lifecycle의 순수 함수 `_capture_health()`가 (healthy, reason) 판정 → watchdog(재시작은 dead/stale만)과 get_status(capture_healthy/reason)가 공유 → 프론트 pill이 새 필드 소비. stream drain 분기에서 일경계 상태 리셋. Spec: `docs/superpowers/specs/2026-06-08-capture-health-visibility-design.md`.

**Tech Stack:** Python(pytest, asyncio), FastAPI 응답 모델(pydantic), React/TS(vitest).

---

## 핵심 맥락 (구현자가 알아야 할 것)

- **KIS 구독 ACK 형태** (2026-06-08 녹화 control.txt 확인): `{"header":{"tr_id":"H0STASP0",...},"body":{"rt_cd":"0","msg_cd":"OPSP0000",...}}`. 성공 = `body.rt_cd == "0"`. PINGPONG은 `header.tr_id == "PINGPONG"`. 거부 형태는 미관측 → **"rt_cd가 0이 아닌 모든 control 프레임"**을 거부로 처리(부재 기반).
- **ws_client.py** (현재): `run()` 연결 블록 line 78-88이 `_sub_lock` 안에서 ws 공개+초기 구독(`tr_type="1"`). `_recv_loop` line 151-161의 `else` 분기가 control 프레임(PINGPONG echo + 나머지 INFO 로그). `_TRS`는 3종(호가·체결·회원사).
- **lifecycle.py** (현재): `_ws_watchdog_check`(line 390~)가 `dead`(task done) 또는 `stale`(last_recv grace 초과) 시 재시작. `get_status`(line 178~)가 `cycle_lag_ms=0` 하드코딩, ws에서 connected/last_tick_ms 읽음. `LiveStatus`(line 90~) pydantic 모델.
- **stream.py** (현재): `run_flush_loop` line 149-155 open→closed drain 분기에서 `_ds.reset()` + `gate_closed_drained` 로그. `_last_flush_date`(line 64), `last_flush_ms`(line 63).
- **프론트**: `cycleLagPill.ts`(severity 분류), `LiveStatusBar.tsx:119` `data-testid="cycle-lag-pill"`, `LivePage.tsx:102` `cycleLagMs={status?.cycle_lag_ms ?? 0}`, `liveStatus.ts` LiveStatus 타입.
- **테스트 픽스처**: `test_ws_client.py`의 `FakeWs(script)`(recv 스크립트 재생), `test_lifecycle.py`의 `_install_stream_state`/`_FakeWs`/`_spy_start_stream`, `test_stream.py`의 gate monkeypatch 패턴.

---

### Task 1: ws_client 구독 ACK 추적 (#4 입력 생산)

**Files:**
- Modify: `hoga/live/ws_client.py` (멤버 3개 + 연결 리셋 + control 분기 rt_cd 파싱)
- Test: `tests/unit/live/test_ws_client.py`

- [ ] **Step 1: 실패 테스트 작성** — `test_recv_loop_decodes_bytes_data_frames` 아래에 추가:

```python
async def test_recv_loop_counts_subscription_acks():
    """spec 2026-06-08 §2.1: control 프레임의 body.rt_cd로 구독 확인을 센다 —
    rt_cd=='0'은 sub_acked, 그 외는 sub_rejected(+WARNING). watchdog/pill의
    헬스 술어가 '기대 ACK의 부재'로 구독 거부를 감지하는 입력."""
    ok = '{"header":{"tr_id":"H0STASP0","tr_key":"005930"},"body":{"rt_cd":"0","msg_cd":"OPSP0000","msg1":"SUBSCRIBE SUCCESS"}}'
    ok2 = '{"header":{"tr_id":"H0STCNT0","tr_key":"005930"},"body":{"rt_cd":"0","msg_cd":"OPSP0000"}}'
    reject = '{"header":{"tr_id":"H0STMBC0","tr_key":"005930"},"body":{"rt_cd":"1","msg_cd":"OPSP0002","msg1":"ALREADY IN SUBSCRIBE"}}'
    fake = FakeWs([ok, ok2, reject])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert client.sub_acked == 2
    assert client.sub_rejected == 1


async def test_subscription_counters_reset_fields_exist():
    """연결 전 기본값 — sub_expected/acked/rejected는 0에서 시작."""
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    assert client.sub_expected == 0
    assert client.sub_acked == 0
    assert client.sub_rejected == 0
```

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_ws_client.py::test_recv_loop_counts_subscription_acks tests/unit/live/test_ws_client.py::test_subscription_counters_reset_fields_exist -q`
Expected: FAIL — `AttributeError: 'KisWsClient' object has no attribute 'sub_acked'`.

- [ ] **Step 3: 구현 — 멤버 추가** (`ws_client.py` `__init__`, line 60 `self.connected` 아래):

```python
        # 구독 확인 추적(spec 2026-06-08 §2.1): 이번 연결의 초기 구독 ACK.
        # 헬스 술어가 '기대 ACK의 부재'(sub_acked < sub_expected)로 구독
        # 거부/상실을 감지한다. update_codes diff는 범위 밖(초기 구독만).
        self.sub_expected: int = 0
        self.sub_acked: int = 0
        self.sub_rejected: int = 0
```

- [ ] **Step 4: 구현 — 연결 시 리셋 + expected 설정** (`ws_client.py` `run()`, `_sub_lock` 블록 line 81-88, `codes_now = list(self._codes)` 아래·`_send_subscriptions` 호출 위):

기존:
```python
                        codes_now = list(self._codes)
                        await self._send_subscriptions(
                            ws, approval, codes_now, tr_type="1"
                        )
```
교체:
```python
                        codes_now = list(self._codes)
                        # 연결별 구독 확인 카운터 리셋(spec §2.1) — 초기 구독 수가 기대치.
                        self.sub_expected = len(codes_now) * len(_TRS)
                        self.sub_acked = 0
                        self.sub_rejected = 0
                        await self._send_subscriptions(
                            ws, approval, codes_now, tr_type="1"
                        )
```

- [ ] **Step 5: 구현 — control 분기 rt_cd 파싱** (`ws_client.py` `_recv_loop`, line 159-161 `else` 분기 교체):

기존:
```python
                else:
                    _log.info("live.ws.control tr_id=%s msg=%s",
                              tr_id, str(msg.get("body", {}))[:200])
```
교체:
```python
                else:
                    # 구독 ACK 카운트(spec §2.1): rt_cd=="0" 성공, 그 외 거부.
                    # 거부 형태는 미관측이라 '0이 아닌 모든 control'을 거부로 본다.
                    rt_cd = msg.get("body", {}).get("rt_cd")
                    if rt_cd == "0":
                        self.sub_acked += 1
                        _log.info("live.ws.subscribed tr_id=%s", tr_id)
                    else:
                        self.sub_rejected += 1
                        _log.warning("live.ws.sub_rejected tr_id=%s msg=%s",
                                     tr_id, str(msg.get("body", {}))[:200])
```

- [ ] **Step 6: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_ws_client.py -q`
Expected: 전부 PASS.

- [ ] **Step 7: 커밋**

```bash
git add hoga/live/ws_client.py tests/unit/live/test_ws_client.py
git commit -m "feat(live): ws_client 구독 ACK 추적 — 헬스 술어 입력 (스펙 §2.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `_capture_health` 순수 함수 + get_status 노출 (#7)

**Files:**
- Modify: `hoga/live/lifecycle.py` (순수 함수 + LiveStatus 필드 2개 + get_status)
- Test: `tests/unit/live/test_lifecycle.py`

- [ ] **Step 1: 실패 테스트 작성** — `test_lifecycle.py` 끝에 추가:

```python
def test_capture_health_branches():
    """spec 2026-06-08 §2.2: 단일 헬스 술어 7상태. last_recv 단독(거짓-그린)도
    last_tick 단독(거짓-레드)도 아닌, 구독 확인 + 수신 신선도 결합. recv 체크가
    sub보다 먼저 — sub 미확인이어도 recv 끊기면 'stale'(dead socket→재시작),
    recv 신선하면 'sub_failed'(거부→가시화)로 갈린다(advisor B)."""
    from types import SimpleNamespace
    from hoga.live.lifecycle import _capture_health

    GRACE = 120_000
    NOW = 10_000_000
    REF = NOW - 200_000  # grace 경과 기준점

    def ws(connected, expected, acked, last_recv):
        return SimpleNamespace(connected=connected, sub_expected=expected,
                               sub_acked=acked, last_recv_ms=last_recv)

    # 미기동
    assert _capture_health(running=False, ws=None, now_ms=NOW, ref_ms=REF,
                           stale_after_ms=GRACE, market_closed=False) == (False, "offline")
    # 장외(순수 시계) — running=True여도 closed가 우선(밤·주말 거짓-앰버 방지)
    assert _capture_health(running=True, ws=ws(False, 39, 0, None), now_ms=NOW,
                           ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=True) == (False, "closed")
    # 재연결(백오프) — 장중인데 미연결
    assert _capture_health(running=True, ws=ws(False, 39, 0, None), now_ms=NOW,
                           ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (False, "reconnecting")
    # 구독 대기(grace 내, recv 신선)
    assert _capture_health(running=True, ws=ws(True, 39, 10, NOW - 1000),
                           now_ms=NOW, ref_ms=NOW - 1000, stale_after_ms=GRACE,
                           market_closed=False) == (False, "subscribing")
    # 구독 실패(grace 경과, 미확인, recv 신선) — appkey 거부류, 재시작 안 함
    assert _capture_health(running=True, ws=ws(True, 39, 10, NOW - 1000),
                           now_ms=NOW, ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (False, "sub_failed")
    # silent stall(recv 끊김) — sub 미확인이어도 recv가 먼저라 stale(재시작)
    assert _capture_health(running=True, ws=ws(True, 39, 10, NOW - 200_000),
                           now_ms=NOW, ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (False, "stale")
    # 정상
    assert _capture_health(running=True, ws=ws(True, 39, 39, NOW - 1000),
                           now_ms=NOW, ref_ms=REF, stale_after_ms=GRACE,
                           market_closed=False) == (True, "healthy")


@pytest.mark.asyncio
async def test_get_status_exposes_capture_health(monkeypatch, tmp_path) -> None:
    """get_status가 capture_healthy/capture_reason를 노출 — 정상 ws."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()

    class _FakeWs:
        connected = True
        sub_expected = 3
        sub_acked = 3
        last_tick_ms = None
        last_recv_ms = lifecycle._now_ms()

    class _FakeStream:
        ws = _FakeWs()

    async def _forever():
        await asyncio.sleep(60)
    task = asyncio.create_task(_forever())
    try:
        lifecycle._state = _State(
            started_at_ms=lifecycle._now_ms() - 200_000,
            watchlist_codes=("005930",), stream_task=task,
            stream_obj=_FakeStream(), live_set=("005930",),
        )
        # 장중으로 고정해 closed가 healthy를 가리지 않게(순수 시계 헬퍼 패치).
        monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture",
                            lambda _now: False)
        st = lifecycle.get_status()
        assert st.capture_healthy is True
        assert st.capture_reason == "healthy"
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
```

`test_lifecycle.py` 상단 import에 `import contextlib`가 없으면 추가(이미 다른 테스트가 쓰면 생략).

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_lifecycle.py::test_capture_health_branches tests/unit/live/test_lifecycle.py::test_get_status_exposes_capture_health -q`
Expected: FAIL — `ImportError: cannot import name '_capture_health'` / `AttributeError: ... 'capture_healthy'`.

- [ ] **Step 3: 구현 — 순수 시계 헬퍼 + 헬스 함수** (`lifecycle.py`, `get_status` 정의 위에 추가).

먼저 순수 시계 게이트 근사 (캘린더 HTTP 없음 — get_status가 sync 경로라 필수, advisor A):

```python
def _market_clock_closed_for_capture(now_ms: int) -> bool:
    """캡처 게이트(ws_capture_window)의 순수-시계 근사 — 주말 또는 정규장
    (09:00–15:30 KST) 밖이면 True. get_status는 sync 라우트라 캘린더 HTTP
    (is_trading_session_today)를 못 쓴다(0a67a3e가 to_thread로 격리한 그 블록).
    그래서 _quote_phase와 같은 순수 weekday+clock으로 'closed'를 판정해 밤·주말
    pill 거짓-앰버를 막는다. 평일 공휴일 장중은 'closed'로 안 잡혀 reconnecting
    앰버로 보이나 드물어 수용(quote 게이트와 동일 트레이드오프)."""
    from datetime import datetime  # noqa: PLC0415
    from .kis_client import KIS_KST  # noqa: PLC0415
    from .session_gate import market_phase  # noqa: PLC0415
    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    if kst.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return True
    return market_phase(now_ms) != "regular"  # regular = 09:00–15:30


def _capture_health(
    *, running: bool, ws: object | None, now_ms: int, ref_ms: int,
    stale_after_ms: int, market_closed: bool,
) -> tuple[bool, str]:
    """캡처 헬스 단일 술어(spec 2026-06-08 §2.2) — watchdog과 get_status가 공유.

    last_recv 단독은 구독이 죽어도 PINGPONG이 갱신해 거짓-그린(리뷰 #4),
    last_tick 단독은 한산한 종목을 거짓-레드로 만든다. 그래서 '구독 확인 +
    수신 신선도'를 결합한다. ref_ms = max(started, session_open) — 세션 기준
    grace 시작점(watchdog과 동일).

    체크 순서가 핵심(advisor B): recv(stale)를 sub보다 먼저 본다 — sub 미확인
    이어도 수신이 끊겼으면 dead socket이라 'stale'(watchdog 재시작), 수신이
    신선하면 'sub_failed'(appkey 거부류 — 재연결 불응, 가시화만)로 갈린다.
    """
    if not running or ws is None:
        return (False, "offline")
    if market_closed:
        return (False, "closed")
    if not getattr(ws, "connected", False):
        return (False, "reconnecting")
    grace_elapsed = (now_ms - ref_ms) > stale_after_ms
    last_recv = getattr(ws, "last_recv_ms", None)
    recv_stale = grace_elapsed and (
        last_recv is None or (now_ms - last_recv) > stale_after_ms
    )
    if recv_stale:
        return (False, "stale")
    expected = getattr(ws, "sub_expected", 0)
    acked = getattr(ws, "sub_acked", 0)
    if expected > 0 and acked < expected:
        return (False, "sub_failed" if grace_elapsed else "subscribing")
    return (True, "healthy")
```

- [ ] **Step 4: 구현 — LiveStatus 필드** (`lifecycle.py` `LiveStatus` 모델, `ws_connected: bool = False` 아래):

```python
    # 캡처 헬스(spec 2026-06-08 §2.2) — cycle_lag_ms를 대체하는 정직한 신호.
    capture_healthy: bool = True
    capture_reason: str = "offline"
```

- [ ] **Step 5: 구현 — get_status 계산** (`lifecycle.py` `get_status`, `return LiveStatus(...)` 직전에 헬스 계산 추가, 그리고 LiveStatus 생성에 두 필드 전달):

`get_status` 안에서 `task`/`running`/`stream`/`ws`는 이미 계산됨(line 183-197). `return LiveStatus(` 직전에:

```python
    from datetime import datetime  # noqa: PLC0415
    from .kis_client import KIS_KST  # noqa: PLC0415
    now_ms = _now_ms()
    started = _state.started_at_ms
    if started is None:
        cap_healthy, cap_reason = (False, "offline")
    else:
        kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
        session_open_ms = int(
            kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
        )
        ref_ms = max(started, session_open_ms)
        cap_healthy, cap_reason = _capture_health(
            running=running, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
            stale_after_ms=_WATCHDOG_STALE_AFTER_MS,
            market_closed=_market_clock_closed_for_capture(now_ms),
        )
```

그리고 `return LiveStatus(...)`에 추가:
```python
        capture_healthy=cap_healthy,
        capture_reason=cap_reason,
```

(주의: `ws`는 line 191에서 `getattr(stream, "ws", None)`로 이미 잡힘. `_WATCHDOG_STALE_AFTER_MS`는 모듈 상수 line 277.)

- [ ] **Step 6: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_lifecycle.py -q`
Expected: 전부 PASS (기존 watchdog/status 테스트 포함 — capture_healthy/reason 기본값이 추가됐을 뿐 기존 필드 불변).

- [ ] **Step 7: 커밋**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle.py
git commit -m "feat(live): _capture_health 단일 술어 + get_status 노출 (스펙 §2.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: watchdog 재시작 정책 (#4 — sub_failed는 가시화만)

**Files:**
- Modify: `hoga/live/lifecycle.py` (`_ws_watchdog_check` stale 계산을 _capture_health로)
- Test: `tests/unit/live/test_lifecycle.py`

- [ ] **Step 1: 실패 테스트 작성** — Task 2 테스트 아래에 추가. **두 입력이 핵심(advisor B)**: sub 미확인+recv 신선 → 재시작 안 함(거부류); sub 미확인+recv 끊김 → 재시작(dead socket). 후자가 old 코드와 발산하는 진짜 RED:

```python
@pytest.mark.asyncio
async def test_watchdog_does_not_restart_on_sub_failed_when_recv_fresh(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """spec §2.3: 구독 미확인이지만 수신 신선(appkey 거부류 — PINGPONG은 흐름)
    → 재시작 안 함(재연결 불응, 가시화만)."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.ws_capture_window", lambda _t: True)

    async def _forever():
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_tick_ms=None, last_recv_ms=9_950_000,
        )
        lifecycle._state.stream_obj.ws.sub_expected = 39
        lifecycle._state.stream_obj.ws.sub_acked = 10   # 미확인
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is False           # recv 신선 → 재시작 안 함
        assert _spy_start_stream == []
    finally:
        for t in (ws_task, stream_task):
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t


@pytest.mark.asyncio
async def test_watchdog_restarts_when_sub_unacked_and_recv_stale(
    monkeypatch, _spy_start_stream, tmp_path
) -> None:
    """spec §2.3 + advisor B: 구독 미확인 AND 수신 끊김 = dead socket → 재시작.
    recv 체크가 sub보다 먼저라 'stale'로 분류돼야 한다(이게 old 순차 코드와
    동일하게 재시작하는 발산 입력 — 진짜 RED→GREEN)."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setattr("hoga.live.session_gate.ws_capture_window", lambda _t: True)

    async def _forever():
        await asyncio.sleep(60)
    ws_task = asyncio.create_task(_forever())
    stream_task = asyncio.create_task(_forever())
    try:
        # last_recv가 grace 너머(now 10_000_000, recv 9_000_000 = 1000s 전 > 120s)
        _install_stream_state(
            monkeypatch, started_at_ms=1_000, ws_task=ws_task,
            stream_task=stream_task, last_tick_ms=None, last_recv_ms=9_000_000,
        )
        lifecycle._state.stream_obj.ws.sub_expected = 39
        lifecycle._state.stream_obj.ws.sub_acked = 10   # 미확인이지만 recv가 먼저
        restarted = await lifecycle._ws_watchdog_check(
            data_dir=tmp_path, now_ms=10_000_000, stale_after_ms=120_000
        )
        assert restarted is True            # stale → 재시작
        assert _spy_start_stream == [tmp_path]
    finally:
        for t in (ws_task, stream_task):
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t
```

`_install_stream_state`의 `_FakeWs`에 `sub_expected`/`sub_acked` 속성이 없으면 Step 3에서 헬퍼를 보강한다.

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_lifecycle.py::test_watchdog_does_not_restart_on_sub_failed_when_recv_fresh tests/unit/live/test_lifecycle.py::test_watchdog_restarts_when_sub_unacked_and_recv_stale -q`
Expected: 첫 테스트는 `_FakeWs`에 `sub_expected` 속성 부재로 AttributeError(또는 보강 후 통과). 둘째 테스트가 진짜 RED일 수 있으나 — old 코드도 recv_stale→stale→재시작이라 둘째는 old에서도 통과. 핵심 RED는 **첫 테스트가 새 sub_failed 분기 없이는 검증 불가**라는 점 + 헬퍼 속성. (RED가 약하면 Step 3 적용 후 GREEN으로 두 입력의 분기를 확정 — 회귀 가드 역할.)

- [ ] **Step 3: 구현 — _FakeWs 헬퍼 보강 + watchdog 통합.**

먼저 `test_lifecycle.py`의 `_install_stream_state` 내 `_FakeWs.__init__`에 구독 기본값 추가 (정상 케이스는 확인 완료로 둬 기존 테스트 불변):
```python
        def __init__(self, tick_ms, recv_ms):
            self.last_tick_ms = tick_ms
            self.last_recv_ms = recv_ms
            self.connected = recv_ms is not None
            self.sub_expected = 3      # 헬스 술어용 기본값(확인 완료 상태)
            self.sub_acked = 3
```

그 다음 `lifecycle.py` `_ws_watchdog_check`의 stale 계산(line 432-442 부근)을 _capture_health로 교체. 기존:
```python
    stream = _state.stream_obj
    ws = getattr(stream, "ws", None) if stream is not None else None
    last_recv = getattr(ws, "last_recv_ms", None) if ws is not None else None

    grace_elapsed = (now_ms - ref_ms) > stale_after_ms
    recv_fresh = (
        last_recv is not None
        and last_recv >= session_open_ms
        and (now_ms - last_recv) <= stale_after_ms
    )
    stale = (not dead) and grace_elapsed and (not recv_fresh)
    if dead or stale:
        _log.warning(
            "live.stream.watchdog_restart dead=%s stale=%s last_recv_ms=%s",
            dead, stale, last_recv,
        )
        await start_live_stream(data_dir=data_dir)
        return True
    return False
```
교체:
```python
    stream = _state.stream_obj
    ws = getattr(stream, "ws", None) if stream is not None else None
    # watchdog은 line 411에서 이미 ws_capture_window로 게이트했으므로 여기선
    # 항상 장중 — market_closed=False(헬스 술어의 closed 단락을 우회).
    healthy, reason = _capture_health(
        running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
        stale_after_ms=stale_after_ms, market_closed=False,
    )
    # 재시작은 소켓 문제만(dead/stale) — 구독 거부(sub_failed)는 재연결로 안
    # 풀려 폭풍만 유발하므로 가시화(capture_healthy=False)에 맡기고 WARNING만
    # 남긴다(spec §2.3). subscribing/reconnecting은 정상 진행 — 무동작.
    if dead or reason == "stale":
        _log.warning("live.stream.watchdog_restart dead=%s reason=%s", dead, reason)
        await start_live_stream(data_dir=data_dir)
        return True
    if reason == "sub_failed":
        _log.warning("live.stream.sub_failed acked=%s expected=%s — 재시작 안 함(가시화)",
                     getattr(ws, "sub_acked", 0), getattr(ws, "sub_expected", 0))
    return False
```

(주의: `_capture_health`가 `running=True`로 호출되는 건 watchdog이 이미 `started is not None` + task liveness를 위에서 확인했기 때문. `dead`는 task done이라 `_capture_health`의 connected와 별개로 위에서 계산됨.)

- [ ] **Step 4: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_lifecycle.py -q`
Expected: 전부 PASS — 특히 기존 `test_ws_watchdog_restarts_dead_stream...`, `test_ws_watchdog_noop_when_healthy`, `test_ws_watchdog_gate_runs_off_event_loop`가 무수정 그린 (정상 _FakeWs가 sub_acked==sub_expected라 healthy).

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle.py
git commit -m "feat(live): watchdog가 _capture_health 공유 — sub_failed는 가시화만, dead/stale만 재시작 (스펙 §2.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: stream 일경계 상태 리셋 (#15 + ship 스킵분)

**Files:**
- Modify: `hoga/live/stream.py` (drain 분기에 2줄)
- Test: `tests/unit/live/test_stream.py`

- [ ] **Step 1: 실패 테스트 작성** — `test_stream.py` 끝에 추가:

```python
async def test_drain_resets_day_state_no_morning_warning(tmp_path, monkeypatch, caplog):
    """spec 2026-06-08 §2.4: open→closed drain이 _last_flush_date/last_flush_ms를
    리셋 — 다음 개장 첫 flush가 (#15) R1 경고를 발화하지 않고 (ship 스킵분)
    fill 라벨이 now−FLUSH_INTERVAL 폴백."""
    import logging
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    stream._gate_open = True
    now = int(time.time() * 1000)
    # 어제 윈도 1회 flush — _last_flush_date='20260605', last_flush_ms 설정
    await stream.on_tick(_ob_tick(now, tot_ask=111))
    await stream.flush_once(now_ms=now)
    assert stream._last_flush_date == "20260605"
    # drain 시뮬레이션(open→closed 전환의 리셋 부분만 직접 호출)
    stream._ds.reset()
    stream._last_flush_date = None
    stream.last_flush_ms = None
    # 다음 거래일 개장 첫 flush — 날짜가 바뀌었지만 _last_flush_date=None이라
    # R1 경고 미발화
    stream._date_fn = lambda: "20260608"
    with caplog.at_level(logging.WARNING, logger="hoga.live.stream"):
        await stream.flush_once(now_ms=now + 86_400_000)
    assert not any("stale_state_reset" in r.message for r in caplog.records)
```

(이 테스트는 drain 리셋을 직접 호출해 단위 검증 — run_flush_loop 전체 전환은 기존 `test_run_flush_loop_drains_resets...`가 커버. 핵심은 리셋 후 개장 flush가 경고 안 함.)

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_stream.py::test_drain_resets_day_state_no_morning_warning -q`
Expected: FAIL — 현재는 drain이 `_last_flush_date`를 리셋하지 않으므로(테스트가 직접 None 설정해도 통과할 수 있음 — 이 경우 테스트가 검증하는 건 "리셋되면 경고 안 함"이라 GREEN일 수 있다). **RED를 보장하려면** 테스트에서 직접 None 설정하는 3줄을 빼고 run_flush_loop 전환에 의존해야 하지만, 단위 단순화를 위해 아래 Step 3에서 production 리셋을 추가하고 테스트는 "리셋이 일어난다"를 run_flush_loop로 검증하는 변형을 쓴다 — 아래 Step 3의 테스트 교체 참고.

**RED 보장 위해 Step 1 테스트를 다음으로 교체** (drain을 run_flush_loop로 실제 트리거):
```python
async def test_drain_resets_day_state_no_morning_warning(tmp_path, monkeypatch, caplog):
    """spec §2.4: open→closed drain이 일경계 상태를 리셋 → 다음 개장 첫 flush가
    R1 경고 미발화 + fill 라벨 폴백. drain을 run_flush_loop 전환으로 실제 트리거."""
    import logging
    monkeypatch.setattr(stream_mod, "FLUSH_INTERVAL_S", 0.05)
    monkeypatch.setattr(stream_mod, "IDLE_INTERVAL_S", 0.02)
    buf = LiveBuffer(); writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")
    now = int(time.time() * 1000)
    calls = {"n": 0}
    def gate(now_ms):
        calls["n"] += 1
        if calls["n"] == 1:
            stream._ds.ingest(_ob_tick(now, tot_ask=111))
            return True            # ①open: flush로 _last_flush_date 래치
        return False               # ②+ closed: drain 후 리셋
    monkeypatch.setattr(stream_mod, "ws_capture_window", gate)
    task = asyncio.create_task(stream.run_flush_loop())
    try:
        for _ in range(60):
            await asyncio.sleep(0.02)
            if calls["n"] >= 3:
                break
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    # drain 후 일경계 상태가 리셋됐는가
    assert stream._last_flush_date is None
    assert stream.last_flush_ms is None
```
이 형태는 production 리셋이 없으면 `_last_flush_date`가 '20260605'로 남아 FAIL.

- [ ] **Step 3: 구현** (`stream.py` `run_flush_loop` drain 분기, line 149-155):

기존:
```python
                if was_open:  # open→closed 전환: drain + 상태 초기화
                    try:
                        await self.flush_once()
                    except Exception:  # noqa: BLE001
                        _log.exception("live.stream.drain_flush_failed")
                    self._ds.reset()
                    _log.info("live.stream.gate_closed_drained")
```
교체:
```python
                if was_open:  # open→closed 전환: drain + 상태 초기화
                    try:
                        await self.flush_once()
                    except Exception:  # noqa: BLE001
                        _log.exception("live.stream.drain_flush_failed")
                    self._ds.reset()
                    # 일경계 상태 리셋(spec 2026-06-08 §2.4): _last_flush_date를
                    # None으로 둬 다음 개장 첫 flush가 어제 날짜와 비교해 R1
                    # 경고를 내지 않게(#15), last_flush_ms도 None으로 둬 재개방
                    # 첫 윈도 fill 라벨이 now−FLUSH_INTERVAL로 폴백(ship 스킵분).
                    # R1 백스톱은 보존: drain 없이 날짜가 바뀌는 진짜 케이스
                    # (suspend/시계점프)에선 _last_flush_date가 남아 경고가 정상 발화.
                    self._last_flush_date = None
                    self.last_flush_ms = None
                    _log.info("live.stream.gate_closed_drained")
```

- [ ] **Step 4: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_stream.py -q`
Expected: 전부 PASS — 특히 `test_flush_date_change_resets_stale_state`(R1 백스톱)와 `test_run_flush_loop_drains_resets...`가 무수정 그린.

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/stream.py tests/unit/live/test_stream.py
git commit -m "fix(live): drain 시 일경계 상태 리셋 — R1 데일리 경고 소음 제거 + 재개방 fill 라벨 (스펙 §2.4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 프론트 pill — capture_healthy 소비 (#7)

**Files:**
- Create: `frontend/src/live/captureHealthPill.ts`
- Modify: `frontend/src/api/liveStatus.ts` (타입), `frontend/src/live/LiveStatusBar.tsx`, `frontend/src/live/LivePage.tsx`
- Test: `frontend/src/live/captureHealthPill.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/live/captureHealthPill.test.ts` 생성:

```typescript
import { describe, it, expect } from 'vitest';
import { captureHealthLabel, captureHealthSeverity } from './captureHealthPill';

describe('captureHealthPill', () => {
  it('healthy → ok, 라벨 LIVE', () => {
    expect(captureHealthSeverity(true, 'healthy')).toBe('ok');
    expect(captureHealthLabel(true, 'healthy')).toMatch(/LIVE|실시간/);
  });
  it('sub_failed/stale → error (캡처 죽음, 빨강)', () => {
    expect(captureHealthSeverity(false, 'sub_failed')).toBe('error');
    expect(captureHealthSeverity(false, 'stale')).toBe('error');
  });
  it('reconnecting/subscribing → warn (전환 중, 앰버)', () => {
    expect(captureHealthSeverity(false, 'reconnecting')).toBe('warn');
    expect(captureHealthSeverity(false, 'subscribing')).toBe('warn');
  });
  it('offline/closed → ok-회색 (미기동·장마감은 장애 아님)', () => {
    expect(captureHealthSeverity(false, 'offline')).toBe('ok');
    expect(captureHealthSeverity(false, 'closed')).toBe('ok');  // 밤·주말 거짓-앰버 방지
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd frontend && npx vitest run src/live/captureHealthPill.test.ts 2>&1 | tail -5`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현 — captureHealthPill.ts**:

```typescript
/**
 * 캡처 헬스 pill — cycleLagPill을 대체(spec 2026-06-08 §2.2).
 * 백엔드 _capture_health의 (capture_healthy, capture_reason)를 pill 상태로.
 * cycle_lag_ms(0 고정)가 아니라 정직한 헬스 신호를 표시한다.
 */
export type CaptureHealthSeverity = 'ok' | 'warn' | 'error';

export function captureHealthSeverity(
  healthy: boolean,
  reason: string,
): CaptureHealthSeverity {
  if (healthy) return 'ok';
  // 장외/미기동은 장애가 아님 — 중립(회색). 'closed'는 밤·주말 정상 상태라
  // 반드시 ok여야 한다(없으면 매일 거짓-앰버 — advisor A).
  if (reason === 'offline' || reason === 'closed') return 'ok';
  // 전환 상태(재연결·구독 대기)는 곧 회복 — 경고.
  if (reason === 'reconnecting' || reason === 'subscribing') return 'warn';
  // sub_failed·stale = 캡처가 죽었는데 살아있는 척 — 에러.
  return 'error';
}

export function captureHealthLabel(healthy: boolean, reason: string): string {
  if (healthy) return 'LIVE●';
  switch (reason) {
    case 'offline': return '오프라인';
    case 'closed': return '장 마감';
    case 'reconnecting': return '재연결 중…';
    case 'subscribing': return '구독 중…';
    case 'sub_failed': return '구독 실패';
    case 'stale': return '수신 끊김';
    default: return reason;
  }
}

export function captureHealthPillColor(severity: CaptureHealthSeverity): {
  bg: string; border: string; fg: string;
} {
  switch (severity) {
    case 'error':
      return { bg: 'var(--tint-error)', border: 'var(--error)', fg: 'var(--error)' };
    case 'warn':
      return { bg: 'rgba(245, 158, 11, 0.10)', border: 'var(--warn)', fg: 'var(--warn)' };
    case 'ok':
      return { bg: 'transparent', border: 'var(--border)', fg: 'var(--fg-dimmer)' };
  }
}
```

- [ ] **Step 4: 구현 — LiveStatus 타입** (`liveStatus.ts`, `cycle_lag_ms: number;` 아래):

```typescript
  /** 캡처 헬스(spec 2026-06-08 §2.2). cycle_lag_ms(0 고정)를 대체하는 신호. */
  capture_healthy: boolean;
  capture_reason: string;
```

- [ ] **Step 5: 구현 — LivePage가 새 필드 전달** (`LivePage.tsx:102` 부근 `cycleLagMs={status?.cycle_lag_ms ?? 0}` 를 교체):

```tsx
        captureHealthy={status?.capture_healthy ?? false}
        captureReason={status?.capture_reason ?? 'offline'}
```

- [ ] **Step 6: 구현 — LiveStatusBar pill 렌더** (`LiveStatusBar.tsx`): props 시그니처에서 `cycleLagMs: number`를 `captureHealthy: boolean; captureReason: string`로 바꾸고, cycleLagPill import를 captureHealthPill로 교체, pill 렌더(line 118-130 부근)를:

```tsx
      {(() => {
        const sev = captureHealthSeverity(captureHealthy, captureReason);
        const pill = captureHealthPillColor(sev);
        return (
          <span
            data-testid="capture-health-pill"
            title={`capture_reason = ${captureReason}`}
            className="font-mono px-2 py-0.5 rounded"
            style={{
              background: pill.bg, border: `1px solid ${pill.border}`,
              color: pill.fg, fontSize: 'var(--text-xs)',
            }}
          >
            {captureHealthLabel(captureHealthy, captureReason)}
          </span>
        );
      })()}
```

상단 import: `import { captureHealthSeverity, captureHealthLabel, captureHealthPillColor } from './captureHealthPill';` 추가, `cycleLagPill` import 제거. 기존 `live ? 'LIVE●' : '재연결 중…'` span은 pill과 중복되므로 유지하되(전체 표시 일관성), 또는 pill로 일원화 — **최소 변경**으로 기존 LIVE● span은 두고 lag pill만 교체한다.

- [ ] **Step 7: 기존 cycle_lag 테스트 정리** — `LiveStatusBar.test.tsx`에서 `cycle-lag-pill`/`cycleLagMs`를 참조하는 단언을 `capture-health-pill`/`captureHealthy`로 갱신. `cycleLagPill.test.ts`가 있으면 삭제(`git rm`), `cycleLagPill.ts`도 다른 소비자 없으면 삭제 — 먼저 `grep -rn cycleLag frontend/src`로 잔존 참조 확인 후 정리.

- [ ] **Step 8: GREEN + 프론트 회귀** — Run: `cd frontend && npx vitest run src/live/ src/api/ 2>&1 | tail -5` → 전부 PASS. 타입: `npx tsc --noEmit 2>&1 | tail -3` → 에러 0.

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/live/captureHealthPill.ts frontend/src/live/captureHealthPill.test.ts frontend/src/api/liveStatus.ts frontend/src/live/LiveStatusBar.tsx frontend/src/live/LivePage.tsx frontend/src/live/LiveStatusBar.test.tsx
git rm frontend/src/live/cycleLagPill.ts frontend/src/live/cycleLagPill.test.ts 2>/dev/null || true
git commit -m "feat(frontend): 캡처 헬스 pill — cycle_lag 대체, 캡처 죽으면 빨강 (스펙 §2.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 전체 회귀 + spec 상태 갱신

- [ ] **Step 1: 백엔드 전체** — Run: `uv run pytest -q` → 1317 + 신규(약 6) = ~1323 passed.
- [ ] **Step 2: 프론트 전체** — Run: `cd frontend && npx vitest run 2>&1 | grep -E "Test Files|Tests "` + `npx tsc --noEmit` 에러 0.
- [ ] **Step 3: 린트** — Run: `uv run ruff check hoga/live/ws_client.py hoga/live/lifecycle.py hoga/live/stream.py` → baseline 외 신규 위반 0.
- [ ] **Step 4: spec Status 갱신** — `- **Status**: Approved ...` → `- **Status**: Implemented (2026-06-08)` 교체 후:

```bash
git add docs/superpowers/specs/2026-06-08-capture-health-visibility-design.md
git commit -m "docs(spec): 캡처 헬스 가시화 Status → Implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage**: §2.1 구독 ACK → Task 1 ✓; §2.2 단일 술어+노출 → Task 2 ✓; §2.3 watchdog 정책 → Task 3 ✓; §2.4 일경계 리셋 → Task 4 ✓; pill → Task 5 ✓; 테스트 전략 6항목 → 각 Task 테스트 ✓. 비범위(#8/#11/#14/#3) 명시적 제외 ✓.

**Type consistency**: `_capture_health(running, ws, now_ms, ref_ms, stale_after_ms) → (bool, str)` 시그니처가 Task 2(정의)·Task 3(watchdog 호출)·get_status 호출에서 일치. `capture_healthy`/`capture_reason` 필드명이 백엔드(Task 2)·프론트 타입(Task 5)·pill props에서 일치. `sub_expected`/`sub_acked`/`sub_rejected`가 Task 1(정의)·Task 2 테스트·Task 3 헬퍼에서 일치.

**알려진 주의**: Task 3 RED는 `_FakeWs` 속성 보강 순서에 민감 — Step 2가 명확한 RED를 못 내면 Step 3 헬퍼 보강을 먼저 적용(플랜에 명시). Task 5는 기존 cycle_lag 테스트/모듈 정리가 따르므로 grep로 잔존 참조 확인 후 삭제.

**advisor 반영(2026-06-08)**: (A) `_capture_health`에 `market_closed` 파라미터 + `_market_clock_closed_for_capture` 순수 시계 헬퍼 — get_status가 sync라 캘린더 HTTP 못 쓰고, 없으면 밤·주말 pill 거짓-앰버(=#15가 죽이려는 소음 재현). "closed"→ok 매핑. (B) `_capture_health`가 recv(stale)를 sub보다 먼저 체크 — sub 미확인+recv stale은 dead socket이라 stale(재시작), sub 미확인+recv fresh는 거부류라 sub_failed(가시화만). Task 3 테스트를 두 발산 입력으로. (minor) capture_reason은 plain str(Literal 금지 — response_model 재검증 500 회피). LIVE● span(SSE)과 pill(KIS 캡처)은 다른 레이어로 의식적 공존.
