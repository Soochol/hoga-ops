"""키움 업종지수(0J)·업종등락(0U) REAL 프레임 파서 — `/market` 실시간 오버레이용.

종목 틱(`kiwoom_frames`)과 **파일을 나눈 이유**는 길이가 아니라 계약이 다르기 때문이다.
종목 파서는 `WsTick`(SnapshotKind·venue·저장 파이프라인)을 만들지만, 업종·지수는
저장 축이 없는 **표시 전용 관측**이고 venue 개념도 없다(`_NX`/`_AL` 접미가 이 두
타입에는 오지 않는다). 한 파일에 두면 venue·저장 규율이 업종에도 있는 것처럼 읽힌다.

## 부호 규율 — 이 파일의 존재 이유 절반

키움은 **지수 레벨에도 등락 방향 부호를 접두로** 실어 보낸다. 실측(2026-08-07):

    0J 150 → {"10": "-1327.93", "16": "+1383.62", "11": "-43.69", "12": "-3.19"}

`10`(현재지수)의 `-` 는 "지수가 음수" 가 아니라 "하락 중" 이다. 그대로 float 로 읽으면
하락장에서 전 지수가 음수가 된다 — `ka20003` 이 정확히 그 버그였고 화면이 등락률만
쓰고 있어서 오래 잠복했다. 그래서 레벨(10·16·17·18)은 `abs`, 등락(11·12)은 그대로.

## 0J 와 0U 는 서로를 덮지 않는다

같은 업종코드에 두 타입이 각각 온다. 0J 는 레벨·시고저, 0U 는 등락종목수를 준다(둘 다
지수값과 거래대금을 싣는다). 그래서 파서는 **그 프레임이 실제로 준 필드만** 채우고
나머지는 `None` 으로 남긴다 — 병합은 세션(`KiwoomSessionManager`)의 몫이다. 파서가
빈 필드를 0 으로 채우면 0U 틱 하나가 0J 가 세워 둔 시가·고가를 지운다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import kiwoom_fields as K

#: 백만원 → 억원. `ka20003`(`trde_prica`)과 같은 축으로 맞춘다 — 한 화면에서 폴링
#: 값과 WS 값이 번갈아 그려지므로 단위가 어긋나면 100배 점프로 나타난다.
_MWON_PER_EOK = 100.0


@dataclass(frozen=True)
class SectorTick:
    """업종·지수 1틱. **그 프레임이 준 필드만** 채워지고 나머지는 None 이다.

    `None` 은 "값이 0" 이 아니라 "이 프레임이 말하지 않았다" 는 뜻이다 — 병합하는
    쪽이 기존 값을 유지해야 한다.
    """

    code: str
    #: 원본 타입("0J"/"0U") — 병합·관측에서 어느 축이 살아 있는지 가른다.
    kind: str
    hhmmss: str
    value: float | None = None
    change: float | None = None
    change_pct: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    cum_volume: int | None = None
    trade_value_eok: float | None = None
    rising: int | None = None
    falling: int | None = None
    flat: int | None = None
    upper: int | None = None
    lower: int | None = None
    traded_count: int | None = None
    traded_pct: float | None = None


def _level(values: dict[str, str], fid: str) -> float | None:
    """지수 **레벨** — 부호를 벗긴다(접두 부호는 값이 아니라 등락 방향이다)."""
    n = _signed(values, fid)
    return None if n is None else abs(n)


def _signed(values: dict[str, str], fid: str) -> float | None:
    """부호가 곧 값인 필드(전일대비·등락률). 빈 문자열·`+`/`-` 단독은 None."""
    raw = values.get(fid)
    if raw is None:
        return None
    s = str(raw).strip().replace(",", "")
    if not s or s in {"+", "-"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _count(values: dict[str, str], fid: str) -> int | None:
    n = _signed(values, fid)
    return None if n is None else int(abs(n))


def parse_sector_row(row: dict[str, Any]) -> SectorTick | None:
    """REAL row 1건 → `SectorTick`. 0J/0U 가 아니거나 코드가 없으면 None.

    **시각을 ms 로 바꾸지 않는다.** 이 표면은 저장 축이 없어 날짜 앵커가 필요 없고,
    `HHMMSS` 를 그대로 실어 두면 "언제 온 값인가" 를 화면이 벤더 시각 그대로 말할 수
    있다. 수신 시각으로 덮으면 벤더 지연이 화면에서 사라진다.
    """
    kind = row.get("type")
    if kind not in (K.TYPE_SECTOR_INDEX, K.TYPE_SECTOR_UPDOWN):
        return None
    code = str(row.get("item") or "").strip()
    if not code:
        return None
    v: dict[str, str] = row.get("values") or {}

    cum_value = _signed(v, K.SEC_CUM_VALUE)
    common = {
        "code": code,
        "kind": kind,
        "hhmmss": str(v.get(K.SEC_TIME) or "").strip(),
        "value": _level(v, K.SEC_PRICE),
        "change": _signed(v, K.SEC_DELTA),
        "change_pct": _signed(v, K.SEC_CHANGE_PCT),
        "cum_volume": _count(v, K.SEC_CUM_VOLUME),
        # 거래대금은 방향 부호가 붙을 이유가 없지만, 붙어 와도 크기만 쓴다.
        "trade_value_eok": None if cum_value is None else abs(cum_value) / _MWON_PER_EOK,
    }
    if kind == K.TYPE_SECTOR_INDEX:
        return SectorTick(
            **common,
            open=_level(v, K.SEC_OPEN),
            high=_level(v, K.SEC_HIGH),
            low=_level(v, K.SEC_LOW),
        )
    return SectorTick(
        **common,
        rising=_count(v, K.SEC_UP_COUNT),
        falling=_count(v, K.SEC_DOWN_COUNT),
        flat=_count(v, K.SEC_FLAT_COUNT),
        upper=_count(v, K.SEC_UPPER_COUNT),
        lower=_count(v, K.SEC_LOWER_COUNT),
        traded_count=_count(v, K.SEC_TRADED_COUNT),
        traded_pct=_signed(v, K.SEC_TRADED_PCT),
    )


def merge_tick(prev: dict[str, Any] | None, tick: SectorTick) -> dict[str, Any]:
    """직전 스냅샷 위에 틱을 얹는다 — **None 은 덮지 않는다**.

    0J 와 0U 가 서로 다른 필드를 주므로 단순 교체는 상대의 값을 지운다(0U 틱이
    시가·고가를 날리고, 0J 틱이 등락종목수를 날린다). 한 화면에 둘이 같이 그려지는
    이상 병합은 필드 단위여야 한다.
    """
    out = dict(prev or {})
    for key, value in tick.__dict__.items():
        if key == "kind":
            continue
        if value is not None:
            out[key] = value
    # 어느 축이 마지막으로 살아 있었는지 — 관측용(0U 가 안 오는 `603` 을 결손으로
    # 오인하지 않으려면 축별 최종 수신을 따로 봐야 한다).
    out[f"last_{tick.kind}_hhmmss"] = tick.hhmmss
    return out
