# Signal Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sell-total renewal alert system with persisted date ledgers, an inbox-clearing projection, app toasts, settings controls, and a right-rail alert inbox.

**Architecture:** Backend owns alert rules, date-partitioned append-only ledgers, inbox projection state, and signal detection fed by both WS and REST orderbook paths. Frontend owns settings editing, WebSocket event consumption, toast display, unread state, and a `signalAlerts` right-rail panel that opens live charts from alert rows.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, pytest, React 18, React Router v7, TanStack Query v5, Zustand, Vitest, existing `/api/ws` event bus.

## Global Constraints

- Alert target is capture-enabled watchlist groups only.
- WS-backed codes use real-time snapshots; REST-backed codes use existing 30-second snapshots.
- Defaults: `enabled=true`, `start_hhmm=1100`, `threshold_pct=100`, `use_intra_minute_max=true`.
- Date ledger path is `<data_dir>/signal_alerts/YYYYMMDD.jsonl` and is append-only.
- Inbox clear must not delete or truncate date ledgers.
- Inbox projection state path is `<data_dir>/signal_alert_inbox_state.json`.
- Right-rail alert panel id is `signalAlerts`.
- Settings page edits rule parameters only; alert history lives in the right rail.
- Browser/OS notifications and sound alerts are out of scope.
- Date-based full alert history browsing is out of scope, but storage must preserve the full ledger for it.

---

## File Structure

Backend:

- Create `hoga/live/signal_alerts.py`: Pydantic models, settings load/save, ledger append/read, inbox clear-state load/save, and pure alert store helpers.
- Create `hoga/live/signal_alert_monitor.py`: hot-path-safe `SignalAlertMonitor` with pure detection state and async persistence queue.
- Create `hoga/api/signal_alert_routes.py`: `/api/signal-alerts/*` router.
- Modify `hoga/api/models.py`: shared wire models for settings, alerts, recent response, and clear response.
- Modify `hoga/api/app.py`: include the signal-alert router.
- Modify `hoga/live/lifecycle.py`: own and expose the process singleton monitor.
- Modify `hoga/live/stream.py`: feed WS orderbook snapshots into monitor.
- Modify `hoga/live/rest30_recorder.py`: feed REST orderbook snapshots into monitor.
- Tests: `tests/unit/live/test_signal_alerts.py`, `tests/unit/live/test_signal_alert_monitor.py`, `tests/test_signal_alert_routes.py`.

Frontend:

- Create `frontend/src/api/signalAlerts.ts`: API hooks and wire types.
- Modify `frontend/src/api/types.ts`: add `SignalAlertEvent` to `PushEvent`.
- Create `frontend/src/signalAlerts/useSignalAlertEvents.ts`: root subscription that handles `signal_alert` events, toasts, unread state, and query updates.
- Create `frontend/src/state/signalAlertInbox.ts`: local UI unread/seen state.
- Create `frontend/src/signalAlerts/SignalAlertToastHost.tsx`: app-local toast stack.
- Create `frontend/src/signalAlerts/SignalAlertsDrawer.tsx`: right-rail inbox panel.
- Modify `frontend/src/state/rightRail.ts`, `frontend/src/rightrail/RightRail.tsx`, `frontend/src/App.tsx`: add `signalAlerts` panel.
- Modify `frontend/src/pages/Settings.tsx`: add `시그널 알림` settings section.
- Tests: `frontend/src/api/signalAlerts.test.ts`, `frontend/src/state/signalAlertInbox.test.ts`, `frontend/src/signalAlerts/SignalAlertsDrawer.test.tsx`, `frontend/src/signalAlerts/useSignalAlertEvents.test.tsx`, update `RightRail.test.tsx`, `rightRail.test.ts`, `Settings.test.tsx`, `App.test.tsx`.

---

### Task 1: Backend Models and Persistent Store

**Files:**
- Modify: `hoga/api/models.py`
- Create: `hoga/live/signal_alerts.py`
- Test: `tests/unit/live/test_signal_alerts.py`

**Interfaces:**
- Produces: `SignalAlertSettings`, `SignalAlertSettingsUpdate`, `SignalAlertEvent`, `SignalAlertRecentResponse`, `SignalAlertClearResponse`.
- Produces: `load_signal_alert_settings(data_dir: Path) -> SignalAlertSettings`.
- Produces: `update_signal_alert_settings(data_dir: Path, patch: SignalAlertSettingsUpdate) -> SignalAlertSettings`.
- Produces: `append_signal_alert(data_dir: Path, event: SignalAlertEvent) -> None`.
- Produces: `read_signal_alerts(data_dir: Path, date: str, *, limit: int, scope: Literal["inbox", "all"]) -> list[SignalAlertEvent]`.
- Produces: `clear_today_inbox(data_dir: Path, today: str) -> SignalAlertClearResponse`.
- Later tasks consume these exact names from `hoga.live.signal_alerts`.

- [ ] **Step 1: Write failing persistence tests**

Add `tests/unit/live/test_signal_alerts.py`:

```python
from pathlib import Path

from hoga.api.models import SignalAlertEvent, SignalAlertSettingsUpdate
from hoga.live.signal_alerts import (
    append_signal_alert,
    clear_today_inbox,
    load_signal_alert_settings,
    read_signal_alerts,
    update_signal_alert_settings,
)


def event(seq: int, code: str = "005930") -> SignalAlertEvent:
    return SignalAlertEvent(
        type="signal_alert",
        id=f"20260701:{code}:sell_total_renewal:{seq}:ws",
        signal="sell_total_renewal",
        seq=seq,
        code=code,
        name="삼성전자",
        t_ms=1_779_851_250_000 + seq,
        date="20260701",
        source="ws",
        value=1_240_000 + seq,
        baseline=1_200_000,
        ratio_pct=103.3,
        use_intra_minute_max=True,
    )


def test_settings_defaults_and_patch_round_trip(tmp_path: Path) -> None:
    assert load_signal_alert_settings(tmp_path).sell_total_renewal.threshold_pct == 100

    updated = update_signal_alert_settings(
        tmp_path,
        SignalAlertSettingsUpdate(
            sell_total_renewal={
                "enabled": False,
                "start_hhmm": 1030,
                "threshold_pct": 95,
                "use_intra_minute_max": False,
            },
        ),
    )

    assert updated.sell_total_renewal.enabled is False
    assert updated.sell_total_renewal.start_hhmm == 1030
    assert updated.sell_total_renewal.threshold_pct == 95
    assert updated.sell_total_renewal.use_intra_minute_max is False
    assert load_signal_alert_settings(tmp_path) == updated


def test_alerts_are_date_partitioned_and_read_newest_first(tmp_path: Path) -> None:
    append_signal_alert(tmp_path, event(1, "005930"))
    append_signal_alert(tmp_path, event(2, "000660"))
    append_signal_alert(tmp_path, event(1, "035420").model_copy(update={"date": "20260702"}))

    rows = read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")

    assert [r.seq for r in rows] == [2, 1]
    assert [r.code for r in rows] == ["000660", "005930"]


def test_clear_today_hides_inbox_without_truncating_ledger(tmp_path: Path) -> None:
    append_signal_alert(tmp_path, event(1))
    append_signal_alert(tmp_path, event(2))

    cleared = clear_today_inbox(tmp_path, "20260701")

    assert cleared.date == "20260701"
    assert cleared.cleared_through_seq == 2
    assert read_signal_alerts(tmp_path, "20260701", limit=10, scope="inbox") == []
    assert [r.seq for r in read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")] == [2, 1]

    append_signal_alert(tmp_path, event(3))
    assert [r.seq for r in read_signal_alerts(tmp_path, "20260701", limit=10, scope="inbox")] == [3]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/live/test_signal_alerts.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.signal_alerts'` or missing model imports.

