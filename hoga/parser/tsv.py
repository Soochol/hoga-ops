"""TSV row tokenizer + dispatcher.

Each first.tsv row is identified by its event type (field 2). The TSV Section
marker (field 1) is informational only and ignored here.
"""

from __future__ import annotations

from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade

# Event type codes (field 2 of every first.tsv row).
EVENT_TYPE_TRADE = 1
EVENT_TYPE_ORDERBOOK = 2
EVENT_TYPE_PREMARKET = 3
EVENT_TYPE_BROKER = 4
EVENT_TYPE_PRICE_TICK = 5  # 3-field `section=3 type=5 price` price-only heartbeat

# Minimum field count for parse_row to read the event_type field.
MIN_DISPATCH_FIELDS = 2

# Minimum field count for parse_info_row.
INFO_MIN_FIELDS = 22

# Minimum field count for parse_candle_row.
CANDLE_MIN_FIELDS = 8

EXPECTED_FIELD_COUNTS = {
    EVENT_TYPE_TRADE: 18,
    EVENT_TYPE_ORDERBOOK: 70,  # 6 header + 10*6 levels + 4 totals
    EVENT_TYPE_PREMARKET: 10,
    EVENT_TYPE_BROKER: 42,  # 6 header + 5+5+5+5+5+5 + 6 trailing
    EVENT_TYPE_PRICE_TICK: 3,  # `3 5 <price>` price-only broadcast; intentionally skipped
}


class FieldCountError(ValueError):
    """A row's tab-separated field count doesn't match its event_type's expectation."""


def _split(line: str) -> list[str]:
    """Tokenize a TSV row, stripping trailing newline/CR and one trailing empty field."""
    cleaned = line.rstrip("\n").rstrip("\r")
    parts = cleaned.split("\t")
    if parts and parts[-1] == "":
        parts.pop()
    return parts


def parse_row(line: str) -> Trade | Orderbook | list[BrokerRow] | None:
    """Dispatch on field 2 (event_type).

    Returns None for event types that carry no new structured information
    (e.g. EVENT_TYPE_PRICE_TICK — a price-only broadcast already covered by
    trade events). The orchestrator skips None.
    """
    parts = _split(line)
    if len(parts) < MIN_DISPATCH_FIELDS:
        raise FieldCountError(f"row too short: {len(parts)} fields")
    try:
        event_type = int(parts[1])
    except ValueError as e:
        raise FieldCountError(f"non-numeric event_type: {parts[1]!r}") from e

    if event_type not in EXPECTED_FIELD_COUNTS:
        raise ValueError(f"unknown event type {event_type}")
    expected = EXPECTED_FIELD_COUNTS[event_type]
    if len(parts) != expected:
        raise FieldCountError(
            f"event_type={event_type} expects {expected} fields, got {len(parts)}"
        )

    if event_type == EVENT_TYPE_TRADE:
        return _parse_trade(parts)
    if event_type == EVENT_TYPE_ORDERBOOK:
        return _parse_orderbook(parts)
    if event_type == EVENT_TYPE_PREMARKET:
        return _parse_premarket(parts)
    if event_type == EVENT_TYPE_BROKER:
        return _parse_broker(parts)
    if event_type == EVENT_TYPE_PRICE_TICK:
        return None  # heartbeat-style price broadcast; data already in trades
    raise AssertionError("unreachable")  # pragma: no cover


def _parse_trade(parts: list[str]) -> Trade:
    qty_raw = parts[8]
    if qty_raw.startswith("+"):
        side = 1
        qty = int(qty_raw[1:])
    elif qty_raw.startswith("-"):
        side = -1
        qty = int(qty_raw[1:])
    else:
        side = 0  # Auction Cross
        qty = int(qty_raw)

    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=int(parts[6]),
        change_pct=float(parts[7]),
        qty=qty,
        side=side,
        cum_vol=int(parts[9]),
        cum_trades=int(parts[10]),
        low_so_far=int(parts[11]),
        high_so_far=int(parts[12]),
        net_pressure=int(parts[14]),
        unknown_14=int(parts[13]),
        unknown_16=float(parts[15]),
        unknown_17=float(parts[16]),
        unknown_18=float(parts[17]),
    )


