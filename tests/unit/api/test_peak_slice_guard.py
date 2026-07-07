import hoga.api.peak_slice_guard as psg


def test_resolve_concurrency_reads_named_env(monkeypatch):
    monkeypatch.setenv("HOGA_RANGE_PROFILE_CONCURRENCY", "3")
    assert psg._resolve_concurrency("HOGA_RANGE_PROFILE_CONCURRENCY", 1) == 3


def test_resolve_concurrency_falls_back_on_garbage(monkeypatch):
    monkeypatch.setenv("HOGA_RANGE_PROFILE_CONCURRENCY", "banana")
    assert psg._resolve_concurrency("HOGA_RANGE_PROFILE_CONCURRENCY", 1) == 1


def test_range_profile_guard_exists_with_default_1(monkeypatch):
    monkeypatch.delenv("HOGA_RANGE_PROFILE_CONCURRENCY", raising=False)
    assert isinstance(psg.RANGE_PROFILE_GUARD, psg.PeakSliceGuard)
