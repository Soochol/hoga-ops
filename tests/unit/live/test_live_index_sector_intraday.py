from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.api.heatmap import save_document
from hoga.api.models import HeatmapDocument, HeatmapEntry
from hoga.live import kiwoom_multi_quote
from hoga.live.kis_client import KisClient
from hoga.live.live_index_sector_intraday import LiveIndexSectorIntradayOverlay
from hoga.live.quote_models import Quote


class _FakeQuoteFetcher:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []

    async def fetch_and_gate(
        self,
        _kis: KisClient,
        code_list: list[str],
        phase: str,
        *,
        fetch_chunk_fn=None,
    ) -> list[Quote]:
        self.calls.append((code_list, phase))
        if fetch_chunk_fn is not None:
            # 진짜 fetcher 와 같은 계약: I/O 는 청크 러너로만 한다. 이 호출이 없으면
            # 페이크가 거버너를 건너뛰어 유량·과부하 검증이 조용히 죽는다.
            for chunk in kiwoom_multi_quote.chunk_codes(list(code_list)):
                await fetch_chunk_fn(chunk)
        return [
            Quote("005930", 121, 0.0),
            Quote("000660", 189, 0.0),
        ]


class _RecordingScheduler:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[object | None], Awaitable],
    ):
        # 계정 차원(endpoint·cooldown_scope)은 PR-J(#1046)에서 사라졌다(#1015).
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await call(None)


def _seed_heatmap(tmp_path) -> None:
    from hoga.api.models import WatchlistFolder
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder(id="f_00000aaa", name="반도체", order=0)],
            entries=[
                HeatmapEntry(code="005930", name="삼성전자", folder_id="f_00000aaa", order=0),
                HeatmapEntry(code="000660", name="SK하이닉스", folder_id="f_00000aaa", order=1),
            ],
        ),
    )


@pytest.mark.asyncio
async def test_live_index_sector_intraday_overlay_schedules_quotes(tmp_path, monkeypatch) -> None:
    from hoga.live import kiwoom_rest_runtime
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object())

    async def _fetch_chunk(_client, _chunk, **_kw):
        """청크 러너가 도달하는 바닥 — 페이크 클라이언트에는 `call` 이 없다."""
        return []

    monkeypatch.setattr(kiwoom_multi_quote, "fetch_chunk", _fetch_chunk)
    _seed_heatmap(tmp_path)
    scheduler = _RecordingScheduler()
    quote_fetcher = _FakeQuoteFetcher()
    overlay = LiveIndexSectorIntradayOverlay(
        data_dir=tmp_path,
        scheduler=scheduler,  # type: ignore[arg-type]
        quote_fetcher=quote_fetcher,  # type: ignore[arg-type]
    )

    prices = await overlay.fetch_prices(phase="open")

    assert prices == {"005930": 121, "000660": 189}
    assert quote_fetcher.calls == [(["005930", "000660"], "open")]
    assert scheduler.calls == [
        {
            # key 가 코드 **청크** 단위다 — 유량 페이싱의 전제(ADR-0137).
            "key": ("index-sector-rankings-quotes", ("005930", "000660"), "open"),
            "api_id": "ka10095",
            "priority": "background",
        }
    ]
