"""부품1 — account_id별 KIS client/provider dict (ADR-0067 / spec §4)."""
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


def test_for_account_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.ensure_kis_client_for_account(1, tmp_path) is None


# ── kis_for_role: 계정 분리 라우팅 (2026-06-09 account-split) ────────────────────


def _set_one_account(monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)


def _set_two_accounts(monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")


def test_kis_for_role_n1_all_account0(tmp_path, monkeypatch):
    """N=1(키 1개): foreground·background 모두 account 0(공유 버킷, ②가 우선순위 보호)."""
    _set_one_account(monkeypatch)
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    assert kis_access.kis_for_role("foreground", tmp_path) is c0
    assert kis_access.kis_for_role("background", tmp_path) is c0


def test_kis_for_role_n2_split(tmp_path, monkeypatch):
    """N=2: foreground→account 0(전용), background→account 1(유휴 버킷 활용)."""
    _set_two_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert c0 is not c1
    assert kis_access.kis_for_role("foreground", tmp_path) is c0
    assert kis_access.kis_for_role("background", tmp_path) is c1


def test_kis_for_role_n2_background_degraded_falls_back(tmp_path, monkeypatch):
    """N=2이지만 account 1 REST 토큰 저하 → background가 account 0로 폴백(②우선순위로 보호).

    REST 라우팅은 REST 토큰 latch(is_rest_degraded)만 본다(WS sub_failed는 직교 — 폴백 무관,
    2026-06-10). 그래서 degraded를 mark_rest_auth_degraded(1)로 위조한다."""
    _set_two_accounts(monkeypatch)
    account_health.mark_rest_auth_degraded(1)
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    assert kis_access.kis_for_role("background", tmp_path) is c0


def _set_three_accounts(monkeypatch):
    _set_two_accounts(monkeypatch)
    monkeypatch.setenv("KIS_APP_KEY_3", "k2")
    monkeypatch.setenv("KIS_APP_SECRET_3", "s2")


def test_kis_for_role_n3_background_round_robins(tmp_path, monkeypatch):
    """N≥3: background가 account 1·2를 라운드로빈(유휴 REST 버킷 분산 — 인덱스고정 탈피,
    2026-06-10 N계좌 확장). foreground는 여전히 account 0."""
    _set_three_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    monkeypatch.setattr(kis_access, "_bg_round_robin", 0)   # 결정적 회전
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    c2 = kis_runtime.ensure_kis_client_for_account(2, tmp_path)
    picks = [kis_access.kis_for_role("background", tmp_path) for _ in range(4)]
    assert picks == [c1, c2, c1, c2]                        # 1↔2 회전
    assert kis_access.kis_for_role("foreground", tmp_path) is c0


def test_kis_for_role_background_ignores_ws_degraded(tmp_path, monkeypatch):
    """핵심 직교성(2026-06-10): account 1의 WS가 저하(sub_failed)여도 background는 여전히
    account 1을 쓴다 — REST 라우팅은 REST 토큰 저하(is_rest_degraded)만 본다. (옛 is_degraded
    면 WS저하만으로 account 0 폴백돼 캡처 문제 1회가 REST 용량까지 깎였음.)"""
    _set_two_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: {1})  # account 1 WS 저하
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert kis_access.kis_for_role("background", tmp_path) is c1            # 폴백 안 함


def test_kis_for_role_n3_round_robin_skips_rest_degraded(tmp_path, monkeypatch):
    """N=3에서 account 1 REST 토큰 저하면 background 후보는 [2]만 → account 2로 회전(저하 스킵)."""
    _set_three_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    monkeypatch.setattr(kis_access, "_bg_round_robin", 0)
    account_health.mark_rest_auth_degraded(1)
    c2 = kis_runtime.ensure_kis_client_for_account(2, tmp_path)
    picks = [kis_access.kis_for_role("background", tmp_path) for _ in range(3)]
    assert picks == [c2, c2, c2]


def test_kis_for_role_foreground_never_uses_account1(tmp_path, monkeypatch):
    """foreground는 account 1이 healthy여도 항상 account 0(전용 15/s 보장)."""
    _set_two_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    assert kis_access.kis_for_role("foreground", tmp_path) is c0


def test_is_degraded_swallows_probe_errors(monkeypatch):
    """WS probe 조회 실패 시 보수적으로 False(라우팅을 막지 않는다)."""
    def boom():
        raise RuntimeError("probe not ready")
    monkeypatch.setattr("hoga.live.account_health._ws_probe", boom)
    assert account_health.is_degraded(1) is False


def test_kis_for_role_account0_prefers_injected_singleton_over_env(tmp_path, monkeypatch):
    """account 0 폴백은 env 없이도 주입/부팅된 dict 싱글톤을 우선 반환한다 — api 라우트가
    get_kis_client=set_kis_client(fake)로 주입하는 패턴을 지탱(env-ensure는 그 다음)."""
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    sentinel = object()
    kis_runtime.set_kis_client(sentinel, 0)  # type: ignore[arg-type]
    # env 부재 → ensure_kis_client_for_account(0)는 None이지만 dict 우선이라 sentinel 반환.
    assert kis_access.kis_for_role("foreground", tmp_path) is sentinel
    assert kis_access.kis_for_role("background", tmp_path) is sentinel


