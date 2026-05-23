"""Unit tests for PageStepController state machine (no HTTP, no files)."""

from __future__ import annotations

from hoga.collector.page_step import PageStepController


def _make(
    *,
    initial_t: int = 100,
    initial_step_ms: int = 20,
    min_step_ms: int = 5,
    data_window_end_ms: int = 200,
    termination_empty_pages: int = 2,
) -> PageStepController:
    return PageStepController(
        initial_t=initial_t,
        initial_step_ms=initial_step_ms,
        min_step_ms=min_step_ms,
        data_window_end_ms=data_window_end_ms,
        termination_empty_pages=termination_empty_pages,
    )


def test_initial_state() -> None:
    c = _make()
    assert c.next_t == 100
    assert c.step_ms == 20


def test_normal_advance_with_new_seqs() -> None:
    c = _make()
    # max_t >= target (100+20=120), with new data: advance by step, empty stays 0.
    decision = c.observe(max_event_time=125, new_seqs=3)
    assert decision.progress_t == 100  # OLD t
    assert decision.should_stop is False
    assert c.next_t == 120
    assert c.step_ms == 20


def test_normal_advance_empty_increments_counter() -> None:
    c = _make()
    decision = c.observe(max_event_time=125, new_seqs=0)
    assert decision.progress_t == 100
    assert decision.should_stop is False
    assert c.next_t == 120
    # Internally empty_in_a_row=1; next empty observation pushes us toward termination check.


def test_cap_hit_halves_step_and_advances() -> None:
    c = _make()  # step=20, t=100
    # max_t (110) < target (120), step>min, t<end → cap hit.
    decision = c.observe(max_event_time=110, new_seqs=1)
    assert c.step_ms == 10  # halved
    assert c.next_t == 110  # advanced by new step
    assert decision.progress_t == 110  # NEW t (asymmetry)
    assert decision.should_stop is False


def test_cap_hit_floor_at_min_step() -> None:
    c = _make(initial_step_ms=5, min_step_ms=5)
    # step == min already, so cap-hit condition is false → goes to normal advance.
    decision = c.observe(max_event_time=101, new_seqs=0)
    # Normal path: progress_t=OLD, t advances by step (5).
    assert decision.progress_t == 100
    assert c.step_ms == 5
    assert c.next_t == 105


def test_cap_hit_gated_past_window_end() -> None:
    # t already past window end → cap-hit suppressed even if response short.
    c = _make(initial_t=210, data_window_end_ms=200)
    decision = c.observe(max_event_time=215, new_seqs=0)
    # Normal advance path (no halving).
    assert c.step_ms == 20
    assert decision.progress_t == 210
    assert c.next_t == 230


def test_step_doubles_back_after_halving_when_new_data() -> None:
    c = _make()
    # Cap-hit: step 20 → 10, t 100 → 110.
    c.observe(max_event_time=110, new_seqs=1)
    assert c.step_ms == 10
    # Normal advance with new data (max_t >= target=120) → step doubles back to 20.
    decision = c.observe(max_event_time=130, new_seqs=2)
    assert c.step_ms == 20
    assert decision.progress_t == 110  # OLD t
    assert c.next_t == 130


def test_step_doubling_capped_at_initial() -> None:
    c = _make(initial_step_ms=20, min_step_ms=5)
    # Halve twice via cap hits: 20→10 (t 100→110), then 10→5 (t 110→115).
    c.observe(max_event_time=105, new_seqs=0)
    assert c.step_ms == 10
    c.observe(max_event_time=112, new_seqs=0)
    assert c.step_ms == 5
    # New data (target=120, max_t=999 covers): step doubles 5→10, t=115+10=125.
    c.observe(max_event_time=999, new_seqs=1)
    assert c.step_ms == 10
    # New data again: step doubles 10→20 (cap at initial), t=125+20=145.
    c.observe(max_event_time=999, new_seqs=1)
    assert c.step_ms == 20
    # New data again: step stays at 20.
    c.observe(max_event_time=999, new_seqs=1)
    assert c.step_ms == 20


