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
from hoga.live.venue import Venue

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

# kiwoom_live: 키움 WS 승격본(ADR-0116). **유일한 실시간 WS 티어**다 — ADR-0136이
# 실시간·폴링을 전부 키움으로 옮겼고, 같은 티어를 공유하던 KIS WS 승격본 `kis_live`는
# 소스에서 제거됐다(2026-08-06 · 잔존 데이터는 `_archive/kis_live/`). 종목 소유권 단일
# 원칙(한 종목 실시간 소스 하나)이라 한 stock-date엔 실시간 승격본이 하나만 존재한다.
#
# kis_api(2026-07-17 정책): **캔들 전용 소스**다. rest30 REST 호가 캡처가 제거되면서
# 호가·체결 계열(orderflow — /api/orderbook·/api/brokers/series·range의 호가/체결
# 차원)은 kis_api를 더는 서빙하지 않는다(소비 지점에서 억제 — bundle.orderflow_ok,
# routes._resolved_parquet_dir). 이 사다리에 kis_api tail을 유지하는 이유는 캔들:
# ADR-0109 복구 분봉(kis_api/candles.parquet)이 hogaplay 공백일에 이겨야 서빙된다.
#
# 이 사다리는 **호가·체결 차원의 승자**를 정한다. 캔들 차원은 대칭인 반대 필터가
# 필요해 별도 함수로 분리했다(ADR-0121: resolve_candle_source) — kis_api가 호가를
# 서빙하지 않고 실시간 승격본은 캔들을 **항상 보유하진** 않으므로(합성 실패일 —
# CANDLE_BEARING_SOURCES 주석 참조), 두 차원의 승자가 한 Stock-Date에서 갈릴 수 있다.
SourceName = Literal["hogaplay", "kiwoom_live", "kis_api"]

#: source 가 **어느 venue 를 덮는가**. 디렉터리 축 유무가 아니라 **커버리지**다.
#:
#: ⚠ 예전엔 `SOURCE_HAS_VENUE: dict[SourceName, bool]` 이었고, 그게 두 가지를 하나로
#: 뭉갰다 — *"venue 축이 없다"* 와 *"아무 venue 에나 유효하다"*. hogaplay 는 전자가
#: 아니라 **KRX 정규장 전용**인데 `False` 가 후자로 읽혀, NXT 를 요청해도 사다리
#: 1순위로 이기고 **KRX 데이터를 NXT 라고 돌려줬다**(실측 2026-08-05: 최근 6일 720건
#: 중 494건 = 69%). 빈 응답은 정직하지만 그건 조용히 틀린 답이었다.
#:
#: 집합으로 두면 두 사실이 한 값에서 나온다:
#:   - 디렉터리 축 — 원소가 둘 이상이면 `{source}/{venue}/`, 하나면 평면
#:   - 사다리 자격 — 요청 venue 를 안 덮는 source 는 후보에서 빠진다
SOURCE_VENUES: dict[SourceName, frozenset[Venue]] = {
    # 정규장 KRX 업스트림(전체 디렉터리의 78%). NXT 시간대를 원리적으로 못 준다.
    "hogaplay": frozenset({"KRX"}),
    "kiwoom_live": frozenset({"KRX", "NXT", "UN"}),
    "kis_api": frozenset({"KRX"}),    # 캔들 전용 복구본(ADR-0109)
}


def source_covers_venue(source: str, venue: Venue) -> bool:
    """이 source 가 그 venue 를 서빙할 수 있나. 모르는 source 는 보수적으로 KRX 전용.

    사다리 후보를 거르는 술어다. 안 걸면 KRX 전용 source 가 NXT 요청을 이기고
    **다른 시장 데이터를 그 시장 것처럼** 돌려준다.
    """
    return venue in SOURCE_VENUES.get(cast(SourceName, source), frozenset({"KRX"}))


def source_venue_dir(stock_date_dir: Path, source: str, venue: Venue) -> Path:
    """정본 경로 `{code}/{source}[/{venue}]` — **쓰기는 항상 이걸 쓴다.**

    venue 를 하나만 덮는 source 는 세그먼트를 붙이지 않는다(축이 없으므로).
    venue 를 **필수 인자**로 둔 이유: 기본값을 주면 호출부가 빠뜨렸을 때 조용히
    KRX 를 쓰고, 그게 곧 두 시장이 한 파일에 섞이는 경로다(ADR-0140 §3).
    """
    base = stock_date_dir / source
    covered = SOURCE_VENUES.get(cast(SourceName, source), frozenset({"KRX"}))
    return base / venue if len(covered) > 1 else base


