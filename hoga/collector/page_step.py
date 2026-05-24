"""Page Step adaptation state machine.

Page Step is the increment applied to the `time` query parameter between
successive first.php calls. Default 60000ms; halves on cap-hit (response
stopped short of the requested window) and doubles back when new data is
found, up to the default. The loop terminates when t passes
DATA_WINDOW_END_MS and TERMINATION_EMPTY_PAGES consecutive pages contain
no new global_seq.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

DEFAULT_PAGE_STEP_MS = 60000
MIN_PAGE_STEP_MS = 1000
DATA_WINDOW_END_MS = 160000000
TERMINATION_EMPTY_PAGES = 3
# see spec §8.3 v2 — guards against hogaplay response freeze (raised from initial 100 after Phase 0 baseline showed normal captures reach stagnant streaks up to 130; ×1.5 margin)
MAX_STAGNANT_PAGES = 200


class StopReason(str, Enum):
    """Why the page step loop terminated.

    EMPTY_STREAK is the normal end (t past Data Window end + N consecutive empty
    pages). STAGNATION is the abnormal abort path — hogaplay froze its response
    (max_event_time held flat for MAX_STAGNANT_PAGES pages). Callers MUST
    distinguish these so a stagnation abort is recorded as
    ``finished=False, abort_reason="stagnation_abort"`` in _progress.json,
    preventing the parser from reading partial data as complete.
    """

    EMPTY_STREAK = "empty_streak"
    STAGNATION = "stagnation_abort"


@dataclass(frozen=True)
class StepDecision:
    """Caller persists ``progress_t`` and stops if ``should_stop``.

    ``stop_reason`` is set iff ``should_stop`` is True. None while the loop
    continues.
    """

    progress_t: int  # value to write to the progress file as last_time_ms
    should_stop: bool
    stop_reason: StopReason | None = None


class PageStepController:
    """Owns Page Step state across one collect_stock_date run.

    The controller decides next ``t`` and ``step_ms`` and detects termination.
    The caller fetches at ``next_t``, then reports ``(max_event_time, new_seqs)``
    via ``observe``. The returned :class:`StepDecision` tells the caller what
    to persist and when to stop.
    """

    def __init__(
        self,
        *,
        initial_t: int,
        initial_step_ms: int = DEFAULT_PAGE_STEP_MS,
        min_step_ms: int = MIN_PAGE_STEP_MS,
        data_window_end_ms: int = DATA_WINDOW_END_MS,
        termination_empty_pages: int = TERMINATION_EMPTY_PAGES,
        max_stagnant_pages: int = MAX_STAGNANT_PAGES,
    ) -> None:
        self._t = initial_t
        self._step_ms = initial_step_ms
        self._initial_step_ms = initial_step_ms
        self._min_step_ms = min_step_ms
        self._data_window_end_ms = data_window_end_ms
        self._termination_empty_pages = termination_empty_pages
        self._max_stagnant = max_stagnant_pages
        self._empty_in_a_row = 0
        self._stagnant_pages = 0
        self._last_max_event_time: int | None = None

    @property
    def next_t(self) -> int:
        """The ``t`` the caller should pass to fetch_first on the next iteration."""
        return self._t

    @property
    def step_ms(self) -> int:
        return self._step_ms

    def observe(self, *, max_event_time: int | None, new_seqs: int) -> StepDecision:
        """Update state from one page's response and return the persist + stop decision.

        Cap-hit (response stopped short): halve step, advance t by new step,
        reset empty counter, no termination check (we're retrying the window).
        Normal advance: update empty counter, possibly double step back, then
        t += step. If t passed data window end and empty streak >= threshold,
        stop.

        Stagnation guard (spec §8.3 v2): if max_event_time stays frozen at
        its previous value AND new_seqs==0, increment _stagnant_pages. Either
        signal advancing resets the counter. At MAX_STAGNANT_PAGES consecutive
        stagnant calls, force should_stop=True regardless of branch.
        """
        # Update stagnation counter (must run BEFORE cap-hit branch which may not return early changes)
        if max_event_time == self._last_max_event_time and new_seqs == 0:
            self._stagnant_pages += 1
        else:
            self._stagnant_pages = 0
        self._last_max_event_time = max_event_time

        target = self._t + self._step_ms
        cap_hit = (
            max_event_time is not None
            and max_event_time < target
            and self._step_ms > self._min_step_ms
            and self._t < self._data_window_end_ms
        )
        if cap_hit:
            self._step_ms = max(self._step_ms // 2, self._min_step_ms)
            self._t = self._t + self._step_ms
            self._empty_in_a_row = 0
            # NEW: even in cap-hit branch, stagnation guard can fire
            if self._stagnant_pages >= self._max_stagnant:
                return StepDecision(
                    progress_t=self._t,
                    should_stop=True,
                    stop_reason=StopReason.STAGNATION,
                )
            # Cap-hit progress write uses the NEW (advanced) t.
            return StepDecision(progress_t=self._t, should_stop=False)

        # Normal advance: empty counter, possibly double step, write OLD t, then advance.
        if new_seqs == 0:
            self._empty_in_a_row += 1
        else:
            self._empty_in_a_row = 0
            if self._step_ms < self._initial_step_ms:
                self._step_ms = min(self._step_ms * 2, self._initial_step_ms)
        progress_t = self._t  # write current t before advancing
        self._t += self._step_ms
        # Stagnation takes precedence over empty-streak so partial-data captures
        # don't get reported as normal completion.
        if self._stagnant_pages >= self._max_stagnant:
            return StepDecision(
                progress_t=progress_t,
                should_stop=True,
                stop_reason=StopReason.STAGNATION,
            )
        if (
            self._t >= self._data_window_end_ms
            and self._empty_in_a_row >= self._termination_empty_pages
        ):
            return StepDecision(
                progress_t=progress_t,
                should_stop=True,
                stop_reason=StopReason.EMPTY_STREAK,
            )
        return StepDecision(progress_t=progress_t, should_stop=False)
