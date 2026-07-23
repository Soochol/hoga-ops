"""Source-name resolution for /api routes."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, cast

from hoga.api.disk_state import (
    Classification,
    DiskState,
    classify_from_meta,
    classify_stock_date,
    completeness_rank,
)

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

# kiwoom_live: 키움 WS 승격본(ADR-0116). kis_live와 같은 실시간 WS 티어라 우선순위도
# kis_live 인접(뒤). 종목 소유권 단일 원칙(한 종목 실시간 소스 하나)이라 보통 한
# stock-date엔 kis_live/kiwoom_live 중 하나만 존재 — 순서는 전환기 이중구독 시에만 유효.
#
# kis_api(2026-07-17 정책): **캔들 전용 소스**다. rest30 REST 호가 캡처가 제거되면서
# 호가·체결 계열(orderflow — /api/orderbook·/api/brokers/series·range의 호가/체결
# 차원)은 kis_api를 더는 서빙하지 않는다(소비 지점에서 억제 — bundle.orderflow_ok,
# routes._resolved_parquet_dir). 이 사다리에 kis_api tail을 유지하는 이유는 캔들:
# ADR-0109 복구 분봉(kis_api/candles.parquet)이 hogaplay 공백일에 이겨야 서빙된다.
#
# 이 사다리는 **호가·체결 차원의 승자**를 정한다. 캔들 차원은 대칭인 반대 필터가
# 필요해 별도 함수로 분리했다(ADR-0121: resolve_candle_source) — kis_api가 호가를
# 서빙하지 않듯 kis_live/kiwoom_live는 캔들을 서빙하지 않으므로, 두 차원의 승자가
# 한 Stock-Date에서 갈릴 수 있다.
SourceName = Literal["hogaplay", "kis_live", "kiwoom_live", "kis_api"]
MissingReason = Literal["stock_date_missing", "source_missing"]
SourcePolicy = Literal[
    "hogaplay",
    "kis_live",
    "kiwoom_live",
    "kis_api",
    "hogaplay_first",
    "kis_ws_first",
    "kiwoom_ws_first",
    "kis_api_first",
    "completeness_first",
]

# completeness_first(ADR-0124): 호가·체결 차원을 **완결성 등급**으로 고른다 —
# 기존 정책들이 "사다리에서 첫 non-INVALID"를 쓰는 것과 달리, 소스를
# (완결성 등급, 사다리 위치)로 정렬해 가장 완결한 소스를 채택하고, 동급이면
# 사다리 순서(WS 우선)로 타이브레이크한다. 판정 자체는 재구현하지 않고
# resolve_source_result가 이미 계산하는 per_source[*].state(= classify_from_meta,
# 캡처 게이트와 동일 SSOT)를 그대로 소비한다.
_COMPLETENESS_POLICIES: frozenset[str] = frozenset({"completeness_first"})

# 캔들 차원 후보 — candles.parquet을 실제로 쓰는 Source만.
#
# 실시간 WS 승격본(kis_live/kiwoom_live)은 캔들을 절대 쓰지 않는다(ADR-0040/0043:
# 캔들 차원은 Live Candle Backfill이 따로 서빙). 이들을 캔들 사다리에 남겨두면
# "건강한 승자가 이겼는데 그 승자에겐 캔들이 없다"가 성립해, 같은 Stock-Date의
# hogaplay 캔들과 ADR-0109 복구본(kis_api)이 **동시에** 가려진다. 사다리는 소스
# 우선순위(정책)를 표현하고, 이 상수는 소스가 그 차원을 보유하는지(물리적 사실)를
# 표현한다 — 두 축을 섞으면 정책이 디스크 레이아웃에 오염된다.
#
# ADR-0118(키움 전담) 이후 모든 거래일이 kiwoom_live 파티션을 갖게 되면서 이
# 필터 없이는 hogaplay가 INVALID인 날의 캔들이 **항상** 사라진다.
CANDLE_BEARING_SOURCES: frozenset[SourceName] = frozenset({"hogaplay", "kis_api"})

_POLICY_ORDER: dict[str, tuple[SourceName, ...]] = {
    "hogaplay": ("hogaplay", "kis_live", "kiwoom_live", "kis_api"),
    "hogaplay_first": ("hogaplay", "kis_live", "kiwoom_live", "kis_api"),
    "kis_live": ("kis_live", "kiwoom_live", "kis_api", "hogaplay"),
    "kis_ws_first": ("kis_live", "kiwoom_live", "kis_api", "hogaplay"),
    "kiwoom_live": ("kiwoom_live", "kis_live", "kis_api", "hogaplay"),
    "kiwoom_ws_first": ("kiwoom_live", "kis_live", "kis_api", "hogaplay"),
    "kis_api": ("kis_api", "kis_live", "kiwoom_live", "hogaplay"),
    "kis_api_first": ("kis_api", "kis_live", "kiwoom_live", "hogaplay"),
    # 완결성 등급이 1차 키이므로 이 사다리는 **동급 타이브레이크**로만 쓰인다
    # (둘 다 COMPLETE·둘 다 PARTIAL이면 WS 우선). WS-first 순서와 동일.
    "completeness_first": ("kis_live", "kiwoom_live", "kis_api", "hogaplay"),
}

# 캔들 차원은 완결성 타이브레이크를 적용하지 않는다(사용자 결정 2026-07-23):
# 이 설정은 호가·체결 전용이고 캔들은 'KIS API 우회' 토글이 단독 결정한다.
# completeness_first의 WS-first 사다리를 그대로 캔들에 쓰면 후보가 (kis_api,
# hogaplay) 순이 되어 ADR-0109 복구본이 hogaplay를 앞서는 미묘한 변화가 생기므로,
# 캔들 사다리는 오늘 기본(hogaplay 우선)으로 되돌린다.
_CANDLE_POLICY_ALIAS: dict[str, str] = {
    "completeness_first": "hogaplay_first",
}


@dataclass(frozen=True, slots=True)
class SourceResolution:
    """Resolved read-path Source plus the disk facts that made it win.

    ``source`` is always populated so callers can echo a Source honestly even
    when the Stock-Date is absent. ``path`` and ``classification`` are populated
    only when the winning Source has a readable ``meta.json`` on disk.
    """

    source: SourceName
    path: Path | None
    classification: Classification | None
    missing_reason: MissingReason | None = None


def ordered_sources(policy: str) -> tuple[SourceName, ...]:
    try:
        return _POLICY_ORDER[policy]
    except KeyError as e:
        raise ValueError(f"unknown source policy: {policy}") from e


def _classify_flat_legacy_meta(stock_date_dir: Path) -> Classification | None:
    """Classify pre-ADR-0037 flat Stock-Date layout when present."""
    meta_path = stock_date_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return Classification(state=DiskState.INVALID)
    return classify_from_meta(meta)


def resolve_source_result(
    engine: QueryEngine, date: str, code: str, pref: str,
) -> SourceResolution:
    order = ordered_sources(pref)
    sd_dir = engine.data_dir / "parquet" / date / code
    if not isinstance(sd_dir, Path):
        return SourceResolution(
            source=order[0],
            path=None,
            classification=None,
            missing_reason="stock_date_missing",
        )
    if not sd_dir.exists():
        return SourceResolution(
            source=order[0],
            path=None,
            classification=None,
            missing_reason="stock_date_missing",
        )

    per_source = classify_stock_date(sd_dir)

    # Legacy flat layout has no source subdirectory. Preserve the old contract:
    # the requested first Source wins, and QueryEngine resolves it to sd_dir.
    flat_classification = _classify_flat_legacy_meta(sd_dir)
    if not per_source and flat_classification is not None:
        return SourceResolution(
            source=order[0],
            path=sd_dir,
            classification=flat_classification,
        )

    healthy = {
        source
        for source, classification in per_source.items()
        if classification.state != DiskState.INVALID
    }

    if pref in _COMPLETENESS_POLICIES:
        # 완결성 등급(1차) → 사다리 위치(2차, WS-first 타이브레이크)로 최상 선택.
        # INVALID는 healthy에서 이미 배제 — "부패 데이터는 서빙 안 함" 계약 유지.
        ranked = sorted(
            (
                (completeness_rank(per_source[source].state), idx, source)
                for idx, source in enumerate(order)
                if source in healthy
            ),
            key=lambda t: (t[0], t[1]),
        )
        if ranked:
            winner = cast(SourceName, ranked[0][2])
            return SourceResolution(
                source=winner,
                path=sd_dir / winner,
                classification=per_source[winner],
            )
        # healthy 없음(전부 INVALID/부재) → 아래 공통 폴백으로 진행.
    else:
        for source in order:
            if source in healthy:
                return SourceResolution(
                    source=source,
                    path=sd_dir / source,
                    classification=per_source[source],
                )

    source = cast(SourceName, order[0])
    if source in per_source:
        return SourceResolution(
            source=source,
            path=sd_dir / source,
            classification=per_source[source],
        )
    return SourceResolution(
        source=source,
        path=None,
        classification=None,
        missing_reason="source_missing",
    )


def resolve_source(engine: QueryEngine, date: str, code: str, pref: str) -> SourceName:
    return resolve_source_result(engine, date, code, pref).source


def resolve_candle_source(
    engine: QueryEngine, date: str, code: str, pref: str,
) -> SourceName | None:
    """이 (date, code)의 캔들을 서빙할 Source — 없으면 ``None``.

    호가·체결 차원의 승자(:func:`resolve_source_result`)와 **독립적으로** 정한다.
    소스마다 보유 차원이 다르므로 한 Stock-Date의 호가 승자와 캔들 승자가 갈릴 수
    있다(예: 호가는 kiwoom_live 승격본, 캔들은 hogaplay 또는 ADR-0109 복구본).

    후보는 ``CANDLE_BEARING_SOURCES``로 좁히고, 정책 사다리 순서대로
    ``INVALID가 아니면서 candles.parquet이 실제로 있는`` 첫 Source를 고른다.
    파일 존재까지 보는 이유: 캔들 없이 끝난 hogaplay 캡처가 healthy로 남아
    복구본을 가리는 것을 막는다. 승자가 없으면 ``None`` — 호출부는 캔들만
    비우고 호가 차원은 정상 서빙한다(그날 전체를 버리지 않는다).
    """
    # 캔들 차원은 완결성 타이브레이크 대상이 아니다 — completeness_first는 캔들에서
    # 오늘 기본(hogaplay 우선) 사다리로 되돌린다(_CANDLE_POLICY_ALIAS).
    candle_pref = _CANDLE_POLICY_ALIAS.get(pref, pref)
    candle_order: tuple[SourceName, ...] = tuple(
        s for s in ordered_sources(candle_pref) if s in CANDLE_BEARING_SOURCES
    )
    if not candle_order:
        return None
    sd_dir = engine.data_dir / "parquet" / date / code
    if not isinstance(sd_dir, Path):
        # Path가 아닌 엔진(테스트 더블) — 디스크 사실을 확인할 수 없으므로
        # resolve_source_result와 같은 계약으로 사다리 첫 후보를 돌려준다.
        return candle_order[0]
    if not sd_dir.exists():
        return None
    per_source = classify_stock_date(sd_dir)
    for source in candle_order:
        classification = per_source.get(source)
        if classification is None or classification.state == DiskState.INVALID:
            continue
        if (sd_dir / source / "candles.parquet").exists():
            return source
    return None
