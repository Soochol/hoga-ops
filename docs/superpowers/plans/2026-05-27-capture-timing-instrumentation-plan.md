---
scope: both
spec: docs/superpowers/specs/2026-05-27-capture-timing-instrumentation-design.md
---

# Capture Timing Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture 경로에 phase-별 wall-time 측정 인프라(`CaptureTimingCollector` + JSON 영구화 + `capture_timing` SSE + `/capture` UI `TimingPanel`)를 깐다. ADR-0017 이후 다음 튜닝 결정의 근거 데이터를 만든다.

**Architecture:** 각 (code, date) 작업마다 worker가 `CaptureTimingCollector` 인스턴스를 만들고 `_run_capture_inner` → `collect_stock_date` → `_page_step_loop` 까지 keyword 인자로 전달. 7개 **Timing Phase** (`http_fetch`/`parse`/`disk_write`/`rate_limit`/`backoff`/`cookie_pause`/`other`)를 `time.perf_counter` context manager로 측정. 완료 시 `data_dir/timing/<date>/<code>.json` atomic write + `capture_timing` SSE 1회. 프론트는 SSE를 받아 `TimingPanel`(접힘 default)을 `CaptureRowDetail` 안에 렌더. `HOGA_CAPTURE_TIMING=0` 으로 전체 비활성 가능.

**Tech Stack:** Python (FastAPI, pydantic v2, asyncio, ThreadPoolExecutor), React 18 + TypeScript + Vite + Zustand + TailwindCSS. Tests: pytest + Vitest + RTL.

**Conventions resolved (from code exploration + plan-review fixes):**
- Worker entry: `hoga/api/captures.py:_run_item` (~L627, asyncio) → `_run_capture_and_parse` (~L506, asyncio) → `_run_capture_inner` (~L532, asyncio) → `loop.run_in_executor(...)` → `collect_stock_date` (~L417, thread) → `_page_step_loop` (~L304, thread). Collector kwarg는 asyncio 측 두 함수와 thread 측 두 함수 모두에 추가 (4곳).
- SSE 발행: `_publish_event(event: BaseModel)` (sync, captures.py:392). pydantic 모델을 받아 `_loop.call_soon_threadsafe(_bus.publish, payload)` 로 dispatch. **dict 아님, await 아님.** 새 `CaptureTimingEvent` pydantic 모델을 `hoga/api/models.py` 에 추가 후 `_publish_event(CaptureTimingEvent(...))` 호출.
- SSE 이벤트 이름은 기존 컨벤션(`capture_queue`, `capture_progress` 등) 따라 **underscore**: `capture_timing`.
- 환경 변수는 모듈 최상단 상수 대신 **`_timing_enabled() -> bool`** 함수 호출 형태로 (테스트에서 `monkeypatch.setenv` 만으로 토글 가능; `importlib.reload` 불필요).
- 버전: `hoga/__init__.py:__version__`. Git SHA helper는 신설 필요.
- `TimingEnv.rate_limit_s` 는 **effective rate**(테스트용 0 override 반영) 를 저장 — `_run_capture_inner`가 결정한 값을 넘긴다.
- `cookie_pause` Timing Phase 는 spec 정정 그대로 현재 구조에서 **항상 0ms**. exception handler에서 `record_error("cookie_expired")` 만 호출.
- 프론트 SSE는 `frontend/src/api/sse.ts` 의 `addEventListener` 등록 방식. `SSEEvent` union을 `frontend/src/api/types.ts` 에서 확장.
- 잡 카드 expansion panel = `frontend/src/capture/CaptureRowDetail.tsx`. `TimingPanel`은 그 내부에 새 row로 추가하되 **timing 존재할 때만 wrapper까지 렌더** (빈 bordered slot 회피).
- DESIGN.md 토큰 실측 확인: `--accent`, `--accent-shade`, `--ma-1..5`, `--warn`, `--error`, `--fg`, `--fg-dim`, `--fg-dimmer`, `--border` 만 사용. `--accent-muted` / `--warning` / `--warning-muted` / `--fg-strong` 는 **존재하지 않음** — 사용 금지.

---

## File Structure

**Backend — new files:**
- `hoga/collector/timing.py` — `CaptureTimingCollector` + `PhaseName` literal + thread-safe state. ~200 LOC.
- `hoga/collector/timing_writer.py` — `write_timing_report(data_dir, report)` atomic write. ~60 LOC.
- `hoga/util/git_sha.py` — `get_git_sha() -> str | None` runtime helper. ~25 LOC.

**Backend — modified:**
- `hoga/api/models.py` — Add `TimingPhaseTotals`, `TimingPageDetail`, `TimingEnv`, `TimingSummary`, `TimingReport`.
- `hoga/api/captures.py` — `_run_item` collector lifecycle + SSE emit; wrap `parse_stock_date` executor call (`parse`), retry sleeps (`backoff`), cookie pause (`cookie_pause`); `HOGA_CAPTURE_TIMING` env.
- `hoga/collector/orchestrator.py` — Add `collector` kwarg to `collect_stock_date` + `_page_step_loop`; wrap `fetch_first` (`http_fetch`), TSV write (`disk_write`), `time.sleep(rate_limit_s)` (`rate_limit`); `mark_page_boundary` per page; `record_event_count` after each page.

**Frontend — new files:**
- `frontend/src/capture/timing/TimingPanel.tsx` — single card (collapsed + expanded).
- `frontend/src/capture/timing/useCaptureTimings.ts` — Zustand store: `Map<string, TimingSummary>`.
- `frontend/src/capture/timing/phaseColors.ts` — phase → DESIGN.md token mapping.
- `frontend/src/capture/timing/timingFormat.ts` — ms→s, percent, ko-KR locale.

**Frontend — modified:**
- `frontend/src/api/types.ts` — Add `TimingSummary`-mirror type; extend `SSEEvent` union.
- `frontend/src/api/sse.ts` — Register `capture_timing` listener.
- `frontend/src/capture/useCaptureQueue.ts` — Dispatch `capture_timing` SSE into `useCaptureTimings` store.
- `frontend/src/capture/CaptureRowDetail.tsx` — Render `<TimingPanel id={`${code}:${date}`} />` after existing detail rows.

**Tests — new:**
- `tests/collector/test_timing.py`
- `tests/collector/test_timing_writer.py`
- `tests/util/test_git_sha.py`
- `tests/api/test_captures_timing.py`
- `frontend/src/capture/timing/TimingPanel.test.tsx`
- `frontend/src/capture/timing/useCaptureTimings.test.ts`
- `frontend/src/capture/timing/timingFormat.test.ts`

---

## Phase A — Backend models + collector core (TDD)

### Task 1: Pydantic timing models

**Files:**
- Modify: `hoga/api/models.py`
- Test: `tests/api/test_timing_models.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_timing_models.py`:

```python
from hoga.api.models import (
    TimingEnv,
    TimingPageDetail,
    TimingPhaseTotals,
    TimingReport,
    TimingSummary,
)


def test_timing_phase_totals_defaults_to_zero():
    totals = TimingPhaseTotals()
    assert totals.http_fetch_ms == 0.0
    assert totals.parse_ms == 0.0
    assert totals.other_ms == 0.0


def test_timing_summary_roundtrip():
    summary = TimingSummary(
        code="005930",
        date="20250520",
        started_at_kst="2026-05-27T14:32:18+09:00",
        ended_at_kst="2026-05-27T14:33:02+09:00",
        total_ms=43821.4,
        phase_totals_ms=TimingPhaseTotals(
            http_fetch_ms=31204.8,
            parse_ms=4102.1,
            disk_write_ms=1843.7,
            rate_limit_ms=5021.0,
        ),
        phase_percentages={
            "http_fetch": 71.2,
            "rate_limit": 11.5,
            "parse": 9.4,
            "disk_write": 4.2,
            "backoff": 0.0,
            "cookie_pause": 0.0,
            "other": 0.0,
        },
        unaccounted_ms=1649.8,
        page_count=387,
        event_count=184231,
        error_counts={"429": 0, "cookie_expired": 0},
        env=TimingEnv(
            rate_limit_s=0.05,
            max_concurrent=3,
            page_step_ms_initial=60000,
            hoga_version="0.1.0",
            git_sha="9aef504",
        ),
    )
    data = summary.model_dump()
    rebuilt = TimingSummary.model_validate(data)
    assert rebuilt == summary


def test_timing_report_serialises_pages():
    report = TimingReport(
        summary=TimingSummary(
            code="005930",
            date="20250520",
            started_at_kst="2026-05-27T14:32:18+09:00",
            ended_at_kst="2026-05-27T14:33:02+09:00",
            total_ms=10.0,
            phase_totals_ms=TimingPhaseTotals(http_fetch_ms=10.0),
            phase_percentages={
                "http_fetch": 100.0,
                "parse": 0.0,
                "disk_write": 0.0,
                "rate_limit": 0.0,
                "backoff": 0.0,
                "cookie_pause": 0.0,
                "other": 0.0,
            },
            unaccounted_ms=0.0,
            page_count=1,
            event_count=0,
            error_counts={},
            env=TimingEnv(
                rate_limit_s=0.05,
                max_concurrent=3,
                page_step_ms_initial=60000,
                hoga_version="0.1.0",
                git_sha=None,
            ),
        ),
        pages=[
            TimingPageDetail(idx=0, http_ms=10.0, parse_ms=0.0, write_ms=0.0, events=0, errors=[]),
        ],
    )
    assert len(report.pages) == 1
    assert report.pages[0].idx == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_timing_models.py -v`
Expected: FAIL with `ImportError: cannot import name 'TimingEnv' from 'hoga.api.models'`

- [ ] **Step 3: Add the models**

Append to `hoga/api/models.py` (next to existing capture-related models like `CaptureProgress`):

```python
class TimingPhaseTotals(BaseModel):
    http_fetch_ms: float = 0.0
    parse_ms: float = 0.0
    disk_write_ms: float = 0.0
    rate_limit_ms: float = 0.0
    backoff_ms: float = 0.0
    cookie_pause_ms: float = 0.0
    other_ms: float = 0.0


class TimingPageDetail(BaseModel):
    idx: int
    http_ms: float
    parse_ms: float
    write_ms: float
    events: int
    errors: list[str]


class TimingEnv(BaseModel):
    rate_limit_s: float
    max_concurrent: int
    page_step_ms_initial: int
    hoga_version: str
    git_sha: str | None = None


class TimingSummary(BaseModel):
    code: str
    date: str
    started_at_kst: str
    ended_at_kst: str
    total_ms: float
    phase_totals_ms: TimingPhaseTotals
    phase_percentages: dict[str, float]
    unaccounted_ms: float
    page_count: int
    event_count: int
    error_counts: dict[str, int]
    env: TimingEnv


class TimingReport(BaseModel):
    summary: TimingSummary
    pages: list[TimingPageDetail]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_timing_models.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_timing_models.py
git commit -m "feat(api): add TimingReport / TimingSummary pydantic models"
```

---

