# Live REST Error Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared KIS REST supervisor error policy and migrate the display poller, REST30 recorder, program-trade collector, and live status wire model to use it.

**Architecture:** `KisClient` remains the only KIS/httpx normalization boundary. New `hoga/live/error_policy.py` classifies exceptions into supervisor-facing policy values. Supervisor loops consume the policy for logging, local degraded status, and limited backoff, while `/api/live/status` exposes additive `rest_poller_*` fields without changing capture health or account health semantics.

**Tech Stack:** Python 3.14, asyncio, Pydantic `BaseModel`, pytest, pytest-asyncio, existing `hoga.live.kis_client` exception taxonomy.

## Global Constraints

- Do not change `KisClient` request semantics, URL selection, token issuance, or KIS response parsing.
- Do not add new retry attempts inside `KisClient`; existing retry behavior stays the transport/API adapter's responsibility.
- Do not redesign frontend status UI in this change. Additive backend status fields are introduced so UI work can follow separately.
- Do not hide internal bugs. Parser, model conversion, invariant, and unexpected application errors must still preserve traceback logs.
- `LiveRestPoller` remains display-only and must not write or promote `live_api` artifacts.
- `rest_poller_*` `/api/live/status` fields must not affect `capture_healthy`, `capture_reason`, or `degraded_accounts`.
- `KisRateLimitError` does not trigger supervisor-level backoff; `KisClient` retry and **KIS Capacity Scheduler** cooldown own rate-limit throttling.
- `ProgramTradeCollector` adopts shared classification/logging/status fields only; it does not gain a new backoff loop.
- Existing status fields are append-only for compatibility; do not remove or rename public fields.
- `last_error` remains a compatibility string close to `f"{type(exc).__name__}: {exc}"`; machine decisions use `last_error_kind` and `last_error_code`.

---

## File Structure

- Create `hoga/live/error_policy.py`: pure classification module. No logging, sleeping, state mutation, scheduler calls, or target-set logic.
- Create `tests/unit/live/test_error_policy.py`: focused classification tests.
- Modify `hoga/live/rest_poller.py`: add `LiveRestPollerStatus`, policy-based per-code logging, component-local status, and transport/auth supervisor backoff.
- Modify `tests/unit/live/test_rest_poller.py`: lock transport warnings, unexpected tracebacks, status fields, backoff behavior, and success clearing.
- Modify `hoga/live/lifecycle.py`: add additive `rest_poller_*` fields to `LiveStatus` and populate them from `LiveRestPoller.status()`.
- Modify `tests/unit/live/test_lifecycle_rest_poller.py`: lock wire exposure and prove capture health/account health are unchanged.
- Modify `hoga/live/rest30_recorder.py`: replace local KIS exception classification with shared policy and add status kind/code/backoff fields.
- Modify `tests/unit/live/test_rest30_recorder.py`: update log shape, add kind/code assertions, and change rate-limit test to no supervisor backoff.
- Modify `hoga/live/program_trade_collector.py`: add status kind/code and policy-based logging only.
- Modify `tests/unit/live/test_program_trade_collector.py`: lock compact KIS logs, unexpected tracebacks, and status kind/code behavior.
- Modify `docs/superpowers/specs/2026-07-04-live-rest-error-policy-design.md` and `CONTEXT.md`: keep grilled decisions with the implementation if they are still uncommitted.

---

### Task 1: Shared Error Policy

**Files:**
- Create: `hoga/live/error_policy.py`
- Create: `tests/unit/live/test_error_policy.py`

**Interfaces:**
- Consumes: `KisTransportError`, `KisRateLimitError`, `KisAuthError`, `KisApiError` from `hoga.live.kis_client`.
- Produces:
  - `LiveErrorKind = Literal["transport", "rate_limit", "auth", "kis_api", "internal", "unexpected"]`
  - `LiveErrorPolicy(kind, reason, code, message, log_level, include_traceback, degraded, backoff_cycles)`
  - `classify_live_error(exc: BaseException, *, internal: bool = False) -> LiveErrorPolicy`
  - `format_live_error(exc: BaseException) -> str`

- [ ] **Step 1: Write the failing classification tests**

Create `tests/unit/live/test_error_policy.py`:

