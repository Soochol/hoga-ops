from hoga.live.service_status import DEFAULT_NOTICE, provider_status


def session(now, connected=True):
    return {"enabled": True, "accounts_configured": 1, "connected_accounts": int(connected),
            "last_recv_ms": now if connected else None,
            "accounts": [{"connected": connected, "last_recv_ms": now if connected else None,
                          "registration_ready": connected,
                          "last_error_type": None if connected else "ConnectionError"}]}


def test_login_success_is_partial_until_registration_ready(tmp_path):
    now = DEFAULT_NOTICE.ends_at_ms + 1
    pending = session(now)
    pending["accounts"][0]["registration_ready"] = False
    result = provider_status(tmp_path, pending, now)
    assert result.connection == "partial"
    assert result.connected_accounts == 1
    assert result.ready_accounts == 0
    assert result.notice_phase == "overdue"


def test_missing_readiness_is_unknown_not_recovered(tmp_path):
    now = DEFAULT_NOTICE.ends_at_ms + 1
    pending = session(now)
    del pending["accounts"][0]["registration_ready"]
    result = provider_status(tmp_path, pending, now)
    assert result.connection == "partial"
    assert result.ready_accounts == 0


def test_weekend_outage_is_not_market_closed(tmp_path):
    now = DEFAULT_NOTICE.starts_at_ms
    result = provider_status(tmp_path, session(now, False), now)
    assert result.connection == "unavailable"
    assert result.notice_phase == "active"


def test_notice_boundaries_and_recovery_survive_disconnect(tmp_path):
    start, end = DEFAULT_NOTICE.starts_at_ms, DEFAULT_NOTICE.ends_at_ms
    assert provider_status(tmp_path, session(start, False), start - 1).notice_phase == "scheduled"
    assert provider_status(tmp_path, session(start, False), end).notice_phase == "overdue"
    assert provider_status(tmp_path, session(end - 1), end).notice_phase == "overdue"
    assert provider_status(tmp_path, session(end), end).notice is None
    # A later outage is an outage, not this old maintenance announcement.
    result = provider_status(tmp_path, session(end, False), end + 1000)
    assert result.connection == "unavailable"
    assert result.notice is None


def test_stale_response_and_partial_connection_cannot_recover(tmp_path):
    now = DEFAULT_NOTICE.ends_at_ms + 200_000
    result = provider_status(tmp_path, session(now - 150_000), now)
    assert result.connection == "partial"
    assert result.notice_phase == "overdue"


def test_unconfigured_and_invalid_config(tmp_path):
    assert provider_status(tmp_path, None, DEFAULT_NOTICE.starts_at_ms).notice is None
    (tmp_path / "kiwoom-maintenance.json").write_text('{"invalid": true}')
    result = provider_status(tmp_path, session(DEFAULT_NOTICE.starts_at_ms), DEFAULT_NOTICE.starts_at_ms)
    assert result.notice_config_error
    assert result.notice is None
