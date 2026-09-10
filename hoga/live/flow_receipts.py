"""Receipt health independent of deduplicated flow values (not task liveness)."""
from __future__ import annotations

from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, ValidationError

from hoga.util.atomic_write import atomic_write_json

DEFAULT_POLL_INTERVAL_S = 10.0
FlowStatus = Literal["waiting", "receiving", "delayed", "closed", "unavailable", "unknown"]


class ReceiptGap(BaseModel):
    start_ms: int
    end_ms: int


class CollectionRun(BaseModel):
    run_id: str
    started_at_ms: int
    poll_interval_ms: int


class FlowReceipt(BaseModel):
    last_attempt_at_ms: int | None = None
    last_success_at_ms: int | None = None
    last_written_at_ms: int | None = None
    consecutive_failures: int = 0
    error_kind: str | None = None
    failure_started_at_ms: int | None = None
    gaps: list[ReceiptGap] = Field(default_factory=list)


class ReceiptFile(BaseModel):
    date: str
    run_id: str
    started_at_ms: int
    updated_at_ms: int
    poll_interval_ms: int = Field(gt=0)
    runs: list[CollectionRun] = Field(default_factory=list)
    last_cycle_duration_ms: int | None = None
    targets: dict[str, FlowReceipt] = Field(default_factory=dict)


class FlowHealth(FlowReceipt):
    waiting_since_ms: int | None = None
    status: FlowStatus = "unknown"


class FlowCollection(BaseModel):
    server_now_ms: int
    collection_expected: bool
    poll_interval_ms: int
    stale_after_ms: int
    last_cycle_duration_ms: int | None = None
    runs: list[CollectionRun] = Field(default_factory=list)
    targets: dict[str, FlowHealth]


def read_receipts(root: Path, date: str) -> ReceiptFile | None:
    try:
        state = ReceiptFile.model_validate_json((root / "receipts" / f"{date}.json").read_bytes())
        return state if state.date == date else None
    except (OSError, ValidationError):
        return None


class FlowReceipts:
    """One writer, atomic file per day; restarted writers cannot inherit 'receiving'."""

    def __init__(self, root: Path, poll_interval_s: float) -> None:
        self.root = root
        self.poll_ms = int(poll_interval_s * 1000)
        self.run_id = uuid4().hex
        self.state: ReceiptFile | None = None

    def begin(self, date: str, now_ms: int, keys: list[str]) -> None:
        if self.state is not None and self.state.date == date:
            return
        old = read_receipts(self.root, date)
        targets = {key: FlowReceipt() for key in keys}
        if old:
            for key, target in targets.items():
                previous = old.targets.get(key)
                if previous:
                    target.last_written_at_ms = previous.last_written_at_ms
                    target.gaps = list(previous.gaps)
                    # Preserve confirmed failures across a restart, not old success.
                    target.failure_started_at_ms = previous.failure_started_at_ms
        self.state = ReceiptFile(
            date=date, run_id=self.run_id, started_at_ms=now_ms,
            updated_at_ms=now_ms, poll_interval_ms=self.poll_ms, targets=targets,
            runs=[*(old.runs if old else []), CollectionRun(
                run_id=self.run_id, started_at_ms=now_ms, poll_interval_ms=self.poll_ms,
            )],
        )
        self.save(now_ms)

    def attempt(self, key: str, now_ms: int) -> None:
        assert self.state is not None
        self.state.targets[key].last_attempt_at_ms = now_ms

    def failure(self, key: str, now_ms: int, kind: str) -> None:
        assert self.state is not None
        target = self.state.targets[key]
        target.consecutive_failures += 1
        target.error_kind = kind
        if target.failure_started_at_ms is None:
            target.failure_started_at_ms = now_ms

    def success(self, key: str, now_ms: int, *, written: bool) -> None:
        assert self.state is not None
        target = self.state.targets[key]
        if target.failure_started_at_ms is not None:
            target.gaps.append(ReceiptGap(start_ms=target.failure_started_at_ms, end_ms=now_ms))
        target.failure_started_at_ms = None
        target.last_success_at_ms = now_ms
        if written:
            target.last_written_at_ms = now_ms
        target.consecutive_failures = 0
        target.error_kind = None

    def save(self, now_ms: int) -> None:
        assert self.state is not None
        self.state.updated_at_ms = now_ms
        path = self.root / "receipts" / f"{self.state.date}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, self.state.model_dump())

    def cycle_completed(self, now_ms: int, duration_ms: int) -> None:
        if self.state is not None:
            self.state.last_cycle_duration_ms = duration_ms
            self.save(now_ms)


def collection_health(
    root: Path, date: str, *, now_ms: int, expected: bool, available: bool,
    keys: list[str], open_ms: int, poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
) -> FlowCollection:
    state = read_receipts(root, date)
    # A reading process may not own credentials. The writer's receipt is evidence
    # of configuration, but not proof that the writer is still alive.
    poll_ms = state.poll_interval_ms if state else int(poll_interval_s * 1000)
    stale_ms = max(poll_ms * 3, 1)
    targets: dict[str, FlowHealth] = {}
    for key in keys:
        receipt = state.targets.get(key, FlowReceipt()) if state else FlowReceipt()
        status: FlowStatus
        if not available and state is None:
            status = "unavailable"
        elif not expected:
            status = "closed"
        elif state is None:
            status = "unknown"
        elif receipt.last_success_at_ms is None:
            status = "waiting" if now_ms - max(open_ms, state.started_at_ms) <= stale_ms else "delayed"
        else:
            status = "delayed" if now_ms - receipt.last_success_at_ms > stale_ms else "receiving"
        targets[key] = FlowHealth(**receipt.model_dump(), status=status,
                                  waiting_since_ms=max(open_ms, state.started_at_ms) if state else None)
    return FlowCollection(
        server_now_ms=now_ms, collection_expected=expected, poll_interval_ms=poll_ms,
        stale_after_ms=stale_ms, targets=targets,
        last_cycle_duration_ms=state.last_cycle_duration_ms if state else None,
        runs=state.runs if state else [],
    )