```python
import logging

import httpx

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)


def test_transport_error_maps_to_warning_without_traceback_and_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisTransportError(httpx.ConnectError("down")))

    assert policy.kind == "transport"
    assert policy.code == "TRANSPORT/ConnectError"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 3


def test_rate_limit_error_maps_without_supervisor_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisRateLimitError("EGW00201 exhausted"))

    assert policy.kind == "rate_limit"
    assert policy.code == "EGW00201"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_auth_error_maps_to_warning_with_backoff() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisAuthError("token issue failed"))

    assert policy.kind == "auth"
    assert policy.code == "KIS_AUTH"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 3


def test_generic_kis_api_error_maps_without_traceback() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(KisApiError("HTTP_500", "server error"))

    assert policy.kind == "kis_api"
    assert policy.code == "HTTP_500"
    assert policy.log_level == logging.WARNING
    assert policy.include_traceback is False
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_unexpected_error_keeps_traceback() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(RuntimeError("boom"))

    assert policy.kind == "unexpected"
    assert policy.code == "RuntimeError"
    assert policy.log_level == logging.ERROR
    assert policy.include_traceback is True
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_internal_marker_keeps_traceback_but_uses_internal_kind() -> None:
    from hoga.live.error_policy import classify_live_error

    policy = classify_live_error(ValueError("bad row"), internal=True)

    assert policy.kind == "internal"
    assert policy.code == "ValueError"
    assert policy.log_level == logging.ERROR
    assert policy.include_traceback is True
    assert policy.degraded is True
    assert policy.backoff_cycles == 0


def test_format_live_error_preserves_compatibility_shape() -> None:
    from hoga.live.error_policy import format_live_error

    exc = RuntimeError("boom")

    assert format_live_error(exc) == "RuntimeError: boom"
```

- [ ] **Step 2: Run the policy tests to verify RED**

Run:

```bash
pytest tests/unit/live/test_error_policy.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.error_policy'`.

- [ ] **Step 3: Implement the minimal policy module**

Create `hoga/live/error_policy.py`:

```python
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from hoga.live.kis_client import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)

LiveErrorKind = Literal[
    "transport",
    "rate_limit",
    "auth",
    "kis_api",
    "internal",
    "unexpected",
]


@dataclass(frozen=True)
class LiveErrorPolicy:
    kind: LiveErrorKind
    reason: str
    code: str
    message: str
    log_level: int
    include_traceback: bool
    degraded: bool
    backoff_cycles: int


def format_live_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def classify_live_error(exc: BaseException, *, internal: bool = False) -> LiveErrorPolicy:
    if internal:
        return LiveErrorPolicy(
            kind="internal",
            reason="internal_processing_error",
            code=type(exc).__name__,
            message=str(exc),
            log_level=logging.ERROR,
            include_traceback=True,
            degraded=True,
            backoff_cycles=0,
        )
    if isinstance(exc, KisTransportError):
        return LiveErrorPolicy(
            kind="transport",
            reason="kis_transport_error",
            code=exc.msg_cd,
            message=exc.msg1,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
        )
    if isinstance(exc, KisRateLimitError):
        return LiveErrorPolicy(
            kind="rate_limit",
            reason="kis_rate_limit",
            code="EGW00201",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
        )
    if isinstance(exc, KisAuthError):
        return LiveErrorPolicy(
            kind="auth",
            reason="kis_auth_error",
            code="KIS_AUTH",
            message=str(exc),
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=3,
        )
    if isinstance(exc, KisApiError):
        return LiveErrorPolicy(
            kind="kis_api",
            reason="kis_api_error",
            code=exc.msg_cd,
            message=exc.msg1,
            log_level=logging.WARNING,
            include_traceback=False,
            degraded=True,
            backoff_cycles=0,
        )
    return LiveErrorPolicy(
        kind="unexpected",
        reason="unexpected_error",
        code=type(exc).__name__,
        message=str(exc),
        log_level=logging.ERROR,
        include_traceback=True,
        degraded=True,
        backoff_cycles=0,
    )
```

- [ ] **Step 4: Run the policy tests to verify GREEN**

Run:

```bash
pytest tests/unit/live/test_error_policy.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add hoga/live/error_policy.py tests/unit/live/test_error_policy.py
git commit -m "feat: add live rest error policy"
```

---

### Task 2: LiveRestPoller Supervisor Status and Policy Logging

**Files:**
- Modify: `hoga/live/rest_poller.py`
- Modify: `tests/unit/live/test_rest_poller.py`

**Interfaces:**
- Consumes: `classify_live_error`, `format_live_error`, `LiveErrorPolicy`.
- Produces:
  - `LiveRestPollerStatus(running, target_count, targets, last_cycle_ms, last_error, last_error_kind, last_error_code, last_error_count, degraded, backoff_remaining)`
  - `LiveRestPoller.status() -> LiveRestPollerStatus`