- [ ] **Step 3: Add Pydantic models**

Append these models near `LiveSettingsResponse` in `hoga/api/models.py`:

```python
SignalAlertSource = Literal["ws", "rest"]
SignalAlertName = Literal["sell_total_renewal"]
SignalAlertScope = Literal["inbox", "all"]


class SellTotalRenewalSettings(BaseModel):
    enabled: bool = True
    start_hhmm: int = 1100
    threshold_pct: int = 100
    use_intra_minute_max: bool = True

    @field_validator("start_hhmm")
    @classmethod
    def _valid_hhmm(cls, value: int) -> int:
        hh = value // 100
        mm = value % 100
        if hh < 9 or hh > 15 or mm < 0 or mm > 59 or (hh == 15 and mm > 20):
            raise ValueError("start_hhmm must be between 0900 and 1520 KST")
        return value

    @field_validator("threshold_pct")
    @classmethod
    def _valid_threshold(cls, value: int) -> int:
        if value < 50 or value > 150:
            raise ValueError("threshold_pct must be between 50 and 150")
        return value


class SignalAlertSettings(BaseModel):
    schema_version: int = 1
    sell_total_renewal: SellTotalRenewalSettings = Field(default_factory=SellTotalRenewalSettings)


class SignalAlertSettingsUpdate(BaseModel):
    sell_total_renewal: SellTotalRenewalSettings


class SignalAlertEvent(BaseModel):
    type: Literal["signal_alert"] = "signal_alert"
    id: str
    signal: SignalAlertName
    seq: int
    code: str
    name: str
    t_ms: int
    date: str
    source: SignalAlertSource
    value: int
    baseline: int
    ratio_pct: float
    use_intra_minute_max: bool


class SignalAlertRecentResponse(BaseModel):
    date: str
    scope: SignalAlertScope
    cleared_through_seq: int
    alerts: list[SignalAlertEvent]


class SignalAlertClearResponse(BaseModel):
    date: str
    cleared_through_seq: int
```

- [ ] **Step 4: Add persistent store**

Create `hoga/live/signal_alerts.py`:

```python
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    SignalAlertClearResponse,
    SignalAlertEvent,
    SignalAlertRecentResponse,
    SignalAlertScope,
    SignalAlertSettings,
    SignalAlertSettingsUpdate,
)

_lock = threading.RLock()


class _InboxState(BaseModel):
    schema_version: int = 1
    cleared_through_seq_by_date: dict[str, int] = {}


def _settings_path(data_dir: Path) -> Path:
    return data_dir / "signal_alert_settings.json"


def _alerts_dir(data_dir: Path) -> Path:
    return data_dir / "signal_alerts"


def _ledger_path(data_dir: Path, date: str) -> Path:
    return _alerts_dir(data_dir) / f"{date}.jsonl"


def _inbox_state_path(data_dir: Path) -> Path:
    return data_dir / "signal_alert_inbox_state.json"


def load_signal_alert_settings(data_dir: Path) -> SignalAlertSettings:
    path = _settings_path(data_dir)
    if not path.exists():
        return SignalAlertSettings()
    try:
        return SignalAlertSettings.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValidationError, TypeError):
        return SignalAlertSettings()


def update_signal_alert_settings(data_dir: Path, patch: SignalAlertSettingsUpdate) -> SignalAlertSettings:
    settings = SignalAlertSettings(sell_total_renewal=patch.sell_total_renewal)
    with _lock:
        atomic_write_json(_settings_path(data_dir), settings.model_dump())
    return settings


def _load_inbox_state(data_dir: Path) -> _InboxState:
    path = _inbox_state_path(data_dir)
    if not path.exists():
        return _InboxState()
    try:
        return _InboxState.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValidationError, TypeError):
        return _InboxState()


def _save_inbox_state(data_dir: Path, state: _InboxState) -> None:
    atomic_write_json(_inbox_state_path(data_dir), state.model_dump())


def _next_seq_unlocked(data_dir: Path, date: str) -> int:
    path = _ledger_path(data_dir, date)
    if not path.exists():
        return 1
    seq = 0
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            if raw.strip():
                try:
                    seq = max(seq, int(json.loads(raw).get("seq", 0)))
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
    return seq + 1


def assign_next_seq(data_dir: Path, event: SignalAlertEvent) -> SignalAlertEvent:
    with _lock:
        seq = _next_seq_unlocked(data_dir, event.date)
    return event.model_copy(update={"seq": seq})


def append_signal_alert(data_dir: Path, event: SignalAlertEvent) -> None:
    path = _ledger_path(data_dir, event.date)
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(event.model_dump_json() + "\n")


def _read_all(data_dir: Path, date: str) -> list[SignalAlertEvent]:
    path = _ledger_path(data_dir, date)
    if not path.exists():
        return []
    rows: list[SignalAlertEvent] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                rows.append(SignalAlertEvent.model_validate_json(raw))
            except ValidationError:
                continue
    rows.sort(key=lambda e: (e.seq, e.t_ms), reverse=True)
    return rows


def read_signal_alerts(
    data_dir: Path,
    date: str,
    *,
    limit: int,
    scope: SignalAlertScope,
) -> list[SignalAlertEvent]:
    with _lock:
        state = _load_inbox_state(data_dir)
        cleared = state.cleared_through_seq_by_date.get(date, 0) if scope == "inbox" else 0
        return [e for e in _read_all(data_dir, date) if e.seq > cleared][:limit]


def recent_response(
    data_dir: Path,
    date: str,
    *,
    limit: int,
    scope: SignalAlertScope,
) -> SignalAlertRecentResponse:
    with _lock:
        state = _load_inbox_state(data_dir)
        cleared = state.cleared_through_seq_by_date.get(date, 0)
        return SignalAlertRecentResponse(
            date=date,
            scope=scope,
            cleared_through_seq=cleared,
            alerts=read_signal_alerts(data_dir, date, limit=limit, scope=scope),
        )


def clear_today_inbox(data_dir: Path, today: str) -> SignalAlertClearResponse:
    with _lock:
        state = _load_inbox_state(data_dir)
        latest = max((e.seq for e in _read_all(data_dir, today)), default=0)
        state.cleared_through_seq_by_date[today] = latest
        _save_inbox_state(data_dir, state)
        return SignalAlertClearResponse(date=today, cleared_through_seq=latest)
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/unit/live/test_signal_alerts.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/live/signal_alerts.py tests/unit/live/test_signal_alerts.py
git commit -m "feat: persist signal alert ledgers"
```

---

### Task 2: Alert Monitor and Detection Logic

**Files:**
- Create: `hoga/live/signal_alert_monitor.py`
- Test: `tests/unit/live/test_signal_alert_monitor.py`

**Interfaces:**
- Consumes: `load_signal_alert_settings`, `assign_next_seq`, `append_signal_alert`, `SignalAlertEvent`.
- Produces: `SignalAlertMonitor(data_dir: Path, publish: Callable[[dict], None], date_fn: Callable[[int], str] | None = None)`.
- Produces: `SignalAlertMonitor.set_targets(codes: set[str]) -> None`.
- Produces: `SignalAlertMonitor.ingest_orderbook(code: str, name: str, t_ms: int, total_ask_qty: int, source: Literal["ws", "rest"]) -> SignalAlertEvent | None`.
- Later tasks feed WS/REST snapshots through `ingest_orderbook`.

