from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from scripts.probe_kiwoom_trading_readonly import (
    MOCK_HOST,
    READ_PATHS,
    REAL_HOST,
    ProbeError,
    ReadOnlyProbe,
    ReadOnlyTransport,
    cached_token,
    shape,
)


@pytest.mark.parametrize("host", [REAL_HOST, MOCK_HOST])
@pytest.mark.parametrize("api_id", ["kt10000", "kt10001", "kt10002", "kt10003", "kt10006", "au10001", "au10002"])
async def test_order_credit_and_auth_trs_never_reach_transport(host, api_id):
    sent = []

    async def handler(request):
        sent.append(request)
        return httpx.Response(200, json={"return_code": 0})

    transport = ReadOnlyTransport(host, httpx.MockTransport(handler))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(ProbeError, match="read-only-transport-blocked"):
            await client.post(f"https://{host}/api/dostk/ordr", headers={"api-id": api_id})
    assert sent == []
    assert transport.dispatched == 0


@pytest.mark.parametrize(
    "url,method",
    [
        (f"http://{REAL_HOST}/api/dostk/acnt", "POST"),
        (f"https://{MOCK_HOST}/api/dostk/acnt", "POST"),
        (f"https://{REAL_HOST}:444/api/dostk/acnt", "POST"),
        (f"https://{REAL_HOST}/api/dostk/ordr", "POST"),
        (f"https://{REAL_HOST}/oauth2/token", "POST"),
        (f"https://{REAL_HOST}/api/dostk/acnt?api-id=kt10000", "POST"),
        (f"https://user:pass@{REAL_HOST}/api/dostk/acnt", "POST"),
        (f"https://{REAL_HOST}/api/dostk/acnt", "GET"),
    ],
)
async def test_host_path_method_and_auth_issuance_are_closed(url, method):
    sent = []

    async def handler(request):
        sent.append(request)
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=ReadOnlyTransport(REAL_HOST, httpx.MockTransport(handler))) as client:
        with pytest.raises(ProbeError):
            await client.request(method, url, headers={"api-id": "ka00001"})
    assert not sent


@pytest.mark.parametrize("api_id,path", READ_PATHS.items())
async def test_allowlisted_read_preserves_binding_and_sends_once(api_id, path):
    sent = []

    async def handler(request):
        sent.append(request)
        assert request.url.host == REAL_HOST
        assert request.url.path == path
        assert request.headers["authorization"] == "Bearer existing-token"
        return httpx.Response(200, json={"return_code": 0, "rows": []})

    probe = ReadOnlyProbe("existing-token", pace=0, transport=httpx.MockTransport(handler))
    try:
        result, cursor = await probe.page(api_id, {})
        assert result["return_code"] == 0 and cursor is None
        assert len(sent) == 1
    finally:
        await probe.close()


@pytest.mark.parametrize("failure", ["timeout", "429", "vendor", "invalid", "redirect"])
async def test_read_failure_never_refreshes_replays_or_follows_redirect(failure):
    sent = []

    async def handler(request):
        sent.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("SECRET-response-must-not-leak")
        if failure == "429":
            return httpx.Response(429, json={"return_code": 5})
        if failure == "vendor":
            return httpx.Response(200, json={"return_code": 20, "return_msg": "[2000](571489:SECRET-account)"})
        if failure == "redirect":
            return httpx.Response(307, headers={"location": f"https://{REAL_HOST}/api/dostk/ordr"})
        return httpx.Response(200, text="SECRET-not-json")

    probe = ReadOnlyProbe("existing-token", pace=0, transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProbeError) as error:
            await probe.page("ka00001", {})
        assert len(sent) == 1
        assert "SECRET" not in str(error.value)
        assert "SECRET" not in json.dumps(probe.records)
        if failure == "vendor":
            assert probe.records[0]["return_code"] == 20
            assert probe.records[0]["vendor_reason_codes"] == ["2000", "571489"]
    finally:
        await probe.close()


async def test_pagination_keeps_account_binding_and_cursor():
    sent = []

    async def handler(request):
        sent.append(request)
        assert request.headers["authorization"] == "Bearer existing-token"
        if len(sent) == 1:
            assert request.headers["cont-yn"] == "N"
            return httpx.Response(
                200,
                json={"return_code": 0, "oso": [{"ord_no": "0000018"}]},
                headers={"cont-yn": "Y", "next-key": "opaque-cursor"},
            )
        assert request.headers["cont-yn"] == "Y"
        assert request.headers["next-key"] == "opaque-cursor"
        return httpx.Response(200, json={"return_code": 0, "oso": []})

    probe = ReadOnlyProbe("existing-token", pace=0, transport=httpx.MockTransport(handler))
    try:
        assert len(await probe.walk("ka10075", {})) == 2
        assert len(sent) == 2
    finally:
        await probe.close()


@pytest.mark.parametrize("cursor", ["", "same"])
async def test_incomplete_cursor_is_failure_not_a_complete_snapshot(cursor):
    async def handler(_):
        return httpx.Response(200, json={"return_code": 0, "oso": []}, headers={"cont-yn": "Y", "next-key": cursor})

    probe = ReadOnlyProbe("existing-token", pace=0, transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProbeError, match="read-(missing|repeated)-cursor"):
            await probe.walk("ka10075", {})
    finally:
        await probe.close()


def test_token_cache_is_key_bound_and_never_written(tmp_path):
    import hashlib

    path = tmp_path / "token.json"
    now = datetime(2026, 10, 18, tzinfo=UTC)
    path.write_text(
        json.dumps(
            {
                "access_token": "existing-token",
                "expires_at": (now + timedelta(hours=1)).isoformat(),
                "app_key_sha256": hashlib.sha256(b"key").hexdigest()[:16],
            }
        )
    )
    before = path.read_bytes()
    assert cached_token(path, "key", now=now) == "existing-token"
    with pytest.raises(ProbeError, match="token-key-mismatch"):
        cached_token(path, "other-key", now=now)
    with pytest.raises(ProbeError, match="token-expired-no-refresh"):
        cached_token(path, "key", now=now + timedelta(hours=2))
    assert path.read_bytes() == before


def test_report_contains_schema_and_counts_without_customer_values():
    result = shape(
        {
            "return_code": 0,
            "acctNo": "9876543210",
            "return_msg": "SECRET",
            "oso": [{"ord_no": "0000018", "acnt_no": "9876543210", "ord_pric": "999999"}],
        }
    )
    encoded = json.dumps(result)
    assert all(value not in encoded for value in ["9876543210", "0000018", "999999", "SECRET"])
    assert result["lists"]["oso"] == {"rows": 1, "row_fields": ["acnt_no", "ord_no", "ord_pric"]}
