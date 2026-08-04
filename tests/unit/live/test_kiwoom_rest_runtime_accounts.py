"""키움 REST 클라이언트의 **계정별** 싱글턴 (ADR-0138).

이전 판은 `_client` 전역 하나여서 `ensure_rest_client(data_dir, 1)` 이 계정 1 이
아니라 **계정 0 의 클라이언트를 돌려줬다** — 파라미터가 있는데 작동하지 않았다.
유량이 앱키별인 것이 실측되면서(1키 4.17 → 4키 18.4 콜/초) 이게 처리량을 4분의 1로
묶는 병목이 됐다.
"""
from __future__ import annotations

import pytest

from hoga.live import kiwoom_rest_runtime as R

_ENV = [
    "KIWOOM_APP_KEY", "KIWOOM_APP_SECRET",
    "KIWOOM_APP_KEY_2", "KIWOOM_APP_SECRET_2",
    "KIWOOM_APP_KEY_3", "KIWOOM_APP_SECRET_3",
    "KIWOOM_APP_KEY_4", "KIWOOM_APP_SECRET_4",
]


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    R.reset_for_tests()
    yield
    R.reset_for_tests()


def _set_accounts(monkeypatch, n: int) -> None:
    for i in range(n):
        key, secret = ("KIWOOM_APP_KEY", "KIWOOM_APP_SECRET") if i == 0 else (
            f"KIWOOM_APP_KEY_{i + 1}", f"KIWOOM_APP_SECRET_{i + 1}")
        monkeypatch.setenv(key, f"k{i}")
        monkeypatch.setenv(secret, f"s{i}")


def test_each_account_gets_its_own_client(monkeypatch, tmp_path):
    _set_accounts(monkeypatch, 3)

    c0 = R.ensure_rest_client(tmp_path, 0)
    c1 = R.ensure_rest_client(tmp_path, 1)
    c2 = R.ensure_rest_client(tmp_path, 2)

    assert c0 is not None and c1 is not None and c2 is not None
    assert len({id(c0), id(c1), id(c2)}) == 3, "계정마다 다른 클라이언트여야 한다"
    # 싱글턴 계약은 계정 단위로 유지된다.
    assert R.ensure_rest_client(tmp_path, 1) is c1


def test_client_pool_follows_configured_accounts(monkeypatch, tmp_path):
    _set_accounts(monkeypatch, 4)

    pool = R.ensure_rest_clients(tmp_path)

    assert len(pool) == 4
    assert len({id(c) for c in pool}) == 4
    # 순서가 account_id 순이어야 거버너의 계정 인덱스와 어긋나지 않는다.
    assert pool[1] is R.ensure_rest_client(tmp_path, 1)


def test_no_credentials_yields_empty_pool(tmp_path):
    """ADR-0134 dev 무자격 프로필 — 빈 풀이 정상 경로다(예외 아님)."""
    assert R.ensure_rest_clients(tmp_path) == []
    assert R.ensure_rest_client(tmp_path, 0) is None


def test_scheduler_receives_the_pool(monkeypatch, tmp_path):
    _set_accounts(monkeypatch, 4)

    scheduler = R.ensure_scheduler(tmp_path)

    assert scheduler.snapshot()["accounts"] == 4


def test_scheduler_without_data_dir_keeps_existing_pool(monkeypatch, tmp_path):
    """`data_dir` 생략은 '풀을 건드리지 말라' 는 뜻이다 — 호출처 일부가 아직
    data_dir 을 넘기지 않아도 이미 등록된 풀이 유지돼야 한다."""
    _set_accounts(monkeypatch, 2)
    R.ensure_scheduler(tmp_path)

    assert R.ensure_scheduler().snapshot()["accounts"] == 2


def test_single_account_reports_one(monkeypatch, tmp_path):
    _set_accounts(monkeypatch, 1)

    assert R.ensure_scheduler(tmp_path).snapshot()["accounts"] == 1
