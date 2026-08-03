"""Integration: enqueue -> worker -> orchestrator -> timing JSON + SSE event.

End-to-end coverage for the timing instrumentation (plan §14):
- Enqueue an item, spin up the worker pool, drive it via the in-memory
  FakeHogaplayClient to termination, then verify that
  (a) `<data_dir>/timing/<date>/<code>.json` is written, and
  (b) exactly one `CaptureTimingEvent` was published.
- With `HOGA_CAPTURE_TIMING=0`, neither artifact appears.

The fake client + module-attribute DI seam (`captures._data_dir`,
`captures._client_factory`) is the same pattern used by
`test_api_captures_queue.py` (see `_run_capture_inner` in
hoga/api/captures.py:577 — `_require_client_factory()()` calls into the
patched factory).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from hoga.api import captures
from hoga.api.captures_fake import FakeHogaplayClient
from hoga.api.models import (
    CaptureFinishedEvent,
    CaptureQueueDrainedEvent,
    CaptureTimingEvent,
    EnqueueRequest,
)


@pytest.fixture(autouse=True)
def _reset():
    """Per-test reset of captures module singletons (matches the pattern in
    test_api_captures_queue.py)."""
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


@pytest.fixture(autouse=True)
def _skip_production_rate_limit(monkeypatch):
    """`_run_capture_inner` checks HOGA_ENABLE_TEST_ENDPOINTS=1 to zero out the
    300ms-per-page rate-limit sleep (captures.py:594). Without this the
    FakeHogaplayClient's 5-page loop would burn 1.5s of real time per test."""
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")


@dataclass
class _EventProbe:
    """Every `_publish_event` payload, plus a terminal signal to await on.

    `finished` is what makes the drain wait deterministic: `_finalize_item`
    publishes `CaptureFinishedEvent` from the event loop thread (it is an
    `async def` holding `_lock`), so setting an `asyncio.Event` here is a
    plain in-loop set — no `call_soon_threadsafe` needed.
    """

    events: list[Any] = field(default_factory=list)
    finished: asyncio.Event = field(default_factory=asyncio.Event)

    def record(self, event: Any) -> None:
        self.events.append(event)
        if isinstance(event, CaptureFinishedEvent):
            self.finished.set()

    def of_type(self, cls: type) -> list[Any]:
        return [e for e in self.events if isinstance(e, cls)]


@pytest.fixture
def captured_events(monkeypatch) -> _EventProbe:
    """Capture every `_publish_event` call from captures.py.

    The production path serializes via `model_dump` and hops to the event
    loop via `call_soon_threadsafe` — both irrelevant to this test, which
    cares only about WHICH typed events fired. Patching at the module
    boundary captures the typed objects directly.
    """
    probe = _EventProbe()
    monkeypatch.setattr(captures, "_publish_event", probe.record)
    return probe