- [ ] **Step 1: Write failing monitor tests**

Create `tests/unit/live/test_signal_alert_monitor.py`:

```python
from pathlib import Path

from hoga.api.models import SignalAlertSettingsUpdate, SellTotalRenewalSettings
from hoga.live.signal_alert_monitor import SignalAlertMonitor
from hoga.live.signal_alerts import read_signal_alerts, update_signal_alert_settings


def date_fn(_t_ms: int) -> str:
    return "20260701"


def test_emits_at_default_100_percent_after_start(tmp_path: Path) -> None:
    published: list[dict] = []
    monitor = SignalAlertMonitor(tmp_path, publish=published.append, date_fn=date_fn)
    monitor.set_targets({"005930"})

    assert monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "ws") is None
    assert monitor.ingest_orderbook("005930", "삼성전자", 11_01_00, 999, "ws") is None
    event = monitor.ingest_orderbook("005930", "삼성전자", 11_02_00, 1_000, "ws")

    assert event is not None
    assert event.seq == 1
    assert event.ratio_pct == 100.0
    assert published[0]["type"] == "signal_alert"
    assert read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")[0].seq == 1


def test_custom_95_percent_threshold(tmp_path: Path) -> None:
    update_signal_alert_settings(
        tmp_path,
        SignalAlertSettingsUpdate(
            sell_total_renewal=SellTotalRenewalSettings(
                enabled=True,
                start_hhmm=1100,
                threshold_pct=95,
                use_intra_minute_max=True,
            ),
        ),
    )
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})

    monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "rest")
    event = monitor.ingest_orderbook("005930", "삼성전자", 11_00_30, 950, "rest")

    assert event is not None
    assert event.source == "rest"


def test_ignores_non_targets_and_missing_baseline(tmp_path: Path) -> None:
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})

    assert monitor.ingest_orderbook("000660", "SK하이닉스", 10_00_00, 5_000, "ws") is None
    assert monitor.ingest_orderbook("005930", "삼성전자", 11_00_00, 5_000, "ws") is None


def test_rearm_suppresses_repeated_alerts(tmp_path: Path) -> None:
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})

    monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "ws")
    first = monitor.ingest_orderbook("005930", "삼성전자", 11_00_00, 1_000, "ws")
    duplicate = monitor.ingest_orderbook("005930", "삼성전자", 11_00_10, 1_010, "ws")
    monitor.ingest_orderbook("005930", "삼성전자", 11_01_00, 800, "ws")
    second = monitor.ingest_orderbook("005930", "삼성전자", 11_02_00, 1_000, "ws")

    assert first is not None
    assert duplicate is None
    assert second is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/live/test_signal_alert_monitor.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.signal_alert_monitor'`.

- [ ] **Step 3: Implement monitor**

Create `hoga/live/signal_alert_monitor.py`:

```python
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from hoga.api.models import SignalAlertEvent, SignalAlertSource
from hoga.live.signal_alerts import assign_next_seq, append_signal_alert, load_signal_alert_settings

_KST = timezone(timedelta(hours=9))
_REARM_RATIO = 0.85


def _hhmm_from_ms(t_ms: int) -> int:
    dt = datetime.fromtimestamp(t_ms / 1000, tz=_KST)
    return dt.hour * 100 + dt.minute


def _date_from_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=_KST).strftime("%Y%m%d")


def _minute_bucket(t_ms: int) -> int:
    return t_ms // 60_000


@dataclass
class _CodeState:
    date: str
    baseline: int = 0
    armed: bool = True
    minute_bucket: int | None = None
    minute_max: int = 0


class SignalAlertMonitor:
    def __init__(
        self,
        data_dir: Path,
        *,
        publish: Callable[[dict], None],
        date_fn: Callable[[int], str] | None = None,
    ) -> None:
        self._data_dir = data_dir
        self._publish = publish
        self._date_fn = date_fn or _date_from_ms
        self._targets: set[str] = set()
        self._state: dict[str, _CodeState] = {}

    def set_targets(self, codes: set[str]) -> None:
        self._targets = set(codes)
        for code in list(self._state):
            if code not in self._targets:
                del self._state[code]

    def ingest_orderbook(
        self,
        code: str,
        name: str,
        t_ms: int,
        total_ask_qty: int,
        source: SignalAlertSource,
    ) -> SignalAlertEvent | None:
        if code not in self._targets or total_ask_qty <= 0:
            return None

        settings = load_signal_alert_settings(self._data_dir).sell_total_renewal
        if not settings.enabled:
            return None

        date = self._date_fn(t_ms)
        state = self._state.get(code)
        if state is None or state.date != date:
            state = _CodeState(date=date)
            self._state[code] = state

        hhmm = _hhmm_from_ms(t_ms) if t_ms > 10_000_000_000 else t_ms // 10_000
        if hhmm < settings.start_hhmm:
            state.baseline = max(state.baseline, int(total_ask_qty))
            return None
        if state.baseline <= 0:
            return None

        candidate = int(total_ask_qty)
        if settings.use_intra_minute_max:
            bucket = _minute_bucket(t_ms)
            if state.minute_bucket != bucket:
                state.minute_bucket = bucket
                state.minute_max = candidate
            else:
                state.minute_max = max(state.minute_max, candidate)
            candidate = state.minute_max

        if candidate < state.baseline * _REARM_RATIO:
            state.armed = True
            return None
        if not state.armed:
            return None

        threshold_value = state.baseline * settings.threshold_pct / 100
        if candidate < threshold_value:
            return None

        ratio_pct = round(candidate / state.baseline * 100, 1)
        event = SignalAlertEvent(
            type="signal_alert",
            id=f"{date}:{code}:sell_total_renewal:{t_ms}:{source}",
            signal="sell_total_renewal",
            seq=0,
            code=code,
            name=name,
            t_ms=t_ms,
            date=date,
            source=source,
            value=candidate,
            baseline=state.baseline,
            ratio_pct=ratio_pct,
            use_intra_minute_max=settings.use_intra_minute_max,
        )
        event = assign_next_seq(self._data_dir, event)
        append_signal_alert(self._data_dir, event)
        self._publish(event.model_dump())
        state.armed = False
        return event
```

- [ ] **Step 4: Run monitor tests**

Run: `uv run pytest tests/unit/live/test_signal_alert_monitor.py tests/unit/live/test_signal_alerts.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/signal_alert_monitor.py tests/unit/live/test_signal_alert_monitor.py
git commit -m "feat: detect sell total signal alerts"
```

---

### Task 3: Backend API Routes

**Files:**
- Create: `hoga/api/signal_alert_routes.py`
- Modify: `hoga/api/app.py`
- Test: `tests/test_signal_alert_routes.py`

**Interfaces:**
- Consumes: store functions from Task 1.
- Produces:
  - `GET /api/signal-alerts/settings`
  - `PATCH /api/signal-alerts/settings`
  - `GET /api/signal-alerts/recent?date=YYYYMMDD&limit=100&scope=inbox`
  - `POST /api/signal-alerts/clear-today`

- [ ] **Step 1: Write failing route tests**

Create `tests/test_signal_alert_routes.py`:

