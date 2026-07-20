"""키움 WS REAL 프레임 → WsTick 순수 파서. I/O 없음 — fixture로 완전 테스트 가능.

포트 계약: 출력 WsTick.payload는 KIS ws_frames의 키·타입·의미를 **전부 보존**한다.
그래야 stream.on_tick 이후의 표시·저장·지표 파이프라인이 소스 무관으로 재사용된다.
KIS와의 두 차이(가격 등락부호 접두·venue는 코드 접미)를 여기서 흡수한다.

계약 개정(2026-07-20): 원래는 "byte 동일"이었으나, KIS 파서가 삭제된(ADR-0118 PR-G)
지금 이 계약이 지키는 건 **하위 소비자의 기대**다. 그래서 KIS 키 보존을 불변으로
유지하되, 키움만 주는 필드는 additive 로 덧붙일 수 있게 완화한다. 첫 사례가 trade
payload 의 `prev_close`(FID 11 유도) — 소비자는 optional 로 다뤄야 한다. 계약은
test_kiwoom_frames 의 parity 테스트가 "KIS 키 ⊆ payload, 초과분은 허용목록 내"로
고정한다.

KIS ws_frames와 짝을 이루는 브로커-대칭 모듈. 서로 import하지 않는다(ADR-0116 규율 1).
"""
from __future__ import annotations

import logging
from typing import Any

from hoga.api.timeenc import hhmmssms_to_unix_ms

from . import kiwoom_fields as K
from .snapshot import SnapshotKind
from .ticks import WsTick

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


