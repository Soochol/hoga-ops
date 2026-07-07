"""부품1 — account_id별 KIS client/provider dict (ADR-0067 / spec §4).

account 라우팅 자체는 KisAccountPool로 옮겨졌다(ADR-0082) — degraded 제외/least-loaded
lease/예약은 test_kis_account_pool.py, rate-limit failover는 test_kis_capacity_scheduler.py
가 커버한다. 이 파일은 리소스 소유(dict 싱글톤·env creds·토큰 provider 배선)와 FM5
REST-auth latch 메커니즘(account_health)만 검증한다.
"""
from pathlib import Path

import pytest

import hoga.live.account_health as account_health
import hoga.live.kis_access as kis_access
import hoga.live.kis_runtime as kis_runtime


@pytest.fixture(autouse=True)
def _reset():
    kis_runtime.reset_for_tests()
    yield
    kis_runtime.reset_for_tests()


def test_account_env_suffix_convention():
    assert kis_runtime._account_env(0) == ("KIS_APP_KEY", "KIS_APP_SECRET")
    assert kis_runtime._account_env(1) == ("KIS_APP_KEY_2", "KIS_APP_SECRET_2")
    assert kis_runtime._account_env(2) == ("KIS_APP_KEY_3", "KIS_APP_SECRET_3")


def test_token_cache_path_backcompat(tmp_path: Path):
    # account 0 keeps legacy filename; account k>0 gets a per-account file.
    assert kis_runtime._token_cache_path(tmp_path, 0) == tmp_path / ".local" / "kis-token.json"
    assert kis_runtime._token_cache_path(tmp_path, 1) == tmp_path / ".local" / "kis-token-1.json"


