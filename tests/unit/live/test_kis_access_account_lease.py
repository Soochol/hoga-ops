from __future__ import annotations

from pathlib import Path

from hoga.live import account_health, kis_access


class _Client:
    def __init__(self, account_id: int):
        self.account_id = account_id


def test_foreground_lease_uses_account0(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_from_env",
        lambda data_dir: _Client(0),
    )

    lease = kis_access.acquire_account_for_role("foreground", tmp_path)

    assert lease is not None
    assert lease.account_id == 0
    assert lease.role == "foreground"
    assert lease.client.account_id == 0


def test_background_lease_uses_nonzero_accounts_round_robin(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(kis_access, "_bg_round_robin", 0)
    monkeypatch.setattr(
        "hoga.live.kis_runtime.configured_account_ids",
        lambda data_dir: [0, 1, 2],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda account_id, data_dir: _Client(account_id),
    )
    account_health.reset_for_tests()

    first = kis_access.acquire_account_for_role("background", tmp_path)
    second = kis_access.acquire_account_for_role("background", tmp_path)

    assert first is not None and first.account_id == 1
    assert second is not None and second.account_id == 2


def test_background_lease_can_disallow_account0_fallback(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.configured_account_ids",
        lambda data_dir: [0],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_from_env",
        lambda data_dir: _Client(0),
    )

    lease = kis_access.acquire_account_for_role(
        "background", tmp_path, allow_account0_fallback=False,
    )

    assert lease is None


def test_background_lease_can_allow_account0_fallback(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "hoga.live.kis_runtime.configured_account_ids",
        lambda data_dir: [0],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_from_env",
        lambda data_dir: _Client(0),
    )

    lease = kis_access.acquire_account_for_role(
        "background", tmp_path, allow_account0_fallback=True,
    )

    assert lease is not None
    assert lease.account_id == 0
    assert lease.role == "background"
