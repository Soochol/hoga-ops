"""키움 `1h` VI 이벤트 → 종목별 최신 상태 (10호가 VI 행 소스).

legend 는 실이벤트 60건으로 확정했다(docs/research/2026-07-21-kiwoom-vi-price-sources.md):
9069 발동방향 1=상승/2=하락 · 9068 발동구분 1=정적/2=동적/3=동적+정적 ·
해제 = 같은 프레임이 1224(해제시각)만 채워져 재발화 · _AL(통합)+bare(KRX) 중복 2row.

시장 전체 스트림에서 종목별 **최신 1건**만 유지한다(last-write-wins — _AL 중복도
자연 해소). 관측 캡처(kiwoom_vi_capture, raw 보존)와 별개로, 이 모듈은 표시 소비용
파싱만 담당한다. 예상 발동가는 프론트 계산(기준가×1.1/0.9 틱 반올림)이고, 여기의
trigger_price 는 발동 후 정적기준가의 근사(해제 단일가 ≈ 발동가 부근)로도 쓰인다.
"""
from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger(__name__)

# 실측 legend (2026-07-21, 60건 전건 무모순)
_DIRECTION = {"1": "up", "2": "down"}
_KIND = {"1": "static", "2": "dynamic", "3": "both"}


def _int_or_none(raw: object) -> int | None:
    """부호 prefix 가격/수량 문자열 → 양수 int. 0/빈/불량은 None("해당 없음" 규약 —
    동적VI 이벤트의 1236(정적기준)=0 처럼 0 이 미제공 센티널이다)."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().lstrip("+-")
    if not s.isdigit():
        return None
    v = int(s)
    return v if v > 0 else None


def _hhmmss_or_none(raw: object) -> str | None:
    if isinstance(raw, str):
        s = raw.strip()
        if len(s) == 6 and s.isdigit() and s != "000000":  # noqa: PLR2004
            return s
    return None


def parse_vi_row(row: dict[str, Any], now_ms: int) -> dict[str, Any] | None:
    """1h raw row → 상태 dict. 종목코드 부재/legend 밖 값은 None(드롭 + 경고).

    반환 shape 는 /api/live/vi-status 응답 그대로다(소비자 = BookPanel VI 행).
    """
    values = row.get("values")
    if not isinstance(values, dict):
        return None
    item = row.get("item")
    code = (values.get("9001") or "").strip() or (item if isinstance(item, str) else "")
    code = code.split("_", 1)[0]  # _AL/_NX 접미 제거 — 상태 키는 bare
    if len(code) != 6 or not code.isdigit():  # noqa: PLR2004
        return None
    direction = _DIRECTION.get((values.get("9069") or "").strip())
    kind = _KIND.get((values.get("9068") or "").strip())
    if direction is None or kind is None:
        # legend 밖 값 — 확정 표본(60건)에 없던 코드다. 드롭하되 경고로 표면화해
        # 새 코드값이 나타나면 채록(raw 는 kiwoom_vi_capture 에 남음)으로 재확정한다.
        _log.warning("live.kiwoom.vi_state_unknown_code 9069=%r 9068=%r code=%s",
                     values.get("9069"), values.get("9068"), code)
        return None
    released_at = _hhmmss_or_none(values.get("1224"))
    return {
        "code": code,
        "direction": direction,
        "kind": kind,
        "trigger_price": _int_or_none(values.get("1221")),
        "static_base": _int_or_none(values.get("1236")),
        "dynamic_base": _int_or_none(values.get("1237")),
        "triggered_at": _hhmmss_or_none(values.get("1223")),
        "released_at": released_at,
        "count": _int_or_none(values.get("1490")),
        "active": released_at is None,
        "recv_ms": now_ms,
    }


class KiwoomViState:
    """종목별 최신 VI 이벤트 상태. on_row 는 예외를 삼킨다(관측 훅 규율과 동일)."""

    def __init__(self) -> None:
        self._by_code: dict[str, dict[str, Any]] = {}

    def on_row(self, row: dict, now_ms: int) -> None:
        try:
            state = parse_vi_row(row, now_ms)
            if state is not None:
                self._by_code[state["code"]] = state
        except Exception:  # noqa: BLE001 — 상태 갱신 실패가 recv 루프를 못 해치게
            _log.warning("live.kiwoom.vi_state_failed", exc_info=True)

    def get(self, code: str) -> dict[str, Any] | None:
        return self._by_code.get(code)
