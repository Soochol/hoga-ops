"""KIS chk-holiday sync fetch (Phase 3). Real-response fixture."""
import json
from pathlib import Path

import httpx
import pytest

from hoga.api.kis_holidays import (
    KisHolidayFetchError,
    _collect_month_from_pages,
    fetch_month_trading_days,
)

FIX = Path(__file__).parent / "fixtures" / "chk_holiday_20260601.json"


def _pages_from_fixture():
    body = json.loads(FIX.read_text())
    return [body["output"]]  # one page of 24 rows


def test_collect_filters_opnd_yn_and_month() -> None:
    days = _collect_month_from_pages(_pages_from_fixture(), 2026, 6)
    assert "20260601" in days          # opnd_yn=Y
    assert "20260603" not in days      # 선거일 — opnd_yn=N (real data)
    assert "20260607" not in days      # Sunday
    assert all(d.startswith("202606") for d in days)


def test_fetch_month_advances_bass_dt(monkeypatch: pytest.MonkeyPatch) -> None:
    """First page covers only 6/1-6/24 → loop must call again from 6/25."""
    body = json.loads(FIX.read_text())
    page2 = [
        {"bass_dt": d, "wday_dvsn_cd": "03", "bzdy_yn": "Y",
         "tr_day_yn": "Y", "opnd_yn": "Y", "sttl_day_yn": "Y"}
        for d in ("20260625", "20260626", "20260629", "20260630", "20260701")
    ]
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bass = req.url.params["BASS_DT"]
        calls.append(bass)
        out = body["output"] if bass == "20260601" else page2
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output": out})

    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(kh, "_transport_for_tests", httpx.MockTransport(handler))

    days = fetch_month_trading_days(2026, 6)
    assert calls == ["20260601", "20260625"]   # BASS_DT advanced past last row
    assert "20260630" in days and "20260701" not in days


def test_fetch_raises_without_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: None)
    with pytest.raises(KisHolidayFetchError):
        fetch_month_trading_days(2026, 6)


def test_fetch_raises_on_rt_cd_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(
        kh, "_transport_for_tests",
        httpx.MockTransport(lambda req: httpx.Response(
            200, json={"rt_cd": "1", "msg_cd": "E", "msg1": "bad", "output": []})),
    )
    with pytest.raises(KisHolidayFetchError):
        fetch_month_trading_days(2026, 6)


def test_creds_missing_raises_distinct_subclass(monkeypatch: pytest.MonkeyPatch) -> None:
    """KisCredentialsMissing (≠ generic fetch failure) lets calendar map it to
    KIS_CREDENTIALS_MISSING so the UI gives 'set keys' instead of 'retry'."""
    from hoga.api.kis_holidays import KisCredentialsMissing

    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: None)
    with pytest.raises(KisCredentialsMissing):
        fetch_month_trading_days(2026, 6)
    assert issubclass(KisCredentialsMissing, KisHolidayFetchError)  # contract intact


def test_transient_500_retried_once_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    """A single transient 500 must NOT abort the month — live probes saw ~1/6
    calls 500; zero retries amplified one blip into a whole-month failure and
    a misleading 'configure credentials' 503."""
    body = json.loads(FIX.read_text())
    page2 = [
        {"bass_dt": d, "opnd_yn": "Y"} for d in ("20260625", "20260626", "20260630")
    ]
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, text="Internal Server Error")
        out = body["output"] if req.url.params["BASS_DT"] == "20260601" else page2
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output": out})

    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(kh, "_transport_for_tests", httpx.MockTransport(handler))

    days = fetch_month_trading_days(2026, 6)
    assert "20260601" in days and "20260630" in days
    assert calls["n"] == 3  # 500 + retry-ok + page2


def test_persistent_500_raises_after_one_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, text="boom")

    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(kh, "_transport_for_tests", httpx.MockTransport(handler))
    with pytest.raises(KisHolidayFetchError):
        fetch_month_trading_days(2026, 6)
    assert calls["n"] == 2  # original + exactly one retry


def test_token_failure_normalized_into_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """provider.get_token() raising (KisAuthError cooldown etc.) must surface
    as KisHolidayFetchError per the documented contract, not escape untyped."""
    import hoga.api.kis_holidays as kh

    def _boom():
        raise RuntimeError("token reissue cooldown")

    monkeypatch.setattr(kh, "_resolve_provider", _boom)
    with pytest.raises(KisHolidayFetchError, match="KIS token unavailable"):
        fetch_month_trading_days(2026, 6)


def test_malformed_bass_dt_raises_typed_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rows lacking bass_dt: max() yields '' → must raise KisHolidayFetchError,
    not an untyped ValueError from int('')."""
    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(
        kh, "_transport_for_tests",
        httpx.MockTransport(lambda req: httpx.Response(
            200, json={"rt_cd": "0", "msg_cd": "", "msg1": "",
                       "output": [{"opnd_yn": "Y"}]})),
    )
    with pytest.raises(KisHolidayFetchError, match="malformed bass_dt"):
        fetch_month_trading_days(2026, 6)


def test_month_covered_but_empty_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """Coverage-without-content: rows reach month_end but none are opnd_yn=Y
    inside the month → raising prevents calendar from permanently caching an
    empty month as success (every weekday rendered 'holiday', no banner, and
    is_trading_day False gating the live poller off — ADR-0064 class)."""
    import hoga.api.kis_holidays as kh
    rows = [{"bass_dt": "20260701", "opnd_yn": "Y"}]  # past 2026-06 month_end, wrong month
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(
        kh, "_transport_for_tests",
        httpx.MockTransport(lambda req: httpx.Response(
            200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output": rows})),
    )
    with pytest.raises(KisHolidayFetchError, match="0 trading days"):
        fetch_month_trading_days(2026, 6)
