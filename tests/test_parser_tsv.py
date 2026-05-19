from __future__ import annotations

import pytest

from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade
from hoga.parser.tsv import (
    FieldCountError,
    parse_candle_row,
    parse_info_row,
    parse_row,
)


def test_parse_trade_signed_positive() -> None:
    line = "\t".join(
        [
            "2",
            "1",
            "25",
            "2123",
            "90008726",
            "32408726",
            "274500",
            "-2.31",
            "+4",
            "789300",
            "216275",
            "274000",
            "274500",
            "274000",
            "-32765914",
            "2.35",
            "0.01",
            "500.00",
        ]
    )
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.ts_ms == 90008726
    assert ev.seq == 2123
    assert ev.price == 274500
    assert ev.qty == 4
    assert ev.side == 1
    assert ev.cum_vol == 789300


def test_parse_trade_signed_negative() -> None:
    line = "\t".join(
        [
            "2",
            "1",
            "27",
            "2125",
            "90008900",
            "32408900",
            "274000",
            "-2.49",
            "-3",
            "789307",
            "216277",
            "274000",
            "274500",
            "274000",
            "-32765917",
            "2.35",
            "0.01",
            "500.00",
        ]
    )
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.qty == 3
    assert ev.side == -1


def test_parse_trade_auction_cross_unsigned() -> None:
    line = "\t".join(
        [
            "2",
            "1",
            "24",
            "2122",
            "90008618",
            "32408618",
            "274000",
            "-2.49",
            "788290",
            "789296",
            "216274",
            "274000",
            "274000",
            "274000",
            "-32765918",
            "2.35",
            "0.01",
            "500.00",
        ]
    )
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.qty == 788290
    assert ev.side == 0


def test_parse_orderbook() -> None:
    header = ["2", "2", "835", "847", "90000435", "32400435"]
    ask_p = ["25700", "25750", "25800"] + ["0"] * 7
    ask_q = ["657", "72", "111"] + ["0"] * 7
    ask_d = ["0"] * 10
    bid_p = ["25650", "25600", "25550"] + ["0"] * 7
    bid_q = ["2776", "4193", "4259"] + ["0"] * 7
    bid_d = ["0"] * 10
    totals = ["840", "-2387", "11228", "6383"]
    line = "\t".join(header + ask_p + ask_q + ask_d + bid_p + bid_q + bid_d + totals) + "\t"
    ev = parse_row(line)
    assert isinstance(ev, Orderbook)
    assert ev.ts_ms == 90000435
    assert ev.seq == 847
    assert ev.ask_p[:3] == (25700, 25750, 25800)
    assert ev.ask_q[:3] == (657, 72, 111)
    assert ev.bid_p[:3] == (25650, 25600, 25550)
    assert ev.tot_ask == 840
    assert ev.tot_bid == 11228


def test_parse_broker_row_returns_list() -> None:
    header = ["2", "4", "0", "912", "90019919", "32419919"]
    sell_names = ["미래에셋", "NH투자증권", "키움증권", "한국투자증권", "신한투자증권"]
    sell_today = ["1798", "1291", "1210", "1164", "804"]
    sell_delta = ["1798", "1291", "1210", "1164", "804"]
    buy_names = ["아이엠증권", "유비에스증권", "NH투자증권", "JP모간서울", "키움증권"]
    buy_today = ["3450", "1236", "968", "602", "549"]
    buy_delta = ["3450", "1236", "968", "602", "549"]
    extras = ["0", "0", "1838", "1838", "1838", "1838"]
    line = "\t".join(
        header + sell_names + sell_today + sell_delta + buy_names + buy_today + buy_delta + extras
    )
    rows = parse_row(line)
    assert isinstance(rows, list)
    assert all(isinstance(r, BrokerRow) for r in rows)
    assert len(rows) == 10
    sells = [r for r in rows if r.side == "sell"]
    buys = [r for r in rows if r.side == "buy"]
    assert [r.broker for r in sells] == sell_names
    assert [r.qty_today for r in sells] == [int(x) for x in sell_today]
    assert [r.broker for r in buys] == buy_names


def test_parse_premarket_row_returns_trade_with_side_zero() -> None:
    line = "1\t3\t10\t11\t84000352\t31200352\t0\t0\t501\t0"
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.ts_ms == 84000352
    assert ev.qty == 501
    assert ev.side == 0


def test_parse_unknown_event_type_raises() -> None:
    line = "2\t9\t0\t1\t90000000\t0"
    with pytest.raises(ValueError, match="unknown event type"):
        parse_row(line)


def test_parse_wrong_field_count_raises() -> None:
    line = "2\t1\t0\t1\t90000000"
    with pytest.raises(FieldCountError):
        parse_row(line)


def test_parse_info_row() -> None:
    line = "1\t005930\t삼성전자\t0\t90000000\t153000000\t520235\t83000216\t160000326\t30186229\t8264833\t274000\t281500\t266000\t275500\t365000\t197000\t281000\t269500\t271000\t267000\t267500"
    info = parse_info_row(line)
    assert isinstance(info, StockInfo)
    assert info.code == "005930"
    assert info.name == "삼성전자"
    assert info.regular_session_open_ms == 90000000
    assert info.regular_session_close_ms == 153000000
    assert info.prev_close == 274000
    assert info.upper_limit == 281500
    assert info.lower_limit == 266000
    assert info.today_open == 275500
    assert info.today_high == 281000
    assert info.today_low == 269500
    assert info.today_close == 271000


def test_parse_candle_row() -> None:
    line = "30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t0\t0\t43\t5"
    c = parse_candle_row(line)
    assert isinstance(c, Candle)
    assert c.ts_ms == 30600000
    assert c.open_ == c.close_ == c.high == c.low == 281000
    assert c.vol_a == 119
    assert c.vol_b == 0
