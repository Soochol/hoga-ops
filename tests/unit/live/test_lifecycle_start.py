"""start_live_stream / stop_live_stream / capture-candidate integration.

ADR-0118 PR-G: KIS WS 계층 삭제 후 실시간 캡처는 키움 전담. start의 가드 의미론
(creds/빈 watchlist/symbol 필터/cold cache/stop 멱등)은 유지된다. 심볼-마스터 필터는
`coverage._compute_capture_candidates`가 소유한다(구 `_compute_live_set` 승계).
"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


def _write_watchlist(tmp_path: Path, codes: list[str]) -> None:
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": c, "name": c,
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for c in codes
        ],
    }))


@pytest.mark.asyncio
async def test_start_live_stream_returns_falsy_when_creds_missing(
    tmp_path: Path, monkeypatch,
) -> None:
    """Without KIS_APP_KEY/SECRET, start stays off (creds 가드 승계)."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    _write_watchlist(tmp_path, ["005930"])
    assert not await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_stop_live_stream_is_idempotent(tmp_path: Path) -> None:
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    await lifecycle.stop_live_stream()
    await lifecycle.stop_live_stream()   # 두 번째 호출도 무해
    assert lifecycle.get_status().running is False


def test_compute_capture_candidates_filters_unknown_codes(
    tmp_path: Path, monkeypatch, caplog,
) -> None:
    """symbol-master에 없는 코드는 drop + 경고 로그 — 심볼 필터 정책(구 _compute_live_set)."""
    import logging

    from hoga.api import symbols
    from hoga.live.coverage import _compute_capture_candidates

    _write_watchlist(tmp_path, ["005930", "999999"])
    monkeypatch.setattr(
        symbols, "search",
        lambda q, limit=10_000: [SimpleNamespace(code="005930")],
    )
    with caplog.at_level(logging.WARNING):
        assert _compute_capture_candidates(tmp_path) == ["005930"]
    assert any("codes_unknown" in r.message for r in caplog.records)  # I2 pin


def test_compute_capture_candidates_cold_cache_keeps_all(
    tmp_path: Path, monkeypatch, caplog,
) -> None:
    """symbol-master cold cache(빈 결과)면 무필터 폴백 — 캡처 중단보다 노이즈 선호.

    다만 **생략 사실은 반드시 로그로 남는다**: fail-open 은 저장셋 크기를 캐시 상태에
    종속시키고 그 크기가 키움 WS 슬롯 예산의 입력이라, 조용하면 같은 설정이 실행마다
    다른 수집 대상을 만든 걸 사후에 알 수 없다.
    """
    import logging

    from hoga.api import symbols
    from hoga.live.coverage import _compute_capture_candidates

    _write_watchlist(tmp_path, ["005930", "999999"])
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    with caplog.at_level(logging.WARNING):
        assert _compute_capture_candidates(tmp_path) == ["005930", "999999"]
    assert any("symbol_master_cold" in r.message for r in caplog.records)


def test_compute_heatmap_codes_cold_cache_keeps_all_and_warns(
    tmp_path: Path, monkeypatch, caplog,
) -> None:
    """히트맵 표면도 같은 fail-open + 관측 계약을 따른다(watchlist 표면과 대칭)."""
    import logging

    from hoga.api import symbols
    from hoga.live.coverage import _compute_heatmap_codes

    (tmp_path / "heatmap.json").write_text(json.dumps({
        "schema_version": 1,
        "folders": [{"id": "f1", "name": "F1"}],
        "entries": [
            {"code": "005930", "name": "005930", "folder_id": "f1"},
            {"code": "999999", "name": "999999", "folder_id": "f1"},
        ],
    }))
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    with caplog.at_level(logging.WARNING):
        assert _compute_heatmap_codes(tmp_path) == ("005930", "999999")
    assert any("symbol_master_cold" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_lifespan_starts_and_stops_stream_gracefully(tmp_path: Path, monkeypatch) -> None:
    """The FastAPI lifespan integrates start_live_stream + stop_live_stream gracefully.

    ADR-0118 PR-G: 실시간 캡처=키움 전담. 키움 off(이 테스트)면 running=False가 정직한
    신호다 — 그래도 lifespan은 예외 없이 기동·정지하고 /api/live/status가 200을 반환해야
    한다. WS 게이트(should_run_now=False)는 REST 사이드카를 네트워크 없이 idle로 유지한다.
    """
    import json

    from fastapi.testclient import TestClient

    from hoga.api.app import create_app
    from hoga.live import lifecycle, session_gate

    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    lifecycle.reset_for_tests()
    monkeypatch.setenv("HOGA_LIVE_STARTUP_ENABLED", "true")
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자",
             "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }))

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        # 키움 off → 실시간 캡처 없음 → running=False(정직 신호).
        assert r.json()["running"] is False

    # After TestClient exits, lifespan finally ran — stream should be stopped
    assert lifecycle.get_status().running is False
