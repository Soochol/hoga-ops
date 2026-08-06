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
)
from hoga.live.venue import Venue

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

# kiwoom_live: 키움 WS 승격본(ADR-0116). **유일한 실시간 WS 티어**다 — ADR-0136이
# 실시간·폴링을 전부 키움으로 옮겼고, 같은 티어를 공유하던 KIS WS 승격본 `kis_live`는
# 소스에서 제거됐다(2026-08-06 · 잔존 데이터는 `_archive/kis_live/`). 종목 소유권 단일
# 원칙(한 종목 실시간 소스 하나)이라 한 stock-date엔 실시간 승격본이 하나만 존재한다.
#
# **`kis_api` 는 제거됐다(2026-08-07).** ADR-0109 캔들 복구본의 네임스페이스였는데,
# 실측으로 남길 이유가 사라졌다:
#
#   - 882 파티션 전부 캔들만 보유(snapshots 0) — 호가 차원은 2026-07-17 에 이미 폐지
#   - 그중 실제로 서빙되던 것은 263 Stock-Date(나머지 619 는 다른 소스에 가려짐)
#   - 그 263 일은 **캔들 말고 아무것도 없다**(호가·체결·거래원 전부 0)
#   - 캔들은 벤더가 과거를 다시 주므로, REST 우회 OFF(기본)에서는 키움 `ka10080` 으로
#     그대로 온다 — 디스크 복구본이 필요한 것은 우회 ON 일 때뿐이었다
#
# 즉 "소급 불가라 지키던 데이터" 가 아니라 **다시 받을 수 있는 캐시**였다. 이름이
# 이미 거짓이기도 했다 — 생산자는 PR-J(#1046)에서 키움 `ka10080` 으로 바뀌었는데
# 라벨만 `kis_api` 로 남아 있었다(경로에 벤더명을 박은 대가).
#
# 이 사다리는 **호가·체결 차원의 승자**를 정한다. 캔들 차원은 대칭인 반대 필터가
# 필요해 별도 함수로 분리했다(ADR-0121: resolve_candle_source) — 실시간 승격본은
# 캔들을 **항상 보유하진** 않으므로(합성 실패일 — CANDLE_BEARING_SOURCES 주석 참조),
# 두 차원의 승자가 한 Stock-Date에서 갈릴 수 있다.
SourceName = Literal["hogaplay", "kiwoom_live"]

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
}