@pytest.fixture
def fake_client(monkeypatch, tmp_path):
    """Wire the captures module to the in-memory fake client + a per-test
    data_dir. `_data_dir` and `_client_factory` are the documented DI seams
    (see captures.py:220-224)."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    return FakeHogaplayClient


# 행(hang) 백스톱 — **성능 예산이 아니다.** 정상 경로는 아래
# `_await_capture_finished` 가 SSE 종결 이벤트로 깨우므로 이 값은 통과/실패
# 판정에 관여하지 않는다. 실측 0.8s(로컬, CPU 바운드 — FakeHogaplayClient 가
# ~1,520 페이지를 재생·파싱한다)의 75배라, 러너가 아무리 느려도 닿지 않는다.
# 이게 걸리면 그건 느린 러너가 아니라 교착이고, 잡 전체가 timeout-minutes 로
# 죽는 대신 이 테스트가 원인을 지목하며 실패한다.
_HANG_BACKSTOP_S = 60.0


async def _await_capture_finished(
    probe: _EventProbe, workers: list[asyncio.Task],
) -> None:
    """Block until the item publishes its terminal SSE event — or a worker dies.

    벽시계 예산이 아니라 **이벤트**를 기다린다. 이전 판은
    ``wait_for(captures.wait_drained(), timeout=10.0)`` 였는데, ``wait_drained()``
    는 10ms 폴링 루프(captures.py:1354)라 완료를 관측할 수단이 벽시계뿐이었다.
    그래서 "완료 감지" 와 "행 방지" 가 숫자 하나에 뭉쳐 있었고, 그 숫자는 실측의
    12배에 불과했다 — 공유 러너가 느린 날 **무관한 PR** 이 이 2건으로 빨간불이
    됐다(#1002: 같은 커밋을 재실행하니 통과).

    ``CaptureFinishedEvent`` 는 ``_finalize_item`` 이 장부(_active·_inflight_paths·
    _done·persist) 정리를 마친 뒤 **마지막**으로 낸다(captures.py:1062). 그 시점엔
    ``_run_item`` 의 finally 가 이미 timing JSON 쓰기와 ``CaptureTimingEvent``
    발행을 끝냈으므로(captures.py:955-989), 이 신호를 본다는 것은 이 테스트가
    단언하는 산출물이 전부 존재한다는 뜻이다. 순서가 계약이라 경합이 없다.

    워커 태스크도 함께 기다리는 이유: ``_worker_loop`` 는 정상적으로 반환하지 않는
    무한 루프다. 따라서 "워커가 done" == "워커가 죽었다" 이고, 10초를 기다린 뒤
    익명의 TimeoutError 를 보는 대신 즉시 원래 예외를 드러낼 수 있다.
    """
    signal = asyncio.create_task(probe.finished.wait(), name="capture-finished")
    try:
        done, _pending = await asyncio.wait(
            [signal, *workers],
            timeout=_HANG_BACKSTOP_S,
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        signal.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await signal
    for w in workers:
        if w in done:
            # 예외로 죽었으면 여기서 그대로 raise 된다(동시에 "retrieved" 처리라
            # "exception was never retrieved" 경고도 나지 않는다).
            w.result()
            raise AssertionError(
                f"worker {w.get_name()} exited without finishing the item",
            )
    if signal not in done:
        raise AssertionError(
            f"capture never reached a terminal event within {_HANG_BACKSTOP_S}s — "
            "정상 경로 실측은 ~0.8s 이므로 이건 러너 속도가 아니라 교착이다",
        )


async def _enqueue_and_drain(
    tmp_path: Path, code: str, date: str, probe: _EventProbe,
) -> None:
    """Helper: enqueue one item, run the worker pool to drain, stop workers."""
    req = EnqueueRequest(code=code, dates=[date], force_retry=False)
    resp = await captures.enqueue_items_core(
        req, data_dir=tmp_path, now=captures._now_kst(),
    )
    assert len(resp.enqueued) == 1, "expected exactly one item enqueued"

    workers = captures.start_workers(n=1)
    try:
        await _await_capture_finished(probe, workers)
    finally:
        await captures.stop_workers(workers)

    # 큐가 실제로 바닥났다는 확인. 이전 판이 `wait_drained()` 폴링으로 간접
    # 관측하던 속성을 이제 드레인 SSE 로 직접 단언한다 — `_finalize_item` 은
    # `not _queue and not _active and not _queue_paused` 일 때만 이걸 내고,
    # 종결 이벤트보다 **먼저** 낸다(captures.py:1060). 폴링을 걷어내면서
    # 커버리지를 잃지 않기 위한 자리다.
    drained = probe.of_type(CaptureQueueDrainedEvent)
    assert len(drained) == 1, (
        f"expected 1 CaptureQueueDrainedEvent, got {len(drained)}"
    )


@pytest.mark.asyncio
async def test_capture_timing_json_and_sse_emitted(
    tmp_path: Path, captured_events, fake_client, monkeypatch,
):
    """Default-ON (HOGA_CAPTURE_TIMING unset): one timing JSON + one
    CaptureTimingEvent SSE per capture."""
    monkeypatch.delenv("HOGA_CAPTURE_TIMING", raising=False)

    code, date = "005930", "20260520"
    await _enqueue_and_drain(tmp_path, code, date, captured_events)

    # JSON written by the finally block (collector.to_report + write_timing_report).
    json_path = tmp_path / "timing" / date / f"{code}.json"
    assert json_path.exists(), f"timing JSON missing at {json_path}"

    data = json.loads(json_path.read_text())
    summary = data["summary"]

    # Structural sanity — not exact ms values (clock-dependent).
    assert summary["code"] == code
    assert summary["date"] == date
    assert summary["page_count"] >= 1
    assert summary["total_ms"] > 0
    # Phases sum cannot exceed total wall time (modulo float noise).
    assert sum(summary["phase_totals_ms"].values()) <= summary["total_ms"] + 1.0
    # Percentages + unaccounted normalize to ~100 (within rounding). Wall-clock
    # time outside any `phase(...)` wrap shows up as unaccounted_ms, so the
    # phase percentages alone can be well below 100 — only the SUM is the
    # invariant. See test_summary_phase_percentages_sum_to_100 for the
    # phase-only case (no unaccounted gap).
    total_ms = summary["total_ms"]
    unaccounted_pct = (summary["unaccounted_ms"] / total_ms) * 100.0 if total_ms > 0 else 0.0
    assert abs(sum(summary["phase_percentages"].values()) + unaccounted_pct - 100.0) < 0.5

    # SSE event published exactly once.
    timing_events = captured_events.of_type(CaptureTimingEvent)
    assert len(timing_events) == 1, (
        f"expected 1 CaptureTimingEvent, got {len(timing_events)}"
    )
    assert timing_events[0].id == f"{code}:{date}"


@pytest.mark.asyncio
async def test_capture_timing_disabled_skips_emit(
    tmp_path: Path, captured_events, fake_client, monkeypatch,
):
    """HOGA_CAPTURE_TIMING=0 -> no JSON file, no CaptureTimingEvent SSE.

    The disable path lives in `_run_item`: it constructs `collector = None`,
    so the finally block's `if collector is not None` branch is skipped
    entirely. Other SSE events (phase, progress, finished) still fire."""
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "0")

    code, date = "005930", "20260520"
    await _enqueue_and_drain(tmp_path, code, date, captured_events)

    # No timing directory should ever appear.
    assert not (tmp_path / "timing").exists(), (
        "timing directory was created despite HOGA_CAPTURE_TIMING=0"
    )

    timing_events = captured_events.of_type(CaptureTimingEvent)
    assert timing_events == [], (
        f"expected 0 CaptureTimingEvent with timing disabled, got {len(timing_events)}"
    )