def test_configured_account_ids_single(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.configured_account_ids(tmp_path) == [0]


def test_configured_account_ids_two(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    assert kis_runtime.configured_account_ids(tmp_path) == [0, 1]


def test_configured_account_ids_stops_at_gap(tmp_path, monkeypatch):
    # account 0 only; account 1 missing → list stops (no [0, 2] skip).
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.setenv("KIS_APP_KEY_3", "k2")
    monkeypatch.setenv("KIS_APP_SECRET_3", "s2")
    assert kis_runtime.configured_account_ids(tmp_path) == [0]


def test_for_account_distinct_clients_per_account(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert c0 is not None and c1 is not None and c0 is not c1
    assert c0._creds.app_key == "k0"
    assert c1._creds.app_key == "k1"
    # idempotent per account (one bucket each)
    assert kis_runtime.ensure_kis_client_for_account(0, tmp_path) is c0


def test_for_account_clients_share_global_rate_limiter(tmp_path, monkeypatch):
    """같은 명의의 계좌들은 KIS 유량제한을 명의 단위로 공유한다 — 런타임이 만드는
    모든 KisClient는 하나의 전역 버킷을 써야 합산 송신이 한도(~20/s) 아래로 묶인다
    (/investigate 2026-07-07: 3계좌 × 15/s = 45/s → ~47% EGW00201)."""
    monkeypatch.setattr(kis_runtime, "_global_rate_limiter", None)  # 전역 버킷 격리
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert c0 is not None and c1 is not None and c0 is not c1
    assert c0._rate_limiter is c1._rate_limiter, "계좌별 독립 버킷이면 명의 한도 초과"


def test_for_account_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.ensure_kis_client_for_account(1, tmp_path) is None


# ── FM5: REST 토큰 실패 latch (account_health 메커니즘) ───────────────────────────
# latch → 계좌 degraded 표시. 그 degraded 계좌를 라우팅에서 제외하는 동작은
# KisAccountPool.eligible_accounts(test_kis_account_pool.py)가 커버한다.


def test_is_degraded_swallows_probe_errors(monkeypatch):
    """WS probe 조회 실패 시 보수적으로 False(라우팅을 막지 않는다)."""
    def boom():
        raise RuntimeError("probe not ready")
    monkeypatch.setattr("hoga.live.account_health._ws_probe", boom)
    assert account_health.is_degraded(1) is False


def test_rest_auth_latch_warns_once_on_transition(tmp_path, monkeypatch, caplog):
    """FM5: account 1 REST 토큰 발급 실패 latch는 degraded로 전환하고, 운영자가 grep할
    1회성 WARNING을 남긴다(silent capacity degradation 방지). 멱등 — 로그는 1회만."""
    import logging
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    assert account_health.is_degraded(1) is False
    with caplog.at_level(logging.WARNING, logger="hoga.live.account_health"):
        account_health.mark_rest_auth_degraded(1)  # 토큰 provider 콜백이 호출하는 것
        account_health.mark_rest_auth_degraded(1)  # 멱등 — 로그는 1회만
    auth_warnings = [r for r in caplog.records if "REST-degraded" in r.message]
    assert len(auth_warnings) == 1, "latch 전환 로그가 1회(once-only)가 아님"
    assert account_health.is_degraded(1) is True
    assert account_health.is_rest_degraded(1) is True


def test_mark_rest_auth_degraded_noops_for_account0(monkeypatch):
    """account 0은 폴백 대상 자체 → 마킹해도 degraded 아님(자기 자신으로 폴백 불가)."""
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    account_health.mark_rest_auth_degraded(0)
    assert account_health.is_degraded(0) is False


def test_rest_auth_latch_cleared_by_reset_for_tests(tmp_path, monkeypatch):
    """latch는 reset_for_tests로 초기화(테스트 격리)."""
    account_health.mark_rest_auth_degraded(1)
    assert account_health.is_degraded(1) is True
    kis_runtime.reset_for_tests()
    assert account_health.is_degraded(1) is False


def test_ensure_token_provider_wires_account_bound_auth_callback(tmp_path):
    """end-to-end 배선: ensure_kis_token_provider가 account_id에 바인딩된 on_issue_failure를
    주입한다 — 호출 시 그 account를 REST-degraded latch(토큰 chokepoint→kis_runtime)."""
    from hoga.live.kis_client import KisCredentials
    creds = KisCredentials(app_key="k1", app_secret="s1", env="real")
    prov = kis_runtime.ensure_kis_token_provider(tmp_path / "t1.json", creds, 1)
    assert prov._on_issue_failure is not None
    assert account_health.is_degraded(1) is False
    prov._on_issue_failure()  # 토큰 발급 실패 시 provider가 호출하는 콜백
    assert account_health.is_degraded(1) is True


# ── kis_access seam: has_rest_capacity + run_with_capacity ───────────────────────


def test_has_rest_capacity_accepts_injected_account0_client(tmp_path, monkeypatch):
    for name in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(name, raising=False)
    sentinel = object()
    kis_runtime.set_kis_client(sentinel)

    assert kis_access.has_rest_capacity(tmp_path) is True


async def test_run_with_capacity_invokes_scheduler_with_background_priority(tmp_path):
    seen = {}
    fake_client = object()

    class _Scheduler:
        async def submit(
            self,
            *,
            key,
            endpoint,
            priority,
            call,
            cooldown_scope=None,
        ):
            seen["key"] = key
            seen["endpoint"] = endpoint
            seen["priority"] = priority
            seen["cooldown_scope"] = cooldown_scope
            return await call(fake_client)

    async def fetch_fn(client):
        seen["client"] = client
        return "ok"

    result = await kis_access.run_with_capacity(
        _Scheduler(),
        data_dir=tmp_path,
        key=("screener", "005930"),
        endpoint=kis_access.KisRestEndpoint.SCREENER_DAILY,
        priority="background",
        cooldown_scope="daily",
        fetch_fn=fetch_fn,
    )

    assert result == "ok"
    assert seen == {
        "key": ("screener", "005930"),
        "endpoint": "screener-daily",
        "priority": "background",
        "cooldown_scope": "daily",
        "client": fake_client,
    }


async def test_run_with_capacity_rejects_raw_endpoint_string(tmp_path):
    # _endpoint_value raises before scheduler.submit, so the scheduler is never touched.
    class _Scheduler:
        async def submit(self, **kwargs):
            raise AssertionError("scheduler must not be reached for a raw endpoint string")

    async def fetch_fn(client):
        return "unreachable"

    with pytest.raises(TypeError, match="KisRestEndpoint"):
        await kis_access.run_with_capacity(
            _Scheduler(),
            data_dir=tmp_path,
            key=("legacy", "005930"),
            endpoint="screener-daily",  # type: ignore[arg-type]
            priority="background",
            fetch_fn=fetch_fn,
        )