- [ ] **Step 1: Write failing LiveRestPoller tests**

Append these tests to `tests/unit/live/test_rest_poller.py`:

```python
@pytest.mark.asyncio
async def test_transport_failure_logs_warning_without_traceback_and_sets_status(caplog):
    import httpx

    from hoga.live.kis_client import KisTransportError

    class TransportFailureKis(FakeKisClient):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls["fetch_orderbook"].append(code)
            raise KisTransportError(httpx.ConnectError("All connection attempts failed"))

    kis = TransportFailureKis()
    buf = LiveBuffer()
    poller = LiveRestPoller(lambda: kis, buf, interval_s=0.02, phase_fn=lambda: "regular")
    poller.on_subscribe("247540")

    with caplog.at_level("WARNING", logger="hoga.live.rest_poller"):
        await poller._poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest_poller"]
    assert len(records) == 1
    assert records[0].exc_info is None
    assert records[0].getMessage() == (
        "live.rest_poller.code_failed code=247540 "
        "kind=transport error=TRANSPORT/ConnectError"
    )
    status = poller.status()
    assert status.last_error_count == 1
    assert status.last_error_kind == "transport"
    assert status.last_error_code == "TRANSPORT/ConnectError"
    assert status.degraded is True
    assert status.backoff_remaining == 3


@pytest.mark.asyncio
async def test_transport_backoff_skips_next_cycle_without_refetching():
    import httpx

    from hoga.live.kis_client import KisTransportError

    class TransportFailureKis(FakeKisClient):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls["fetch_orderbook"].append(code)
            raise KisTransportError(httpx.ConnectError("down"))

    kis = TransportFailureKis()
    poller = LiveRestPoller(
        lambda: kis,
        LiveBuffer(),
        interval_s=0.02,
        phase_fn=lambda: "regular",
    )
    poller.on_subscribe("005930")

    await poller._poll_once()
    await poller._poll_once()

    assert kis.calls["fetch_orderbook"] == ["005930"]
    assert poller.status().backoff_remaining == 2
    assert poller.last_cycle_ms is not None


@pytest.mark.asyncio
async def test_unexpected_failure_logs_with_traceback_and_no_backoff(caplog):
    _, _, poller = _make_poller(raise_for={"005930"}, interval_s=0.02)
    poller.on_subscribe("005930")

    with caplog.at_level("ERROR", logger="hoga.live.rest_poller"):
        await poller._poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest_poller"]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert records[0].getMessage() == (
        "live.rest_poller.code_failed code=005930 kind=unexpected error=RuntimeError"
    )
    status = poller.status()
    assert status.last_error_kind == "unexpected"
    assert status.last_error_code == "RuntimeError"
    assert status.backoff_remaining == 0


@pytest.mark.asyncio
async def test_successful_cycle_clears_degraded_status_after_failure():
    class FirstBrokenThenHealthy(FakeKisClient):
        def __init__(self) -> None:
            super().__init__()
            self.fail = True

        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            if self.fail:
                self.calls["fetch_orderbook"].append(code)
                raise RuntimeError("boom")
            return await super().fetch_orderbook(code)

    kis = FirstBrokenThenHealthy()
    poller = LiveRestPoller(lambda: kis, LiveBuffer(), interval_s=0.02, phase_fn=lambda: "regular")
    poller.on_subscribe("005930")

    await poller._poll_once()
    assert poller.status().degraded is True

    kis.fail = False
    await poller._poll_once()

    status = poller.status()
    assert status.degraded is False
    assert status.last_error is None
    assert status.last_error_kind is None
    assert status.last_error_code is None
    assert status.last_error_count == 0
```

- [ ] **Step 2: Run LiveRestPoller tests to verify RED**

Run:

```bash
pytest tests/unit/live/test_rest_poller.py::test_transport_failure_logs_warning_without_traceback_and_sets_status tests/unit/live/test_rest_poller.py::test_transport_backoff_skips_next_cycle_without_refetching tests/unit/live/test_rest_poller.py::test_unexpected_failure_logs_with_traceback_and_no_backoff tests/unit/live/test_rest_poller.py::test_successful_cycle_clears_degraded_status_after_failure -q
```

Expected: FAIL because `LiveRestPoller.status` and `LiveRestPollerStatus` do not exist and logs still use the old traceback-only shape.

