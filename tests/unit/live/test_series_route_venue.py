"""`/api/live/series` 의 **당일 최대벽**이 선택 venue 를 탄다 (ADR-0140 §2).

⚠ 라우트가 `get_today_ask_peak(code, "KRX")` 로 venue 를 **리터럴로 못박고** 있었다.
그 자리엔 *"읽기 API 표면에 venue 를 싣는 것은 PR-J 의 몫"* 이라는 주석까지 있었는데
PR-J 가 이 라우트를 안 건드렸다 — 표식이 남았지만 아무도 따라가지 않은 자리다.

결과: NXT·통합을 골라도 **KRX 최대벽**이 떴다. 최대벽은 스트림이 `(code, venue)` 로
키잉해 들고 있으므로 값 자체는 venue 별로 존재했다 — 읽는 쪽만 안 물어봤다.
"""
import pytest
from fastapi.testclient import TestClient

from hoga.live.api import build_router
from hoga.live.lifecycle import LiveStatus


@pytest.fixture
def client():
    """venue 별로 다른 최대벽을 돌려주는 가짜 조회기."""
    from fastapi import FastAPI

    seen: list[tuple[str, str]] = []

    def ask_peak(code: str, venue: str):
        seen.append((code, venue))
        return {"date": "20260806", "venue_echo": venue}

    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lambda: LiveStatus(
                running=True, started_at_ms=None, last_tick_ms=None,
                cycle_lag_ms=0, watchlist_count=0,
            ),
            get_buffer=lambda: _EmptyBuffer(),
            get_today_ask_peak=ask_peak,
            get_today_bid_peak=lambda c, v: {"venue_echo": v},
        ),
    )  # build_router 가 이미 prefix="/api/live" 를 갖는다
    with TestClient(app) as c:
        c.seen = seen  # type: ignore[attr-defined]
        yield c


class _EmptyBuffer:
    async def get_series(self, code: str) -> dict:
        return {"code": code, "snapshots": [], "trades": [], "brokers": [], "programs": []}


@pytest.mark.parametrize("venue", ["KRX", "NXT", "UN"])
def test_peak_walls_follow_the_requested_venue(client, venue):
    r = client.get("/api/live/series", params={"code": "005930", "date": "20260806", "venue": venue})

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ask_peak_today"]["venue_echo"] == venue
    assert body["bid_peak_today"]["venue_echo"] == venue


def test_venue_defaults_to_krx_for_old_clients(client):
    """⚠ 이 라우트만 기본값을 둔다 — 표시 버퍼 hydrate 용이라 필수화하면 구 프론트가
    통째로 빈 화면이 된다. 다른 스팟 라우트(`/api/orderbook` 등)는 필수다."""
    r = client.get("/api/live/series", params={"code": "005930", "date": "20260806"})

    assert r.status_code == 200
    assert r.json()["ask_peak_today"]["venue_echo"] == "KRX"
