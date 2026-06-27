from __future__ import annotations

import pytest

from hoga.live.kis_capacity_runtime import (
    aclose_kis_capacity_scheduler,
    ensure_kis_capacity_scheduler,
    max_pending_requests_from_env,
    max_workers_for_account_count,
)


@pytest.fixture(autouse=True)
async def _close_schedulers():
    yield
    await aclose_kis_capacity_scheduler()


def test_max_workers_for_account_count_scales_with_accounts() -> None:
    assert max_workers_for_account_count(0, {}) == 4
    assert max_workers_for_account_count(1, {}) == 8
    assert max_workers_for_account_count(2, {}) == 16
    assert max_workers_for_account_count(4, {}) == 32
    assert max_workers_for_account_count(8, {}) == 64
    assert max_workers_for_account_count(16, {}) == 64


def test_max_workers_for_account_count_accepts_env_override() -> None:
    assert max_workers_for_account_count(
        4,
        {"HOGA_KIS_CAPACITY_MAX_WORKERS": "12"},
    ) == 12


def test_max_workers_for_account_count_ignores_invalid_env_override() -> None:
    assert max_workers_for_account_count(2, {"HOGA_KIS_CAPACITY_MAX_WORKERS": "bad"}) == 16
    assert max_workers_for_account_count(2, {"HOGA_KIS_CAPACITY_MAX_WORKERS": "0"}) == 16
    assert max_workers_for_account_count(2, {"HOGA_KIS_CAPACITY_MAX_WORKERS": "-3"}) == 16


def test_max_pending_requests_from_env_accepts_positive_override() -> None:
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "42"}) == 42


def test_max_pending_requests_from_env_ignores_invalid_override() -> None:
    assert max_pending_requests_from_env({}) == 1000
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "bad"}) == 1000
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "0"}) == 1000
    assert max_pending_requests_from_env({"HOGA_KIS_CAPACITY_MAX_PENDING": "-1"}) == 1000


def test_ensure_kis_capacity_scheduler_reuses_scheduler_for_same_data_dir(
    tmp_path, monkeypatch
) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0])

    s1 = ensure_kis_capacity_scheduler(tmp_path)
    s2 = ensure_kis_capacity_scheduler(tmp_path)

    assert s1 is s2


def test_ensure_kis_capacity_scheduler_isolates_different_data_dirs(
    tmp_path, monkeypatch
) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0])

    s1 = ensure_kis_capacity_scheduler(tmp_path / "one")
    s2 = ensure_kis_capacity_scheduler(tmp_path / "two")

    assert s1 is not s2


@pytest.mark.asyncio
async def test_existing_scheduler_does_not_hot_reload_worker_count(
    tmp_path, monkeypatch
) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0])
    s1 = ensure_kis_capacity_scheduler(tmp_path)
    assert s1.snapshot()["max_workers"] == 8

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2, 3])
    assert ensure_kis_capacity_scheduler(tmp_path) is s1
    assert s1.snapshot()["max_workers"] == 8

    await aclose_kis_capacity_scheduler(tmp_path)
    s2 = ensure_kis_capacity_scheduler(tmp_path)
    assert s2.snapshot()["max_workers"] == 32


@pytest.mark.asyncio
async def test_aclose_kis_capacity_scheduler_removes_scheduler(tmp_path, monkeypatch) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0])

    s1 = ensure_kis_capacity_scheduler(tmp_path)
    await aclose_kis_capacity_scheduler(tmp_path)
    s2 = ensure_kis_capacity_scheduler(tmp_path)

    assert s1 is not s2


@pytest.mark.asyncio
async def test_aclose_kis_capacity_scheduler_without_data_dir_closes_all(
    tmp_path, monkeypatch
) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0])

    s1 = ensure_kis_capacity_scheduler(tmp_path / "one")
    s2 = ensure_kis_capacity_scheduler(tmp_path / "two")
    await aclose_kis_capacity_scheduler()

    assert ensure_kis_capacity_scheduler(tmp_path / "one") is not s1
    assert ensure_kis_capacity_scheduler(tmp_path / "two") is not s2