MissingReason = Literal["stock_date_missing", "source_missing", "venue_unsupported"]
SourcePolicy = Literal[
    "hogaplay",
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
# 이 상수가 사다리와 **분리돼 있는** 이유는 삭제된 `kis_live`(KIS WS 승격본)가 남긴
# 교훈이다: 그 소스는 캔들을 쓰지 않았는데(ADR-0040/0043 — 캔들 차원은 Live Candle
# Backfill이 따로 서빙했다) 캔들 사다리엔 남아 있어, "건강한 승자가 이겼는데 그
# 승자에겐 캔들이 없다"가 성립했다. 그러면 같은 Stock-Date의 hogaplay 캔들과
# ADR-0109 복구본(kis_api)이 **동시에** 가려진다. 사다리는 소스 우선순위(정책)를
# 표현하고, 이 상수는 소스가 그 차원을 보유하는지(물리적 사실)를 표현한다 — 두 축을
# 섞으면 정책이 디스크 레이아웃에 오염된다.
#
# **kiwoom_live는 예외적으로 캔들을 보유한다**(ADR-0125가 ADR-0040/0043 개정):
# 키움 WS 체결 틱에서 수신 시점에 1분봉을 합성해 kiwoom_live/candles.parquet으로
# 승격한다(hoga/live/minute_candle_agg.py). 그래서 이 집합에 포함된다. 파일 존재
# 판정(resolve_candle_source)이 캔들 없는 날의 kiwoom_live를 자연히 걸러내므로,
# 캔들을 합성하지 못한 날엔 여전히 hogaplay/kis_api가 이긴다.
CANDLE_BEARING_SOURCES: frozenset[SourceName] = frozenset(
    {"hogaplay", "kis_api", "kiwoom_live"}
)

_POLICY_ORDER: dict[str, tuple[SourceName, ...]] = {
    "hogaplay": ("hogaplay", "kiwoom_live", "kis_api"),
    "hogaplay_first": ("hogaplay", "kiwoom_live", "kis_api"),
    "kis_ws_first": ("kiwoom_live", "kis_api", "hogaplay"),
    "kiwoom_live": ("kiwoom_live", "kis_api", "hogaplay"),
    "kiwoom_ws_first": ("kiwoom_live", "kis_api", "hogaplay"),
    "kis_api": ("kis_api", "kiwoom_live", "hogaplay"),
    "kis_api_first": ("kis_api", "kiwoom_live", "hogaplay"),
    # 완결성 등급이 1차 키이므로 이 사다리는 **동급 타이브레이크**로만 쓰인다
    # (둘 다 COMPLETE·둘 다 PARTIAL이면 WS 우선). WS-first 순서와 동일.
    "completeness_first": ("kiwoom_live", "kis_api", "hogaplay"),
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


def _venue_unsupported(source: SourceName) -> SourceResolution:
    """이 venue 를 줄 수 있는 source 가 없다 — 빈 응답 + 사유.

    "장애" 와 "이 시장엔 원래 없음" 을 호출부가 가를 수 있어야 한다. 사유 없이
    비우면 둘이 같아 보이고, 그러면 사용자는 재시도할지 포기할지 모른다.
    """
    return SourceResolution(
        source=source, path=None, classification=None,
        missing_reason="venue_unsupported",
    )


def resolve_source_result(
    engine: QueryEngine, date: str, code: str, pref: str, venue: str = "KRX",
) -> SourceResolution:
    # ⚠ venue 기본값의 **경계**: HTTP 라우트는 필수(`Query(...)`), 내부 헬퍼는 기본값이다.
    # 이 PR 이 막는 위험은 **프론트가 venue 를 안 보내 조용히 KRX 가 되는 것**이고 그건
    # HTTP 경계에서만 생긴다 — 이 함수의 유일한 프로덕션 호출자는 이미 라우트에서
    # venue 를 받는다. 내부까지 필수로 하면 venue 와 무관한 테스트 125개가 "KRX" 를
    # 채워 넣는 의식이 되고, 그 의식은 오히려 경계를 흐린다.
    # venue 를 못 덮는 source 는 **후보가 아니다**. 안 거르면 KRX 전용 source 가
    # NXT 요청을 사다리 순위로 이기고 다른 시장 데이터를 그 시장 것처럼 돌려준다.
    venue_v = cast(Venue, venue)
    order = tuple(s for s in ordered_sources(pref) if source_covers_venue(s, venue_v))
    if not order:
        # 이 venue 를 덮는 source 가 정책 사다리에 하나도 없다 — 빈 응답이 정답이고,
        # 사유를 실어 호출부가 "장애" 와 "이 시장엔 원래 없음" 을 가를 수 있게 한다.
        return _venue_unsupported(ordered_sources(pref)[0])
    sd_dir = engine.data_dir / "parquet" / date / code
    # `isinstance` 를 먼저 본다 — 테스트 더블(MagicMock)엔 `.exists()` 가 없다.
    # 단락 평가라 순서가 계약이다.
    if not isinstance(sd_dir, Path) or not sd_dir.exists():
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
        # ⚠ 평면 레이아웃은 **venue 축이 생기기 전** 데이터라 정의상 KRX 다.
        # NXT·통합 요청에 이걸 돌려주면 위 사다리 필터를 뒷문으로 우회한다.
        if venue_v != "KRX":
            return _venue_unsupported(order[0])
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
                path=source_venue_dir(sd_dir, winner, venue_v),
                classification=per_source[winner],
            )
        # healthy 없음(전부 INVALID/부재) → 아래 공통 폴백으로 진행.
    else:
        for source in order:
            if source in healthy:
                return SourceResolution(
                    source=source,
                    path=source_venue_dir(sd_dir, source, venue_v),
                    classification=per_source[source],
                )

    source = cast(SourceName, order[0])
    if source in per_source:
        return SourceResolution(
            source=source,
            path=source_venue_dir(sd_dir, source, venue_v),
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
    engine: QueryEngine, date: str, code: str, pref: str, venue: str = "KRX",
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
    # 캔들 후보도 같은 규율로 좁힌다 — `CANDLE_BEARING_SOURCES` 는 "캔들을 갖는가",
    # `source_covers_venue` 는 "그 시장을 갖는가". 둘 다 만족해야 후보다.
    venue_v = cast(Venue, venue)
    candle_order: tuple[SourceName, ...] = tuple(
        s for s in ordered_sources(candle_pref)
        if s in CANDLE_BEARING_SOURCES and source_covers_venue(s, venue_v)
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
        if (source_venue_dir(sd_dir, source, venue_v) / "candles.parquet").exists():
            return source
    return None