- [ ] **Step 3: Implement LiveRestPoller status and policy application**

In `hoga/live/rest_poller.py`, add imports:

```python
from dataclasses import dataclass

from .error_policy import classify_live_error, format_live_error
```

Add the status dataclass above `LiveRestPoller`:

```python
@dataclass(frozen=True)
class LiveRestPollerStatus:
    running: bool
    target_count: int
    targets: tuple[str, ...]
    last_cycle_ms: int | None
    last_error: str | None
    last_error_kind: str | None
    last_error_code: str | None
    last_error_count: int
    degraded: bool
    backoff_remaining: int
```

In `LiveRestPoller.__init__`, add component-local status fields:

```python
self._last_error: str | None = None
self._last_error_kind: str | None = None
self._last_error_code: str | None = None
self._last_error_count = 0
self._degraded = False
self._backoff_remaining = 0
```

Add a public status method:

```python
def status(self) -> LiveRestPollerStatus:
    targets = self._subscribed - self._excluded
    return LiveRestPollerStatus(
        running=self.alive,
        target_count=len(targets),
        targets=tuple(sorted(targets)),
        last_cycle_ms=self.last_cycle_ms,
        last_error=self._last_error,
        last_error_kind=self._last_error_kind,
        last_error_code=self._last_error_code,
        last_error_count=self._last_error_count,
        degraded=self._degraded,
        backoff_remaining=self._backoff_remaining,
    )
```

At the beginning of `_poll_once`, before resolving KIS, add backoff skip handling:

```python
if self._backoff_remaining > 0:
    self._backoff_remaining -= 1
    self.last_cycle_ms = _now_ms()
    return
```

Replace the per-code exception branch with policy consumption:

```python
error_count = 0
last_error: str | None = None
last_error_kind: str | None = None
last_error_code: str | None = None

for code in targets:
    try:
        await self._fetch_and_publish(code, kis)
        if closed:
            self._snapshotted_once.add(code)
    except Exception as e:  # noqa: BLE001 — 종목별 격리
        policy = classify_live_error(e)
        error_count += 1
        last_error = format_live_error(e)
        last_error_kind = policy.kind
        last_error_code = policy.code
        self._backoff_remaining = max(self._backoff_remaining, policy.backoff_cycles)
        log_msg = "live.rest_poller.code_failed code=%s kind=%s error=%s"
        if policy.include_traceback:
            _log.error(log_msg, code, policy.kind, policy.code, exc_info=True)
        else:
            _log.warning(log_msg, code, policy.kind, policy.code)

self._last_error_count = error_count
if error_count == 0:
    self._last_error = None
    self._last_error_kind = None
    self._last_error_code = None
    self._degraded = False
else:
    self._last_error = last_error
    self._last_error_kind = last_error_kind
    self._last_error_code = last_error_code
    self._degraded = True
```

Keep the existing `self.last_cycle_ms = _now_ms()` at the end of `_poll_once`.

- [ ] **Step 4: Run LiveRestPoller targeted tests to verify GREEN**

Run:

```bash
pytest tests/unit/live/test_rest_poller.py::test_transport_failure_logs_warning_without_traceback_and_sets_status tests/unit/live/test_rest_poller.py::test_transport_backoff_skips_next_cycle_without_refetching tests/unit/live/test_rest_poller.py::test_unexpected_failure_logs_with_traceback_and_no_backoff tests/unit/live/test_rest_poller.py::test_successful_cycle_clears_degraded_status_after_failure -q
```

Expected: PASS.

- [ ] **Step 5: Run the full rest poller test file**

Run:

```bash
pytest tests/unit/live/test_rest_poller.py -q
```