def test_kis_for_role_account0_lazy_ensures_when_dict_empty(tmp_path, monkeypatch):
    """dict 미생성(빈 관심목록) + N=1 → env에서 지연 생성(ensure_kis_client_from_env 경유,
    /quotes lazy-init 승계)."""
    _set_one_account(monkeypatch)
    created = object()
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda data_dir: created)
    assert kis_runtime.get_kis_client(0) is None  # dict 비어있음
    assert kis_access.kis_for_role("background", tmp_path) is created


# ── FM5: REST 토큰 실패 latch → background account 0 폴백 (2026-06-09) ────────────


def test_background_routes_to_account0_after_rest_auth_latch(tmp_path, monkeypatch, caplog):
    """FM5: account 1 REST 토큰 발급 실패가 latch되면 background가 account 0로 폴백한다
    (이후 영구 — 재시작 전까지). foreground는 영향 없음(원래 account 0). latch 전환 시
    운영자가 grep할 1회성 WARNING을 남긴다(silent capacity degradation 방지)."""
    import logging
    _set_two_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert kis_access.kis_for_role("background", tmp_path) is c1  # 평상시 account 1
    with caplog.at_level(logging.WARNING, logger="hoga.live.account_health"):
        account_health.mark_rest_auth_degraded(1)  # 토큰 provider 콜백이 호출하는 것
        account_health.mark_rest_auth_degraded(1)  # 멱등 — 로그는 1회만
    auth_warnings = [r for r in caplog.records if "REST-degraded" in r.message]
    assert len(auth_warnings) == 1, "latch 전환 로그가 1회(once-only)가 아님"
    assert account_health.is_degraded(1) is True
    assert kis_access.kis_for_role("background", tmp_path) is c0  # latch 후 account 0
    assert kis_access.kis_for_role("foreground", tmp_path) is c0  # foreground 불변


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


# ── fetch_background_with_auth_fallback: 스크리너 배치 FM5 폴백 헬퍼 ───────────────


async def test_fetch_background_fallback_retries_on_account0(tmp_path, monkeypatch):
    """N=2: account 1 fetch가 KisAuthError면 account 0로 재해결해 재시도(latch가 켜진 뒤
    재해결이 account 0 반환). 스크리너 배치가 acct1 토큰 실패에도 끝까지 진행하는 경로."""
    from hoga.live.kis_client import KisAuthError
    _set_two_accounts(monkeypatch)
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    seen = []

    async def fetch_fn(client):
        seen.append(client)
        if client is c1:
            account_health.mark_rest_auth_degraded(1)  # provider 콜백이 하는 일(시뮬레이션)
            raise KisAuthError("acct1 token fail")
        return "ok"

    result = await kis_access.fetch_for_role("background", tmp_path, fetch_fn)
    assert result == "ok"
    assert seen == [c1, c0]  # account 1 시도 → 폴백 → account 0 성공


async def test_fetch_background_fallback_reraises_when_account0_also_fails(tmp_path, monkeypatch):
    """N=1(또는 account 0 자체 실패): 재해결이 동일 client → 무한재시도 없이 전파."""
    from hoga.live.kis_client import KisAuthError
    _set_one_account(monkeypatch)
    kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    calls = {"n": 0}

    async def fetch_fn(client):
        calls["n"] += 1
        raise KisAuthError("acct0 fail")

    with pytest.raises(KisAuthError):
        await kis_access.fetch_for_role("background", tmp_path, fetch_fn)
    assert calls["n"] == 1  # 동일 client 재시도 안 함


async def test_fetch_background_fallback_raises_when_no_client(tmp_path, monkeypatch):
    """creds 전무 → background client None → KisAuthError로 표면화(침묵 사망 금지)."""
    from hoga.live.kis_client import KisAuthError
    for _k in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(_k, raising=False)

    async def fetch_fn(client):  # 도달하면 안 됨
        raise AssertionError("fetch_fn should not be called when no client")

    with pytest.raises(KisAuthError):
        await kis_access.fetch_for_role("background", tmp_path, fetch_fn)


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
        role="background",
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


async def test_run_with_capacity_none_keeps_legacy_role_fallback(tmp_path, monkeypatch):
    _set_one_account(monkeypatch)
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    seen = []

    async def fetch_fn(client):
        seen.append(client)
        return "ok"

    result = await kis_access.run_with_capacity(
        None,
        data_dir=tmp_path,
        role="background",
        key=("legacy", "005930"),
        endpoint=kis_access.KisRestEndpoint.SCREENER_DAILY,
        priority="background",
        fetch_fn=fetch_fn,
    )

    assert result == "ok"
    assert seen == [c0]


async def test_run_with_capacity_rejects_raw_endpoint_string(tmp_path):
    async def fetch_fn(client):
        return "unreachable"

    with pytest.raises(TypeError, match="KisRestEndpoint"):
        await kis_access.run_with_capacity(
            None,
            data_dir=tmp_path,
            role="background",
            key=("legacy", "005930"),
            endpoint="screener-daily",  # type: ignore[arg-type]
            priority="background",
            fetch_fn=fetch_fn,
        )
