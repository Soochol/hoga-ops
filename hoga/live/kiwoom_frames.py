"""키움 WS REAL 프레임 → WsTick 순수 파서. I/O 없음 — fixture로 완전 테스트 가능.

포트 계약: 출력 WsTick.payload는 KIS ws_frames와 **byte 동일**(같은 키·타입·의미).
그래야 stream.on_tick 이후의 표시·저장·지표 파이프라인이 소스 무관으로 재사용된다.
KIS와의 두 차이(가격 등락부호 접두·venue는 코드 접미)를 여기서 흡수한다.

KIS ws_frames와 짝을 이루는 브로커-대칭 모듈. 서로 import하지 않는다(ADR-0116 규율 1).
"""
from __future__ import annotations

import logging
from typing import Any

from hoga.api.timeenc import hhmmssms_to_unix_ms

from . import kiwoom_fields as K
from .snapshot import SnapshotKind
from .ws_frames import WsTick

_log = logging.getLogger(__name__)


def _hhmmss_to_unix_ms(date: str, hhmmss: str) -> int:
    return hhmmssms_to_unix_ms(date, int(hhmmss) * 1000)


def _price(values: dict[str, str], fid: str) -> int:
    """가격 FID → 크기(부호=등락방향이라 abs). 빈/공백/부재는 0."""
    raw = values.get(fid, "0").strip()
    return abs(int(raw)) if raw else 0


def _qty(values: dict[str, str], fid: str) -> int:
    """수량 FID → int. 빈/공백/부재는 0. 부호 있으면 크기(방향은 별도 필드/규약)."""
    raw = values.get(fid, "0").strip()
    return abs(int(raw)) if raw else 0


def parse_real_row(row: dict[str, Any], *, date: str, now_ms: int) -> WsTick | None:
    """REAL 메시지의 data[] 원소 1개 → WsTick. 미지원 type·불량 프레임은 None.

    row = {"type": "0D", "item": "005930_NX", "values": {fid: str, ...}}
    """
    typ = row.get("type")
    item = row.get("item")
    values = row.get("values")
    if not isinstance(item, str) or not isinstance(values, dict):
        _log.warning("live.kiwoom.malformed_row head=%s", str(row)[:80])
        return None
    code, venue = K.split_venue(item)
    try:
        if typ == K.TYPE_ORDERBOOK:
            return _parse_orderbook(code, values, date=date, venue=venue)
        if typ == K.TYPE_TRADE:
            return _parse_trade(code, values, date=date, venue=venue)
    except (ValueError, KeyError):
        # 숫자 불량/필드 부재는 프레임 1건 손실로 격리 — recv 루프까지 전파 금지.
        _log.warning("live.kiwoom.bad_field type=%s code=%s", typ, code)
        return None
    return None


def parse_real_message(msg: dict[str, Any], *, date: str, now_ms: int) -> list[WsTick]:
    """REAL 메시지 전체 → WsTick 목록. data[] 각 원소를 parse_real_row로.

    ws_client가 trnm=="REAL"만 넘긴다(LOGIN/PING/REG ACK는 별도 처리). data 부재·
    비리스트는 [].
    """
    data = msg.get("data")
    if not isinstance(data, list):
        return []
    ticks: list[WsTick] = []
    for row in data:
        if isinstance(row, dict):
            tick = parse_real_row(row, date=date, now_ms=now_ms)
            if tick is not None:
                ticks.append(tick)
    return ticks


def _parse_orderbook(
    code: str, values: dict[str, str], *, date: str, venue: str
) -> WsTick:
    t_ms = _hhmmss_to_unix_ms(date, values[K.OB_TIME])
    payload = {
        "code": code,
        "t_ms": t_ms,
        "asks": [
            {"price": _price(values, p), "qty": _qty(values, q)}
            for p, q in zip(K.OB_ASK_PRICE, K.OB_ASK_QTY, strict=True)
        ],
        "bids": [
            {"price": _price(values, p), "qty": _qty(values, q)}
            for p, q in zip(K.OB_BID_PRICE, K.OB_BID_QTY, strict=True)
        ],
        "total_ask_qty": _qty(values, K.OB_TOTAL_ASK_QTY),
        "total_bid_qty": _qty(values, K.OB_TOTAL_BID_QTY),
    }
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.OB, payload=payload, venue=venue)


def _parse_trade(
    code: str, values: dict[str, str], *, date: str, venue: str
) -> WsTick:
    t_ms = _hhmmss_to_unix_ms(date, values[K.CNT_TIME])
    qty_raw = values.get(K.CNT_QTY, "0").strip() or "0"
    side = _sign(int(qty_raw))
    trade = {
        "t_ms": t_ms,
        "price": _price(values, K.CNT_PRICE),
        "qty": abs(int(qty_raw)),
        "side": side,
        "side_source": "kiwoom_ws",
    }
    return WsTick(
        code=code, t_ms=t_ms, kind=SnapshotKind.TRADE, payload={"trades": [trade]},
        venue=venue,
    )


def _sign(n: int) -> int:
    """FID 15(체결량) 부호 → side(+1 매수 / -1 매도 / 0). KIS _SIDE_MAP과 동형."""
    return 1 if n > 0 else (-1 if n < 0 else 0)
