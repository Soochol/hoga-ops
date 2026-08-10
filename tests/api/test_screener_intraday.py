import asyncio
import datetime as dt
import logging
from dataclasses import dataclass
from pathlib import Path

import polars as pl
import pytest

from hoga.api import screener_intraday, screener_universe
from hoga.api.models import ScreenerUniverse
from hoga.live.kiwoom_errors import KiwoomRateLimitError

_RATE_LIMIT_MSG = "허용된 요청 개수를 초과하였습니다[1700:유량=5, API ID=ka10095]"


@dataclass(frozen=True)
class Quote:
    code: str
    price: int
    change_pct: float | None = None
    change_won: int | None = None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    volume: int | None = None


class FakeKis:
    def __init__(self, quotes):
        self.quotes = quotes
        self.calls = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def fetch_multi_price(self, codes):
        self.calls += 1
        self.started.set()
        await asyncio.sleep(0)
        return [q for q in self.quotes if q.code in codes]


def _patch_scheduler(monkeypatch, fake: FakeKis, calls: list[dict] | None = None) -> None:
    """PR-D(#1040) 칼 컷오버 — 키움 시임으로 옮겼다.

    `data_dir`·`cooldown_scope` 가 사라진 것은 **계정 차원이 사라졌기 때문**이다:
    키움 유량은 TR별이라 고를 계정이 없고, 같은 `api_id` 호출자끼리 자동으로 같은
    버킷을 공유한다(#1015).
    """
    sentinel = object()
    monkeypatch.setattr(
        screener_intraday.kiwoom_rest_runtime, "ensure_rest_client",
        lambda data_dir, account_id=0: sentinel,
    )
    # 거버너는 이제 계정 풀 갱신을 위해 data_dir 을 받는다(ADR-0138).
    monkeypatch.setattr(
        screener_intraday.kiwoom_rest_runtime, "ensure_scheduler",
        lambda data_dir=None: object(),
    )

    async def fake_run_with_capacity(scheduler, *, key, api_id, priority, fetch_fn, client):
        if calls is not None:
            calls.append({
                "scheduler": scheduler, "key": key,
                "api_id": api_id, "priority": priority,
            })
        return await fetch_fn(client)

    monkeypatch.setattr(screener_intraday.kiwoom_access, "run_with_capacity", fake_run_with_capacity)

    async def fake_fetch(client, codes, *, venue="KRX"):
        return await fake.fetch_multi_price(codes)

    monkeypatch.setattr(screener_intraday.kiwoom_multi_quote, "fetch_multi_price", fake_fetch)


def _write_stocks(path: Path) -> None:
    pl.DataFrame({
        "code": ["000111", "000222", "000333"],
        "name": ["a", "b", "c"],
        "market": ["KOSPI", "KOSDAQ", "KOSPI"],
        "is_etf": [False, False, True],
        "is_halted": [False, True, False],
    }).write_parquet(path)


def test_codes_for_universe_applies_screener_universe(tmp_path: Path):
    stocks = tmp_path / "stocks.parquet"
    _write_stocks(stocks)

    codes = screener_universe.codes_for_universe(
        stocks,
        ScreenerUniverse(markets=["KOSPI"], exclude_etf=True, exclude_halted=True),
    )

    assert codes == ["000111"]