Expected: PASS. Existing writer-prohibition tests must keep passing.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add hoga/live/rest_poller.py tests/unit/live/test_rest_poller.py
git commit -m "feat: apply error policy to live rest poller"
```

---

### Task 3: Live Status Wire Exposure for Rest Poller

**Files:**
- Modify: `hoga/live/lifecycle.py`
- Modify: `tests/unit/live/test_lifecycle_rest_poller.py`

**Interfaces:**
- Consumes: `LiveRestPoller.status()`.
- Produces additive `LiveStatus` fields:
  - `rest_poller_degraded: bool`
  - `rest_poller_last_error: str | None`
  - `rest_poller_last_error_kind: str | None`
  - `rest_poller_last_error_code: str | None`
  - `rest_poller_last_error_count: int`
  - `rest_poller_backoff_remaining: int`

- [ ] **Step 1: Write the failing lifecycle status test**

In `tests/unit/live/test_lifecycle_rest_poller.py`, add this import near the top:

```python
from dataclasses import dataclass
```

Add this helper dataclass after `_FakePoller`:

```python
@dataclass(frozen=True)
class _FakePollerStatus:
    running: bool = True
    target_count: int = 1
    targets: tuple[str, ...] = ("247540",)
    last_cycle_ms: int | None = 1770000000000
    last_error: str | None = "KisTransportError: KIS api error TRANSPORT/ConnectError: down"
    last_error_kind: str | None = "transport"
    last_error_code: str | None = "TRANSPORT/ConnectError"
    last_error_count: int = 1
    degraded: bool = True
    backoff_remaining: int = 2
```

Add `status()` to `_FakePoller`:

```python
def status(self) -> _FakePollerStatus:
    return _FakePollerStatus(running=self.alive)
```

Append the test:

```python
def test_get_status_exposes_rest_poller_fields_without_capture_health_side_effect() -> None:
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    lifecycle.reset_for_tests()
    lifecycle._state = _State(rest_poller=_FakePoller())
    lifecycle._state.rest_poller.start()

    st = lifecycle.get_status()

    assert st.rest_poller_degraded is True
    assert st.rest_poller_last_error == (
        "KisTransportError: KIS api error TRANSPORT/ConnectError: down"
    )
    assert st.rest_poller_last_error_kind == "transport"
    assert st.rest_poller_last_error_code == "TRANSPORT/ConnectError"
    assert st.rest_poller_last_error_count == 1
    assert st.rest_poller_backoff_remaining == 2
    assert st.capture_healthy is True
    assert st.capture_reason == "idle"
    assert st.degraded_accounts == []
