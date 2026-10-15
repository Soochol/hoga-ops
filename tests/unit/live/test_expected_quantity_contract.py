"""Keep orderbook quantities and 0H volume distinct through public serialization."""
import json

from hoga.live.api import LiveSeriesResponse
from hoga.live.buffer import LiveBuffer
from hoga.live.kiwoom_frames import parse_real_row
from hoga.live.snapshot import LiveSnapshot
from hoga.util.timeenc import hhmmssms_to_unix_ms


async def test_book_quantities_and_price_only_expected_survive_series_and_ws() -> None:
    stamp = hhmmssms_to_unix_ms("20261015", 152703000)
    buf = LiveBuffer()
    subscriber = buf.subscribe("000660", batch=True)
    rows = [
        {"type": "0D", "item": "000660_AL", "values": {
            "21": "152703", "41": "1240000", "61": "100",
            "51": "1239000", "71": "200", "121": "55619", "125": "18449",
            "23": "1240000", "24": "363789",
        }},
        {"type": "0H", "item": "000660_AL", "values": {
            "20": "152703", "10": "1240000", "15": "3", "13": "7877367",
        }},
    ]
    for row in rows:
        tick = parse_real_row(row, date="20261015", now_ms=stamp)
        assert tick is not None
        await buf.publish("000660", [LiveSnapshot(
            tick.t_ms, tick.kind, {**tick.payload, "venue": tick.venue},
        )], now_ms=stamp)

    series = await buf.get_series("000660")
    wire = json.loads(LiveSeriesResponse.model_validate({**series, "date": "20261015"}).model_dump_json())
    book = wire["snapshots"][0]
    assert book["asks"][0] == {"price": 1_240_000, "qty": 100}
    assert book["bids"][0] == {"price": 1_239_000, "qty": 200}
    assert (book["total_ask_qty"], book["total_bid_qty"]) == (55_619, 18_449)
    assert book["expected_qty"] == 363_789
    expected = wire["expected"][0]
    assert expected["expected_price"] == 1_240_000
    assert "expected_qty" not in expected
    assert "asks" not in expected and "total_ask_qty" not in expected

    delivered = json.loads(json.dumps(await subscriber.get()))
    expected_delivery = next(row for row in delivered["data"] if row["kind"] == "expected")
    assert expected_delivery["expected_price"] == 1_240_000
    assert "expected_qty" not in expected_delivery
