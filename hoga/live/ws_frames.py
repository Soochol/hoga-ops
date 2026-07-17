"""KIS WS 프레임 → Live Tick 순수 파서. I/O 없음 — fixture로 완전 테스트 가능.

payload 형태는 poller 시절 JSONL payload와 키-호환(shape-compat; 키 순서·phase
키는 다르며 promote는 무영향)을 유지해 promote._parse_jsonl_to_records 와
프론트 bucketHogaSeries 가 무변경으로 동작한다.
"""

from __future__ import annotations

import logging

from hoga.api.timeenc import hhmmssms_to_unix_ms

from . import ws_fields as F
from .snapshot import SnapshotKind
from .ticks import WsTick  # 이주처(PR-A/ADR-0118). 재수출 — ws_client·구경로 하위호환.

_log = logging.getLogger(__name__)

_SIDE_MAP = {"1": 1, "5": -1}  # 그 외('3' 장전 등) → 0 (Auction Cross 규약과 동일)


def _hhmmss_to_unix_ms(date: str, hhmmss: str) -> int:
    return hhmmssms_to_unix_ms(date, int(hhmmss) * 1000)


def parse_message(raw: str, *, date: str, now_ms: int) -> list[WsTick]:
    """raw 1수신 → WsTick 목록. 컨트롤(JSON)·미지원 TR·암호화 프레임은 [].

    호출자(ws_client)는 JSON 컨트롤의 PINGPONG echo를 raw 첫 글자로 직접 판단한다
    — 파서는 데이터 프레임만 책임진다.
    """
    if not raw or raw[0] not in ("0", "1"):
        return []
    if raw[0] == "1":
        # 시세 3종은 평문. 암호문이 오면 구독 구성 오류 — 버리고 경고.
        _log.warning("live.ws.unexpected_encrypted_frame head=%s", raw[:32])
        return []
    try:
        _, tr_id, cnt_s, body = raw.split("|", 3)
        cnt = int(cnt_s)
        fields = body.split("^")
    except ValueError:
        _log.warning("live.ws.malformed_frame head=%s", raw[:64])
        return []

    return _dispatch(tr_id, fields, cnt=cnt, date=date, now_ms=now_ms)


def _dispatch(
    tr_id: str, fields: list[str], *, cnt: int, date: str, now_ms: int
) -> list[WsTick]:
    # KRX/NXT 호가·체결은 필드 레이아웃이 동일(ws_fields 주석)이라 같은 파서를
    # venue만 바꿔 재사용한다. venue는 tr_id로 결정(ws_fields.tr_venue).
    if tr_id in (F.TR_ORDERBOOK, F.TR_ORDERBOOK_NXT):
        return _parse_orderbook(fields, date=date, venue=F.tr_venue(tr_id))
    if tr_id in (F.TR_TRADE, F.TR_TRADE_NXT):
        return _parse_trades(fields, cnt=cnt, date=date, venue=F.tr_venue(tr_id))
    if tr_id == F.TR_MEMBER:  # 거래원은 KRX 전용(NXT 미구독)
        return _parse_member(fields, now_ms=now_ms)
    return []


def _parse_orderbook(f: list[str], *, date: str, venue: str = "KRX") -> list[WsTick]:
    if len(f) < F.ASP_MIN_FIELDS:
        _log.warning("live.ws.asp_short_frame n=%d", len(f))
        return []
    code = f[F.ASP_CODE]
    try:
        t_ms = _hhmmss_to_unix_ms(date, f[F.ASP_TIME_HHMMSS])
        payload = {
            "code": code,
            "t_ms": t_ms,
            "asks": [
                {"price": int(f[p]), "qty": int(f[q])}
                for p, q in zip(F.ASP_ASK_P, F.ASP_ASK_Q, strict=True)
            ],
            "bids": [
                {"price": int(f[p]), "qty": int(f[q])}
                for p, q in zip(F.ASP_BID_P, F.ASP_BID_Q, strict=True)
            ],
            "total_ask_qty": int(f[F.ASP_TOT_ASK_Q]),
            "total_bid_qty": int(f[F.ASP_TOT_BID_Q]),
        }
    except ValueError:
        # 숫자 필드 불량은 프레임 1건 손실로 격리 — recv 루프까지 전파 금지.
        _log.warning(
            "live.ws.bad_numeric_field tr=%s head=%s", F.TR_ORDERBOOK, "^".join(f)[:64]
        )
        return []
    return [WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.OB, payload=payload, venue=venue)]


def _parse_trades(f: list[str], *, cnt: int, date: str, venue: str = "KRX") -> list[WsTick]:
    if len(f) != cnt * F.CNT_FIELDS:
        # stride 불변식 — 어긋나면 레코드 k가 (k-1)필드씩 시프트되는
        # silent corruption(종목 오귀속 포함)이므로 프레임 전체를 버린다.
        _log.warning("live.ws.cnt_stride_mismatch n=%d cnt=%d", len(f), cnt)
        return []
    ticks: list[WsTick] = []
    for i in range(cnt):
        rec = f[i * F.CNT_FIELDS : (i + 1) * F.CNT_FIELDS]
        try:
            t_ms = _hhmmss_to_unix_ms(date, rec[F.CNT_TIME_HHMMSS])
            trade = {
                "t_ms": t_ms,
                "price": int(rec[F.CNT_PRICE]),
                "qty": int(rec[F.CNT_QTY]),
                "side": _SIDE_MAP.get(rec[F.CNT_SIDE], 0),
                "side_source": "kis_ws",
            }
        except ValueError:
            # 숫자 필드 불량은 레코드 1건 손실로 격리 — recv 루프까지 전파 금지.
            _log.warning(
                "live.ws.bad_numeric_field tr=%s head=%s",
                F.TR_TRADE,
                "^".join(rec)[:64],
            )
            continue
        ticks.append(
            WsTick(
                code=rec[F.CNT_CODE],
                t_ms=t_ms,
                kind=SnapshotKind.TRADE,
                payload={"trades": [trade]},
                venue=venue,
            )
        )
    return ticks


def _parse_member(f: list[str], *, now_ms: int) -> list[WsTick]:
    if len(f) < F.MBC_MIN_FIELDS:
        _log.warning("live.ws.mbc_short_frame n=%d", len(f))
        return []
    code = f[F.MBC_CODE]
    try:
        payload = {
            "code": code,
            "t_ms": now_ms,  # H0STMBC0엔 시간 필드 없음(spec §12) — 수신 시각 사용
            "sell_top": [
                {"name": f[n].strip(), "qty": int(f[q])}
                for n, q in zip(F.MBC_SELL_NAMES, F.MBC_SELL_QTYS, strict=True)
            ],
            "buy_top": [
                {"name": f[n].strip(), "qty": int(f[q])}
                for n, q in zip(F.MBC_BUY_NAMES, F.MBC_BUY_QTYS, strict=True)
            ],
        }
    except ValueError:
        # 숫자 필드 불량은 프레임 1건 손실로 격리 — recv 루프까지 전파 금지.
        _log.warning(
            "live.ws.bad_numeric_field tr=%s head=%s", F.TR_MEMBER, "^".join(f)[:64]
        )
        return []
    return [WsTick(code=code, t_ms=now_ms, kind=SnapshotKind.BROKER, payload=payload)]