def _signed_opt(values: dict[str, str], fid: str) -> int | None:
    """부호 유의미 FID → int, 없거나 불량이면 None.

    _price/_qty 와 달리 abs 를 취하지 않고, **예외를 던지지 않는다**. 선택 필드
    전용이라서다 — 이 값이 불량이라고 프레임 전체를 버리면(parse_real_row 의
    ValueError 핸들러가 None 반환) 기존에 살아있던 체결 틱까지 잃는다.
    """
    raw = values.get(fid, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _ratio(values: dict[str, str], fid: str) -> float | None:
    """비율 FID(%, 소수 2자리) → 크기. 부호는 증감방향이라 abs.

    _signed_opt 와 같은 이유로 예외를 던지지 않는다 — 선택 필드 하나가 불량이라고
    체결 틱 전체를 버리면 안 된다. 0.0 도 None 으로 접는다(미수신과 동일 취급).
    """
    raw = values.get(fid, "").strip()
    if not raw:
        return None
    try:
        v = abs(float(raw))
    except ValueError:
        return None
    return v if v > 0 else None


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
        if typ == K.TYPE_MEMBER:
            return _parse_member(code, values, now_ms=now_ms, venue=venue)
        if typ == K.TYPE_PROGRAM:
            return _parse_program(code, values, now_ms=now_ms, venue=venue)
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
    price = _price(values, K.CNT_PRICE)
    trade = {
        "t_ms": t_ms,
        "price": price,
        "qty": abs(int(qty_raw)),
        "side": side,
        "side_source": "kiwoom_ws",
    }
    payload: dict[str, Any] = {"trades": [trade]}
    # 종목 단위 값(전일종가·당일 OHLC)은 체결 레코드마다 반복하지 않고 payload
    # 최상위에 싣는다(소비자의 dedup·재렌더 판정이 단순해진다). KIS 계약 키를
    # 건드리지 않는 additive 확장 — 없을 수도 있는 필드라 소비자는 optional 로
    # 다뤄야 한다(거래원 REST 합성 틱은 이 키들이 없다: rest_buffer_build).
    prev_close = _prev_close(price, _signed_opt(values, K.CNT_DELTA))
    if prev_close is not None:
        payload["prev_close"] = prev_close
    # 당일 OHLC — 폴링이 주던 값을 키움 실시간으로 대체(히트맵 행). 0은 미수신이라
    # 키를 싣지 않는다: 소비자가 폴링값으로 폴백하도록.
    for key, fid in (("day_open", K.CNT_OPEN), ("day_high", K.CNT_HIGH),
                     ("day_low", K.CNT_LOW)):
        v = _price(values, fid)
        if v > 0:
            payload[key] = v
    # 종목 요약 지표(체결강도·어제보다·거래량·VWAP). OHLC 와 같은 규약 —
    # 0/불량은 키를 싣지 않아 소비자가 "미수신"과 "진짜 0"을 구분하지 않아도 되게 한다.
    # 비율 FID 는 부호가 증감방향이라 크기만 취한다(가격 FID 와 동형).
    for key, fid in (("fill_strength_pct", K.CNT_FILL_STRENGTH),
                     ("vs_prev_volume_pct", K.CNT_VS_PREV_VOL_PCT)):
        r = _ratio(values, fid)
        if r is not None:
            payload[key] = r
    for key, fid in (("cum_volume", K.CNT_CUM_VOLUME), ("vwap", K.CNT_VWAP)):
        v = _qty(values, fid)
        if v > 0:
            payload[key] = v
    return WsTick(
        code=code, t_ms=t_ms, kind=SnapshotKind.TRADE, payload=payload, venue=venue,
    )


def _parse_member(
    code: str, values: dict[str, str], *, now_ms: int, venue: str
) -> WsTick:
    """0F 주식당일거래원 → SnapshotKind.BROKER.

    payload 는 삭제된 ADR-0111 REST 합성 경로(brokers_to_snapshot — PR-F2 로 은퇴)가
    쓰던 shape 그대로: {code, t_ms, sell_top[{name,qty}], buy_top[{name,qty}]}.
    하위 소비자(버퍼·거래원 카드)가 이 shape 를 계속 기대한다.
    phase/venue 는 stream.on_tick 이 덧붙이므로 파서는 싣지 않는다(0B/0D 와 동일).

    0F 프레임에는 시각 FID 가 없어 t_ms=now_ms(수신 시각) — REST 합성 경로와
    같은 규약이다.
    """
    payload = {
        "code": code,
        "t_ms": now_ms,
        "sell_top": _member_top(values, K.MEM_SELL_NAME, K.MEM_SELL_QTY),
        "buy_top": _member_top(values, K.MEM_BUY_NAME, K.MEM_BUY_QTY),
    }
    return WsTick(
        code=code, t_ms=now_ms, kind=SnapshotKind.BROKER, payload=payload, venue=venue,
    )


def _member_top(
    values: dict[str, str], name_fids: list[str], qty_fids: list[str]
) -> list[dict[str, Any]]:
    """이름/수량 FID 5쌍 → 상위 거래원 목록. 빈 슬롯(이름 공백)은 건너뛴다.

    이름은 내부 공백이 유의미한 한글 텍스트("삼  성")라 양끝만 strip 한다.
    KIS REST 의 sell_top/buy_top 도 상위 5 미만이면 자연히 짧은 리스트였으므로,
    빈 슬롯 스킵이 소비자 관점에서 같은 의미다.
    """
    top: list[dict[str, Any]] = []
    for name_fid, qty_fid in zip(name_fids, qty_fids, strict=True):
        name = values.get(name_fid, "").strip()
        if not name:
            continue
        top.append({"name": name, "qty": _qty(values, qty_fid)})
    return top


_MILLION = 1_000_000


def _parse_program(
    code: str, values: dict[str, str], *, now_ms: int, venue: str
) -> WsTick:
    """0w 종목프로그램매매 → SnapshotKind.PROGRAM.

    payload 키는 ProgramTradeByStockRow(KIS wire 모델) 필드명과 동일 — 프로그램
    latch → collector drain 이 이 dict 로 Row 를 만들어 store.merge_response 에
    넘기므로, 저장·이상탐지·/api/range 소비·프론트가 전부 무변경 재사용된다.

    금액(204/208/212)은 키움이 **백만원** 단위로 준다 — 저장·프론트는 KIS REST 의
    원 단위를 쓰므로 여기서 ×1e6 정규화한다(F3 실측: REST 399,887,415,500원 ↔
    0w 397,701백만원, 비율 정확히 1e-6). 211/213(증감)은 재전송 취약이라 미소비 —
    delta 는 collector 가 flush 간 누적 diff 로 파생한다(F3 권고).

    시각 FID 가 없어 t_ms=now_ms(0F 와 동일 규약). bsop_hour(store 병합 키)는
    collector 가 t_ms 에서 합성한다.
    """
    payload = {
        "code": code,
        "t_ms": now_ms,
        "sell_qty": _qty(values, K.PRG_SELL_QTY),
        "sell_amount": _qty(values, K.PRG_SELL_AMT) * _MILLION,
        "buy_qty": _qty(values, K.PRG_BUY_QTY),
        "buy_amount": _qty(values, K.PRG_BUY_AMT) * _MILLION,
        # 순매수는 부호 유의미(abs 금지) — F3 검산에서 210=206−202 가 205/205
        # 성립했으므로 재계산 대신 수신값을 신뢰한다.
        "net_qty": _signed_opt(values, K.PRG_NET_QTY),
        "net_amount": (
            v * _MILLION if (v := _signed_opt(values, K.PRG_NET_AMT)) is not None else None
        ),
        "price": _price(values, K.CNT_PRICE),
    }
    return WsTick(
        code=code, t_ms=now_ms, kind=SnapshotKind.PROGRAM, payload=payload, venue=venue,
    )


def _prev_close(price: int, delta: int | None) -> int | None:
    """현재가 + 전일대비 → 전일종가. 유도 불가면 None.

    price<=0(빈 프레임)이나 delta 부재는 물론, 결과가 0 이하인 경우도 버린다 —
    등락률 분모라서 0/음수면 소비자가 0으로 나누거나 부호가 뒤집힌다.
    """
    if price <= 0 or delta is None:
        return None
    prev = price - delta
    return prev if prev > 0 else None


def _sign(n: int) -> int:
    """FID 15(체결량) 부호 → side(+1 매수 / -1 매도 / 0). KIS _SIDE_MAP과 동형."""
    return 1 if n > 0 else (-1 if n < 0 else 0)