def _parse_orderbook(parts: list[str]) -> Orderbook:
    base = 6
    ask_p = tuple(int(x) for x in parts[base : base + 10])
    ask_q = tuple(int(x) for x in parts[base + 10 : base + 20])
    ask_d = tuple(int(x) for x in parts[base + 20 : base + 30])
    bid_p = tuple(int(x) for x in parts[base + 30 : base + 40])
    bid_q = tuple(int(x) for x in parts[base + 40 : base + 50])
    bid_d = tuple(int(x) for x in parts[base + 50 : base + 60])
    totals_start = base + 60
    return Orderbook(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        ask_p=ask_p,
        ask_q=ask_q,
        ask_d=ask_d,
        bid_p=bid_p,
        bid_q=bid_q,
        bid_d=bid_d,
        tot_ask=int(parts[totals_start]),
        tot_ask_d=int(parts[totals_start + 1]),
        tot_bid=int(parts[totals_start + 2]),
        tot_bid_d=int(parts[totals_start + 3]),
    )


def _parse_premarket(parts: list[str]) -> Trade:
    """`(*, 3)` pre-market summary stored as a side=0 trade.

    Field layout (10 significant fields):
        parts[0]=tsv_section, parts[1]=3, parts[2]=sub_seq, parts[3]=global_seq,
        parts[4]=event_time, parts[5]=rel_time,
        parts[6..9] = unclear; field 8 is most likely the qty.
    """
    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=0,
        change_pct=0.0,
        qty=int(parts[8]),
        side=0,
        cum_vol=0,
        cum_trades=0,
        low_so_far=0,
        high_so_far=0,
        net_pressure=0,
        unknown_14=int(parts[6]),
        unknown_16=float(parts[7]),
        unknown_17=float(parts[9]),
        unknown_18=0.0,
    )


def _parse_broker(parts: list[str]) -> list[BrokerRow]:
    ts_ms = int(parts[4])
    seq = int(parts[3])
    base = 6
    rows: list[BrokerRow] = []
    sell_names = parts[base : base + 5]
    sell_today = parts[base + 5 : base + 10]
    sell_delta = parts[base + 10 : base + 15]
    buy_names = parts[base + 15 : base + 20]
    buy_today = parts[base + 20 : base + 25]
    buy_delta = parts[base + 25 : base + 30]
    for i, (name, today, delta) in enumerate(
        zip(sell_names, sell_today, sell_delta, strict=True), start=1
    ):
        rows.append(
            BrokerRow(
                ts_ms=ts_ms,
                seq=seq,
                side="sell",
                rank=i,
                broker=name,
                qty_today=int(today),
                qty_delta=int(delta),
            )
        )
    for i, (name, today, delta) in enumerate(
        zip(buy_names, buy_today, buy_delta, strict=True), start=1
    ):
        rows.append(
            BrokerRow(
                ts_ms=ts_ms,
                seq=seq,
                side="buy",
                rank=i,
                broker=name,
                qty_today=int(today),
                qty_delta=int(delta),
            )
        )
    return rows


def parse_info_row(line: str) -> StockInfo:
    parts = _split(line)
    if len(parts) < INFO_MIN_FIELDS:
        raise FieldCountError(f"info row expects >={INFO_MIN_FIELDS} fields, got {len(parts)}")
    unknowns = {
        "f11": parts[10],
        "f16": parts[15],
        "f17": parts[16],
        "f21": parts[20],
        "f22": parts[21],
    }
    return StockInfo(
        code=parts[1],
        name=parts[2],
        regular_session_open_ms=int(parts[4]),
        regular_session_close_ms=int(parts[5]),
        prev_close=int(parts[11]),
        upper_limit=int(parts[12]),
        lower_limit=int(parts[13]),
        today_open=int(parts[14]),
        today_high=int(parts[17]),
        today_low=int(parts[18]),
        today_close=int(parts[19]),
        raw_line=line.rstrip("\n"),
        unknowns=unknowns,
    )


def parse_candle_row(line: str) -> Candle:
    parts = _split(line)
    if len(parts) < CANDLE_MIN_FIELDS:
        raise FieldCountError(f"candle row expects >={CANDLE_MIN_FIELDS} fields, got {len(parts)}")
    return Candle(
        ts_ms=int(parts[0]),
        open_=int(parts[2]),
        close_=int(parts[3]),
        high=int(parts[4]),
        low=int(parts[5]),
        vol_a=int(parts[6]),
        vol_b=int(parts[7]),
    )