```python
from pathlib import Path

from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.models import SignalAlertEvent
from hoga.live.signal_alerts import append_signal_alert


def make_client(tmp_path: Path) -> TestClient:
    app = create_app(data_dir=tmp_path)
    return TestClient(app)


def test_signal_alert_settings_round_trip(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    assert client.get("/api/signal-alerts/settings").json()["sell_total_renewal"]["threshold_pct"] == 100

    response = client.patch(
        "/api/signal-alerts/settings",
        json={
            "sell_total_renewal": {
                "enabled": False,
                "start_hhmm": 1030,
                "threshold_pct": 95,
                "use_intra_minute_max": False,
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["sell_total_renewal"]["enabled"] is False


def test_recent_inbox_and_clear_preserve_ledger(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    for seq in [1, 2]:
        append_signal_alert(
            tmp_path,
            SignalAlertEvent(
                type="signal_alert",
                id=f"20260701:005930:sell_total_renewal:{seq}:ws",
                signal="sell_total_renewal",
                seq=seq,
                code="005930",
                name="삼성전자",
                t_ms=1_779_851_250_000 + seq,
                date="20260701",
                source="ws",
                value=1_000 + seq,
                baseline=1_000,
                ratio_pct=100.0,
                use_intra_minute_max=True,
            ),
        )

    before = client.get("/api/signal-alerts/recent?date=20260701&scope=inbox").json()
    assert [row["seq"] for row in before["alerts"]] == [2, 1]

    cleared = client.post("/api/signal-alerts/clear-today?date=20260701")
    assert cleared.status_code == 200
    assert cleared.json()["cleared_through_seq"] == 2
    assert client.get("/api/signal-alerts/recent?date=20260701&scope=inbox").json()["alerts"] == []
    assert [row["seq"] for row in client.get("/api/signal-alerts/recent?date=20260701&scope=all").json()["alerts"]] == [2, 1]
```

- [ ] **Step 2: Run route test to verify it fails**

Run: `uv run pytest tests/test_signal_alert_routes.py -v`

Expected: FAIL with 404 for `/api/signal-alerts/settings`.

- [ ] **Step 3: Implement router**

Create `hoga/api/signal_alert_routes.py`:

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import (
    SignalAlertClearResponse,
    SignalAlertRecentResponse,
    SignalAlertScope,
    SignalAlertSettings,
    SignalAlertSettingsUpdate,
)
from hoga.live.signal_alerts import (
    clear_today_inbox,
    load_signal_alert_settings,
    recent_response,
    update_signal_alert_settings,
)

_KST = timezone(timedelta(hours=9))


def _today() -> str:
    return datetime.now(_KST).strftime("%Y%m%d")


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/signal-alerts", tags=["signal-alerts"])

    @router.get("/settings", response_model=SignalAlertSettings)
    async def get_settings() -> SignalAlertSettings:
        return load_signal_alert_settings(data_dir)

    @router.patch("/settings", response_model=SignalAlertSettings)
    async def patch_settings(req: SignalAlertSettingsUpdate) -> SignalAlertSettings:
        return update_signal_alert_settings(data_dir, req)

    @router.get("/recent", response_model=SignalAlertRecentResponse)
    async def recent(
        date: str = Query(default_factory=_today, pattern=r"^\d{8}$"),
        limit: int = Query(100, ge=1, le=500),
        scope: SignalAlertScope = "inbox",
    ) -> SignalAlertRecentResponse:
        return recent_response(data_dir, date, limit=limit, scope=scope)

    @router.post("/clear-today", response_model=SignalAlertClearResponse)
    async def clear_today(date: str = Query(default_factory=_today, pattern=r"^\d{8}$")) -> SignalAlertClearResponse:
        return clear_today_inbox(data_dir, date)

    return router
```

- [ ] **Step 4: Include router**

Modify `hoga/api/app.py`:

```python
from hoga.api.signal_alert_routes import build_router as build_signal_alert_router
```

and include it near the other routers:

```python
app.include_router(build_signal_alert_router(data_dir=data_dir))
```

- [ ] **Step 5: Run route tests**

Run: `uv run pytest tests/test_signal_alert_routes.py tests/unit/live/test_signal_alerts.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/app.py hoga/api/signal_alert_routes.py tests/test_signal_alert_routes.py
git commit -m "feat: add signal alert API"
```

---

### Task 4: Feed WS and REST Snapshots Into Monitor

**Files:**
- Modify: `hoga/live/lifecycle.py`
- Modify: `hoga/live/stream.py`
- Modify: `hoga/live/rest30_recorder.py`
- Test: `tests/unit/live/test_signal_alert_monitor.py` or focused existing lifecycle tests.

**Interfaces:**
- Consumes: `SignalAlertMonitor.set_targets`, `SignalAlertMonitor.ingest_orderbook`.
- Produces: lifecycle functions:
  - `configure_signal_alert_monitor(data_dir: Path, publish: Callable[[dict], None]) -> None`
  - `get_signal_alert_monitor() -> SignalAlertMonitor | None`

- [ ] **Step 1: Add focused ingestion test**

Append to `tests/unit/live/test_signal_alert_monitor.py`:

```python
def test_set_targets_removes_stale_state(tmp_path: Path) -> None:
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})
    monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "ws")

    monitor.set_targets({"000660"})

    assert monitor.ingest_orderbook("005930", "삼성전자", 11_00_00, 1_000, "ws") is None
```

- [ ] **Step 2: Run test**

Run: `uv run pytest tests/unit/live/test_signal_alert_monitor.py::test_set_targets_removes_stale_state -v`

Expected: PASS if Task 2 already removes stale state.

- [ ] **Step 3: Add lifecycle singleton**

Modify `hoga/live/lifecycle.py`:

```python
from hoga.live.signal_alert_monitor import SignalAlertMonitor
```

Add module state near `_buffer`:

```python
_signal_alert_monitor: SignalAlertMonitor | None = None


def configure_signal_alert_monitor(data_dir: Path, publish: Callable[[dict], None]) -> None:
    global _signal_alert_monitor
    _signal_alert_monitor = SignalAlertMonitor(data_dir, publish=publish)


def get_signal_alert_monitor() -> SignalAlertMonitor | None:
    return _signal_alert_monitor
```

Modify `_sync_storage_targets` in `hoga/live/lifecycle.py` so the monitor target set is synced from the returned `snapshot`:

```python
monitor = get_signal_alert_monitor()
if monitor is not None:
    monitor.set_targets(set(snapshot.ws_targets) | set(snapshot.kis_api_targets))
```

The final helper should look like:

```python
async def _sync_storage_targets(
    data_dir: Path,
    *,
    n_configured: int | None = None,
) -> tuple[list[str], tuple[str, ...]]:
    snapshot = await sync_storage_runtime(
        data_dir,
        state=_state,
        buffer=_buffer,
        date_fn=_today_kst,
        now_ms_fn=_now_ms,
        n_configured=n_configured,
    )
    monitor = get_signal_alert_monitor()
    if monitor is not None:
        monitor.set_targets(set(snapshot.ws_targets) | set(snapshot.kis_api_targets))
    return list(snapshot.ws_targets), snapshot.kis_api_targets
```

- [ ] **Step 4: Wire monitor at app startup**

Modify `hoga/api/app.py` after `bus` is constructed and before routers are included:

```python
from hoga.live.lifecycle import configure_signal_alert_monitor

configure_signal_alert_monitor(data_dir, bus.publish)
```

- [ ] **Step 5: Feed WS orderbook snapshots**

Modify `hoga/live/stream.py` inside the OB branch after `total_ask_qty` is parsed or payload is available:

```python
from .lifecycle import get_signal_alert_monitor
```

Use this helper in the OB path:

```python
monitor = get_signal_alert_monitor()
if monitor is not None:
    total_ask = tick.payload.get("total_ask_qty")
    if type(total_ask) is int:
        monitor.ingest_orderbook(
            code=tick.code,
            name=tick.code,
            t_ms=tick.t_ms,
            total_ask_qty=total_ask,
            source="ws",
        )