@pytest.mark.asyncio
async def test_build_intraday_overlay_creates_daily_rows(monkeypatch, tmp_path: Path):
    fake = FakeKis([
        Quote("000111", price=109, open=100, high=110, low=99, volume=1234),
        Quote("000222", price=0, open=0, high=0, low=0, volume=0),
    ])
    calls = []
    _patch_scheduler(monkeypatch, fake, calls)

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path,
        codes=["000111", "000222"],
        today="20260625",
        now_ms=1_000,
        ttl_ms=15_000,
    )

    assert overlay.fetched_at_ms == 1_000
    assert overlay.rows.height == 1
    row = overlay.rows.to_dicts()[0]
    assert row["code"] == "000111"
    assert row["date"] == dt.date(2026, 6, 25)
    assert row["close"] == 109.0
    assert row["high"] == 110.0
    assert row["volume"] == 1234
    assert "intraday_quote_invalid" in overlay.warnings
    # 계정 차원(data_dir·cooldown_scope) 소멸 — 키움 유량은 TR별이다(#1015).
    assert calls == [{
        "scheduler": calls[0]["scheduler"],
        "key": ("screener-intraday", "20260625", ("000111", "000222")),
        "api_id": "ka10095",
        "priority": "background",
    }]


@pytest.mark.asyncio
async def test_build_intraday_overlay_warns_when_volume_is_unavailable(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=None)])
    _patch_scheduler(monkeypatch, fake)

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path,
        codes=["000111"],
        today="20260625",
        now_ms=1_000,
        ttl_ms=15_000,
    )

    assert overlay.rows.height == 0
    assert "intraday_volume_unavailable" in overlay.warnings


@pytest.mark.asyncio
async def test_build_intraday_overlay_reuses_ttl_cache(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=1234)])
    _patch_scheduler(monkeypatch, fake)

    first = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000, ttl_ms=15_000,
    )
    second = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=2_000, ttl_ms=15_000,
    )

    assert fake.calls == 1
    assert first.rows.to_dicts() == second.rows.to_dicts()


# --- ADR-0137 -----------------------------------------------------------------


def _many(n: int) -> list[str]:
    return [f"{i:06d}" for i in range(n)]


def _ok_quotes(codes: list[str]) -> list[Quote]:
    return [Quote(c, price=100, open=100, high=100, low=100, volume=1) for c in codes]


@pytest.mark.asyncio
async def test_overlay_submits_one_capacity_request_per_chunk(monkeypatch, tmp_path: Path):
    """회귀 봉인(ADR-0137) — 청킹은 거버너 **위**에 있어야 한다.

    청킹이 `fetch_multi_price` 안에 있으면 거버너는 submit 1건만 세고 벤더는 N콜을
    세어 유량 초과가 난다(실측: 4,295종목 → 43콜을 0.23초에 발사 → 6번째에서 1700).
    submit 횟수가 청크 수와 같아야 TR 버킷이 실제 HTTP 콜을 페이싱한다.
    """
    codes = _many(250)
    fake = FakeKis(_ok_quotes(codes))
    calls: list[dict] = []
    _patch_scheduler(monkeypatch, fake, calls)

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=codes, today="20260625", now_ms=1_000,
    )

    assert len(calls) == 3, "100 + 100 + 50 → 세 번 제출돼야 한다"
    assert all(c["api_id"] == "ka10095" for c in calls)
    assert all(c["priority"] == "background" for c in calls)
    # key 가 겹치면 거버너가 중복제거로 합쳐 버려 청크 하나만 실제로 나간다.
    assert len({c["key"] for c in calls}) == 3
    assert overlay.rows.height == 250


