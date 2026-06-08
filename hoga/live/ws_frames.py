"""KIS WS 프레임 → Live Tick 순수 파서. I/O 없음 — fixture로 완전 테스트 가능.

payload 형태는 poller 시절 JSONL payload와 키-호환(shape-compat; 키 순서·phase
키는 다르며 promote는 무영향)을 유지해 promote._parse_jsonl_to_records 와
프론트 bucketHogaSeries 가 무변경으로 동작한다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.broker_names import canonical

from . import ws_fields as F
from .snapshot import SnapshotKind

_log = logging.getLogger(__name__)

_SIDE_MAP = {"1": 1, "5": -1}  # 그 외('3' 장전 등) → 0 (Auction Cross 규약과 동일)


@dataclass(frozen=True)
class WsTick:
    """Live Tick — WS 1메시지에서 나온 1개 도메인 이벤트 (CONTEXT.md 'Live Tick')."""

    code: str
    t_ms: int
    kind: SnapshotKind
    payload: dict[str, Any]


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
    if tr_id == F.TR_ORDERBOOK:
        return _parse_orderbook(fields, date=date)
    if tr_id == F.TR_TRADE:
        return _parse_trades(fields, cnt=cnt, date=date)
    if tr_id == F.TR_MEMBER:
        return _parse_member(fields, now_ms=now_ms)
    return []


def _parse_orderbook(f: list[str], *, date: str) -> list[WsTick]:
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
    return [WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.OB, payload=payload)]


def _parse_trades(f: list[str], *, cnt: int, date: str) -> list[WsTick]:
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
            # canonical(spec 2026-06-08 P2 #10): 삭제된 REST fetch_brokers가
            # 경계에서 하던 정규화 승계 — live(raw '신한증권')와 replay
            # (brokers.parquet 읽기 canonical '신한투자증권')의 거래원 식별자를
            # 통일. _unknown_seen dedup이라 미지 별칭 경보는 1회뿐 + unknown_alias
            # 계측이 캡처 경로에 복원된다.
            "sell_top": [
                {"name": canonical(f[n].strip()), "qty": int(f[q])}
                for n, q in zip(F.MBC_SELL_NAMES, F.MBC_SELL_QTYS, strict=True)
            ],
            "buy_top": [
                {"name": canonical(f[n].strip()), "qty": int(f[q])}
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