class VenueNotCoveredError(ValueError):
    """그 source 가 못 덮는 venue 로 경로를 조립하려 했다 — **프로그래밍 오류**다.

    데이터 부재(`source_missing`)와 다르다. 저쪽은 "있을 수 있는데 그날 없다" 이고
    이건 "원리적으로 있을 수 없는 조합" 이라, 빈 결과로 삼키면 안 되고 호출부의
    venue 필터 누락을 드러내야 한다. `ValueError` 를 상속해 기존 광범위 핸들러가
    잡던 자리는 그대로 잡는다.
    """


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

    ⚠ **커버리지 밖 조합은 예외다**(#1133). 그전엔 `source_venue_dir(sd, "hogaplay",
    "NXT")` 가 `sd/hogaplay` 를 **조용히** 돌려줬다 — hogaplay 는 venue 를 하나만
    덮어 세그먼트가 안 붙기 때문이다. 즉 NXT 를 물었는데 KRX 경로가 나왔다.

    "사다리가 미리 거르니 도달하지 않는다" 는 방어가 실제로 뚫렸다(실측 2026-08-07):
    `_resolve_trade_indicator_source` 는 사다리가 아니라 `ordered_sources` 전체를
    순회해 체결 지표 소스를 재선택하는데, 거기엔 venue 필터가 없어 venue=NXT 요청이
    hogaplay 를 골랐다 — 매물대·거래량 POC 가 KRX 데이터로 계산됐다.

    그래서 방어를 **경로 조립 지점**으로 내린다. 호출부마다 필터를 기억해야 하는
    규율은 한 곳만 빠뜨려도 조용히 틀리지만, 여기서 던지면 시끄럽게 틀린다.
    """
    covered = SOURCE_VENUES.get(cast(SourceName, source), frozenset({"KRX"}))
    if venue not in covered:
        raise VenueNotCoveredError(
            f"source {source!r} does not cover venue {venue!r} "
            f"(covers {sorted(covered)}) — 호출부가 사다리의 venue 필터를 우회했다",
        )
    base = stock_date_dir / source
    return base / venue if len(covered) > 1 else base


MissingReason = Literal["stock_date_missing", "source_missing", "venue_unsupported"]
# 구 정책 문자열들 — 값은 무시되지만(옵션 폐지) 저장된 설정·구 URL 이 여전히 보낸다.
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

# 캔들 차원 후보 — candles.parquet을 실제로 쓰는 Source만.
#
# 이 상수가 사다리와 **분리돼 있는** 이유는 삭제된 `kis_live`(KIS WS 승격본)가 남긴
# 교훈이다: 그 소스는 캔들을 쓰지 않았는데(ADR-0040/0043 — 캔들 차원은 Live Candle
# Backfill이 따로 서빙했다) 캔들 사다리엔 남아 있어, "건강한 승자가 이겼는데 그
# 승자에겐 캔들이 없다"가 성립했다. 그러면 같은 Stock-Date 의 다른 소스 캔들이
# 가려진다. 사다리는 소스 우선순위(정책)를 표현하고, 이 상수는 소스가 그 차원을
# 보유하는지(물리적 사실)를 표현한다 — 두 축을 섞으면 정책이 디스크 레이아웃에
# 오염된다.
#
# **kiwoom_live는 예외적으로 캔들을 보유한다**(ADR-0125가 ADR-0040/0043 개정):
# 키움 WS 체결 틱에서 수신 시점에 1분봉을 합성해 kiwoom_live/candles.parquet으로
# 승격한다(hoga/live/minute_candle_agg.py). 파일 존재 판정(resolve_candle_source)이
# 캔들 없는 날의 kiwoom_live를 자연히 걸러내므로, 합성하지 못한 날엔 hogaplay가 이긴다.
#
# 지금은 두 소스 모두 캔들을 가져 집합이 사다리와 같지만, **두 축은 여전히 별개**다 —
# 캔들 없는 소스가 다시 생기면 이 집합만 줄어든다(사다리는 그대로).
CANDLE_BEARING_SOURCES: frozenset[SourceName] = frozenset({"hogaplay", "kiwoom_live"})

#: **단일 사다리** — 소스 선호 옵션 폐지(2026-08-07).
#:
#: 예전엔 정책별로 순서가 갈렸고(`hogaplay_first`·`kis_ws_first`·`completeness_first`)
#: 사용자가 설정에서 골랐다. 그 선택지가 **venue 비교를 깨뜨린다**는 것이 폐지 이유다:
#: hogaplay 는 KRX 만 덮으므로(`SOURCE_VENUES`), 그것이 1순위인 정책에서는
#: KRX 는 hogaplay 로, NXT·통합은 kiwoom_live 로 계산된다 — venue 를 토글하면 시장과
#: 소스가 **동시에** 바뀌어, 값 차이가 시장 차이인지 업스트림 차이인지 알 수 없다.
#: 실측(2026-08-06, 010060·475150·028670): `KRX=hogaplay  NXT=kiwoom_live  UN=kiwoom_live`.
#:
#: 정답이 하나뿐이면 그건 옵션이 아니라 동작이다. `completeness_first` 도 같은 이유로
#: 뺐다 — NXT 는 후보가 kiwoom_live 하나뿐이라 완결성 비교가 성립하지 않고 KRX 만
#: 갈리므로, **어떤 날은 대칭이고 어떤 날은 아닌** 가장 예측하기 어려운 선택지였다.
#:
#: 순서의 근거: 수집 주력이 이미 키움이다(실측 2026-08: hogaplay 0~25건/일 vs
#: kiwoom_live 247~273건/일, 8/5 는 hogaplay 0건). hogaplay 는 **kiwoom_live 가 없는
#: 과거 구간의 폴백**으로 남고, 그 구간은 애초에 NXT 데이터가 없어 대칭이 훼손되지 않는다.
#:
#: 치르는 값: hogaplay 아카이브가 30배 촘촘해(하루 71,453행 vs 2,404행) 과거 KRX 지표가
#: 달라진다 — 실측 중앙 0.7% / 90분위 8.8% / 최대 101.5%. 차이는 **잔량이 급변한 분**에
#: 몰린다. 사용자 결정으로 비교 가능성을 택했다.
ORDERFLOW_LADDER: tuple[SourceName, ...] = ("kiwoom_live", "hogaplay")

# 캔들 차원도 **같은 사다리**를 쓴다(2026-08-07). 예전엔 정책별 별칭(`_CANDLE_POLICY_ALIAS`)
# 으로 캔들만 hogaplay 우선으로 되돌렸는데, 그 별칭이 존재한 이유는 `completeness_first`
# 의 WS-first 순서가 kis_api 를 hogaplay 앞에 놓는 것이었다. 그 소스가 사라져 별칭도
# 함께 제거했다. 승자는 `resolve_candle_source` 가 `candles.parquet` 존재로 정한다.


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


def ordered_sources(policy: str = "") -> tuple[SourceName, ...]:
    """소스 사다리 — **정책과 무관하게 하나**다(2026-08-07). 근거는 `ORDERFLOW_LADDER`.

    인자를 남긴 이유는 배관 제거를 별도 단계로 미뤘기 때문이다(`source_pref` 가 20개
    파일·123줄에 퍼져 있다). 값을 무시하되 **검증도 하지 않는다** — 옵션이 사라졌으니
    "모르는 정책" 이라는 개념 자체가 없고, 구 URL·저장된 설정이 오면 조용히 새 사다리로
    수렴하는 편이 사용자에게 낫다.
    """
    return ORDERFLOW_LADDER


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

    # 사다리 순서대로 첫 non-INVALID. **완결성 등급 정렬은 폐지**했다(2026-08-07) —
    # 그 방식은 KRX 에서만 소스가 갈리고(NXT 는 후보가 kiwoom_live 하나뿐이라 비교 자체가
    # 성립하지 않는다) 그래서 **어떤 날은 venue 대칭이고 어떤 날은 아니었다**. 사용자는
    # 그게 언제인지 알 수 없었고 화면에도 안 나왔다.
    #
    # 부분 결손일에 더 완결한 소스를 고르던 이점은 잃는다(실측 2026-08-06: 키움 54분 vs
    # hogaplay 401분인 날이 있었다). 그 날을 사용자가 알 수 있도록 **소스 배지**가 승자와
    # 완결 상태를 표시한다 — 자동으로 소스를 바꾸는 대신 무엇을 보고 있는지 보여 준다.
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
    # 캔들 후보도 같은 규율로 좁힌다 — `CANDLE_BEARING_SOURCES` 는 "캔들을 갖는가",
    # `source_covers_venue` 는 "그 시장을 갖는가". 둘 다 만족해야 후보다.
    venue_v = cast(Venue, venue)
    candle_order: tuple[SourceName, ...] = tuple(
        s for s in ordered_sources(pref)
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
