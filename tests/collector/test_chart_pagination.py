from __future__ import annotations

import pytest

from hoga.collector.chart import ChartPaginationError, fetch_full_chart


def row(minute: int, *, price: int = 100) -> str:
    return f"{minute * 60000}\t{minute // 60:02}:{minute % 60:02}:00\t{price}\t100\t100\t100\t1\t2\t3\n"


def test_full_evening_chart_fetches_morning_without_minute_hour_encoding_mixup():
    calls = []

    def fetch(cursor):
        calls.append(cursor)
        if len(calls) == 1:
            return "".join(row(m) for m in range(1200, 700, -1))
        assert cursor == 114100000  # oldest first-page bucket = 11:41
        # Include the boundary with changed fields: first request must win.
        return row(701, price=999) + "".join(row(m) for m in range(700, 509, -1))

    body = fetch_full_chart(fetch, date="20261022", final_time=200100000)
    timestamps = [int(line.split("\t")[0]) for line in body.splitlines()]
    assert calls == [200100000, 114100000]
    assert timestamps == [m * 60000 for m in range(1200, 509, -1)]
    assert row(701).strip() in body.splitlines()


@pytest.mark.parametrize("body", ["", "\n", row(540), "invalid upstream body"])
def test_short_first_page_preserves_existing_parser_contract(body):
    calls = []

    def fetch(cursor):
        calls.append(cursor)
        return body

    assert fetch_full_chart(fetch, date="20260520", final_time=153100000) == body
    assert calls == [153100000]


def test_repeated_capped_response_fails_instead_of_publishing_partial_chart():
    body = "".join(row(m) for m in range(1200, 700, -1))
    with pytest.raises(ChartPaginationError, match="did not move"):
        fetch_full_chart(lambda _: body, date="20261022", final_time=200100000)


def test_exactly_500_candles_can_end_with_empty_older_page():
    body = "".join(row(m) for m in range(1000, 500, -1))
    pages = iter([body, ""])
    assert fetch_full_chart(lambda _: next(pages), date="20261022", final_time=200100000) == body


@pytest.mark.parametrize("timestamp", ["-1", "86400000", "bad"])
def test_invalid_pagination_timestamp_fails(timestamp):
    body = (timestamp + "\tbad\n") * 500
    with pytest.raises(ChartPaginationError):
        fetch_full_chart(lambda _: body, date="20261022", final_time=200100000)


def test_collector_stores_all_chart_pages_before_marking_capture_finished(tmp_path, monkeypatch):
    from hoga.collector import orchestrator
    from hoga.collector.page_step import StopReason

    monkeypatch.setattr(orchestrator, "_page_step_loop", lambda *_a, **_kw: (
        set(), 0, 200100000, StopReason.EMPTY_STREAK,
    ))
    calls = []

    class Client:
        def fetch_info(self, *_args):
            return "info"

        def fetch_chart(self, code, date, cursor):
            calls.append(cursor)
            if len(calls) == 1:
                return "".join(row(m) for m in range(1200, 700, -1))
            return row(540)

    result = orchestrator.collect_stock_date(
        client=Client(), code="005930", date="20261022", data_dir=tmp_path, rate_limit_s=0,
    )
    assert calls == [200100000, 114100000]
    assert len((result.raw_dir / "chart.tsv").read_text().splitlines()) == 501


def test_failed_older_chart_request_preserves_previous_raw(tmp_path, monkeypatch):
    from hoga.collector import orchestrator
    from hoga.collector.page_step import StopReason

    monkeypatch.setattr(orchestrator, "_page_step_loop", lambda *_a, **_kw: (
        set(), 0, 200100000, StopReason.EMPTY_STREAK,
    ))
    raw = tmp_path / "raw" / "20261022" / "005930"
    raw.mkdir(parents=True)
    (raw / "chart.tsv").write_text("previous raw")

    class Client:
        def fetch_info(self, *_args):
            return "info"

        def fetch_chart(self, code, date, cursor):
            if cursor != 200100000:
                raise RuntimeError("older chart fetch failed")
            return "".join(row(m) for m in range(1200, 700, -1))

    with pytest.raises(RuntimeError, match="older chart fetch failed"):
        orchestrator.collect_stock_date(
            client=Client(), code="005930", date="20261022", data_dir=tmp_path, rate_limit_s=0,
        )
    assert (raw / "chart.tsv").read_text() == "previous raw"
    assert not (raw / "_progress.json").exists()