```

Keep it after active-code filtering and regular orderbook validation so non-target or malformed ticks do not alert.

- [ ] **Step 6: Feed REST orderbook snapshots**

Modify `hoga/live/rest30_recorder.py` in `_fetch_write_publish` after `ob = await kis.fetch_orderbook(code)`:

```python
from .lifecycle import get_signal_alert_monitor
```

Then:

```python
monitor = get_signal_alert_monitor()
if monitor is not None:
    monitor.ingest_orderbook(
        code=code,
        name=code,
        t_ms=ob.t_ms,
        total_ask_qty=ob.total_ask_qty,
        source="rest",
    )
```

- [ ] **Step 7: Run backend tests**

Run: `uv run pytest tests/unit/live/test_signal_alert_monitor.py tests/unit/live/test_signal_alerts.py tests/test_signal_alert_routes.py -v`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hoga/live/lifecycle.py hoga/live/stream.py hoga/live/rest30_recorder.py hoga/api/app.py tests/unit/live/test_signal_alert_monitor.py
git commit -m "feat: feed live signal alerts"
```

---

### Task 5: Frontend API Types and Event Plumbing

**Files:**
- Create: `frontend/src/api/signalAlerts.ts`
- Modify: `frontend/src/api/types.ts`
- Create: `frontend/src/state/signalAlertInbox.ts`
- Test: `frontend/src/api/signalAlerts.test.ts`, `frontend/src/state/signalAlertInbox.test.ts`

**Interfaces:**
- Produces `SignalAlertEvent`, `SignalAlertSettings`, `SignalAlertRecentResponse`, `SignalAlertClearResponse`.
- Produces `useSignalAlertSettings`, `usePatchSignalAlertSettings`, `useSignalAlertRecent`, `useClearSignalAlertToday`.
- Produces Zustand store `useSignalAlertInboxStore` with `unreadCount`, `markPanelSeen()`, `noteIncoming(event)`, `resetForClear(date)`.

- [ ] **Step 1: Write frontend API tests**

Create `frontend/src/api/signalAlerts.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { clearTodaySignalAlerts, getSignalAlertRecent, patchSignalAlertSettings } from './signalAlerts';

vi.mock('./client', () => ({
  apiCall: vi.fn(),
}));

import { apiCall } from './client';

describe('signalAlerts api', () => {
  beforeEach(() => vi.mocked(apiCall).mockReset());

  it('requests inbox recent alerts by date', async () => {
    vi.mocked(apiCall).mockResolvedValue({ date: '20260701', scope: 'inbox', cleared_through_seq: 0, alerts: [] });
    await getSignalAlertRecent('20260701');
    expect(apiCall).toHaveBeenCalledWith('/api/signal-alerts/recent?date=20260701&limit=100&scope=inbox');
  });

  it('patches settings', async () => {
    vi.mocked(apiCall).mockResolvedValue({});
    await patchSignalAlertSettings({
      sell_total_renewal: { enabled: true, start_hhmm: 1100, threshold_pct: 100, use_intra_minute_max: true },
    });
    expect(apiCall).toHaveBeenCalledWith('/api/signal-alerts/settings', expect.objectContaining({ method: 'PATCH' }));
  });

  it('clears today inbox by date', async () => {
    vi.mocked(apiCall).mockResolvedValue({ date: '20260701', cleared_through_seq: 2 });
    await clearTodaySignalAlerts('20260701');
    expect(apiCall).toHaveBeenCalledWith('/api/signal-alerts/clear-today?date=20260701', { method: 'POST' });
  });
});
```

- [ ] **Step 2: Add API module**

Create `frontend/src/api/signalAlerts.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

export type SignalAlertSource = 'ws' | 'rest';
export type SignalAlertName = 'sell_total_renewal';

export interface SignalAlertEvent {
  type: 'signal_alert';
  id: string;
  signal: SignalAlertName;
  seq: number;
  code: string;
  name: string;
  t_ms: number;
  date: string;
  source: SignalAlertSource;
  value: number;
  baseline: number;
  ratio_pct: number;
  use_intra_minute_max: boolean;
}

export interface SignalAlertSettings {
  schema_version: number;
  sell_total_renewal: {
    enabled: boolean;
    start_hhmm: number;
    threshold_pct: number;
    use_intra_minute_max: boolean;
  };
}

export type SignalAlertSettingsPatch = Pick<SignalAlertSettings, 'sell_total_renewal'>;

export interface SignalAlertRecentResponse {
  date: string;
  scope: 'inbox' | 'all';
  cleared_through_seq: number;
  alerts: SignalAlertEvent[];
}

export interface SignalAlertClearResponse {
  date: string;
  cleared_through_seq: number;
}

export const SIGNAL_ALERT_SETTINGS_KEY = ['signal-alerts', 'settings'] as const;
export const signalAlertRecentKey = (date: string) => ['signal-alerts', 'recent', date, 'inbox'] as const;

export function getSignalAlertSettings(): Promise<SignalAlertSettings> {
  return apiCall<SignalAlertSettings>('/api/signal-alerts/settings');
}

export function patchSignalAlertSettings(patch: SignalAlertSettingsPatch): Promise<SignalAlertSettings> {
  return apiCall<SignalAlertSettings>('/api/signal-alerts/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function getSignalAlertRecent(date: string): Promise<SignalAlertRecentResponse> {
  return apiCall<SignalAlertRecentResponse>(`/api/signal-alerts/recent?date=${date}&limit=100&scope=inbox`);
}

export function clearTodaySignalAlerts(date: string): Promise<SignalAlertClearResponse> {
  return apiCall<SignalAlertClearResponse>(`/api/signal-alerts/clear-today?date=${date}`, { method: 'POST' });
}

export function useSignalAlertSettings() {
  return useQuery({ queryKey: SIGNAL_ALERT_SETTINGS_KEY, queryFn: getSignalAlertSettings });
}

export function usePatchSignalAlertSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchSignalAlertSettings,
    onSuccess: (settings) => qc.setQueryData(SIGNAL_ALERT_SETTINGS_KEY, settings),
  });
}

export function useSignalAlertRecent(date: string) {
  return useQuery({ queryKey: signalAlertRecentKey(date), queryFn: () => getSignalAlertRecent(date) });
}

export function useClearSignalAlertToday(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => clearTodaySignalAlerts(date),
    onSuccess: () => qc.invalidateQueries({ queryKey: signalAlertRecentKey(date) }),
  });
}
```

- [ ] **Step 3: Extend PushEvent type**

Modify `frontend/src/api/types.ts`:

```ts
import type { SignalAlertEvent } from './signalAlerts';
```

Add to `PushEvent` union:

```ts
| SignalAlertEvent
```

- [ ] **Step 4: Add inbox UI state tests and store**

Create `frontend/src/state/signalAlertInbox.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useSignalAlertInboxStore } from './signalAlertInbox';
import type { SignalAlertEvent } from '../api/signalAlerts';

const event: SignalAlertEvent = {
  type: 'signal_alert',
  id: 'a',
  signal: 'sell_total_renewal',
  seq: 1,
  code: '005930',
  name: '삼성전자',
  t_ms: 1,
  date: '20260701',
  source: 'ws',
  value: 1000,
  baseline: 1000,
  ratio_pct: 100,
  use_intra_minute_max: true,
};

describe('signalAlertInbox store', () => {
  beforeEach(() => useSignalAlertInboxStore.setState({ unreadCount: 0, lastSeenAtMs: 0 }));

  it('increments unread for incoming alerts and resets on panel seen', () => {
    useSignalAlertInboxStore.getState().noteIncoming(event);
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(1);
    useSignalAlertInboxStore.getState().markPanelSeen();
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);
  });

  it('resets unread after clear', () => {
    useSignalAlertInboxStore.getState().noteIncoming(event);
    useSignalAlertInboxStore.getState().resetForClear('20260701');
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);
  });
});
```