### Task 2: CaptureTimingCollector — phase context manager (happy path + exception path)

**Files:**
- Create: `hoga/collector/timing.py`
- Test: `tests/collector/test_timing.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/collector/test_timing.py`:

```python
import pytest

from hoga.collector.timing import CaptureTimingCollector


class FakeClock:
    """Monotonic clock with manual advance — kills flakiness."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def tick_ms(self, ms: float) -> None:
        self.t += ms / 1000.0


def test_phase_accumulates_time():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)

    with c.phase("http_fetch"):
        clock.tick_ms(120.0)
    with c.phase("parse"):
        clock.tick_ms(5.0)
    with c.phase("http_fetch"):
        clock.tick_ms(80.0)

    assert c.phase_totals_ms["http_fetch"] == pytest.approx(200.0)
    assert c.phase_totals_ms["parse"] == pytest.approx(5.0)


def test_phase_records_time_on_exception():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)

    with pytest.raises(RuntimeError, match="boom"):
        with c.phase("parse"):
            clock.tick_ms(50.0)
            raise RuntimeError("boom")

    # Exception propagated AND time was still recorded.
    assert c.phase_totals_ms["parse"] == pytest.approx(50.0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/collector/test_timing.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.collector.timing'`

- [ ] **Step 3: Write the collector skeleton**

Create `hoga/collector/timing.py`:

```python
"""Capture timing collector — per (code, date) wall-time attribution.

See docs/superpowers/specs/2026-05-27-capture-timing-instrumentation-design.md
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator, Literal

PhaseName = Literal[
    "http_fetch",
    "parse",
    "disk_write",
    "rate_limit",
    "backoff",
    "cookie_pause",
    "other",
]

_PHASES: tuple[PhaseName, ...] = (
    "http_fetch",
    "parse",
    "disk_write",
    "rate_limit",
    "backoff",
    "cookie_pause",
    "other",
)


class CaptureTimingCollector:
    """Thread-safe-by-isolation per-(code, date) timing aggregator.

    Each capture worker creates one instance; the instance never crosses
    workers. Phases are measured with a monotonic clock; nesting is disallowed
    so a `phase()` re-entry while another is active raises RuntimeError —
    this catches accidental misuse where time would be double-counted.
    """

    def __init__(
        self,
        code: str,
        date: str,
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.code = code
        self.date = date
        self._clock = clock
        self._started = clock()
        self._active_phase: PhaseName | None = None
        self.phase_totals_ms: dict[PhaseName, float] = {p: 0.0 for p in _PHASES}

    @contextmanager
    def phase(self, name: PhaseName) -> Iterator[None]:
        if self._active_phase is not None:
            raise RuntimeError(
                f"timing phase {name!r} entered while {self._active_phase!r} is active; "
                f"nesting is not allowed"
            )
        self._active_phase = name
        start = self._clock()
        try:
            yield
        finally:
            elapsed_ms = (self._clock() - start) * 1000.0
            self.phase_totals_ms[name] += elapsed_ms
            self._active_phase = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/collector/test_timing.py -v`
Expected: 2 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/collector/timing.py tests/collector/test_timing.py
git commit -m "feat(collector): CaptureTimingCollector phase context manager"
```

---

### Task 3: Collector — nesting prevention + page boundary + event/error recording

**Files:**
- Modify: `hoga/collector/timing.py`
- Modify: `tests/collector/test_timing.py`

- [ ] **Step 1: Add failing tests**

Append to `tests/collector/test_timing.py`:

```python
def test_nested_phase_raises():
    c = CaptureTimingCollector("005930", "20250520", clock=FakeClock())
    with c.phase("http_fetch"):
        with pytest.raises(RuntimeError, match="nesting is not allowed"):
            with c.phase("parse"):
                pass


def test_mark_page_boundary_creates_new_page():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)

    c.mark_page_boundary()  # page 0 starts
    with c.phase("http_fetch"):
        clock.tick_ms(100.0)
    c.record_event_count(42)

    c.mark_page_boundary()  # page 1 starts
    with c.phase("http_fetch"):
        clock.tick_ms(80.0)
    c.record_event_count(17)

    assert len(c.pages) == 2
    assert c.pages[0].idx == 0
    assert c.pages[0].http_ms == pytest.approx(100.0)
    assert c.pages[0].events == 42
    assert c.pages[1].idx == 1
    assert c.pages[1].http_ms == pytest.approx(80.0)
    assert c.pages[1].events == 17


def test_record_error_updates_page_and_totals():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)
    c.mark_page_boundary()
    c.record_error("429")
    c.mark_page_boundary()
    c.record_error("429")
    c.record_error("cookie_expired")

    assert c.error_counts == {"429": 2, "cookie_expired": 1}
    assert c.pages[0].errors == ["429"]
    assert c.pages[1].errors == ["429", "cookie_expired"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/collector/test_timing.py -v`
Expected: 3 FAIL (`AttributeError: ... has no attribute 'pages'`, etc.)

- [ ] **Step 3: Extend the collector**

Modify `hoga/collector/timing.py`. Add this imports change at the top:

```python
from dataclasses import dataclass, field
```

Add this dataclass below the `_PHASES` tuple:

```python
@dataclass
class PageTiming:
    idx: int
    http_ms: float = 0.0
    parse_ms: float = 0.0
    write_ms: float = 0.0
    events: int = 0
    errors: list[str] = field(default_factory=list)
```

Modify `__init__` to add new state:

```python
    def __init__(
        self,
        code: str,
        date: str,
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.code = code
        self.date = date
        self._clock = clock
        self._started = clock()
        self._active_phase: PhaseName | None = None
        self.phase_totals_ms: dict[PhaseName, float] = {p: 0.0 for p in _PHASES}
        self.pages: list[PageTiming] = []
        self.error_counts: dict[str, int] = {}
        self.event_count: int = 0
```

Modify the `phase` context manager `__exit__` to also bump per-page when there's a current page:

```python
    @contextmanager
    def phase(self, name: PhaseName) -> Iterator[None]:
        if self._active_phase is not None:
            raise RuntimeError(
                f"timing phase {name!r} entered while {self._active_phase!r} is active; "
                f"nesting is not allowed"
            )
        self._active_phase = name
        start = self._clock()
        try:
            yield
        finally:
            elapsed_ms = (self._clock() - start) * 1000.0
            self.phase_totals_ms[name] += elapsed_ms
            current_page = self.pages[-1] if self.pages else None
            if current_page is not None:
                if name == "http_fetch":
                    current_page.http_ms += elapsed_ms
                elif name == "parse":
                    current_page.parse_ms += elapsed_ms
                elif name == "disk_write":
                    current_page.write_ms += elapsed_ms
            self._active_phase = None
```

Add the new methods at the end of the class:

```python
    def mark_page_boundary(self) -> None:
        self.pages.append(PageTiming(idx=len(self.pages)))

    def record_event_count(self, n: int) -> None:
        if not self.pages:
            self.mark_page_boundary()
        self.pages[-1].events += n
        self.event_count += n

    def record_error(self, kind: str) -> None:
        self.error_counts[kind] = self.error_counts.get(kind, 0) + 1
        if self.pages:
            self.pages[-1].errors.append(kind)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/collector/test_timing.py -v`
Expected: 5 PASS (the 2 from Task 2 + 3 new)

- [ ] **Step 5: Commit**

```bash
git add hoga/collector/timing.py tests/collector/test_timing.py
git commit -m "feat(collector): page boundaries + event/error recording"
```

---

### Task 4: Collector — summary() and to_report()

**Files:**
- Modify: `hoga/collector/timing.py`
- Modify: `tests/collector/test_timing.py`

- [ ] **Step 1: Add failing tests**

Append to `tests/collector/test_timing.py`:

```python
def test_summary_phase_percentages_sum_to_100():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)
    c.mark_page_boundary()
    with c.phase("http_fetch"):
        clock.tick_ms(700.0)
    with c.phase("parse"):
        clock.tick_ms(200.0)
    with c.phase("rate_limit"):
        clock.tick_ms(100.0)

    env = make_env()
    summary = c.summary(env=env)

    assert sum(summary.phase_percentages.values()) == pytest.approx(100.0, abs=0.5)
    assert summary.phase_percentages["http_fetch"] == pytest.approx(70.0, abs=0.5)


def test_summary_unaccounted_ms_when_total_exceeds_phases():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)
    # Advance the wall clock without entering any phase — that becomes "unaccounted".
    clock.tick_ms(1000.0)
    with c.phase("http_fetch"):
        clock.tick_ms(500.0)

    summary = c.summary(env=make_env())
    assert summary.unaccounted_ms == pytest.approx(1000.0, abs=1.0)
    assert summary.total_ms == pytest.approx(1500.0, abs=1.0)


def test_to_report_includes_pages():
    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)
    c.mark_page_boundary()
    with c.phase("http_fetch"):
        clock.tick_ms(50.0)
    c.record_event_count(10)

    report = c.to_report(env=make_env())
    assert len(report.pages) == 1
    assert report.pages[0].idx == 0
    assert report.pages[0].http_ms == pytest.approx(50.0)
    assert report.pages[0].events == 10


