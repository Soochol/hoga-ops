from hoga.live import kiwoom_diagnostics as M


def test_failure_window_keeps_units_and_cpu_scope_explicit(monkeypatch):
    process, thread = [1.0], [0.5]
    monkeypatch.setattr(M.time, "process_time", lambda: process[0])
    monkeypatch.setattr(M.time, "thread_time", lambda: thread[0])
    flow = M.QueueFlowEvidence(0.0)
    flow.receive(4, 0.0)
    flow.start_frame(4, 0.0)
    flow.tick()
    process[0], thread[0] = 1.2, 0.55
    snap = flow.snapshot(2.0)
    assert snap['received_frames'] == 1
    assert snap['received_raw_rows'] == 4
    assert snap['processed_ticks'] == 1
    assert snap['completed_frames'] == 0
    assert snap['input_frames_per_s'] == 0.5
    assert snap['inflight_age_ms'] == 2000
    assert snap['process_cpu_ms'] == 200
    assert snap['loop_thread_cpu_ms'] == 50
    flow.complete_frame(2.0)
    assert flow.snapshot(2.0)['inflight_age_ms'] == 0


def test_samples_are_bounded_and_old_history_expires():
    flow = M.QueueFlowEvidence(0.0)
    for second in range(100):
        flow.receive(1, float(second))
        flow.complete_frame(float(second))
    snap = flow.snapshot(100.0)
    assert len(flow._samples) <= 12
    assert snap['window_ms'] == 10000
    assert snap['received_frames'] == 100
    assert snap['recent_received_frames'] == 10
    assert snap['recent_completed_frames'] == 10


def test_context_failure_does_not_leak_exception_text_or_mask_overload():
    def broken():
        raise RuntimeError('SECRET')
    M.configure_failure_context(broken)
    try:
        assert M.failure_context() == {'runtime_context_error': 'RuntimeError'}
    finally:
        M.configure_failure_context(None)