@pytest.mark.asyncio
async def test_overlay_names_the_rate_limit_instead_of_generic_failure(
    monkeypatch, tmp_path: Path, caplog,
):
    """유량 초과는 '잠시 후 재시도' 가 옳은 안내다. 자격증명 부재·파싱 오류와 같은
    한 단어(`intraday_quote_fetch_failed`)로 접히면 사용자가 처방을 알 수 없다."""
    fake = FakeKis([])
    _patch_scheduler(monkeypatch, fake)

    async def rate_limited(*args, **kwargs):
        raise KiwoomRateLimitError(_RATE_LIMIT_MSG, api_id="ka10095")

    monkeypatch.setattr(screener_intraday.kiwoom_access, "run_with_capacity", rate_limited)

    with caplog.at_level(logging.WARNING, logger="hoga.api.screener_intraday"):
        overlay = await screener_intraday.build_intraday_overlay(
            data_dir=tmp_path, codes=_many(120), today="20260625", now_ms=1_000,
        )

    assert overlay.rows.height == 0
    # ADR-0143: 사유는 상태 태그 배열이 아니라 `failure` 가 소유한다 — 접두 없이 kind 동반.
    assert overlay.warnings == []
    assert overlay.failure == {
        "reason": "rate_limit_upstream",
        "kind": "rate_limit",
        "is_failure": True,
        "msg": overlay.failure["msg"],
    }
    # R3 — 폴백을 고른 층이 **영향**을 로그한다. 하위 층의 "ka10095 rate-limited" 만으로는
    # 어떤 기능이 무엇으로 대체됐는지 복원할 수 없다.
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "전일 확정 폴백" in logged
    assert "1700/ka10095" in logged, "원인의 실체(벤더 코드)가 로그에 남아야 한다"


@pytest.mark.asyncio
async def test_overlay_keeps_partial_results_when_some_chunks_fail(
    monkeypatch, tmp_path: Path,
):
    """R5 — 앞선 청크가 받아온 종목은 조건 평가에 그대로 쓸 수 있다. 예외 하나로
    전량 폐기하면 500종목을 성공해 놓고도 0행이 된다(구 동작)."""
    codes = _many(250)
    fake = FakeKis(_ok_quotes(codes))
    _patch_scheduler(monkeypatch, fake)
    passthrough = screener_intraday.kiwoom_access.run_with_capacity

    async def second_chunk_fails(scheduler, *, key, api_id, priority, fetch_fn, client):
        if key[2][0] == "000100":  # 두 번째 청크의 첫 코드 — 결정적으로 고른다
            raise KiwoomRateLimitError(_RATE_LIMIT_MSG, api_id="ka10095")
        return await passthrough(
            scheduler, key=key, api_id=api_id, priority=priority,
            fetch_fn=fetch_fn, client=client,
        )

    monkeypatch.setattr(
        screener_intraday.kiwoom_access, "run_with_capacity", second_chunk_fails
    )

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=codes, today="20260625", now_ms=1_000,
    )

    assert overlay.rows.height == 150, "1·3번 청크(100+50)는 살아남아야 한다"
    assert "intraday_partial" in overlay.warnings
    assert overlay.failure is not None
    assert overlay.failure["reason"] == "rate_limit_upstream"
    assert overlay.failure["kind"] == "rate_limit"


@pytest.mark.asyncio
async def test_overlay_distinguishes_missing_credentials_from_fetch_failure(
    monkeypatch, tmp_path: Path,
):
    """ADR-0134 dev 무자격 프로필에서 **정상 경로**다 — 재시도해도 소용없으므로
    일시 장애와 같은 문구를 쓰면 안 된다."""
    monkeypatch.setattr(
        screener_intraday.kiwoom_rest_runtime, "ensure_rest_client",
        lambda data_dir, account_id=0: None,
    )

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000,
    )

    assert overlay.rows.height == 0
    # 자격증명 부재는 `auth_error`(벤더가 거절)와 처방이 달라 kind 가 갈린다.
    assert overlay.warnings == []
    assert overlay.failure is not None
    assert overlay.failure["reason"] == "credentials_missing"
    assert overlay.failure["kind"] == "not_wired"


@pytest.mark.asyncio
async def test_build_intraday_overlay_singleflights_concurrent_fetches(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=1234)])
    _patch_scheduler(monkeypatch, fake)

    first, second = await asyncio.gather(
        screener_intraday.build_intraday_overlay(
            data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000, ttl_ms=15_000,
        ),
        screener_intraday.build_intraday_overlay(
            data_dir=tmp_path, codes=["000111"], today="20260625", now_ms=1_000, ttl_ms=15_000,
        ),
    )

    assert fake.calls == 1
    assert first.rows.to_dicts() == second.rows.to_dicts()