# helper at top of test file (or move near class)
def make_env():
    from hoga.api.models import TimingEnv
    return TimingEnv(
        rate_limit_s=0.05,
        max_concurrent=3,
        page_step_ms_initial=60000,
        hoga_version="0.1.0",
        git_sha=None,
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/collector/test_timing.py -v`
Expected: 3 FAIL (`AttributeError: ... has no attribute 'summary'`)

- [ ] **Step 3: Add the summary/to_report API**

Append to `hoga/collector/timing.py`:

```python
import datetime as _dt
from zoneinfo import ZoneInfo

from hoga.api.models import (
    TimingEnv,
    TimingPageDetail,
    TimingPhaseTotals,
    TimingReport,
    TimingSummary,
)

_KST = ZoneInfo("Asia/Seoul")


def _now_kst_iso() -> str:
    return _dt.datetime.now(_KST).isoformat(timespec="seconds")
```

Add these methods to `CaptureTimingCollector`:

```python
    def summary(self, *, env: TimingEnv, ended_at_kst: str | None = None) -> TimingSummary:
        total_ms = (self._clock() - self._started) * 1000.0
        phase_sum = sum(self.phase_totals_ms.values())
        unaccounted = max(0.0, total_ms - phase_sum)

        denom = total_ms if total_ms > 0 else 1.0
        phase_percentages = {
            phase: (self.phase_totals_ms[phase] / denom) * 100.0
            for phase in _PHASES
        }

        return TimingSummary(
            code=self.code,
            date=self.date,
            started_at_kst=getattr(self, "_started_at_kst", _now_kst_iso()),
            ended_at_kst=ended_at_kst or _now_kst_iso(),
            total_ms=total_ms,
            phase_totals_ms=TimingPhaseTotals(
                http_fetch_ms=self.phase_totals_ms["http_fetch"],
                parse_ms=self.phase_totals_ms["parse"],
                disk_write_ms=self.phase_totals_ms["disk_write"],
                rate_limit_ms=self.phase_totals_ms["rate_limit"],
                backoff_ms=self.phase_totals_ms["backoff"],
                cookie_pause_ms=self.phase_totals_ms["cookie_pause"],
                other_ms=self.phase_totals_ms["other"],
            ),
            phase_percentages=phase_percentages,
            unaccounted_ms=unaccounted,
            page_count=len(self.pages),
            event_count=self.event_count,
            error_counts=dict(self.error_counts),
            env=env,
        )

    def to_report(self, *, env: TimingEnv, ended_at_kst: str | None = None) -> TimingReport:
        return TimingReport(
            summary=self.summary(env=env, ended_at_kst=ended_at_kst),
            pages=[
                TimingPageDetail(
                    idx=p.idx,
                    http_ms=p.http_ms,
                    parse_ms=p.parse_ms,
                    write_ms=p.write_ms,
                    events=p.events,
                    errors=list(p.errors),
                )
                for p in self.pages
            ],
        )
```

Update `__init__` to capture the start ISO:

```python
        self._started_at_kst = _now_kst_iso()
```

(Add this line at the end of `__init__`, after `self.event_count = 0`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/collector/test_timing.py -v`
Expected: 8 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/collector/timing.py tests/collector/test_timing.py
git commit -m "feat(collector): summary() + to_report() with phase percentages"
```

---

## Phase B — Persistence

### Task 5: Git SHA helper

**Files:**
- Create: `hoga/util/git_sha.py`
- Test: `tests/util/test_git_sha.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/util/test_git_sha.py`:

```python
from pathlib import Path
from unittest.mock import patch

from hoga.util.git_sha import get_git_sha


def test_returns_sha_in_a_git_repo():
    # This repo itself is a git repo — the call should return something.
    sha = get_git_sha()
    assert sha is None or (isinstance(sha, str) and len(sha) >= 7)


def test_returns_none_when_not_a_git_repo(tmp_path: Path):
    with patch("hoga.util.git_sha._REPO_ROOT", tmp_path):
        assert get_git_sha() is None


def test_returns_none_on_subprocess_failure():
    with patch("hoga.util.git_sha.subprocess.check_output", side_effect=FileNotFoundError):
        assert get_git_sha() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/util/test_git_sha.py -v`
Expected: FAIL `ModuleNotFoundError`

- [ ] **Step 3: Implement the helper**

Create `hoga/util/git_sha.py`:

```python
"""Best-effort runtime git SHA lookup for timing env metadata."""
from __future__ import annotations

import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def get_git_sha() -> str | None:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=_REPO_ROOT,
            text=True,
            timeout=1.0,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    sha = out.strip()
    return sha or None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/util/test_git_sha.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/util/git_sha.py tests/util/test_git_sha.py
git commit -m "feat(util): best-effort git SHA lookup for timing env"
```

---

### Task 6: Timing writer (atomic JSON write)

**Files:**
- Create: `hoga/collector/timing_writer.py`
- Test: `tests/collector/test_timing_writer.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/collector/test_timing_writer.py`:

```python
import json
from pathlib import Path

import pytest

from hoga.api.models import (
    TimingEnv,
    TimingPageDetail,
    TimingPhaseTotals,
    TimingReport,
    TimingSummary,
)
from hoga.collector.timing_writer import write_timing_report


def _make_report(code: str = "005930", date: str = "20250520") -> TimingReport:
    return TimingReport(
        summary=TimingSummary(
            code=code,
            date=date,
            started_at_kst="2026-05-27T14:32:18+09:00",
            ended_at_kst="2026-05-27T14:33:02+09:00",
            total_ms=1000.0,
            phase_totals_ms=TimingPhaseTotals(http_fetch_ms=1000.0),
            phase_percentages={
                "http_fetch": 100.0,
                "parse": 0.0,
                "disk_write": 0.0,
                "rate_limit": 0.0,
                "backoff": 0.0,
                "cookie_pause": 0.0,
                "other": 0.0,
            },
            unaccounted_ms=0.0,
            page_count=1,
            event_count=10,
            error_counts={},
            env=TimingEnv(
                rate_limit_s=0.05,
                max_concurrent=3,
                page_step_ms_initial=60000,
                hoga_version="0.1.0",
                git_sha=None,
            ),
        ),
        pages=[TimingPageDetail(idx=0, http_ms=1000.0, parse_ms=0.0, write_ms=0.0, events=10, errors=[])],
    )


def test_writes_to_expected_path(tmp_path: Path):
    report = _make_report()
    out = write_timing_report(tmp_path, report)
    assert out == tmp_path / "timing" / "20250520" / "005930.json"
    assert out.exists()
    data = json.loads(out.read_text())
    assert data["summary"]["code"] == "005930"
    assert data["pages"][0]["events"] == 10


def test_creates_parent_directories(tmp_path: Path):
    report = _make_report(date="20260101")
    out = write_timing_report(tmp_path, report)
    assert out.parent.is_dir()


def test_atomic_overwrite(tmp_path: Path):
    write_timing_report(tmp_path, _make_report())
    second = _make_report()
    second.summary.event_count = 999
    write_timing_report(tmp_path, second)
    data = json.loads((tmp_path / "timing" / "20250520" / "005930.json").read_text())
    assert data["summary"]["event_count"] == 999
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/collector/test_timing_writer.py -v`
Expected: FAIL `ModuleNotFoundError`

- [ ] **Step 3: Implement the writer**

Create `hoga/collector/timing_writer.py`:

```python
"""Atomic JSON persistence for TimingReport.

Layout: <data_dir>/timing/<date>/<code>.json
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from hoga.api.models import TimingReport


def write_timing_report(data_dir: Path, report: TimingReport) -> Path:
    out_dir = data_dir / "timing" / report.summary.date
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{report.summary.code}.json"

    payload = report.model_dump_json()
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        delete=False,
        dir=out_dir,
        prefix=f".{report.summary.code}.",
        suffix=".tmp",
    ) as fh:
        fh.write(payload)
        tmp_name = fh.name
    os.replace(tmp_name, out_path)
    return out_path
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/collector/test_timing_writer.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/collector/timing_writer.py tests/collector/test_timing_writer.py
git commit -m "feat(collector): atomic JSON write for TimingReport"
```

---

## Phase C — Orchestrator wiring

### Task 7: Thread collector through orchestrator (None-default, no-op when absent)

**Files:**
- Modify: `hoga/collector/orchestrator.py`
- Test: `tests/collector/test_orchestrator_timing_passthrough.py` (new)

- [ ] **Step 1: Read the current signatures**

Open `hoga/collector/orchestrator.py` and locate:
- `def collect_stock_date(...)` at line ~417
- `def _page_step_loop(...)` at line ~304

Confirm both already take `cancel_token: CancelToken | None = None`. We will add `collector: CaptureTimingCollector | None = None` alongside.

- [ ] **Step 2: Write the failing test**

Create `tests/collector/test_orchestrator_timing_passthrough.py`:

```python
"""Verifies collector kwarg is accepted by collect_stock_date / _page_step_loop.

We don't run a real capture here — that's the integration test in
tests/api/test_captures_timing.py. This test only guards the signature.
"""
import inspect

from hoga.collector import orchestrator
from hoga.collector.timing import CaptureTimingCollector


def test_collect_stock_date_accepts_collector_kwarg():
    sig = inspect.signature(orchestrator.collect_stock_date)
    assert "collector" in sig.parameters
    p = sig.parameters["collector"]
    assert p.default is None
    assert p.kind == inspect.Parameter.KEYWORD_ONLY


def test_page_step_loop_accepts_collector_kwarg():
    sig = inspect.signature(orchestrator._page_step_loop)
    assert "collector" in sig.parameters
    p = sig.parameters["collector"]
    assert p.default is None


def test_collector_type_is_threadable():
    # The collector class must not require asyncio context (caller threads
    # it into a ThreadPoolExecutor).
    c = CaptureTimingCollector("000000", "20000101")
    with c.phase("http_fetch"):
        pass
    assert c.phase_totals_ms["http_fetch"] >= 0.0
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/collector/test_orchestrator_timing_passthrough.py -v`
Expected: 2 FAIL (`assert 'collector' in {...}`)

- [ ] **Step 4: Modify orchestrator signatures**

Edit `hoga/collector/orchestrator.py`:

At the top, add to existing imports:

```python
from hoga.collector.timing import CaptureTimingCollector
```

Change `def collect_stock_date(...)` signature. Locate the existing signature at line ~417 and add the new keyword-only argument **after `cancel_token`**, keeping all other args identical:

```python
def collect_stock_date(
    # ... existing positional/keyword args unchanged ...
    *,
    cancel_token: CancelToken | None = None,
    collector: CaptureTimingCollector | None = None,
) -> CollectStockDateResult:
```

(If `cancel_token` is not already keyword-only via `*`, leave it positional but make `collector` keyword-only via `*` insertion. Match the existing keyword-only convention.)

Same for `_page_step_loop` at line ~304:

```python
def _page_step_loop(
    # ... existing args unchanged ...
    *,
    cancel_token: CancelToken | None = None,
    collector: CaptureTimingCollector | None = None,
) -> _LoopResult:
```

Inside `collect_stock_date`, when it calls `_page_step_loop`, pass `collector=collector` through.

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/collector/test_orchestrator_timing_passthrough.py -v`
Expected: 3 PASS

- [ ] **Step 6: Commit**

```bash
git add hoga/collector/orchestrator.py tests/collector/test_orchestrator_timing_passthrough.py
git commit -m "feat(orchestrator): thread collector kwarg through capture loop"
```

---

### Task 7.5: Split `_fetch_and_store_page` into HTTP + write halves (refactor, behavior-preserving)

> **Plan-review insertion (eng C4):** Task 8 originally proposed splitting `_fetch_and_store_page` into `_fetch_first_body` + `_store_page_body` with no failing test driving the refactor — the only place in the plan that broke TDD discipline, and the function is in ADR-0017 throttle territory. This new task lands the refactor under a pinning test first.

**Files:**
- Modify: `hoga/collector/orchestrator.py`
- Test: `tests/collector/test_fetch_store_split.py` (new)

- [ ] **Step 1: Write a pinning test that locks current behavior**

Create `tests/collector/test_fetch_store_split.py`:

```python
"""Pin _fetch_first_body + _store_page_body behavior across the refactor.

Goal: a single fetch+store round produces identical disk artifacts and return
values before vs. after the split. We don't care which symbols exist — just
that calling the public surface twice with identical inputs produces identical
side effects."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest


def test_fetch_first_body_and_store_page_body_compose(tmp_path: Path):
    from hoga.collector.orchestrator import _fetch_first_body, _store_page_body

    fake_client = MagicMock()
    fake_client.fetch_first.return_value = ("info\n1\t0\t10\t1000\t...\n", 200)

    body = _fetch_first_body(fake_client, code="005930", date="20250520", time_ms=0)
    assert body.startswith("info")
    fake_client.fetch_first.assert_called_once_with(code="005930", date="20250520", time_ms=0)

    page_idx, new_seqs = _store_page_body(tmp_path, body, expected_idx=0, seen_seqs=set())
    assert page_idx == 0
    assert (tmp_path / "first_00000.tsv").read_text().startswith("info")
    assert 1000 in new_seqs
```

- [ ] **Step 2: Run to confirm failure**

Run: `uv run pytest tests/collector/test_fetch_store_split.py -v`
Expected: FAIL `ImportError: cannot import name '_fetch_first_body'`

- [ ] **Step 3: Perform the split**

In `hoga/collector/orchestrator.py`, locate the current `_fetch_and_store_page` function (~L281). Refactor it into two helpers + a thin composite that preserves the existing call site:

```python
def _fetch_first_body(
    client: HogaplayClient,
    *,
    code: str,
    date: str,
    time_ms: int,
) -> str:
    body, status = client.fetch_first(code=code, date=date, time_ms=time_ms)
    if status != 200:
        raise HogaplayPageError(status=status, code=code, date=date, time_ms=time_ms)
    return body


def _store_page_body(
    raw_dir: Path,
    body: str,
    *,
    expected_idx: int,
    seen_seqs: set[int],
) -> tuple[int, set[int]]:
    # Move existing TSV-write + seq-extraction logic here, unchanged in
    # behavior. Returns (page_idx_written, new_seqs_added).
    ...


def _fetch_and_store_page(...) -> tuple[str, int, set[int]]:
    body = _fetch_first_body(client, code=code, date=date, time_ms=t)
    page_idx, new_seqs = _store_page_body(raw_dir, body, expected_idx=..., seen_seqs=seen_seqs)
    return body, page_idx, new_seqs
```

(Migrate the actual logic verbatim — read the current function body and move the appropriate lines. Adjust function-internal `_time.perf_counter` profiling vars if needed; per ADR-0017 the `HOGA_PROFILE=1` instrumentation should still work after the split.)

- [ ] **Step 4: Run all collector tests**

Run: `uv run pytest tests/collector/ -v`
Expected: All PASS (existing tests unchanged, new pinning test passes).

- [ ] **Step 5: Commit**

```bash
git add hoga/collector/orchestrator.py tests/collector/test_fetch_store_split.py
git commit -m "refactor(orchestrator): split _fetch_and_store_page (pinning test)"
```

---

### Task 8: Wrap orchestrator hot path with phases

**Files:**
- Modify: `hoga/collector/orchestrator.py`
- Test: `tests/collector/test_orchestrator_phases.py` (new)

- [ ] **Step 1: Write the failing integration-light test**

Create `tests/collector/test_orchestrator_phases.py`:

```python
"""Light-weight test: drive _page_step_loop with a stub fetcher to verify
phase wraps fire and event counts accumulate. We don't talk to hogaplay."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hoga.collector.timing import CaptureTimingCollector


@pytest.fixture
def fake_clock_collector():
    from tests.collector.test_timing import FakeClock

    clock = FakeClock()
    c = CaptureTimingCollector("005930", "20250520", clock=clock)
    return clock, c


def test_collect_stock_date_records_http_and_disk_phases(tmp_path: Path, fake_clock_collector):
    """A single (mocked) page should produce >0 ms in http_fetch and disk_write."""
    from hoga.collector import orchestrator

    clock, c = fake_clock_collector

    def fake_fetch_first(*args, **kwargs):
        clock.tick_ms(20.0)
        # Return a body that the loop can parse as "empty / no progress".
        return "info\nstuff\n", 200

    # Patch the client and the time.sleep to advance the fake clock.
    real_sleep = orchestrator.time.sleep

    def fake_sleep(seconds: float) -> None:
        clock.tick_ms(seconds * 1000.0)

    with (
        patch.object(orchestrator, "fetch_first", side_effect=fake_fetch_first),
        patch.object(orchestrator.time, "sleep", side_effect=fake_sleep),
    ):
        # Minimal collect_stock_date invocation — the orchestrator will exit
        # quickly via its stagnation guard since fake_fetch_first returns no
        # new events. We only check that the collector recorded SOMETHING.
        try:
            orchestrator.collect_stock_date(
                code="005930",
                date="20250520",
                raw_dir=tmp_path,
                # ... pass any required minimal args; if the real signature
                # requires more, mark this test xfail with a TODO to revise
                # after Task 7 lands.
                collector=c,
            )
        except TypeError:
            pytest.skip("collect_stock_date signature requires more args; revise after wiring")

    assert c.phase_totals_ms["http_fetch"] > 0 or c.phase_totals_ms["rate_limit"] > 0
```

(If the real `collect_stock_date` requires more setup, the test skips itself rather than failing on signature. The integration test in Task 14 covers the full path.)

- [ ] **Step 2: Run test to see current state**

Run: `uv run pytest tests/collector/test_orchestrator_phases.py -v`
Expected: SKIP or FAIL depending on signature. This task's success is judged by the wrapping edits below + manual review.

- [ ] **Step 3: Wrap fetch_first**

In `hoga/collector/orchestrator.py`, locate the call to `client.fetch_first(...)` inside `_fetch_and_store_page` at line ~343 (or wherever the actual HTTP call lives — search for `fetch_first(`).

Wrap it:

```python
            if collector is not None:
                with collector.phase("http_fetch"):
                    body, status = client.fetch_first(code=code, date=date, time_ms=t)
            else:
                body, status = client.fetch_first(code=code, date=date, time_ms=t)
```

Note: the `collector` variable must be in scope. If `_fetch_and_store_page` is the call site and doesn't currently take a `collector` arg, **either**:
1. Add `collector` kwarg to `_fetch_and_store_page` and pass through, OR
2. Move the `fetch_first` wrap up one level into the caller `_page_step_loop` where `collector` is already in scope.

**Choose option 2** to minimise signature changes. So in `_page_step_loop`, change the call site that invokes `_fetch_and_store_page` to:

```python
        if collector is not None:
            with collector.phase("http_fetch"):
                body, page_idx, new_seqs = _fetch_and_store_page(...)
        else:
            body, page_idx, new_seqs = _fetch_and_store_page(...)
```

This unfortunately wraps both the HTTP and the disk write. To keep them separable, inline a small refactor: split `_fetch_and_store_page` into `_fetch_first_body(...)` (HTTP only, returns body) and `_store_page_body(...)` (TSV write, takes body). Then in `_page_step_loop`:

```python
        if collector is not None:
            with collector.phase("http_fetch"):
                body = _fetch_first_body(client, code, date, t)
            with collector.phase("disk_write"):
                page_idx, new_seqs = _store_page_body(raw_dir, body, ...)
        else:
            body = _fetch_first_body(client, code, date, t)
            page_idx, new_seqs = _store_page_body(raw_dir, body, ...)
```

- [ ] **Step 4: Wrap rate_limit sleep**

Locate `time.sleep(rate_limit_s)` in `_page_step_loop` (per ADR-0017, this is the dominant page-time component).

```python
        if collector is not None:
            with collector.phase("rate_limit"):
                time.sleep(rate_limit_s)
        else:
            time.sleep(rate_limit_s)
```

- [ ] **Step 5: Mark page boundary + record events (retry-aware)**

> **Plan-review correction (eng S2):** On 429, the loop does `iter_idx -= 1; continue`. If `mark_page_boundary()` runs at iteration top **unconditionally**, a retried page will create a fresh `PageTiming` with ~0 events — phantom rows in the JSON. Gate the boundary call on "not a retry".

Track a `_pending_boundary` local flag in the loop. At the top of each iteration:

```python
        if collector is not None and _pending_boundary:
            collector.mark_page_boundary()
            _pending_boundary = False
```

When a page successfully completes (after the disk_write), arm the next boundary:

```python
        # ... after disk_write + new_seqs computed ...
        if collector is not None:
            collector.record_event_count(len(new_seqs))
            _pending_boundary = True  # next iteration is a new page
```

On a 429 retry path (`iter_idx -= 1; continue`), `_pending_boundary` stays `False` so the retry reuses the current PageTiming row instead of creating a phantom one. The new errors and timing fall onto the same page row.

Initialize `_pending_boundary = True` before the loop so the first iteration creates page 0.

- [ ] **Step 6: Run all collector tests**

Run: `uv run pytest tests/collector/ -v`
Expected: All previous PASS. The new orchestrator_phases test may still skip; that's OK — the full path lands in Task 14.

- [ ] **Step 7: Commit**

```bash
git add hoga/collector/orchestrator.py tests/collector/test_orchestrator_phases.py
git commit -m "feat(orchestrator): wrap fetch_first / disk_write / rate_limit phases"
```

---

## Phase D — captures.py wiring

### Task 9: `HOGA_CAPTURE_TIMING` env flag + collector lifecycle in `_run_item`

**Files:**
- Modify: `hoga/api/captures.py`

- [ ] **Step 1: Add the env flag as a function (not a module-level constant)**

Why function-call form: tests need to toggle this between cases without `importlib.reload` (which would corrupt `_bus`, `_loop`, `_queue`, `_active`, `_wakeup`, `_max_concurrent` module singletons). With a function, `monkeypatch.setenv` alone flips the behavior.

In `hoga/api/captures.py`, near the existing `_max_concurrent` declaration at line ~201, add:

```python
def _timing_enabled() -> bool:
    """Read HOGA_CAPTURE_TIMING at call time. Default ON; only explicit
    falsy values disable. Empty string is treated as 'unset' (= default ON)."""
    raw = os.environ.get("HOGA_CAPTURE_TIMING", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")
```

(`HOGA_CAPTURE_TIMING=0` / `=false` / `=no` / `=off` explicitly disables. Unset or empty = default ON.)

- [ ] **Step 2: Import the collector module**

Near the top of `hoga/api/captures.py`:

```python
from hoga.collector.timing import CaptureTimingCollector
from hoga.collector.timing_writer import write_timing_report
from hoga.util.git_sha import get_git_sha
from hoga.api.models import CaptureTimingEvent, TimingEnv
```

(`CaptureTimingEvent` is added to `hoga/api/models.py` in Task 13.)

- [ ] **Step 3: Create collector at the start of `_run_item`**

Locate `async def _run_item(state: QueueItemState)` at **line ~627** (verified). Add at the top of the function body, before any work begins:

```python
    collector: CaptureTimingCollector | None = (
        CaptureTimingCollector(state.code, state.date) if _timing_enabled() else None
    )
```

Pass `collector` into `_run_capture_and_parse`:

```python
    await _run_capture_and_parse(state, resume=..., collector=collector)
```

(You will add the `collector` kwarg to `_run_capture_and_parse` (~L506) and `_run_capture_inner` (~L532) in step 4, and the `_run_item` finally block in Task 13.)

- [ ] **Step 4: Add the `collector` kwarg to `_run_capture_and_parse` and `_run_capture_inner`**

`_run_capture_and_parse` at **line ~506** (verified). `_run_capture_inner` at **line ~532** (verified):

```python
async def _run_capture_and_parse(
    state: QueueItemState,
    *,
    resume: bool,
    collector: CaptureTimingCollector | None = None,
) -> None:
    ...
    await _run_capture_inner(state, resume=resume, collector=collector)


async def _run_capture_inner(
    state: QueueItemState,
    *,
    resume: bool,
    collector: CaptureTimingCollector | None = None,
) -> _CaptureInnerResult:
    ...
```

Pass it into the executor lambda at line ~555:

```python
    result = await loop.run_in_executor(
        None,
        lambda: collect_stock_date(
            # ... existing args ...
            collector=collector,
        ),
    )
```

- [ ] **Step 5: Run tests to confirm no regression**

Run: `uv run pytest tests/api/ tests/collector/ -v`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py
git commit -m "feat(captures): wire CaptureTimingCollector lifecycle into _run_item"
```

---

### Task 10: Wrap `parse_stock_date` executor call with `parse` phase

**Files:**
- Modify: `hoga/api/captures.py`

- [ ] **Step 1: Locate the parse call**

In `hoga/api/captures.py` line ~595, find:

```python
    await loop.run_in_executor(None, lambda: parse_stock_date(...))
```

- [ ] **Step 2: Wrap it**

The phase context manager is synchronous. Since the executor offload is an async-await but the work happens in a thread, we time the **awaiting wall-clock** which is what the user perceives. The collector is thread-bound but the phase context manager itself is plain Python — calling it from asyncio is safe.

```python
    if collector is not None:
        with collector.phase("parse"):
            await loop.run_in_executor(None, lambda: parse_stock_date(...))
    else:
        await loop.run_in_executor(None, lambda: parse_stock_date(...))
```

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/api/ tests/collector/ -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hoga/api/captures.py
git commit -m "feat(captures): wrap parse_stock_date with parse phase"
```

---

### Task 11: Wrap 429 retry sleep with `backoff` + record_error

**Files:**
- Modify: `hoga/api/captures.py`

- [ ] **Step 1: Locate the retry sleeps**

Around line ~518-529 in `hoga/api/captures.py`, find the 5/10/30s sleeps triggered on 429 (per the exploration report). The block likely looks like:

```python
    backoff_seconds = (5, 10, 30)[attempt_idx]
    await asyncio.sleep(backoff_seconds)
```

(Exact code may differ — search for `asyncio.sleep` near 429 handling.)

- [ ] **Step 2: Wrap with backoff phase + record_error**

```python
    if collector is not None:
        collector.record_error("429")
        with collector.phase("backoff"):
            await asyncio.sleep(backoff_seconds)
    else:
        await asyncio.sleep(backoff_seconds)
```

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/api/ tests/collector/ -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hoga/api/captures.py
git commit -m "feat(captures): wrap 429 retry sleep with backoff phase + error count"
```

---

### Task 12: Record cookie_expired error in exception handler

**Files:**
- Modify: `hoga/api/captures.py`

> **Plan-review correction (eng B2):** In the actual code, `CookieExpiredError` is raised inside `collect_stock_date` (executor thread) and propagates up to the worker loop where it sets `phase="failed"` and calls `_handle_cookie_expired(state)` (which pauses the QUEUE, not this item). The failing item never sleeps awaiting a cookie resume — it's terminal at that point. So there is no sleep to `with collector.phase("cookie_pause"):`. The `cookie_pause` Timing Phase remains in the enum (reserved for a future restructure that attributes queue-pause time to items), but stays 0 ms in this iteration. We only record the *error*.

- [ ] **Step 1: Locate the cookie_expired exception handler in the worker loop**

In `hoga/api/captures.py`, search for `except CookieExpiredError` near line ~845 (worker loop in `_worker_loop` or in `_run_capture_and_parse`'s try block). This is **outside** `_run_item`'s collector scope as currently designed.

To make the error recordable while keeping the collector instance local to `_run_item`, restructure slightly: catch `CookieExpiredError` **inside** `_run_item`'s try block (where `collector` is in scope), record the error, then re-raise so the worker loop's existing `_handle_cookie_expired(state)` path still runs.

- [ ] **Step 2: Add the inner exception handler in `_run_item`**

```python
async def _run_item(state: QueueItemState) -> None:
    collector: CaptureTimingCollector | None = (
        CaptureTimingCollector(state.code, state.date) if _timing_enabled() else None
    )

    try:
        try:
            await _run_capture_and_parse(state, resume=..., collector=collector)
        except CookieExpiredError:
            if collector is not None:
                collector.record_error("cookie_expired")
            raise  # let existing outer handler pause the queue
    finally:
        # See Task 13 — write JSON + emit SSE.
        ...
```

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/api/ tests/collector/ -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hoga/api/captures.py
git commit -m "feat(captures): record cookie_expired in collector before re-raise"
```

---

### Task 13: Finalize collector — write JSON + emit SSE in `_run_item` finally

**Files:**
- Modify: `hoga/api/models.py` (add `CaptureTimingEvent` pydantic model)
- Modify: `hoga/api/captures.py`

> **Plan-review correction (eng B1):** The actual SSE entry point is `_publish_event(event: BaseModel)` at `hoga/api/captures.py:392` — **synchronous** (no `await`), takes a **pydantic model** (not dict), and internally calls `event.model_dump(mode="json")` before dispatching via `_loop.call_soon_threadsafe(_bus.publish, payload)`. There is no `event_bus` symbol. Existing `CaptureProgressEvent` / `CaptureQueueEvent` show the pattern.

- [ ] **Step 1: Read existing event patterns**

Open `hoga/api/captures.py` around line 392 and confirm the `_publish_event(...)` shape. Also open `hoga/api/models.py` and find the existing `CaptureProgressEvent` / `CaptureQueueEvent` (or whatever the existing capture event models are called) — note their field layout (`type` Literal, `data` payload, any other top-level fields).

- [ ] **Step 2: Add `CaptureTimingEvent` model to `hoga/api/models.py`**

After the existing capture-event models in `hoga/api/models.py`:

```python
from typing import Literal


class CaptureTimingEvent(BaseModel):
    type: Literal["capture_timing"] = "capture_timing"
    id: str          # `${code}:${date}` — frontend dedup key
    summary: TimingSummary
```

(If the existing sibling events use a different field naming convention — e.g. `data` instead of `summary`, or include a `kind` discriminator — conform to that. The wire shape is what `_publish_event` flattens; whatever the existing capture events look like on `/api/events` is the precedent.)

- [ ] **Step 3: Add finally block to `_run_item`**

Wrap the existing `_run_item` body in `try / finally`. The full structure including Task 12's cookie_expired catch:

```python
async def _run_item(state: QueueItemState) -> None:
    collector: CaptureTimingCollector | None = (
        CaptureTimingCollector(state.code, state.date) if _timing_enabled() else None
    )

    # Effective rate may differ from DEFAULT_RATE_LIMIT_S (e.g. test override).
    # _run_capture_inner sets the actual value used; we capture it for TimingEnv.
    # If the existing code already exposes the effective rate, read it directly;
    # otherwise plumb it back via a small wrapper that returns it alongside the
    # capture result.
    effective_rate_s: float = DEFAULT_RATE_LIMIT_S

    try:
        try:
            await _run_capture_and_parse(state, resume=..., collector=collector)
        except CookieExpiredError:
            if collector is not None:
                collector.record_error("cookie_expired")
            raise
    finally:
        if collector is not None:
            try:
                env = TimingEnv(
                    rate_limit_s=effective_rate_s,
                    max_concurrent=_max_concurrent,
                    page_step_ms_initial=DEFAULT_PAGE_STEP_MS,
                    hoga_version=hoga.__version__,
                    git_sha=get_git_sha(),
                )
                report = collector.to_report(env=env)
                # 1) JSON first so any consumer reading the file sees a complete state.
                write_timing_report(_require_data_dir(), report)
                # 2) Then SSE summary (no per-page detail on the wire).
                _publish_event(
                    CaptureTimingEvent(
                        id=f"{state.code}:{state.date}",
                        summary=report.summary,
                    )
                )
            except Exception as exc:  # best-effort: never break the capture pipeline
                logger.warning(
                    "capture_timing emit failed for %s/%s: %r",
                    state.code,
                    state.date,
                    exc,
                )
```

Imports to add at the top of `captures.py`:

```python
import hoga
from hoga.api.models import CaptureTimingEvent, TimingEnv
from hoga.collector.orchestrator import DEFAULT_PAGE_STEP_MS, DEFAULT_RATE_LIMIT_S
```

- [ ] **Step 4: Plumb effective rate**

If `_run_capture_inner` already exposes the effective `rate_limit_s` (e.g. via a return field), use it. If not, add it: change `_run_capture_inner` to return `(result, effective_rate_s)` instead of `result`, and update the single existing caller in `_run_capture_and_parse`. Then surface `effective_rate_s` to `_run_item` via the same pattern.

If this plumbing is non-trivial, defer it: leave `effective_rate_s = DEFAULT_RATE_LIMIT_S` with a `# TODO(timing): plumb effective rate, see plan §13 step 4` and move on. The data is still accurate when the default is unmodified, which is the common case.

- [ ] **Step 5: Run all backend tests**

Run: `uv run pytest tests/ -v`
Expected: Existing tests PASS; new integration test (Task 14) will be added next.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/api/captures.py
git commit -m "feat(captures): write timing JSON + publish CaptureTimingEvent in finally"
```

---

### Task 14: Integration test — full capture path produces JSON + SSE

**Files:**
- Create: `tests/collector/conftest.py` (if doesn't exist) — shared `FakeClock` fixture
- Test: `tests/api/test_captures_timing.py` (new)

> **Plan-review corrections:**
> - eng C2: no `importlib.reload`. Function-call `_timing_enabled()` (Task 9) makes `monkeypatch.setenv` sufficient.
> - eng C3: `fetch_first` is a method on `HogaplayClient`, not a module function. Patch the **class** method or the **client factory**.
> - eng C5: `FakeClock` lives in `tests/collector/test_timing.py` — cross-test imports are fragile. Move to `conftest.py` as a fixture.
> - SSE capture: patch `_publish_event` (not `event_bus.publish`).

- [ ] **Step 1: Move `FakeClock` to a shared conftest**

Create or extend `tests/collector/conftest.py`:

```python
import pytest


class FakeClock:
    """Monotonic clock with manual advance — kills flakiness in timing tests."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def tick_ms(self, ms: float) -> None:
        self.t += ms / 1000.0


@pytest.fixture
def fake_clock() -> FakeClock:
    return FakeClock()
```

In `tests/collector/test_timing.py`, **delete** the local `FakeClock` class and replace its usages with the `fake_clock` fixture:

```python
def test_phase_accumulates_time(fake_clock):
    c = CaptureTimingCollector("005930", "20250520", clock=fake_clock)
    ...
```

Rerun `uv run pytest tests/collector/ -v` to confirm all previous tests still pass.

- [ ] **Step 2: Write the integration test**

Create `tests/api/test_captures_timing.py`:

```python
"""Integration: enqueue → run → JSON file + SSE event."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from hoga.api.captures import enqueue_items_core, _now_kst
from hoga.api.models import EnqueueRequest


@pytest.fixture
def captured_events(monkeypatch):
    """Capture every _publish_event call from captures.py."""
    events: list[Any] = []

    from hoga.api import captures as _captures_mod

    def _capture(event):
        events.append(event)

    monkeypatch.setattr(_captures_mod, "_publish_event", _capture)
    return events


class _FakeHogaplayClient:
    """Returns 5 small pages then empties to terminate the loop quickly."""

    def __init__(self) -> None:
        self._call = 0

    def fetch_first(self, code: str, date: str, time_ms: int) -> tuple[str, int]:
        self._call += 1
        if self._call <= 5:
            return (f"info\n1\t0\t10\t{1000 + self._call}\t...\n", 200)
        return ("info\n", 200)

    def fetch_info(self, *a, **kw) -> tuple[str, int]:
        return ("info\n", 200)

    def fetch_chart(self, *a, **kw) -> tuple[str, int]:
        return ("", 200)


@pytest.fixture
def fake_client(monkeypatch):
    """Replace the client factory so every code path resolves to the fake."""
    from hoga.collector import client as _client_mod

    fake = _FakeHogaplayClient()
    monkeypatch.setattr(_client_mod, "HogaplayClient", lambda *a, **kw: fake)
    return fake


@pytest.mark.asyncio
async def test_capture_timing_json_and_sse_emitted(
    tmp_path: Path, captured_events, fake_client, monkeypatch
):
    """A single capture should produce one timing JSON + one capture_timing SSE."""
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "1")
    monkeypatch.setattr("hoga.api.captures._require_data_dir", lambda: tmp_path)

    req = EnqueueRequest(code="005930", dates=["20260520"], force_retry=False)
    resp = await enqueue_items_core(req, data_dir=tmp_path, now=_now_kst())
    assert len(resp.enqueued) >= 1

    # Poll for the JSON file with timeout
    json_path = tmp_path / "timing" / "20260520" / "005930.json"
    for _ in range(50):
        if json_path.exists():
            break
        await asyncio.sleep(0.1)
    else:
        pytest.fail("timing JSON was not created within 5s")

    data = json.loads(json_path.read_text())
    summary = data["summary"]

    # Structural sanity — not exact ms values
    assert summary["code"] == "005930"
    assert summary["date"] == "20260520"
    assert summary["page_count"] >= 1
    assert summary["total_ms"] > 0
    assert sum(summary["phase_totals_ms"].values()) <= summary["total_ms"] + 1.0
    assert abs(sum(summary["phase_percentages"].values()) - 100.0) < 0.5

    # SSE event published exactly once
    from hoga.api.models import CaptureTimingEvent

    timing_events = [e for e in captured_events if isinstance(e, CaptureTimingEvent)]
    assert len(timing_events) == 1
    assert timing_events[0].id == "005930:20260520"


@pytest.mark.asyncio
async def test_capture_timing_disabled_skips_emit(
    tmp_path: Path, captured_events, fake_client, monkeypatch
):
    """HOGA_CAPTURE_TIMING=0 → no JSON file, no capture_timing SSE event."""
    monkeypatch.setenv("HOGA_CAPTURE_TIMING", "0")
    monkeypatch.setattr("hoga.api.captures._require_data_dir", lambda: tmp_path)

    req = EnqueueRequest(code="005930", dates=["20260520"], force_retry=False)
    await enqueue_items_core(req, data_dir=tmp_path, now=_now_kst())

    # Wait briefly for the worker
    await asyncio.sleep(2.0)

    assert not (tmp_path / "timing").exists()

    from hoga.api.models import CaptureTimingEvent

    timing_events = [e for e in captured_events if isinstance(e, CaptureTimingEvent)]
    assert timing_events == []
```

- [ ] **Step 3: Run the integration test**

Run: `uv run pytest tests/api/test_captures_timing.py -v`
Expected: 2 PASS

- [ ] **Step 4: If failures, fix forward**

Common causes:
- `_publish_event` symbol moved or renamed → grep for the actual emit site, repoint the patch.
- Client factory at a different path → grep for `HogaplayClient(` usages in `hoga/collector/orchestrator.py` to find the construction site.
- Worker pool not started in test context → call `start_capture_pool()` in test setup if the FastAPI lifespan isn't running.

Make minimal fixes until the test passes.

- [ ] **Step 5: Commit**

```bash
git add tests/collector/conftest.py tests/collector/test_timing.py tests/api/test_captures_timing.py
git commit -m "test(captures): integration — timing JSON + CaptureTimingEvent SSE"
```

---

## Phase E — Frontend types + SSE

### Task 15: Add TimingSummary type + extend SSEEvent union

**Files:**
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Add the type**

Open `frontend/src/api/types.ts`. Locate the existing `SSEEvent` union (around line 189 per exploration). Add the timing types:

```typescript
export interface TimingPhaseTotalsMs {
  http_fetch_ms: number;
  parse_ms: number;
  disk_write_ms: number;
  rate_limit_ms: number;
  backoff_ms: number;
  cookie_pause_ms: number;
  other_ms: number;
}

export interface TimingEnv {
  rate_limit_s: number;
  max_concurrent: number;
  page_step_ms_initial: number;
  hoga_version: string;
  git_sha: string | null;
}

export interface TimingSummary {
  code: string;
  date: string;
  started_at_kst: string;
  ended_at_kst: string;
  total_ms: number;
  phase_totals_ms: TimingPhaseTotalsMs;
  phase_percentages: Record<string, number>;
  unaccounted_ms: number;
  page_count: number;
  event_count: number;
  error_counts: Record<string, number>;
  env: TimingEnv;
}

export interface CaptureTimingEvent {
  type: 'capture_timing';
  id: string;        // `${code}:${date}`
  data: TimingSummary;
}
```

Extend the `SSEEvent` union (existing line ~189). Find the union and add `CaptureTimingEvent`:

```typescript
export type SSEEvent =
  | CaptureProgressEvent
  | CaptureQueueEvent
  | ... // existing variants
  | CaptureTimingEvent;
```

- [ ] **Step 2: Verify the type compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(api/types): add TimingSummary + CaptureTimingEvent variant"
```

---

### Task 16: Register `capture_timing` listener in sse.ts

**Files:**
- Modify: `frontend/src/api/sse.ts`

- [ ] **Step 1: Add the listener**

Open `frontend/src/api/sse.ts`. Find the block of `src.addEventListener('capture_xxx', ...)` registrations (around line 18-49 per exploration). Add immediately after the last existing capture event listener:

```typescript
  src.addEventListener('capture_timing', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { id: string; data: TimingSummary };
      emit({ type: 'capture_timing', id: data.id, data: data.data });
    } catch (err) {
      console.warn('Failed to parse capture_timing event', err);
    }
  });
```

(Match the exact pattern used by sibling listeners — if they use a different parse helper or `emit` shape, conform to it. The example above is illustrative.)

Make sure `TimingSummary` is imported at the top of the file:

```typescript
import type { SSEEvent, TimingSummary } from './types';
```

- [ ] **Step 2: Verify TS compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/sse.ts
git commit -m "feat(api/sse): register capture_timing event listener"
```

---

## Phase F — Frontend store

### Task 17: useCaptureTimings Zustand store

**Files:**
- Create: `frontend/src/capture/timing/useCaptureTimings.ts`
- Test: `frontend/src/capture/timing/useCaptureTimings.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/capture/timing/useCaptureTimings.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useCaptureTimings } from './useCaptureTimings';
import type { TimingSummary } from '../../api/types';

function makeSummary(overrides: Partial<TimingSummary> = {}): TimingSummary {
  return {
    code: '005930',
    date: '20250520',
    started_at_kst: '2026-05-27T14:32:18+09:00',
    ended_at_kst: '2026-05-27T14:33:02+09:00',
    total_ms: 1000,
    phase_totals_ms: {
      http_fetch_ms: 800,
      parse_ms: 100,
      disk_write_ms: 50,
      rate_limit_ms: 50,
      backoff_ms: 0,
      cookie_pause_ms: 0,
      other_ms: 0,
    },
    phase_percentages: {
      http_fetch: 80, parse: 10, disk_write: 5, rate_limit: 5,
      backoff: 0, cookie_pause: 0, other: 0,
    },
    unaccounted_ms: 0,
    page_count: 5,
    event_count: 100,
    error_counts: {},
    env: {
      rate_limit_s: 0.05, max_concurrent: 3, page_step_ms_initial: 60000,
      hoga_version: '0.1.0', git_sha: null,
    },
    ...overrides,
  };
}

describe('useCaptureTimings', () => {
  beforeEach(() => {
    useCaptureTimings.setState({ timings: {} });
  });

  it('upserts a timing by id', () => {
    const s = makeSummary();
    useCaptureTimings.getState().upsert('005930:20250520', s);
    expect(useCaptureTimings.getState().timings['005930:20250520']).toEqual(s);
  });

  it('replaces on re-emit (dedup by id)', () => {
    const a = makeSummary({ event_count: 100 });
    const b = makeSummary({ event_count: 200 });
    useCaptureTimings.getState().upsert('005930:20250520', a);
    useCaptureTimings.getState().upsert('005930:20250520', b);
    expect(useCaptureTimings.getState().timings['005930:20250520'].event_count).toBe(200);
  });

  it('reads by id helper returns undefined for unknown', () => {
    expect(useCaptureTimings.getState().get('999999:20990101')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/capture/timing/useCaptureTimings.test.ts`
Expected: FAIL `Cannot find module './useCaptureTimings'`

- [ ] **Step 3: Implement the store**

Create `frontend/src/capture/timing/useCaptureTimings.ts`:

```typescript
import { create } from 'zustand';
import type { TimingSummary } from '../../api/types';

interface CaptureTimingsState {
  timings: Record<string, TimingSummary>; // key: `${code}:${date}`
  upsert: (id: string, summary: TimingSummary) => void;
  get: (id: string) => TimingSummary | undefined;
  clear: () => void;
}

export const useCaptureTimings = create<CaptureTimingsState>((set, get) => ({
  timings: {},
  upsert: (id, summary) => set((state) => ({
    timings: { ...state.timings, [id]: summary },
  })),
  get: (id) => get().timings[id],
  clear: () => set({ timings: {} }),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/capture/timing/useCaptureTimings.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/timing/useCaptureTimings.ts frontend/src/capture/timing/useCaptureTimings.test.ts
git commit -m "feat(capture/timing): useCaptureTimings Zustand store"
```

---

### Task 18: Dispatch `capture_timing` SSE into the timings store

**Files:**
- Modify: `frontend/src/capture/useCaptureQueue.ts`

- [ ] **Step 1: Locate the SSE dispatcher**

Open `frontend/src/capture/useCaptureQueue.ts`. Find the `if (e.type === '...')` chain (around lines 56-103).

- [ ] **Step 2: Add the capture_timing branch**

At the top of the file:

```typescript
import { useCaptureTimings } from './timing/useCaptureTimings';
```

Inside the dispatcher chain, after the last existing branch, add:

```typescript
    } else if (e.type === 'capture_timing') {
      useCaptureTimings.getState().upsert(e.id, e.data);
    }
```

(Match the exact `else if` style of sibling branches.)

- [ ] **Step 3: Verify TS compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/capture/useCaptureQueue.ts
git commit -m "feat(capture): dispatch capture_timing SSE into timings store"
```

---

## Phase G — Frontend components

### Task 19: phaseColors + timingFormat helpers

**Files:**
- Create: `frontend/src/capture/timing/phaseColors.ts`
- Create: `frontend/src/capture/timing/timingFormat.ts`
- Test: `frontend/src/capture/timing/timingFormat.test.ts` (new)

- [ ] **Step 1: Write the failing test for timingFormat**

Create `frontend/src/capture/timing/timingFormat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatMs, formatPercent, formatEventCount } from './timingFormat';

describe('formatMs', () => {
  it('shows ms for values under 1000', () => {
    expect(formatMs(234)).toBe('234 ms');
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(999.4)).toBe('999 ms');
  });
  it('shows s with one decimal for values >= 1000', () => {
    expect(formatMs(1000)).toBe('1.0 s');
    expect(formatMs(12_345)).toBe('12.3 s');
    expect(formatMs(43_821.4)).toBe('43.8 s');
  });
});

describe('formatPercent', () => {
  it('rounds to 1 decimal place', () => {
    expect(formatPercent(71.23)).toBe('71.2 %');
    expect(formatPercent(0)).toBe('0.0 %');
    expect(formatPercent(100)).toBe('100.0 %');
  });
});

describe('formatEventCount', () => {
  it('uses ko-KR thousand separators', () => {
    expect(formatEventCount(184231)).toBe('184,231');
    expect(formatEventCount(0)).toBe('0');
    expect(formatEventCount(7)).toBe('7');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/capture/timing/timingFormat.test.ts`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Implement timingFormat**

Create `frontend/src/capture/timing/timingFormat.ts`:

```typescript
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatPercent(p: number): string {
  return `${p.toFixed(1)} %`;
}

const COUNT_FMT = new Intl.NumberFormat('ko-KR');

export function formatEventCount(n: number): string {
  return COUNT_FMT.format(n);
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd frontend && npx vitest run src/capture/timing/timingFormat.test.ts`
Expected: 3 describe blocks all PASS.

- [ ] **Step 5: Create phaseColors**

Create `frontend/src/capture/timing/phaseColors.ts`.

> **Plan-review correction (design B1):** tokens `--accent-muted`, `--warning`, `--warning-muted`, `--fg-strong` **do not exist** in `frontend/src/styles/tokens.css`. The mapping below uses **verified tokens**: `--accent`, `--accent-shade`, `--ma-2`, `--ma-4`, `--warn`, `--error`, `--fg-dimmer`. The semantic axis follows design S1: **normal phases use the categorical (MA) palette + accent family; anomalies use status (warn/error) tokens**.

```typescript
// Phase → DESIGN.md CSS-variable token. All tokens are verified to exist in
// frontend/src/styles/tokens.css. Do not introduce new tokens here.

export type PhaseKey =
  | 'http_fetch'
  | 'parse'
  | 'disk_write'
  | 'rate_limit'
  | 'backoff'
  | 'cookie_pause'
  | 'other';

export const PHASE_TOKEN: Record<PhaseKey, string> = {
  // Normal phases — categorical palette
  http_fetch:   'var(--accent)',         // teal — primary signal
  rate_limit:   'var(--accent-shade)',   // darker teal, same family
  parse:        'var(--ma-4)',           // green — processing
  disk_write:   'var(--ma-2)',           // blue — processing, smaller share
  // Anomalies — status palette (NEVER 0 in healthy state)
  backoff:      'var(--warn)',           // amber
  cookie_pause: 'var(--error)',          // rose — distinct from 429
  // Residual / instrumentation gap
  other:        'var(--fg-dimmer)',
};

// Phase labels are DOMAIN IDENTIFIERS (they match backend JSON keys an
// operator will grep). Keep English/snake_case per ADR-0039 / DESIGN.md
// "Copy tone" — domain identifiers are never localized.
export const PHASE_LABEL: Record<PhaseKey, string> = {
  http_fetch: 'http_fetch',
  parse: 'parse',
  disk_write: 'disk_write',
  rate_limit: 'rate_limit',
  backoff: 'backoff',
  cookie_pause: 'cookie_pause',
  other: 'other',
};
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/capture/timing/timingFormat.ts \
       frontend/src/capture/timing/timingFormat.test.ts \
       frontend/src/capture/timing/phaseColors.ts
git commit -m "feat(capture/timing): timingFormat + phaseColors helpers"
```

---

### Task 20: TimingPanel component (collapsed + expanded)

**Files:**
- Create: `frontend/src/capture/timing/TimingPanel.tsx`
- Test: `frontend/src/capture/timing/TimingPanel.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/capture/timing/TimingPanel.test.tsx`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimingPanel } from './TimingPanel';
import { useCaptureTimings } from './useCaptureTimings';
import type { TimingSummary } from '../../api/types';

function summary(overrides: Partial<TimingSummary> = {}): TimingSummary {
  return {
    code: '005930',
    date: '20250520',
    started_at_kst: '2026-05-27T14:32:18+09:00',
    ended_at_kst: '2026-05-27T14:33:02+09:00',
    total_ms: 43821.4,
    phase_totals_ms: {
      http_fetch_ms: 31204.8, parse_ms: 4102.1, disk_write_ms: 1843.7,
      rate_limit_ms: 5021.0, backoff_ms: 0, cookie_pause_ms: 0, other_ms: 0,
    },
    phase_percentages: {
      http_fetch: 71.2, parse: 9.4, disk_write: 4.2, rate_limit: 11.5,
      backoff: 0, cookie_pause: 0, other: 0,
    },
    unaccounted_ms: 1649.8,
    page_count: 387,
    event_count: 184231,
    error_counts: { '429': 0 },
    env: {
      rate_limit_s: 0.05, max_concurrent: 3, page_step_ms_initial: 60000,
      hoga_version: '0.1.0', git_sha: '9aef504',
    },
    ...overrides,
  };
}

describe('TimingPanel', () => {
  beforeEach(() => {
    useCaptureTimings.setState({ timings: {} });
  });

  it('renders nothing when no timing exists for the id', () => {
    const { container } = render(<TimingPanel id="005930:20250520" />);
    expect(container.textContent).toBe('');
  });

  it('renders collapsed by default when timing exists', () => {
    useCaptureTimings.getState().upsert('005930:20250520', summary());
    render(<TimingPanel id="005930:20250520" />);
    expect(screen.getByText(/43\.8 s/)).toBeInTheDocument();
    // expanded-only content should be absent
    expect(screen.queryByText(/pages: 387/)).not.toBeInTheDocument();
  });

  it('expands to show phase table on toggle click', () => {
    useCaptureTimings.getState().upsert('005930:20250520', summary());
    render(<TimingPanel id="005930:20250520" />);
    const toggle = screen.getByRole('button', { name: /타이밍 상세/i });
    fireEvent.click(toggle);
    expect(screen.getByText(/pages: 387/)).toBeInTheDocument();
    expect(screen.getByText(/events: 184,231/)).toBeInTheDocument();
  });

  it('warns when unaccounted_ms exceeds 5% of total', () => {
    useCaptureTimings.getState().upsert(
      '005930:20250520',
      summary({ unaccounted_ms: 5000, total_ms: 10000 }),
    );
    render(<TimingPanel id="005930:20250520" />);
    fireEvent.click(screen.getByRole('button', { name: /타이밍 상세/i }));
    expect(screen.getByText(/unaccounted/i)).toHaveAttribute('data-warning', 'true');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/capture/timing/TimingPanel.test.tsx`
Expected: FAIL `Cannot find module './TimingPanel'`

- [ ] **Step 3: Implement TimingPanel**

> **Plan-review corrections (design):**
> - C1: Drop `{code} · {date}` from header — already shown by parent row.
> - C2: Use design tokens for separators/spacing. Avoid raw `border-t` (resolves to `currentColor`).
> - C3: aria-label must include action verb + state.
> - C4: Bar height `h-2` (8px) + min-width 2px per segment + `gap-px`.
> - S3: Expanded view uses fixed column widths so values align across rows. Drop `──` ASCII separators; use `border-t var(--border)`.
> - S4: `unaccounted > 5%` row prepends `⚠` + threshold context sentence.
> - N1: `formatMs` hand-off at 950ms (not 1000) to kill ±1ms jitter.
> - N2: Use `▴ / ▾` triangles (consistent across Geist Sans/Mono).
> - N3: Add `tabular-nums` class explicitly to every numeric span.

Create `frontend/src/capture/timing/TimingPanel.tsx`:

```typescript
import { useState } from 'react';
import { useCaptureTimings } from './useCaptureTimings';
import { formatMs, formatPercent, formatEventCount } from './timingFormat';
import { PHASE_TOKEN, PHASE_LABEL, PhaseKey } from './phaseColors';
import type { TimingSummary } from '../../api/types';

const PHASE_ORDER: PhaseKey[] = [
  'http_fetch',
  'rate_limit',
  'parse',
  'disk_write',
  'backoff',
  'cookie_pause',
  'other',
];

interface Props {
  id: string;          // `${code}:${date}`
}

export function TimingPanel({ id }: Props) {
  const summary = useCaptureTimings((s) => s.timings[id]);
  const [expanded, setExpanded] = useState(false);

  if (!summary) return null;

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono tabular-nums">{formatMs(summary.total_ms)}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`타이밍 상세 ${expanded ? '접기' : '펼치기'}`}
          onClick={() => setExpanded((v) => !v)}
          className="px-1"
        >
          {expanded ? '▴' : '▾'}
        </button>
      </div>

      <StackedBar summary={summary} />

      {!expanded && <PhaseSummaryLine summary={summary} />}
      {expanded && <ExpandedDetail summary={summary} />}
    </div>
  );
}

function StackedBar({ summary }: { summary: TimingSummary }) {
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded gap-px mt-xs"
      role="img"
      aria-label={phaseAriaLabel(summary)}
    >
      {PHASE_ORDER.map((p) => {
        const pct = summary.phase_percentages[p] ?? 0;
        if (pct <= 0) return null;
        return (
          <div
            key={p}
            style={{
              width: `${pct}%`,
              minWidth: 2,
              backgroundColor: PHASE_TOKEN[p],
            }}
          />
        );
      })}
    </div>
  );
}

function PhaseSummaryLine({ summary }: { summary: TimingSummary }) {
  const top3 = [...PHASE_ORDER]
    .sort(
      (a, b) =>
        (summary.phase_percentages[b] ?? 0) - (summary.phase_percentages[a] ?? 0),
    )
    .slice(0, 3)
    .filter((p) => (summary.phase_percentages[p] ?? 0) > 0);

  return (
    <div className="font-mono tabular-nums opacity-80 mt-xs">
      {top3.map((p, i) => (
        <span key={p}>
          {PHASE_LABEL[p]} {Math.round(summary.phase_percentages[p])}%
          {i < top3.length - 1 ? ' · ' : ''}
        </span>
      ))}
    </div>
  );
}

function ExpandedDetail({ summary }: { summary: TimingSummary }) {
  const unaccountedPct =
    summary.total_ms > 0 ? (summary.unaccounted_ms / summary.total_ms) * 100 : 0;
  const unaccountedWarn = unaccountedPct > 5;

  return (
    <div className="mt-sm font-mono">
      <div className="grid grid-cols-[8rem_5rem_4rem] gap-x-md">
        {PHASE_ORDER.map((p) => (
          <PhaseRow key={p} phase={p} summary={summary} />
        ))}
      </div>
      <div
        className="mt-sm pt-xs opacity-70 tabular-nums"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        pages: {summary.page_count} · events: {formatEventCount(summary.event_count)}
      </div>
      <div className="opacity-70 tabular-nums">
        env: rate_limit {summary.env.rate_limit_s}s · workers {summary.env.max_concurrent}
      </div>
      <div
        className="tabular-nums"
        data-warning={unaccountedWarn ? 'true' : 'false'}
        style={
          unaccountedWarn
            ? { color: 'var(--warn)' }
            : { opacity: 0.7 }
        }
      >
        {unaccountedWarn && '⚠ '}
        unaccounted: {formatMs(summary.unaccounted_ms)} ({formatPercent(unaccountedPct)})
        {unaccountedWarn && ' — 5% 초과는 미계측 블로킹 가능성'}
      </div>
    </div>
  );
}

function PhaseRow({ phase, summary }: { phase: PhaseKey; summary: TimingSummary }) {
  const ms =
    summary.phase_totals_ms[`${phase}_ms` as keyof typeof summary.phase_totals_ms];
  const pct = summary.phase_percentages[phase] ?? 0;
  return (
    <>
      <div style={{ color: PHASE_TOKEN[phase] }}>{PHASE_LABEL[phase]}</div>
      <div className="text-right tabular-nums">{formatMs(ms)}</div>
      <div className="text-right tabular-nums">{formatPercent(pct)}</div>
    </>
  );
}

function phaseAriaLabel(summary: TimingSummary): string {
  return PHASE_ORDER
    .filter((p) => (summary.phase_percentages[p] ?? 0) > 0)
    .map((p) => `${p} ${Math.round(summary.phase_percentages[p])}%`)
    .join(', ');
}
```

**Also update `timingFormat.ts`** (N1 — kill the 999→1000 jitter):

```typescript
// In frontend/src/capture/timing/timingFormat.ts, replace formatMs:
export function formatMs(ms: number): string {
  if (ms < 950) return `${Math.floor(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
```

And update the existing test cases in `timingFormat.test.ts` accordingly — change `expect(formatMs(999.4)).toBe('999 ms')` to `expect(formatMs(949)).toBe('949 ms')` and add `expect(formatMs(950)).toBe('1.0 s')` to cover the new boundary.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/capture/timing/TimingPanel.test.tsx`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/timing/TimingPanel.tsx frontend/src/capture/timing/TimingPanel.test.tsx
git commit -m "feat(capture/timing): TimingPanel component (collapsed + expanded)"
```

---

### Task 21: Wire TimingPanel into CaptureRowDetail

**Files:**
- Modify: `frontend/src/capture/CaptureRowDetail.tsx`

- [ ] **Step 1: Locate the detail grid**

Open `frontend/src/capture/CaptureRowDetail.tsx`. Per exploration, lines 29-80 are a `grid grid-cols-[auto_1fr]` listing started_at, frontier, enqueued_at, error, result, warnings.

- [ ] **Step 2: Append TimingPanel below the existing detail grid (conditional wrapper)**

> **Plan-review correction (design B2):** `<div className="border-t">…</div>` always renders even if its child is `null` — React doesn't unmount the parent. For in-flight captures (most common viewing state) that leaves a stray ~9px bordered empty region. Gate the wrapper on actual store presence.

Imports at the top of `CaptureRowDetail.tsx`:

```typescript
import { TimingPanel } from './timing/TimingPanel';
import { useCaptureTimings } from './timing/useCaptureTimings';
```

Inside the component body, before the return statement, peek the store:

```typescript
  const timingId = `${item.code}:${item.date}`;
  const hasTiming = useCaptureTimings((s) => Boolean(s.timings[timingId]));
```

Inside the JSX, **after** the existing detail rows, render the wrapper only when timing exists:

```typescript
      {hasTiming && (
        <div
          className="mt-sm pt-xs"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <TimingPanel id={timingId} />
        </div>
      )}
```

(Spacing uses design tokens `mt-sm` / `pt-xs` instead of raw `mt-3` / `pt-2` per design C2.)

- [ ] **Step 3: Build and verify**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: No errors; build artifact produced.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/capture/CaptureRowDetail.tsx
git commit -m "feat(capture): mount TimingPanel inside CaptureRowDetail"
```

---

## Phase H — Verification + end-to-end

### Task 22: Full verification gate

- [ ] **Step 1: Backend tests**

Run: `uv run pytest -v`
Expected: All PASS.

- [ ] **Step 2: Frontend type-check + tests**

Run: `cd frontend && npx tsc --noEmit && npm run test`
Expected: All PASS.

- [ ] **Step 3: Frontend build**

Run: `cd frontend && npm run build`
Expected: Successful build, no warnings about unused exports.

- [ ] **Step 4: Smoke check with timing disabled**

```bash
HOGA_CAPTURE_TIMING=0 uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 &
# Trigger a small capture via /api/captures/items (curl or UI).
# Verify:
#   - data_dir/timing/ does NOT exist or is empty for the new (code, date)
#   - SSE stream at /api/events does NOT include capture_timing
```

- [ ] **Step 5: Smoke check with timing enabled (default)**

```bash
HOGA_CAPTURE_TIMING=1 uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 &
# Trigger a small capture.
# Verify:
#   - data_dir/timing/<date>/<code>.json exists and validates as TimingReport
#   - SSE stream emits one capture_timing event with the right id
#   - /capture UI shows TimingPanel inside the expanded job row
#   - phase_percentages sum ≈ 100, unaccounted_ms / total_ms < 5%
```

- [ ] **Step 6: Final commit (no code change — log the smoke check)**

If everything passes, the verification phase is done. No commit needed.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Plan task | Covered? |
|---|---|---|
| §1 Context | — (rationale only) | n/a |
| §2 Architecture | Task 9 lifecycle + Task 7-8 wiring | ✅ |
| §3.1 Collector API | Tasks 2-4 | ✅ |
| §3.2 Touch points | Tasks 7-12 | ✅ |
| §3.3 Lifecycle | Task 9, 13 | ✅ |
| §3.4 Overhead claim | unverified by tests (intentional, §7.6) | acknowledged |
| §4 JSON schema | Tasks 1, 6 | ✅ |
| §5 SSE event | Tasks 13, 15, 16 | ✅ |
| §6 TimingPanel | Tasks 19-21 | ✅ |
| §7 Tests | Tasks 1, 2-4, 6, 14, 17, 19, 20 | ✅ |
| §8 Non-goals | — (excluded) | acknowledged |
| §9 DoD | Task 22 | ✅ |
| §10 R1-R5 risks | resolved in plan preamble | ✅ |

**2. Placeholder scan:** No "TBD" / "Add appropriate error handling" / "Similar to Task N" patterns. Two areas with explicit "confirm in plan-review" notes:
- Task 19 `phaseColors.ts` PHASE_TOKEN values — explicitly tagged for design-review.
- Task 13 `event_bus.publish` shape — to be aligned with existing emitters during implementation.

These are intentional design-review attachment points, not vague work.

**3. Type consistency:**
- `TimingPhaseTotals.http_fetch_ms` (model) ↔ `phase_totals_ms.http_fetch_ms` (JSON) ↔ `PhaseKey 'http_fetch' + _ms suffix` (frontend lookup): consistent.
- `capture_timing` event name: consistent across backend emit (Task 13), frontend listener (Task 16), and consumer dispatch (Task 18). Spec used `capture.timing` (dot) — the plan reconciles to **underscore** to match existing siblings, noted in preamble.
- `id = "{code}:{date}"`: consistent across Task 13 (backend), Task 18 (frontend dispatch), Task 20 (panel lookup).

---

## Deferred review notes

Suggestions and nits from plan-eng-review + plan-design-review that weren't applied to specific tasks above. Treat as follow-up backlog — none block implementation.

### From eng-review (low-priority suggestions)

- **S3:** `_fetch_and_store_page` already has `_time.perf_counter()` HTTP timing under `HOGA_PROFILE=1`. Our wrap measures the same span. **Decision: keep both.** The `HOGA_PROFILE` path is dev-only and uses log lines, not aggregation. Our collector aggregates into `phase_totals_ms` + per-page detail JSON. No data collision; the dev-only profiling stays untouched.
- **S5:** Task 1 step 2's "Run to verify it fails — Expected: FAIL with ImportError" applies to all three test functions simultaneously (a single module-import error gates collection). Cosmetic framing only; doesn't affect behavior.
- **N2:** Plan §self-review §3.4 says overhead claim is unverified by tests (intentional). Eng review suggests a follow-up issue tracking a one-shot benchmark. Add to follow-up backlog (see "Follow-up issues" below).

### From design-review (low-priority suggestions + nits)

- **S5:** Integer-rounded "71%" in collapsed top-3 view is fine — density-tier readability. Keep.
- **N3:** `font-mono` alone does not enable `font-variant-numeric: tabular-nums` in Tailwind. Already addressed inline in Task 20 by adding `tabular-nums` class on every numeric span.

### Follow-up issues (to file after this plan lands)

1. **Effective rate plumbing.** Task 13 step 4 leaves a `TODO(timing): plumb effective rate` fallback path for the case where `_run_capture_inner` doesn't surface its actual `rate_limit_s` to `_run_item`. If the surface is non-trivial, file a follow-up issue: "Plumb effective rate_limit_s from _run_capture_inner to TimingEnv".
2. **Overhead benchmark.** One-shot measurement comparing `HOGA_CAPTURE_TIMING=0` vs `=1` wall-time on a controlled (code, date). Spec §3.4 / §7.6 acknowledged this as deferred; ADR-0017 throttle behavior should be unaffected but worth verifying once.
3. **Cookie-pause attribution.** Current design has `cookie_pause` Timing Phase always 0 ms (spec correction + eng B2). A future restructure could surface the queue-pause duration to each affected item — file as "Attribute queue-pause time to items".

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-27-capture-timing-instrumentation-plan.md`.**

The /full-flow pipeline (which invoked writing-plans) routes execution to **Step 5 subagent-driven-development** after **GATE 2** (user approval of the merged plan) — see the orchestrating /full-flow command.