Create `frontend/src/state/signalAlertInbox.ts`:

```ts
import { create } from 'zustand';
import type { SignalAlertEvent } from '../api/signalAlerts';

type Store = {
  unreadCount: number;
  lastSeenAtMs: number;
  noteIncoming: (event: SignalAlertEvent) => void;
  markPanelSeen: () => void;
  resetForClear: (date: string) => void;
};

export const useSignalAlertInboxStore = create<Store>((set) => ({
  unreadCount: 0,
  lastSeenAtMs: 0,
  noteIncoming: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  markPanelSeen: () => set({ unreadCount: 0, lastSeenAtMs: Date.now() }),
  resetForClear: () => set({ unreadCount: 0, lastSeenAtMs: Date.now() }),
}));
```

- [ ] **Step 5: Run frontend unit tests**

Run: `cd frontend && npm test -- src/api/signalAlerts.test.ts src/state/signalAlertInbox.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/signalAlerts.ts frontend/src/api/signalAlerts.test.ts frontend/src/api/types.ts frontend/src/state/signalAlertInbox.ts frontend/src/state/signalAlertInbox.test.ts
git commit -m "feat: add signal alert frontend api"
```

---

### Task 6: Right Rail Alert Inbox UI

**Files:**
- Create: `frontend/src/signalAlerts/SignalAlertsDrawer.tsx`
- Test: `frontend/src/signalAlerts/SignalAlertsDrawer.test.tsx`
- Modify: `frontend/src/state/rightRail.ts`
- Modify: `frontend/src/state/rightRail.test.ts`
- Modify: `frontend/src/rightrail/RightRail.tsx`
- Modify: `frontend/src/rightrail/RightRail.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes `useSignalAlertRecent`, `useClearSignalAlertToday`, `SignalAlertEvent`.
- Produces `SignalAlertsDrawer` right-rail panel with id `right-rail-signal-alerts-panel`.

- [ ] **Step 1: Extend right rail store tests**

Update `frontend/src/state/rightRail.test.ts`:

```ts
it('accepts signalAlerts as a persisted panel', async () => {
  localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'signalAlerts' }));
  vi.resetModules();
  const { useRightRailStore: fresh } = await import('./rightRail');
  expect(fresh.getState().activePanel).toBe('signalAlerts');
});
```

- [ ] **Step 2: Extend right rail store**

Modify `frontend/src/state/rightRail.ts`:

```ts
export type RailPanel = 'watchlist' | 'screener' | 'savedViews' | 'signalAlerts';
const VALID_PANELS: readonly RailPanel[] = ['watchlist', 'screener', 'savedViews', 'signalAlerts'];
```

- [ ] **Step 3: Add drawer component test**

Create `frontend/src/signalAlerts/SignalAlertsDrawer.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SignalAlertsDrawer from './SignalAlertsDrawer';
import * as api from '../api/signalAlerts';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('SignalAlertsDrawer', () => {
  it('renders alerts newest first and clears inbox', async () => {
    vi.spyOn(api, 'getSignalAlertRecent').mockResolvedValue({
      date: '20260701',
      scope: 'inbox',
      cleared_through_seq: 0,
      alerts: [{
        type: 'signal_alert',
        id: 'a',
        signal: 'sell_total_renewal',
        seq: 1,
        code: '005930',
        name: '삼성전자',
        t_ms: 1_779_851_250_000,
        date: '20260701',
        source: 'ws',
        value: 1_240_000,
        baseline: 1_200_000,
        ratio_pct: 103.3,
        use_intra_minute_max: true,
      }],
    });
    vi.spyOn(api, 'clearTodaySignalAlerts').mockResolvedValue({ date: '20260701', cleared_through_seq: 1 });

    renderWithQuery(<SignalAlertsDrawer today="20260701" />);

    expect(await screen.findByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByText(/103.3%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '오늘 인박스 비우기' }));
    fireEvent.click(screen.getByRole('button', { name: '비우기 확인' }));

    await waitFor(() => expect(api.clearTodaySignalAlerts).toHaveBeenCalledWith('20260701'));
  });
});
```

- [ ] **Step 4: Implement drawer**

Create `frontend/src/signalAlerts/SignalAlertsDrawer.tsx`:

```tsx
import { useNavigate } from 'react-router';
import { useState } from 'react';
import { useClearSignalAlertToday, useSignalAlertRecent, type SignalAlertEvent } from '../api/signalAlerts';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailState, RailToolbarIconButton } from '../ui/RailShell';

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms);
}

function todayKst(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(Date.now());
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}${m}${d}`;
}

export default function SignalAlertsDrawer({ today = todayKst() }: { today?: string }) {
  const { data, isLoading, error } = useSignalAlertRecent(today);
  const clearMutation = useClearSignalAlertToday(today);
  const resetForClear = useSignalAlertInboxStore((s) => s.resetForClear);
  const markPanelSeen = useSignalAlertInboxStore((s) => s.markPanelSeen);
  const [confirming, setConfirming] = useState(false);

  const alerts = data?.alerts ?? [];

  return (
    <RailDrawer id="right-rail-signal-alerts-panel" testId="signal-alerts-drawer" ariaLabel="시그널 알림">
      <RailDrawerHeader
        title="시그널 알림"
        actions={
          <RailToolbarIconButton
            aria-label="오늘 인박스 비우기"
            disabled={alerts.length === 0 || clearMutation.isPending}
            onClick={() => setConfirming(true)}
          >
            ×
          </RailToolbarIconButton>
        }
      />
      <div className="border-b border-border px-md py-2 text-xs text-fg-dim">
        오늘 {alerts.length.toLocaleString()}건
      </div>
      {confirming && (
        <div role="dialog" aria-label="오늘 인박스 비우기 확인" className="border-b border-border p-md text-sm">
          <p className="mb-2 text-fg">오늘 시그널 알림 인박스를 비울까요? 기록은 날짜별 내역에 보관됩니다.</p>
          <div className="flex gap-2">
            <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setConfirming(false)}>취소</button>
            <button
              type="button"
              className="rounded border border-line-strong px-2 py-1 text-sm text-fg"
              aria-label="비우기 확인"
              onClick={() => {
                clearMutation.mutate(undefined, {
                  onSuccess: () => {
                    resetForClear(today);
                    setConfirming(false);
                  },
                });
              }}
            >
              비우기
            </button>
          </div>
        </div>
      )}
      <RailDrawerBody>
        {isLoading && <RailState>불러오는 중…</RailState>}
        {error && <RailState tone="error">알림 내역을 불러오지 못했습니다.</RailState>}
        {!isLoading && !error && alerts.length === 0 && <RailState>오늘 알림이 없습니다.</RailState>}
        <ul className="divide-y divide-border">
          {alerts.map((alert) => <SignalAlertRow key={alert.id} alert={alert} onSeen={markPanelSeen} />)}
        </ul>
      </RailDrawerBody>
    </RailDrawer>
  );
}

function SignalAlertRow({ alert, onSeen }: { alert: SignalAlertEvent; onSeen: () => void }) {
  const navigate = useNavigate();
  return (
    <li>
      <button
        type="button"
        className="w-full px-md py-sm text-left hover:bg-bg-input-hover"
        onClick={() => {
          onSeen();
          navigate(`/live?code=${alert.code}`);
        }}
      >
        <div className="flex items-center gap-2 text-sm text-fg">
          <span className="tabular-nums text-xs text-fg-dimmer">{formatTime(alert.t_ms)}</span>
          <span className="min-w-0 truncate">{alert.name}</span>
          <span className="text-xs text-fg-dimmer">{alert.code}</span>
        </div>
        <div className="mt-1 text-xs text-fg-dim">
          매도 총잔량 {alert.value.toLocaleString()} · 기준 대비 {alert.ratio_pct.toFixed(1)}% · {alert.source.toUpperCase()}
        </div>
      </button>
    </li>
  );
}
```