def test_termination_when_past_window_and_empty_streak_met() -> None:
    c = _make(initial_t=180, termination_empty_pages=2)  # step=20, end=200
    # max_t large enough to avoid cap-hit. Empty advance: t 180→200, empty=1.
    d1 = c.observe(max_event_time=999, new_seqs=0)
    assert d1.should_stop is False
    assert c.next_t == 200
    # Second empty: t 200→220, empty=2, t>=end → stop.
    d2 = c.observe(max_event_time=999, new_seqs=0)
    assert d2.should_stop is True
    assert d2.progress_t == 200  # OLD t


def test_termination_not_triggered_when_streak_too_short() -> None:
    c = _make(initial_t=180, termination_empty_pages=3)
    d = c.observe(max_event_time=999, new_seqs=0)
    assert c.next_t == 200
    assert d.should_stop is False
    d2 = c.observe(max_event_time=999, new_seqs=0)
    assert d2.should_stop is False  # empty=2, need 3


def test_new_seqs_resets_empty_counter() -> None:
    c = _make(initial_t=180, termination_empty_pages=2)
    c.observe(max_event_time=999, new_seqs=0)  # empty=1, t=200
    c.observe(max_event_time=999, new_seqs=5)  # resets empty=0, t=220
    # Next empty only increments to 1, not enough to stop.
    d = c.observe(max_event_time=999, new_seqs=0)
    assert d.should_stop is False


def test_progress_t_asymmetry_cap_vs_normal() -> None:
    """Cap-hit writes NEW t; normal advance writes OLD t."""
    c = _make()
    cap_decision = c.observe(max_event_time=110, new_seqs=0)
    # Cap hit: t advanced from 100 → 110; progress_t equals new t.
    assert cap_decision.progress_t == 110
    assert c.next_t == 110

    c2 = _make()
    normal_decision = c2.observe(max_event_time=125, new_seqs=0)
    # Normal: progress_t is OLD t (100); next_t advanced to 120.
    assert normal_decision.progress_t == 100
    assert c2.next_t == 120


def test_stagnation_guard_forces_stop_when_max_frozen_and_no_new_seqs() -> None:
    """When hogaplay freezes max_event_time and returns no new seqs for
    MAX_STAGNANT_PAGES iterations, the controller forces should_stop=True."""
    from hoga.collector.page_step import PageStepController

    ctrl = PageStepController(
        initial_t=84000000,
        initial_step_ms=60000,
        max_stagnant_pages=5,  # NEW kwarg, small value for fast test
    )
    # First call: max=84050000, new_seqs=1 — establishes baseline (not stagnant)
    d0 = ctrl.observe(max_event_time=84050000, new_seqs=1)
    assert not d0.should_stop

    # Subsequent calls: same max, no new seqs → stagnant counter grows
    decisions = [d0]
    for _ in range(10):
        d = ctrl.observe(max_event_time=84050000, new_seqs=0)
        decisions.append(d)
        if d.should_stop:
            break

    assert decisions[-1].should_stop
    # 5 stagnant calls after the baseline → 6 total (baseline + 5)
    assert len(decisions) == 6


def test_stagnation_guard_resets_when_max_advances() -> None:
    """If max_event_time advances at any point, stagnant counter resets."""
    from hoga.collector.page_step import PageStepController

    ctrl = PageStepController(
        initial_t=84000000,
        initial_step_ms=60000,
        max_stagnant_pages=3,
    )
    ctrl.observe(max_event_time=84050000, new_seqs=1)
    # 2 stagnant pages (under threshold)
    ctrl.observe(max_event_time=84050000, new_seqs=0)
    ctrl.observe(max_event_time=84050000, new_seqs=0)
    # Advance: max moves forward → reset
    ctrl.observe(max_event_time=84100000, new_seqs=2)
    # Now 3 more stagnant — should still NOT stop (counter was reset)
    d1 = ctrl.observe(max_event_time=84100000, new_seqs=0)
    d2 = ctrl.observe(max_event_time=84100000, new_seqs=0)
    d3 = ctrl.observe(max_event_time=84100000, new_seqs=0)
    # Should stop on the 4th post-reset stagnant call (threshold=3 → exceeds after 3)
    # Actually with threshold=3, the 3rd stagnant call hits should_stop:
    assert not d1.should_stop  # 1 stagnant
    assert not d2.should_stop  # 2 stagnant
    assert d3.should_stop      # 3 stagnant → stop
