from __future__ import annotations

from pathlib import Path

import pytest

from hoga.live.kis_account_pool import (
    KisAccountPool,
    KisAccountReservationDeferred,
    KisNoAccountAvailable,
)


class _FakeKis:
    pass


def _patch_pool_clients(monkeypatch, kis_runtime, clients: dict[int, _FakeKis]) -> None:
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: list(clients))
    monkeypatch.setattr(kis_runtime, "get_kis_client", lambda account_id: None)
    monkeypatch.setattr(
        kis_runtime,
        "ensure_kis_client_from_env",
        lambda data_dir: clients.get(0),
    )
    monkeypatch.setattr(
        kis_runtime,
        "ensure_kis_client_for_account",
        lambda account_id, data_dir: clients.get(account_id),
    )


def test_account_pool_discovers_configured_accounts(tmp_path: Path, monkeypatch) -> None:
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])

    pool = KisAccountPool(tmp_path)

    assert pool.configured_accounts() == [0, 1, 2]


def test_account_pool_does_not_hot_reload_configured_accounts(
    tmp_path: Path, monkeypatch
) -> None:
    from hoga.live import kis_runtime

    account_ids = [0, 1]
    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: account_ids)
    pool = KisAccountPool(tmp_path)

    account_ids.append(2)

    assert pool.configured_accounts() == [0, 1]


def test_account_pool_eligibility_filters_degraded_accounts(
    tmp_path: Path, monkeypatch
) -> None:
    from hoga.live import account_health, kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1, 2])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: account_id == 2)
    pool = KisAccountPool(tmp_path)

    assert pool.eligible_accounts() == [0, 1]


@pytest.mark.asyncio
async def test_account_pool_leases_least_loaded_account(tmp_path: Path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis(), 2: _FakeKis()}
    _patch_pool_clients(monkeypatch, kis_runtime, clients)
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path)

    lease0 = await pool.lease(cooldown_key=("quotes", "quotes"))
    lease1 = await pool.lease(cooldown_key=("quotes", "quotes"))

    assert lease0.account_id == 0
    assert lease1.account_id == 1
    assert lease0.client is clients[0]
    assert lease1.client is clients[1]

    pool.release(lease0.account_id)
    lease2 = await pool.lease(cooldown_key=("quotes", "quotes"))
    assert lease2.account_id == 0


@pytest.mark.asyncio
async def test_account_pool_marks_account_cooldown_per_key(tmp_path: Path, monkeypatch) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis()}
    now = 100.0
    _patch_pool_clients(monkeypatch, kis_runtime, clients)
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path, now=lambda: now)
    pool.mark_cooldown(0, ("past-minute", "KRX"), 10.0)

    lease = await pool.lease(cooldown_key=("past-minute", "KRX"))
    assert lease.account_id == 1
    other_scope = await pool.lease(cooldown_key=("past-minute", "NXT"))
    assert other_scope.account_id == 0


@pytest.mark.asyncio
async def test_account_pool_raises_when_all_candidates_cooling(
    tmp_path: Path, monkeypatch
) -> None:
    from hoga.live import account_health, kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda data_dir: [0, 1])
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path, now=lambda: 100.0)
    pool.mark_cooldown(0, ("past-minute", "KRX"), 10.0)
    pool.mark_cooldown(1, ("past-minute", "KRX"), 10.0)

    with pytest.raises(KisNoAccountAvailable):
        await pool.lease(cooldown_key=("past-minute", "KRX"))


@pytest.mark.asyncio
async def test_account_pool_reserves_final_usable_account_for_user_visible(
    tmp_path: Path, monkeypatch
) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis()}
    _patch_pool_clients(monkeypatch, kis_runtime, clients)
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path)
    first = await pool.lease(cooldown_key=("quotes", "quotes"), reserve_one=False)
    assert first.account_id == 0

    with pytest.raises(KisAccountReservationDeferred):
        await pool.lease(cooldown_key=("quotes", "quotes"), reserve_one=True)


@pytest.mark.asyncio
async def test_account_pool_does_not_reserve_when_only_one_account_is_healthy(
    tmp_path: Path, monkeypatch
) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis()}
    _patch_pool_clients(monkeypatch, kis_runtime, clients)
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: account_id == 1)
    pool = KisAccountPool(tmp_path)

    lease = await pool.lease(cooldown_key=("quotes", "quotes"), reserve_one=True)

    assert lease.account_id == 0


@pytest.mark.asyncio
async def test_account_pool_reservation_uses_non_cooling_accounts_for_key(
    tmp_path: Path, monkeypatch
) -> None:
    from hoga.live import account_health, kis_runtime

    clients = {0: _FakeKis(), 1: _FakeKis(), 2: _FakeKis()}
    now = 100.0
    _patch_pool_clients(monkeypatch, kis_runtime, clients)
    monkeypatch.setattr(account_health, "is_rest_degraded", lambda account_id: False)
    pool = KisAccountPool(tmp_path, now=lambda: now)
    pool.mark_cooldown(1, ("past-minute", "KRX"), 10.0)
    pool.mark_cooldown(2, ("past-minute", "KRX"), 10.0)

    with pytest.raises(KisAccountReservationDeferred):
        await pool.lease(cooldown_key=("past-minute", "KRX"), reserve_one=True)

    lease = await pool.lease(cooldown_key=("past-minute", "KRX"), reserve_one=False)
    assert lease.account_id == 0