- [ ] **Step 5: Add rail button and App panel**

Create `frontend/src/ui/BellIcon.tsx`:

```tsx
export function BellIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
```

Modify `frontend/src/rightrail/RightRail.tsx`:

```tsx
import { BellIcon } from '../ui/BellIcon';
```

Add rail item below saved views:

```tsx
<RailItem
  label="알림"
  ariaLabel="시그널 알림 패널 토글"
  controls="right-rail-signal-alerts-panel"
  active={activePanel === 'signalAlerts'}
  onClick={() => togglePanel('signalAlerts')}
  icon={<BellIcon className="w-[1.125em] h-[1.125em]" />)}
/>
```

Modify `frontend/src/App.tsx`:

```tsx
import SignalAlertsDrawer from './signalAlerts/SignalAlertsDrawer';
```

and render:

```tsx
{activePanel === 'signalAlerts' && <SignalAlertsDrawer />}
```

- [ ] **Step 6: Update right rail tests**

Update `frontend/src/rightrail/RightRail.test.tsx`:

```ts
it('renders signal alerts below saved views', () => {
  render(<RightRail />);
  expect(screen.getByRole('button', { name: '시그널 알림 패널 토글' })).toBeTruthy();
});
```

- [ ] **Step 7: Run frontend tests**

Run: `cd frontend && npm test -- src/state/rightRail.test.ts src/rightrail/RightRail.test.tsx src/signalAlerts/SignalAlertsDrawer.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/state/rightRail.ts frontend/src/state/rightRail.test.ts frontend/src/rightrail/RightRail.tsx frontend/src/rightrail/RightRail.test.tsx frontend/src/App.tsx frontend/src/ui/BellIcon.tsx frontend/src/signalAlerts/SignalAlertsDrawer.tsx frontend/src/signalAlerts/SignalAlertsDrawer.test.tsx
git commit -m "feat: add signal alert rail panel"
```

---

### Task 7: Settings UI

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/pages/Settings.test.tsx`

**Interfaces:**
- Consumes: `useSignalAlertSettings`, `usePatchSignalAlertSettings`.
- Produces: Settings section titled `시그널 알림` with four controls.

- [ ] **Step 1: Write failing Settings test**

Append to `frontend/src/pages/Settings.test.tsx`:

```tsx
import * as signalAlertsApi from '../api/signalAlerts';
```

Add:

```tsx
it('renders signal alert settings and saves threshold changes', async () => {
  vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
    count: 0, fetched_at_ms: null, status: 'fresh', reason: null,
  });
  vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
    schema_version: 1,
    sell_total_renewal: {
      enabled: true,
      start_hhmm: 1100,
      threshold_pct: 100,
      use_intra_minute_max: true,
    },
  });
  const patch = vi.spyOn(signalAlertsApi, 'patchSignalAlertSettings').mockResolvedValue({
    schema_version: 1,
    sell_total_renewal: {
      enabled: true,
      start_hhmm: 1100,
      threshold_pct: 95,
      use_intra_minute_max: true,
    },
  });

  renderWithQuery(<Settings />);

  expect(await screen.findByText('시그널 알림')).toBeInTheDocument();
  const threshold = screen.getByLabelText('기준 최대값 대비 문턱 (%)') as HTMLInputElement;
  threshold.value = '95';
  threshold.dispatchEvent(new Event('change', { bubbles: true }));
  threshold.dispatchEvent(new Event('blur', { bubbles: true }));

  await waitFor(() => expect(patch).toHaveBeenCalled());
});
```

- [ ] **Step 2: Run failing test**

Run: `cd frontend && npm test -- src/pages/Settings.test.tsx`

Expected: FAIL because `시그널 알림` section is missing.

- [ ] **Step 3: Implement settings section**

Modify `frontend/src/pages/Settings.tsx` imports:

```tsx
import { useSignalAlertSettings, usePatchSignalAlertSettings } from '../api/signalAlerts';
```

Add inside the `PanelCard` after Symbol Master:

```tsx
<DataSection title="시그널 알림" contentClassName="space-y-3 p-md">
  <SignalAlertSettingsSection />