```

- [ ] **Step 2: Run lifecycle status test to verify RED**

Run:

```bash
pytest tests/unit/live/test_lifecycle_rest_poller.py::test_get_status_exposes_rest_poller_fields_without_capture_health_side_effect -q
```

Expected: FAIL because `LiveStatus` has no `rest_poller_*` fields.

- [ ] **Step 3: Add additive LiveStatus fields and populate them**

In `hoga/live/lifecycle.py`, add fields to `LiveStatus` after `kis_api_degraded`:

```python
rest_poller_degraded: bool = False
rest_poller_last_error: str | None = None
rest_poller_last_error_kind: str | None = None
rest_poller_last_error_code: str | None = None
rest_poller_last_error_count: int = 0
rest_poller_backoff_remaining: int = 0
```

In `get_status()`, before `return LiveStatus(...)`, compute the poller status:

```python
rest_poller_status = poller.status() if poller is not None else None
```

Then add these arguments to `LiveStatus(...)`:

```python
rest_poller_degraded=bool(rest_poller_status and rest_poller_status.degraded),
rest_poller_last_error=rest_poller_status.last_error if rest_poller_status else None,
rest_poller_last_error_kind=(
    rest_poller_status.last_error_kind if rest_poller_status else None
),
rest_poller_last_error_code=(
    rest_poller_status.last_error_code if rest_poller_status else None
),
rest_poller_last_error_count=(
    rest_poller_status.last_error_count if rest_poller_status else 0
),
rest_poller_backoff_remaining=(
    rest_poller_status.backoff_remaining if rest_poller_status else 0
),
```

Do not change `capture_healthy`, `capture_reason`, or `degraded_accounts` logic.

- [ ] **Step 4: Run lifecycle status test to verify GREEN**

Run:

```bash
pytest tests/unit/live/test_lifecycle_rest_poller.py::test_get_status_exposes_rest_poller_fields_without_capture_health_side_effect -q
```

Expected: PASS.

- [ ] **Step 5: Run lifecycle rest poller file**

Run:

```bash
pytest tests/unit/live/test_lifecycle_rest_poller.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle_rest_poller.py
git commit -m "feat: expose rest poller error status"
```

---

### Task 4: Rest30sRecorder Policy Migration

**Files:**
- Modify: `hoga/live/rest30_recorder.py`
- Modify: `tests/unit/live/test_rest30_recorder.py`

**Interfaces:**
- Consumes: `classify_live_error`, `format_live_error`.
- Produces additive `Rest30sStatus` fields:
  - `last_error_kind: str | None`
  - `last_error_code: str | None`
  - `backoff_remaining: int`

- [ ] **Step 1: Update and add failing Rest30sRecorder tests**

In `tests/unit/live/test_rest30_recorder.py`, update `test_rest30_recorder_logs_transport_failures_without_traceback` expected message:

```python
assert records[0].getMessage() == (
    "live.rest30.api_code_failed code=005930 "
    "kind=transport error=TRANSPORT/ConnectTimeout"
)
assert recorder.status().last_error_kind == "transport"
assert recorder.status().last_error_code == "TRANSPORT/ConnectTimeout"
assert recorder.status().backoff_remaining == 3
```

Replace `test_rest30_recorder_rate_limit_backs_off_next_cycle` with:

```python
@pytest.mark.asyncio
async def test_rest30_recorder_rate_limit_does_not_supervisor_backoff(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.kis_client import KisRateLimitError
    from hoga.live.rest30_recorder import Rest30sRecorder

    class RateLimited(FakeKis):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls.append(("orderbook", code))
            raise KisRateLimitError("rate limited")

    kis = RateLimited()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        backoff_cycles=1,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()
    await recorder.poll_once()

    assert kis.calls == [("orderbook", "005930"), ("orderbook", "005930")]
    status = recorder.status()
    assert status.degraded is True
    assert status.last_error_kind == "rate_limit"
    assert status.last_error_code == "EGW00201"
    assert status.backoff_remaining == 0
```

Add unexpected traceback coverage:

```python
@pytest.mark.asyncio
async def test_rest30_recorder_unexpected_failures_keep_traceback(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class Broken(FakeKis):
        async def fetch_orderbook(self, code: str):
            raise RuntimeError("boom")

    recorder = Rest30sRecorder(
        kis_resolver=lambda: Broken(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930"})

    with caplog.at_level("ERROR", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest30_recorder"]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert records[0].getMessage() == (
        "live.rest30.code_failed code=005930 kind=unexpected error=RuntimeError"
    )
    assert recorder.status().last_error_kind == "unexpected"
    assert recorder.status().last_error_code == "RuntimeError"
```

- [ ] **Step 2: Run Rest30sRecorder targeted tests to verify RED**

Run:

```bash
pytest tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_logs_transport_failures_without_traceback tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_rate_limit_does_not_supervisor_backoff tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_unexpected_failures_keep_traceback -q
```

Expected: FAIL because `Rest30sStatus` lacks new fields, the rate-limit behavior still backs off, and the log shape is old.

- [ ] **Step 3: Implement Rest30sRecorder shared policy usage**

In `hoga/live/rest30_recorder.py`, replace the KIS exception import:

```python
from hoga.live.kis_client import KisApiError, KisAuthError, KisRateLimitError
```

with:

```python
from hoga.live.error_policy import classify_live_error, format_live_error
```

Add fields to `Rest30sStatus`:

```python
last_error_kind: str | None
last_error_code: str | None
backoff_remaining: int
```

Add instance fields in `__init__`:

```python
self._last_error_kind: str | None = None
self._last_error_code: str | None = None
```

Return the new fields from `status()`:

```python
last_error_kind=self._last_error_kind,
last_error_code=self._last_error_code,
backoff_remaining=self._backoff_remaining,
```

Clear them in success/no-target paths:

```python
self._last_error_kind = None
self._last_error_code = None
```

In `poll_once()`, replace the exception body with:

```python
except Exception as e:  # noqa: BLE001
    policy = classify_live_error(e)
    error_count += 1
    last_error = format_live_error(e)
    last_error_kind = policy.kind
    last_error_code = policy.code
    if policy.backoff_cycles > 0:
        self._backoff_remaining = max(
            self._backoff_remaining,
            max(self._backoff_cycles, policy.backoff_cycles),
        )
    if policy.include_traceback:
        _log.error(
            "live.rest30.code_failed code=%s kind=%s error=%s",
            code,
            policy.kind,
            policy.code,
            exc_info=True,
        )
    else:
        _log.warning(
            "live.rest30.api_code_failed code=%s kind=%s error=%s",
            code,
            policy.kind,
            policy.code,
        )
```

Before the loop, initialize:

```python
last_error_kind: str | None = None
last_error_code: str | None = None
```

After the loop, set:

```python
self._last_error_kind = last_error_kind
self._last_error_code = last_error_code
```

For `kis is None`, set:

```python
self._last_error_kind = "auth"
self._last_error_code = "kis_unavailable"
```

- [ ] **Step 4: Run Rest30sRecorder targeted tests to verify GREEN**

Run:

```bash
pytest tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_logs_transport_failures_without_traceback tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_rate_limit_does_not_supervisor_backoff tests/unit/live/test_rest30_recorder.py::test_rest30_recorder_unexpected_failures_keep_traceback -q
```

Expected: PASS.

- [ ] **Step 5: Run the full Rest30sRecorder test file**

Run:

```bash
pytest tests/unit/live/test_rest30_recorder.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add hoga/live/rest30_recorder.py tests/unit/live/test_rest30_recorder.py
git commit -m "feat: apply error policy to rest30 recorder"
```

---

### Task 5: ProgramTradeCollector Policy Logging and Status Codes

**Files:**
- Modify: `hoga/live/program_trade_collector.py`
- Modify: `tests/unit/live/test_program_trade_collector.py`

**Interfaces:**
- Consumes: `classify_live_error`, `format_live_error`.
- Produces additive `ProgramTradeCollectorStatus` fields:
  - `last_error_kind: str | None = None`
  - `last_error_code: str | None = None`

- [ ] **Step 1: Write failing ProgramTradeCollector tests**

Add imports to `tests/unit/live/test_program_trade_collector.py`:

```python
import httpx
```

Append tests:

```python
@pytest.mark.asyncio
async def test_program_trade_collector_logs_transport_without_traceback_and_sets_kind(
    tmp_path,
    monkeypatch,
    caplog,
) -> None:
    from hoga.live.kis_client import KisTransportError
    from hoga.live.program_trade_collector import ProgramTradeCollector

    async def fake_run_with_capacity(
        scheduler,
        *,
        data_dir,
        role,
        key,
        endpoint,
        priority,
        cooldown_scope,
        fetch_fn,
    ):
        raise KisTransportError(httpx.ConnectError("down"))

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.run_with_capacity",
        fake_run_with_capacity,
    )
    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260625",
        now_ms_fn=lambda: 1000,
    )

    with caplog.at_level("WARNING", logger="hoga.live.program_trade_collector"):
        await collector.run_once()

    records = [r for r in caplog.records if r.name == "hoga.live.program_trade_collector"]
    assert len(records) == 2
    assert all(r.exc_info is None for r in records)
    assert records[0].getMessage() == (
        "program_trade.collector.code_failed code=005930 "
        "kind=transport error=TRANSPORT/ConnectError"
    )
    assert collector.status.last_error_count == 2
    assert collector.status.last_error_kind == "transport"
    assert collector.status.last_error_code == "TRANSPORT/ConnectError"


@pytest.mark.asyncio
async def test_program_trade_collector_unexpected_errors_keep_traceback(
    tmp_path,
    monkeypatch,
    caplog,
) -> None:
    from hoga.live.program_trade_collector import ProgramTradeCollector

    async def fake_run_with_capacity(
        scheduler,
        *,
        data_dir,
        role,
        key,
        endpoint,
        priority,
        cooldown_scope,
        fetch_fn,
    ):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        "hoga.live.program_trade_collector.load_document",
        lambda _data_dir: _watchlist_doc(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.kis_access.run_with_capacity",
        fake_run_with_capacity,
    )
    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: "20260625",
        now_ms_fn=lambda: 1000,
    )

    with caplog.at_level("ERROR", logger="hoga.live.program_trade_collector"):
        await collector.run_once()

    records = [r for r in caplog.records if r.name == "hoga.live.program_trade_collector"]
    assert len(records) == 2
    assert all(r.exc_info is not None for r in records)
    assert records[0].getMessage() == (
        "program_trade.collector.code_failed code=005930 "
        "kind=unexpected error=RuntimeError"
    )
    assert collector.status.last_error_count == 2
    assert collector.status.last_error_kind == "unexpected"
    assert collector.status.last_error_code == "RuntimeError"
```

- [ ] **Step 2: Run ProgramTradeCollector targeted tests to verify RED**

Run:

```bash
pytest tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_logs_transport_without_traceback_and_sets_kind tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_unexpected_errors_keep_traceback -q
```

Expected: FAIL because the status fields do not exist and logging has the old shape.

- [ ] **Step 3: Implement ProgramTradeCollector policy logging**

In `hoga/live/program_trade_collector.py`, add import:

```python
from .error_policy import classify_live_error, format_live_error
```

Add fields to `ProgramTradeCollectorStatus`:

```python
last_error_kind: str | None = None
last_error_code: str | None = None
```

At the beginning of `run_once`, clear the fields:

```python
self.status.last_error_kind = None
self.status.last_error_code = None
```

Replace the `except Exception as e` body with:

```python
except Exception as e:  # noqa: BLE001 — per-code failures must stay local.
    policy = classify_live_error(e)
    self.status.last_error = f"{code}: {format_live_error(e)}"
    self.status.last_error_kind = policy.kind
    self.status.last_error_code = policy.code
    self.status.last_error_count += 1
    log_msg = "program_trade.collector.code_failed code=%s kind=%s error=%s"
    if policy.include_traceback:
        log.error(log_msg, code, policy.kind, policy.code, exc_info=True)
    else:
        log.warning(log_msg, code, policy.kind, policy.code)
```

Do not add backoff or scheduler changes.

- [ ] **Step 4: Run ProgramTradeCollector targeted tests to verify GREEN**

Run:

```bash
pytest tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_logs_transport_without_traceback_and_sets_kind tests/unit/live/test_program_trade_collector.py::test_program_trade_collector_unexpected_errors_keep_traceback -q
```

Expected: PASS.

- [ ] **Step 5: Run the full ProgramTradeCollector test file**

Run:

```bash
pytest tests/unit/live/test_program_trade_collector.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add hoga/live/program_trade_collector.py tests/unit/live/test_program_trade_collector.py
git commit -m "feat: apply error policy to program trade collector"
```

---

### Task 6: Documentation Alignment and Full Verification

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-07-04-live-rest-error-policy-design.md`
- Test: all targeted files from Tasks 1-5

**Interfaces:**
- Consumes: accepted grilled decisions from the spec session.
- Produces: committed docs and verified implementation.

- [ ] **Step 1: Confirm grilled docs contain the final decisions**

Run:

```bash
rg -n "REST Supervisor Degraded|rate_limit: 0 cycles|rest_poller_|ProgramTradeCollector.*does not gain" CONTEXT.md docs/superpowers/specs/2026-07-04-live-rest-error-policy-design.md
```

Expected: output includes:

```text
**REST Supervisor Degraded**:
rest_poller_degraded
- rate_limit: 0 cycles
`ProgramTradeCollector` adopts shared classification/logging/status fields only;
```

- [ ] **Step 2: Run the full targeted live test subset**

Run:

```bash
pytest \
  tests/unit/live/test_error_policy.py \
  tests/unit/live/test_rest_poller.py \
  tests/unit/live/test_lifecycle_rest_poller.py \
  tests/unit/live/test_rest30_recorder.py \
  tests/unit/live/test_program_trade_collector.py \
  -q
```

Expected: PASS.

- [ ] **Step 3: Run type/lint checks used by the repo if available**

Run:

```bash
python -m py_compile \
  hoga/live/error_policy.py \
  hoga/live/rest_poller.py \
  hoga/live/lifecycle.py \
  hoga/live/rest30_recorder.py \
  hoga/live/program_trade_collector.py
```

Expected: exits 0.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --stat HEAD
git diff -- hoga/live/error_policy.py hoga/live/rest_poller.py hoga/live/lifecycle.py hoga/live/rest30_recorder.py hoga/live/program_trade_collector.py
```

Expected: diff shows only the shared policy, supervisor migrations, additive status fields, tests, and grilled docs.

- [ ] **Step 5: Commit docs and final verification if uncommitted changes remain**

Run:

```bash
git status --short
git add CONTEXT.md docs/superpowers/specs/2026-07-04-live-rest-error-policy-design.md docs/superpowers/plans/2026-07-04-live-rest-error-policy.md
git commit -m "docs: finalize live rest error policy plan"
```

Expected: commit succeeds if those docs are uncommitted. If `git status --short` shows no matching doc changes, skip this commit.

---

## Self-Review Checklist

- Spec coverage: Task 1 covers shared classification. Task 2 covers `LiveRestPoller` logging/status/backoff. Task 3 covers `/api/live/status` additive `rest_poller_*` fields and non-interference with capture health. Task 4 covers `Rest30sRecorder`. Task 5 covers `ProgramTradeCollector`. Task 6 covers docs and verification.
- Placeholder scan: this plan contains no placeholder markers or unspecified implementation steps.
- Type consistency: `LiveErrorPolicy`, `classify_live_error`, `format_live_error`, `LiveRestPollerStatus`, `Rest30sStatus`, `ProgramTradeCollectorStatus`, and `LiveStatus` fields use the same names across tasks.