</DataSection>
```

Add component:

```tsx
function SignalAlertSettingsSection() {
  const { data } = useSignalAlertSettings();
  const patch = usePatchSignalAlertSettings();
  const rule = data?.sell_total_renewal ?? {
    enabled: true,
    start_hhmm: 1100,
    threshold_pct: 100,
    use_intra_minute_max: true,
  };
  const update = (next: typeof rule) => {
    patch.mutate({ sell_total_renewal: next });
  };
  return (
    <section className="space-y-3">
      <label className="flex items-center justify-between gap-3 text-sm text-fg">
        <span>알림 사용</span>
        <input
          type="checkbox"
          aria-label="알림 사용"
          checked={rule.enabled}
          onChange={(event) => update({ ...rule, enabled: event.currentTarget.checked })}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-fg">
        <span>기준 시각</span>
        <input
          aria-label="기준 시각"
          className="w-24 rounded border border-border bg-bg-input px-2 py-1 text-right text-sm text-fg"
          value={`${String(Math.floor(rule.start_hhmm / 100)).padStart(2, '0')}:${String(rule.start_hhmm % 100).padStart(2, '0')}`}
          onChange={(event) => {
            const [hh, mm] = event.currentTarget.value.split(':').map((v) => Number(v));
            if (Number.isFinite(hh) && Number.isFinite(mm)) update({ ...rule, start_hhmm: hh * 100 + mm });
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-fg">
        <span>기준 최대값 대비 문턱 (%)</span>
        <input
          type="number"
          min={50}
          max={150}
          aria-label="기준 최대값 대비 문턱 (%)"
          className="w-24 rounded border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg"
          value={rule.threshold_pct}
          onChange={(event) => update({ ...rule, threshold_pct: Number(event.currentTarget.value) })}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-fg">
        <span>분봉 내 최대 매도 총잔량으로 판정</span>
        <input
          type="checkbox"
          aria-label="분봉 내 최대 매도 총잔량으로 판정"
          checked={rule.use_intra_minute_max}
          onChange={(event) => update({ ...rule, use_intra_minute_max: event.currentTarget.checked })}
        />
      </label>
    </section>
  );
}
```

- [ ] **Step 4: Run Settings test**

Run: `cd frontend && npm test -- src/pages/Settings.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/pages/Settings.test.tsx
git commit -m "feat: add signal alert settings"
```

---

### Task 8: WebSocket Event Handling and Toasts

**Files:**
- Create: `frontend/src/signalAlerts/SignalAlertToastHost.tsx`
- Create: `frontend/src/signalAlerts/useSignalAlertEvents.ts`
- Test: `frontend/src/signalAlerts/useSignalAlertEvents.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `subscribeEvents`.
- Produces: root hook `useSignalAlertEvents()` and toast host component.

- [ ] **Step 1: Write event handling test**

Create `frontend/src/signalAlerts/useSignalAlertEvents.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PushEvent } from '../api/types';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';
import { useSignalAlertEvents } from './useSignalAlertEvents';

const subs: Array<(event: PushEvent) => void> = [];
vi.mock('../api/ws', () => ({
  subscribeEvents: (cb: (event: PushEvent) => void) => {
    subs.push(cb);
    return () => {};
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useSignalAlertEvents', () => {
  it('increments unread on signal_alert event', () => {
    useSignalAlertInboxStore.setState({ unreadCount: 0, lastSeenAtMs: 0 });
    renderHook(() => useSignalAlertEvents(), { wrapper });

    subs[0]({
      type: 'signal_alert',
      id: 'a',
      signal: 'sell_total_renewal',
      seq: 1,
      code: '005930',
      name: '삼성전자',
      t_ms: 1,
      date: '20260701',
      source: 'ws',
      value: 1000,
      baseline: 1000,
      ratio_pct: 100,
      use_intra_minute_max: true,
    });

    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(1);
  });
});
```

- [ ] **Step 2: Implement hook**

Create `frontend/src/signalAlerts/useSignalAlertEvents.ts`:

```ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeEvents } from '../api/ws';
import type { PushEvent } from '../api/types';
import { signalAlertRecentKey, type SignalAlertEvent } from '../api/signalAlerts';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

export function useSignalAlertEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeEvents((event: PushEvent) => {
      if (!isSignalAlert(event)) return;
      useSignalAlertInboxStore.getState().noteIncoming(event);
      qc.setQueryData(signalAlertRecentKey(event.date), (prev: unknown) => {
        if (!prev || typeof prev !== 'object' || !('alerts' in prev)) return prev;
        const typed = prev as { alerts: SignalAlertEvent[] };
        if (typed.alerts.some((row) => row.id === event.id)) return typed;
        return { ...typed, alerts: [event, ...typed.alerts] };
      });
    });
  }, [qc]);
}
```

- [ ] **Step 3: Add toast host**

Create `frontend/src/signalAlerts/SignalAlertToastHost.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { subscribeEvents } from '../api/ws';
import type { PushEvent } from '../api/types';
import type { SignalAlertEvent } from '../api/signalAlerts';

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

export default function SignalAlertToastHost() {
  const [toasts, setToasts] = useState<SignalAlertEvent[]>([]);
  useEffect(() => subscribeEvents((event) => {
    if (!isSignalAlert(event)) return;
    setToasts((prev) => [event, ...prev].slice(0, 3));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== event.id));
    }, 5000);
  }), []);

  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="fixed right-[calc(var(--rail-w)+12px)] top-12 z-[80] space-y-2">
      {toasts.map((toast) => (
        <div key={toast.id} role="status" className="w-72 rounded border border-border bg-bg-card px-3 py-2 text-sm shadow-lg">
          <div className="font-medium text-fg">{toast.name} 신고 매도 총잔량 갱신</div>
          <div className="mt-1 text-xs text-fg-dim">
            {toast.value.toLocaleString()} / 기준 대비 {toast.ratio_pct.toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire App root**

Modify `frontend/src/App.tsx`:

```tsx
import SignalAlertToastHost from './signalAlerts/SignalAlertToastHost';
import { useSignalAlertEvents } from './signalAlerts/useSignalAlertEvents';
```

Inside `App()`:

```tsx
useSignalAlertEvents();
```

Render the host near the root:

```tsx
<SignalAlertToastHost />
```

- [ ] **Step 5: Run tests**

Run: `cd frontend && npm test -- src/signalAlerts/useSignalAlertEvents.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/signalAlerts/SignalAlertToastHost.tsx frontend/src/signalAlerts/useSignalAlertEvents.ts frontend/src/signalAlerts/useSignalAlertEvents.test.tsx
git commit -m "feat: show signal alert toasts"
```

---

### Task 9: Final Verification and Regression Sweep

**Files:**
- Modify only if tests expose bugs in files from Tasks 1-8.

**Interfaces:**
- Consumes all previous tasks.
- Produces a verified working feature.

- [ ] **Step 1: Run backend focused tests**

Run:

```bash
uv run pytest \
  tests/unit/live/test_signal_alerts.py \
  tests/unit/live/test_signal_alert_monitor.py \
  tests/test_signal_alert_routes.py \
  -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend focused tests**

Run:

```bash
cd frontend && npm test -- \
  src/api/signalAlerts.test.ts \
  src/state/signalAlertInbox.test.ts \
  src/state/rightRail.test.ts \
  src/rightrail/RightRail.test.tsx \
  src/signalAlerts/SignalAlertsDrawer.test.tsx \
  src/signalAlerts/useSignalAlertEvents.test.tsx \
  src/pages/Settings.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run type/build checks**

Run:

```bash
uv run pytest tests/test_api_test_routes.py -v
cd frontend && npm run build
```

Expected: backend smoke PASS; frontend `tsc -b && vite build` PASS.

- [ ] **Step 4: Manual smoke with generated data**

Use a temporary data dir and insert two alert events through the backend store in a Python shell:

```bash
uv run python - <<'PY'
from pathlib import Path
from hoga.api.models import SignalAlertEvent
from hoga.live.signal_alerts import append_signal_alert
p = Path('/tmp/hoga-signal-alert-smoke')
p.mkdir(parents=True, exist_ok=True)
append_signal_alert(p, SignalAlertEvent(type='signal_alert', id='20260701:005930:sell_total_renewal:1:ws', signal='sell_total_renewal', seq=1, code='005930', name='삼성전자', t_ms=1779851250000, date='20260701', source='ws', value=1240000, baseline=1200000, ratio_pct=103.3, use_intra_minute_max=True))
print(p)
PY
```

Start the backend and frontend in two terminals:

```bash
HOGA_DATA_DIR=/tmp/hoga-signal-alert-smoke uv run uvicorn hoga.api.app:create_app --factory --host 127.0.0.1 --port 8000
```

```bash
cd frontend && npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173`, open the right rail `알림` panel, verify the row renders, click it, and verify `/live?code=005930` opens.

- [ ] **Step 5: Inspect git diff**

Run: `git status --short && git diff --stat`

Expected: no uncommitted changes after previous task commits. If there are test-fix changes, commit the concrete files reported by `git status --short`. For example, if only `frontend/src/App.tsx` changed:

```bash
git add frontend/src/App.tsx
git commit -m "fix: stabilize signal alert feature"
```

---

## Self-Review

Spec coverage:

- Alert rule defaults: Task 1 models and Task 2 monitor.
- WS and REST inputs: Task 4.
- Date-partitioned append-only ledger: Task 1.
- Inbox clear without deleting ledger: Task 1 API/store and Task 6 UI.
- Settings page controls: Task 7.
- Right rail alert inbox: Task 6.
- Toasts: Task 8.
- Row click to live chart: Task 6.
- Tests and manual verification: Tasks 1-9.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified "handle edge cases" steps.
- Each task has concrete files, commands, and expected outcomes.

Type consistency:

- Backend event model name is `SignalAlertEvent` in all tasks.
- Frontend panel value is `signalAlerts` in all tasks.
- Clear boundary field is `cleared_through_seq` / `cleared_through_seq_by_date` in all tasks.
