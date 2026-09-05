"""BE↔FE REST wire-mirror drift guards for hand-mirrored API types.

ADR-0004 intentionally ships Pydantic wire models verbatim while the frontend
mirrors TypeScript types by hand. These snapshots make Watchlist/Heatmap REST
field changes loud, especially where the two domains look similar but differ
in capture/scheduler fields.

네 층을 지킨다:

1. **필드 이름** — ``EXPECTED_REST_WIRE_FIELDS`` 스냅샷.
2. **enum 값** — ``WIRE_ENUM_MIRRORS`` 가 백엔드 ``Literal`` 멤버를 프론트 union
   **소스 파일과 직접 대조**한다.
3. **wire model 존재 여부** — ``-> dict`` 라우트를 금지한다. 1·2번은 wire model 이
   있어야 볼 수 있어서, 없는 라우트는 두 층 모두의 사각지대다.
4. **JSONResponse body** — 3번은 ``Response`` 계열을 대상 밖으로 두는데, 그중 일부는
   진짜 JSON body 를 만든다. ``response_model`` 이 Response 를 그대로 흘리므로 그
   body 도 사각지대다. 그런 라우트는 등록과 사유를 요구한다.

2번이 왜 따로 필요한가: 손 미러에서 값 드리프트는 **타입이 원리적으로 못 잡는다**.
#1183 이 그 사고였다 — 백엔드가 ``capture_reason`` 값 4개를 뺐는데 프론트 라벨 표는
1년 가까이 그대로였고, 정작 새로 생긴 값은 매핑이 없어 영문 원문으로 노출됐다.
프론트 안에서 union↔테이블을 exhaustive 로 묶어도 그건 **프론트 내부** lockstep 일
뿐이라, 백엔드만 늘어나는 방향은 여전히 무증상이다. 이 대조가 그 방향을 막는다.

3번이 왜 필요한가: 반환형이 ``dict`` 면 FastAPI 가 검증할 shape 이 없어서 1·2번
가드가 **원리적으로 볼 수 없다**. ADR-0004 의 "Wire Model = 소비자가 받는 것" 전제가
거기선 성립하지 않는다 — 그 라우트의 wire shape 은 어디에도 선언돼 있지 않다.
처음 쟀을 때 108개 중 27개가 그랬고, 네 배치에 걸쳐 **전부 해소했다**. 동결선은 이제
비어 있고, 그래서 이 층은 "모든 라우트는 계약을 갖고 태어난다" 를 강제한다.

4번이 왜 필요한가: 그 두 라우트(``/health``·``/config.json``)는 status code 를 바꾸거나
헤더를 붙이려고 ``JSONResponse`` 를 직접 만든다 — 정당한 이유라 ``response_model`` 로
바꿀 수 없다. 대신 body 를 모델로 만들거나 모델로 검증하게 하고, 이 층이 그 등록을
요구한다. ``/config.json`` 의 ``api_url`` 은 틀리면 **화면이 통째로 죽는** 값이다(실제
사고 2026-08-03).

ADR-0004 가 기각한 codegen 이 아니다 — 손 미러를 유지하고 어긋남만 검출한다.
같은 ADR 의 "both must be updated in the same PR" 이 이 테스트가 강제하는 규칙이다.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Literal, get_args, get_origin

from hoga.api import events, models as m, sources
from hoga.live import futures_runtime, market_overview
from hoga.live.api import AfterHoursBookResponse, LiveQuote
from hoga.live.error_policy import LiveErrorKind
from hoga.live.investor import InvestorNetUnit
from hoga.live.lifecycle import LiveStatus

_REPO_ROOT = Path(__file__).resolve().parents[3]

EXPECTED_REST_WIRE_FIELDS: dict[str, frozenset[str]] = {
    "WatchlistFolderView": frozenset({"id", "name", "order"}),
    # 최대벽(ADR-0076/0084/0156) — 프론트 미러는 `frontend/src/api/types.ts` 의
    # `AskPeak`/`BidPeak` 이고 **두 타입이 같은 필드 집합**이다(백엔드도 동일). 그래서
    # 한쪽만 늘리는 실수가 이 표에서 곧바로 드러난다.
    #
    # ⚠ 이 모델은 **2026-09-05 까지 이 표에 없었다** — `traded_bar_*` 를 추가하며
    # 등록했다. 그전까지 최대벽 wire 는 1층이 통째로 못 보는 사각지대였고, 실제로
    # `traded_record_*`·`unreached_*` 두 계열이 가드 없이 들어왔다.
    "AskPeak": frozenset(
        {
            "all_bar_max_peaks",
            "all_bar_peaks",
            "all_max_peaks",
            "all_max_price",
            "all_max_qty",
            "all_max_t_ms",
            "all_peaks",
            "all_price",
            "all_qty",
            "all_t_ms",
            "date",
            "max_price",
            "max_qty",
            "max_t_ms",
            "price",
            "qty",
            "t_ms",
            "traded_bar_max_peaks",
            "traded_bar_peaks",
            "traded_max_peaks",
            "traded_peaks",
            "traded_record_max_peaks",
            "traded_record_peaks",
            "unreached_peaks",
            "unreached_price",
            "unreached_qty",
            "unreached_t_ms",
        }
    ),
    "BidPeak": frozenset(
        {
            "all_bar_max_peaks",
            "all_bar_peaks",
            "all_max_peaks",
            "all_max_price",
            "all_max_qty",
            "all_max_t_ms",
            "all_peaks",
            "all_price",
            "all_qty",
            "all_t_ms",
            "date",
            "max_price",
            "max_qty",
            "max_t_ms",
            "price",
            "qty",
            "t_ms",
            "traded_bar_max_peaks",
            "traded_bar_peaks",
            "traded_max_peaks",
            "traded_peaks",
            "traded_record_max_peaks",
            "traded_record_peaks",
            "unreached_peaks",
            "unreached_price",
            "unreached_qty",
            "unreached_t_ms",
        }
    ),
    "WatchlistEntryView": frozenset(
        {
            "code",
            "folder_id",
            "last_success_date",
            "name",
            "order",
            "registered_at_kst_date",
        }
    ),
    "WatchlistMemoView": frozenset({"id", "folder_id", "order", "text"}),
    "WatchlistResponse": frozenset({"entries", "folders", "memos", "next_run_at_ms"}),
    # 봉 패턴 검색(ADR-0166). 응답이 **분포·베이스라인을 동반해야** 화면이 유사도
    # 절대값을 단독으로 그리지 않는다 — 그 동반 필드가 조용히 빠지는 것을 여기서 막는다.
    "PatternDistribution": frozenset({"p50", "p95", "p99", "p99_99", "sample"}),
    "PatternBaseline": frozenset({"fwd_median_pct", "fwd_win_rate_pct", "sample"}),
    "PatternMatchRow": frozenset(
        {"code", "name", "from_date", "to_date", "corr", "bars", "tail", "forward_pct", "ma",
         "struct_match", "struct_miss"}
    ),
    "PatternQueryWindow": frozenset({"length", "from_date", "to_date", "bars", "ma"}),
    "PatternLengthResult": frozenset(
        {"length", "query", "ma_periods", "universe", "dist", "matches", "baseline",
         "partial_last_bucket_days", "struct_total", "struct_hist", "struct_relations",
         "elapsed_ms"}
    ),
    "PatternSearchResponse": frozenset(
        {"code", "name", "mode", "timeframe", "results",
         "empty_reason", "coverage_from", "coverage_to"}
    ),
    # 패턴 검색 저장. **불러오기가 조건을 통째로 복원**하므로 필드가 하나라도 조용히
    # 빠지면 "저장했는데 그 조건이 아니다" 가 된다.
    "PatternSaveWindow": frozenset({"kind", "bars", "from_date", "to_date"}),
    "PatternSaveConditions": frozenset(
        {"mode", "since", "count", "sim_floor", "min_tv_eok", "exclude_etf",
         "no_overlap", "per_code", "volume_weight", "ma_preset", "flex_bars",
         "timeframe", "struct_tolerance", "struct_anchor"}
    ),
    "PatternSave": frozenset(
        {"id", "name", "code", "stock_name", "window", "conditions", "excluded",
         "created_at_ms", "updated_at_ms"}
    ),
    "PatternExclusion": frozenset({"code", "from_date", "stock_name"}),
    "PatternSavesFile": frozenset({"schema_version", "saves"}),

    "HeatmapEntry": frozenset({"code", "folder_id", "name", "order"}),
    "HeatmapResponse": frozenset(
        {"entries", "folders", "capture_markers", "next_run_at_ms"}
    ),
    # `/api/range` 의 단일 read-path Wire Model (ADR-0013). **이 리포에서 가장 자주 바뀌는
    # wire model 인데 1층 밖에 있었다** — 슬라이스가 하나 늘 때마다 필드가 늘지만, 그 사실을
    # 재는 것이 아무것도 없었다. 프론트 미러는 ``frontend/src/api/types.ts`` 의 ``RangeBundle``.
    #
    # **최상위 필드만 본다.** 이 스냅샷은 중첩 모델을 따라가지 않으므로 ``RangeSegment``·
    # ``MissingDate`` 같은 하위 shape 의 드리프트는 여기서 안 잡힌다. 하위 모델을 덮고 싶으면
    # 그 이름으로 항목을 따로 추가해야 한다(척도 축만은 ``test_range_price_scale_contract.py``
    # 가 재귀 순회로 이미 덮고 있다).
    #
    # 프론트 ``RangeBundle`` 에는 ``investorPoints`` 가 하나 더 있는데 백엔드엔 대응 필드가
    # 없다 — 프론트가 다른 출처로 채우는 값이라 이 스냅샷의 대상이 아니다.
    # ``RangeBundle.quote_ratio.points[*]`` — 위 문단이 말하는 "하위 모델을 덮고 싶으면
    # 이름으로 따로 추가" 의 첫 사례다. 이 shape 은 손 미러가 값까지 나르는 자리라
    # (``frontend/src/api/types.ts`` 의 ``QuoteRatioPoint``) 필드가 조용히 늘거나 줄면
    # 프론트가 읽던 값이 사라진다 — 실제로 ``band_pct`` 를 추가할 때 최상위 스냅샷은
    # 아무 말도 하지 않았다.
    "QuoteRatioPoint": frozenset(
        {
            "t",
            "bid_total",
            "ask_total",
            "bid_max",
            "ask_max",
            "imb_max_bid",
            "imb_max_ask",
            "band_pct",
            "tick",
        }
    ),
    "RangeBundle": frozenset(
        {
            "earliest_captured_date",
            "code",
            "from_date",
            "to_date",
            "bucket_ms",
            "segments",
            "candles",
            "quote_ratio",
            "fill_strength",
            "volume_profile_range",
            "volume_profile_by_day",
            "excluded_dates",
            "data_warnings",
            "missing_dates",
            "ask_peaks",
            "bid_peaks",
            "depth_heatmap",
            "broker_late_entries",
            "price_level_hits",
            "trade_volume_pocs",
            "volume_distributions",
            "program_trade",
        }
    ),
}


def test_rest_wire_models_match_frontend_mirror_snapshot() -> None:
    for name, expected in EXPECTED_REST_WIRE_FIELDS.items():
        cls = getattr(m, name)
        actual = frozenset(cls.model_fields.keys())
        added = actual - expected
        removed = expected - actual
        assert actual == expected, (
            f"{name} REST wire fields drifted from the frontend mirror snapshot. "
            f"added={sorted(added)} removed={sorted(removed)}. Update the matching "
            "frontend/src/api/*.ts mirror type, then update EXPECTED_REST_WIRE_FIELDS "
            "in this file in the same commit."
        )


#: 1층의 **두 번째 표** — ``hoga.api.models`` 밖에 사는 wire model 용이다.
#:
#: 위 표는 이름을 ``models`` 에서 찾으므로 다른 모듈의 모델을 담을 수 없었고, 그래서
#: ``hoga/live/api.py`` 의 wire model 은 1층이 통째로 못 보는 사각지대였다. 여기는
#: **클래스를 직접 키로 쓴다** — 이름 해석이 없으니 두 모듈에 같은 이름이 생겨도
#: 조용히 엉뚱한 것을 재는 경우가 원리적으로 없다(``AfterHoursBookResponse`` 를 이미
#: 직접 import 하는 것과 같은 방식).
EXPECTED_LIVE_WIRE_FIELDS: dict[type, frozenset[str]] = {
    # 프론트 미러는 ``frontend/src/api/liveQuotes.ts`` 의 ``LiveQuote``.
    #
    # 미러에는 ``expected_price``·``expected_qty``·``expected_change_pct`` 가 더 있는데
    # 백엔드엔 대응 필드가 없다 — WS ob 프레임에서 프론트가 채우는 표시 전용 값이라
    # 이 스냅샷의 대상이 아니다(``RangeBundle.investorPoints`` 와 같은 사유).
    LiveQuote: frozenset(
        {
            "code",
            "price",
            "change_pct",
            "change_won",
            "open",
            "high",
            "low",
            "volume",
            "trade_value",
            "vs_prev_volume_pct",
            "fill_strength_pct",
            "baseline_price",
            "baseline_date",
            "change_pct_source",
            "warnings",
            "stale",
            "stale_reason",
        }
    ),
}


def test_live_wire_models_match_frontend_mirror_snapshot() -> None:
    for cls, expected in EXPECTED_LIVE_WIRE_FIELDS.items():
        actual = frozenset(cls.model_fields.keys())
        added = actual - expected
        removed = expected - actual
        assert actual == expected, (
            f"{cls.__name__} live wire fields drifted from the frontend mirror "
            f"snapshot. added={sorted(added)} removed={sorted(removed)}. Update the "
            "matching frontend/src/api/*.ts mirror type, then update "
            "EXPECTED_LIVE_WIRE_FIELDS in this file in the same commit."
        )


def test_heatmap_capture_marker_stays_off_the_entry() -> None:
    """마커는 entry 가 아니라 **코드 키 사이드 테이블**에 산다 (ADR-0142).

    ADR-0142 로 히트맵이 캡처 대상이 되면서 이 테스트의 원래 명제("캡처·스케줄러
    필드 없음")는 무효가 됐지만, 그중 **하나는 오히려 더 중요해졌다**: HeatmapEntry
    의 identity 는 ``(folder_id, code)`` 라 마커를 entry 에 얹으면 한 종목이 3개
    그룹에 있을 때 마커가 3벌로 갈라진다. 정작 그 마커가 가리키는 캡처는 ``(code,
    date)`` 하나뿐이다. 그래서 entry 에 마커 필드가 생기는 것 자체를 금지한다.
    """
    heatmap_entry_fields = set(m.HeatmapEntry.model_fields)
    heatmap_response_fields = set(m.HeatmapResponse.model_fields)

    assert "registered_at_kst_date" not in heatmap_entry_fields
    assert "last_success_date" not in heatmap_entry_fields
    # 마커는 코드 키 맵으로만 실린다.
    assert "capture_markers" in heatmap_response_fields
    assert "capture_markers" not in heatmap_entry_fields


# ── enum 값 미러 (BE Literal ↔ FE union) ──────────────────────────────────────

# 등록된 쌍: 프론트 타입명 → (백엔드 Literal 멤버, 프론트 소스 파일).
#
# **등록된 쌍만 값이 대조된다.** 다만 "등록을 잊는" 실패 모드는 아래
# ``test_same_named_literal_unions_are_registered_or_excused`` 가 따로 막는다 —
# 이름이 같은 BE Literal ↔ FE union 을 발견하면 여기 등록하거나
# ``INTENTIONALLY_UNMIRRORED`` 에 사유를 적으라고 요구한다.
#
# 백엔드 ``Literal`` 116개 중 대부분은 ``type: Literal["capture_progress"]`` 같은 단일값
# 판별자라 드리프트 여지가 없어서, 여러 값을 갖고 프론트가 그 값으로 분기·라벨링하는
# 것만 고른다. 숫자 Literal(``pct: Literal[10, 20, 30]``)은 대상이 아니다.
#
# 양쪽 타입명이 우연히 같아서 키 하나로 쓴다. 갈리면 쌍을 (be_name, fe_name)으로
# 넓히면 된다.
WIRE_ENUM_MIRRORS: dict[str, tuple[frozenset[str], str]] = {
    "PatternSearchMode": (
        frozenset(get_args(m.PatternSearchMode)),
        "frontend/src/api/screener.ts",
    ),
    "PatternMaPreset": (
        frozenset(get_args(m.PatternMaPreset)),
        "frontend/src/api/screener.ts",
    ),
    "PatternSaveKind": (
        frozenset(get_args(m.PatternSaveKind)),
        "frontend/src/api/screener.ts",
    ),
    # 빈 결과의 **이유**. 값이 갈리면 프론트가 그 원인만 라벨을 못 찾아 **빈 화면에
    # 아무 설명도 못 띄운다** — 이 필드가 생기기 전의 상태로 조용히 되돌아간다.
    "PatternEmptyReason": (
        frozenset(get_args(m.PatternEmptyReason)),
        "frontend/src/api/screener.ts",
    ),
    # 봉 단위. **부재가 `"D"`** 라 값이 갈리면 저장·착지가 조용히 일봉으로 떨어진다.
    "PatternTimeframe": (
        frozenset(get_args(m.PatternTimeframe)),
        "frontend/src/api/screener.ts",
    ),
    "CaptureReason": (
        frozenset(get_args(LiveStatus.model_fields["capture_reason"].annotation)),
        "frontend/src/api/liveStatus.ts",
    ),
    "CapturePhase": (frozenset(get_args(m.CapturePhase)), "frontend/src/api/types.ts"),
    "SkipReason": (frozenset(get_args(m.SkipReason)), "frontend/src/api/types.ts"),
    "CalendarStatus": (frozenset(get_args(m.CalendarStatus)), "frontend/src/api/types.ts"),
    "SignalAlertSource": (
        frozenset(get_args(m.SignalAlertSource)),
        "frontend/src/api/signalAlerts.ts",
    ),
    # 손으로 고른 목록엔 없었다 — 아래 등록 누락 감사가 잡아서 들어왔다.
    "ScanBasis": (frozenset(get_args(m.ScanBasis)), "frontend/src/api/screener.ts"),
    "PatternStructAnchor": (
        frozenset(get_args(m.PatternStructAnchor)),
        "frontend/src/api/screener.ts",
    ),
    # 스크리너 갱신 skip 사유. **오래 `str` 이라 이 층 밖에 있었다** — BE 에 named
    # alias 가 없으면 `get_args` 로 읽을 수 없어 등록 자체가 불가능하고, 그래서 등록
    # 누락 감사도 이 쌍을 못 봤다(`RangeMode` 와 같은 구멍). 달력 실패를 둘로 쪼개면서
    # alias 를 만들어 함께 등록했다. 값이 갈리면 새 사유가 `SKIP_REASON_MESSAGES` 에
    # 없어 갱신 실패가 **문구 없이** 지나간다.
    "ScreenerUpdateSkipReason": (
        frozenset(get_args(m.ScreenerUpdateSkipReason)),
        "frontend/src/api/screener.ts",
    ),
    # `/api/range` 의 mode. **BE 가 Literal 이 아니라 Query 정규식이라 오래 가드 밖에
    # 있었다** — `get_args` 로 읽을 수 없으니 등록 자체가 불가능했고, 그래서 등록 누락
    # 감사도 이 쌍을 못 봤다. models.py 에 alias 를 두어 라우트 검증과 이 대조가 같은
    # 목록에서 파생되게 한 뒤 등록했다. 등록하자마자 실제 드리프트가 드러났다 —
    # 퇴역한 `full`(2026-07-08 WS2, BE 는 422 회귀 테스트까지 세움)이 FE union 에
    # 그대로 남아 있었다.
    "RangeMode": (frozenset(get_args(m.RangeMode)), "frontend/src/api/rangeRequest.ts"),
    # 결손 사유. FE 는 종전에 `RangeMissingDate.reason` 의 **필드 인라인 union** 이라
    # 파서가 원리적으로 못 봤다 — 그래서 같은 이름의 named alias 로 꺼내며 등록했다.
    # 값이 갈리면 새 사유가 배너 문구 분기에 없어 조용히 "손상" 으로 오분류된다.
    # 투자자 순매수의 물리량. **경로마다 다르고 축마다 다르다** — 종목 수량 축은 주,
    # 종목 금액 축은 백만원, 지수 경로는 억원. 프론트가 이 값으로 포맷터를 고르므로
    # 값이 갈리면 **자릿수가 100배 틀린 화면**이 나오고 타입은 아무 말도 안 한다.
    # BE 가 라우트마다 인라인 Literal 을 적었으면 이 감사가 원리적으로 못 본다 —
    # 그래서 도메인에 named alias 를 두고 두 응답 모델이 그것을 쓴다.
    "InvestorNetUnit": (
        frozenset(get_args(InvestorNetUnit)),
        "frontend/src/api/types.ts",
    ),
    "MissingDateReason": (
        frozenset(get_args(m.MissingDateReason)),
        "frontend/src/api/types.ts",
    ),
    # **이름이 다른 쌍이라 자동 발견이 못 본다** — 손으로 등록해야 하는 부류다
    # (ADR-0143). BE 는 `LiveErrorKind`(정책 축에서 태어난 이름), FE 는
    # `LiveWarningKind`(wire 에서 읽는 쪽 이름)다. 값이 갈리면 프론트가 모르는 kind 를
    # 받아 진단 분기가 조용히 default 로 떨어진다 — #1251 과 같은 종류의 무증상 사고다.
    "LiveWarningKind": (
        frozenset(get_args(LiveErrorKind)),
        "frontend/src/api/dataWarnings.ts",
    ),
    # 감사가 못 보던 쌍이었다: BE 정의가 `hoga.live.futures_runtime` 인데 그 모듈이
    # `_AUDITED_BACKEND_MODULES` 에 없었다(#1185 가 남긴 "명시 목록" 한계). market
    # 라우트에 wire model 을 입히다가 발견해 모듈과 함께 등록했다.
    "FuturesSession": (
        frozenset(get_args(futures_runtime.FuturesSession)),
        "frontend/src/api/marketFutures.ts",
    ),
    # **필드 인라인 Literal ↔ 이름 다른 FE union** — 위 감사가 원리적으로 못 보는
    # 조합이라 손으로 등록한다. BE 는 모델 안에 직접 쓴 `timeframe` 필드고, FE 는
    # `LiveTimeframe`(이름도 다르고 파일도 `api/` 밖이다).
    #
    # ⚠ FE 에 `Timeframe`(types.ts)이라는 **다른 타입**이 따로 있다 — 분봉 6개 전용
    # (`TIMEFRAME_TO_MS` 의 키)이라 여기 짝이 아니다. 이름 규칙으로 자동 매칭했다면
    # 그쪽을 짚어 상시 빨간 테스트가 됐을 것이고, 그게 자동 발견을 안 하는 이유다.
    # **양쪽 다 필드 인라인이라 감사가 못 보는 쌍** — 손 등록 부류다. BE 는
    # `AfterHoursBookResponse.source` 의 인라인 `Literal`, FE 는 같은 이유로 named
    # alias 를 만들어 꺼냈다.
    #
    # 값이 갈리면 무증상이다: 백엔드가 `'stored'` 를 보내는데 프론트 union 이
    # `'kiwoom'` 뿐이면 타입 에러 없이 그냥 통과하고, "저장본이라 더 이상 안 변한다"
    # 는 신호를 프론트가 못 읽어 **닫힌 창에 5초 폴링을 계속 건다**.
    "LiveAfterHoursSource": (
        frozenset(get_args(AfterHoursBookResponse.model_fields["source"].annotation)),
        "frontend/src/api/liveAfterHoursBook.ts",
    ),
    "LiveTimeframe": (
        frozenset(get_args(m.StudyViewReference.model_fields["timeframe"].annotation)),
        "frontend/src/state/livePage.ts",
    ),
    # **응답 필드가 아니라 쿼리 파라미터의 enum** 이다 — 그래도 계약 표면은 같다.
    # 값이 갈리면 프론트가 서버가 모르는 방향을 보내고 FastAPI 가 422 를 낸다(카드가
    # 통째로 빈다). 선례인 `ProgramAxis` 는 백엔드가 `axis: str` 이라 대조할 짝이
    # 없었고, 그래서 이쪽은 처음부터 `Literal` 로 뒀다.
    "StreakDirection": (
        frozenset(get_args(market_overview.StreakDirection)),
        "frontend/src/api/market.ts",
    ),
    # 같은 이유로 값 대조가 특히 중요하다 — 벤더가 **모르는 시장 코드를 거절하지 않고
    # 코스피를 그대로 준다**(2026-08-10 실측). 라벨이 갈리면 422 가 아니라 틀린 시장이
    # 그려질 수도 있는 표면이라, 라벨 자체를 계약으로 못박는다.
    "MarketName": (
        frozenset(get_args(market_overview.MarketName)),
        "frontend/src/api/market.ts",
    ),
    # **요청 body 의 판별자**다 — 응답이 아니라서 EXPECTED_REST_WIRE_FIELDS 로는 안
    # 보이고, 필드 인라인 `Literal` 이라 자동 감사도 못 본다(손 등록 부류).
    #
    # BE 는 판별 유니온의 두 갈래(`CodeItemRef` · `MemoItemRef`)에 각각 한 값씩 쓰고,
    # FE 는 그 합집합을 `WatchlistItemKind` 한 줄로 미러한다 — 그래서 여기서도
    # 합집합으로 만든다. 값이 갈리면 프론트가 서버가 모르는 kind 를 보내 422 가
    # 나고, 패널에서 행을 끌어도 순서가 저장되지 않는다(조용한 실패는 아니지만
    # 원인이 dnd 로 보여 진단이 오래 걸린다).
    "WatchlistItemKind": (
        frozenset(get_args(m.CodeItemRef.model_fields["kind"].annotation))
        | frozenset(get_args(m.MemoItemRef.model_fields["kind"].annotation)),
        "frontend/src/api/watchlist.ts",
    ),
}


def _strip_ts_comments(src: str) -> str:
    """블록·줄 주석 제거. **잘라내기 전에** 부르는 것이 중요하다(호출부 주석 참조)."""
    return re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", src, flags=re.S))


def _ts_const_array_members(src: str, const_name: str) -> frozenset[str]:
    """``export const ARR = ['a', 'b'] as const;`` 의 문자열 리터럴 집합."""
    head = re.search(rf"^export const {re.escape(const_name)}\s*=", src, re.M)
    if head is None:
        return frozenset()
    # 배열이므로 첫 `]` 까지가 본문이다(세미콜론은 `as const` 뒤에 온다).
    body = _strip_ts_comments(src[head.end():]).split("]", 1)[0]
    return frozenset(re.findall(r"'([^']*)'", body))


def _ts_union_members(ts_path: Path, type_name: str) -> frozenset[str]:
    """``export type X = 'a' | 'b';`` 의 문자열 리터럴 집합.

    한 줄·여러 줄 정의를 모두 받는다 — 줄 단위 정규식이면 여러 줄 union(``CapturePhase``)
    을 조용히 덜 읽는다.

    **주석을 잘라내기 전에 지운다.** 순서를 뒤집으면 주석 속 세미콜론에서 정의가
    조기 종료된다 — ``CalendarStatus`` 의 ``// ADR-0020 — mirrors backend; was
    missing…`` 이 실제로 그랬고, 멤버 16개 중 5개만 읽혔다. 그 상태로도 위 대조
    테스트는 "프론트에 없는 값" 을 무더기로 보고할 뿐 파서 탓임을 말해 주지 않는다.

    ``export type X = (typeof ARR)[number]`` 형태도 읽는다 — 값이 **배열 상수**에 있고
    타입 선언엔 리터럴이 하나도 없어서, 이 갈래가 없으면 빈 집합을 돌려주고 대조가
    "프론트에 없는 값" 을 전량 보고한다(= 파서 탓인데 드리프트처럼 보인다).
    프론트에서 흔한 관용구다(값 배열이 런타임에도 필요할 때).
    """
    src = ts_path.read_text(encoding="utf-8")
    head = re.search(rf"^export type {re.escape(type_name)}\s*=", src, re.M)
    assert head is not None, (
        f"{ts_path.relative_to(_REPO_ROOT)} 에 `export type {type_name}` 이 없다. "
        "프론트에서 타입을 지웠거나 이름을 바꿨다면 WIRE_ENUM_MIRRORS 도 같이 고칠 것."
    )
    # 선언 이후 전체에서 주석을 걷어낸 뒤 첫 세미콜론까지가 union 본문이다. 뒤쪽까지
    # 주석이 지워지지만 어차피 잘라 버리는 구간이라 무해하다(wire enum 값에 `//` 를
    # 품은 리터럴은 없다 — 있으면 이 파서를 고쳐야 한다).
    body = _strip_ts_comments(src[head.end():]).split(";", 1)[0]
    inline = frozenset(re.findall(r"'([^']*)'", body))
    if inline:
        return inline
    indirect = re.search(r"\(\s*typeof\s+(\w+)\s*\)\s*\[\s*number\s*\]", body)
    if indirect is not None:
        return _ts_const_array_members(src, indirect.group(1))
    return frozenset()


def test_wire_enum_members_match_frontend_union() -> None:
    for type_name, (backend_members, ts_relpath) in WIRE_ENUM_MIRRORS.items():
        ts_path = _REPO_ROOT / ts_relpath
        frontend_members = _ts_union_members(ts_path, type_name)
        missing_in_frontend = backend_members - frontend_members
        stale_in_frontend = frontend_members - backend_members
        assert frontend_members == backend_members, (
            f"{type_name} 의 BE Literal 과 FE union 이 갈렸다. "
            f"프론트에 없는 값={sorted(missing_in_frontend)} "
            f"프론트에만 남은 값={sorted(stale_in_frontend)}. "
            f"{ts_relpath} 의 union 과 그 값을 소비하는 라벨·분기 표를 같은 PR 에서 "
            "함께 고칠 것(ADR-0004)."
        )


def test_wire_enum_mirror_parser_reads_multiline_unions() -> None:
    """파서 자체의 회귀 — 여러 줄 + 줄 주석이 섞인 union 을 온전히 읽는가.

    이 검사가 없으면 파서가 조용히 덜 읽어도 위 테스트가 통과해 버린다(백엔드에만
    있는 값을 "프론트에 없다" 가 아니라 아예 비교 대상에서 빠뜨리는 식이 아니라,
    빈 집합끼리 맞아떨어지는 경우가 문제다).
    """
    members = _ts_union_members(_REPO_ROOT / "frontend/src/api/types.ts", "CalendarStatus")

    assert "complete" in members  # 첫 줄
    assert "partial_live" in members  # 마지막 줄
    assert "source_partial_confirmed" in members  # 주석 바로 다음 줄
    assert len(members) > 10  # 여러 줄을 실제로 다 읽었다는 하한


def test_wire_enum_mirror_parser_reads_as_const_arrays() -> None:
    """``export type X = (typeof ARR)[number]`` 도 읽는가.

    타입 선언 자체엔 리터럴이 **하나도 없다** — 값은 배열 상수가 갖는다. 이 갈래가
    없으면 파서가 빈 집합을 돌려주고, 대조 테스트는 "프론트에 없는 값" 을 전부
    보고한다. 즉 **파서 탓인데 드리프트처럼 보인다** — 위 여러 줄 케이스와 같은 함정이라
    같은 방식으로 고정한다.
    """
    members = _ts_union_members(_REPO_ROOT / "frontend/src/state/livePage.ts", "LiveTimeframe")

    assert "1m" in members
    assert "M" in members  # 배열 마지막 원소
    assert len(members) == 12  # LIVE_TIMEFRAMES 의 실제 길이


# ── 등록 누락 감사 ────────────────────────────────────────────────────────────

# 이름이 같은 BE Literal ↔ FE union 인데 **일부러 대조하지 않는** 쌍. 값과 함께 사유를
# 남긴다 — 사유가 없으면 다음 사람이 "불일치네" 하고 한쪽을 고쳐 버린다.
INTENTIONALLY_UNMIRRORED: dict[str, str] = {
    "SourceName": (
        "FE 는 세 개념의 합집합이다: BE 오더플로 Literal(hogaplay·kiwoom_live)에 "
        "차트 전용 'screener_daily' 와 'kiwoom_gapfill' 을 더했다. 전자는 "
        "/api/live/screener-daily-candles 가 내는데 그 라우트는 반환형이 `-> dict` 라 "
        "wire model 자체가 없다. 후자는 **와이어에 아예 없다** — 얼린 저장뷰가 디스크에 "
        "없는 거래일을 키움 분봉으로 보충한 날의 프론트 표기이고(useMinuteGapFill), 그 "
        "봉은 캡처 저장소에 들어가지 않고 그 창의 화면에서만 산다. 동일성으로 묶으면 "
        "영구히 빨간 테스트가 되고, FE 에서 이 값들을 지우면 차트가 깨진다."
    ),
}

# 감사 대상 백엔드 모듈 — 명시 목록이다(registry 철학과 같다). 여기 없는 모듈의
# Literal 별칭은 감사되지 않으므로, 새 wire enum 을 다른 모듈에 두면 추가할 것.
_AUDITED_BACKEND_MODULES = (m, sources, events, futures_runtime, market_overview)


def _backend_literal_alias_names() -> set[str]:
    """감사 대상 모듈의 **모듈 레벨 문자열 Literal 별칭** 이름들.

    필드 인라인 Literal(``capture_reason`` 처럼 모델 안에 직접 쓴 것)은 이름이 없어서
    이 감사에 안 걸린다 — 그런 쌍은 여전히 손으로 등록해야 한다. 그래서 이 감사는
    누락을 **줄이는** 장치지 없애는 장치가 아니다.
    """
    names: set[str] = set()
    for mod in _AUDITED_BACKEND_MODULES:
        for name in dir(mod):
            if name.startswith("_"):
                continue
            value = getattr(mod, name)
            if get_origin(value) is not Literal:
                continue
            args = get_args(value)
            # 단일값 판별자는 드리프트 여지가 없고, 숫자 Literal 은 TS 문자열 union 과
            # 짝이 아니다. 둘 다 감사에서 뺀다.
            if len(args) > 1 and all(isinstance(a, str) for a in args):
                names.add(name)
    return names


def _frontend_string_union_names() -> set[str]:
    """``frontend/src/api/*.ts`` 의 문자열 union ``export type`` 이름들."""
    names: set[str] = set()
    for ts_path in sorted((_REPO_ROOT / "frontend/src/api").glob("*.ts")):
        src = ts_path.read_text(encoding="utf-8")
        for type_name in re.findall(r"^export type (\w+)\s*=", src, re.M):
            if _ts_union_members(ts_path, type_name):
                names.add(type_name)
    return names


def test_same_named_literal_unions_are_registered_or_excused() -> None:
    """이름이 같은 BE Literal ↔ FE union 은 등록하거나 사유를 남겨야 한다.

    값 대조(``WIRE_ENUM_MIRRORS``)의 최대 약점은 **등록을 잊는 것**이다. 잊으면 그 쌍은
    조용히 무방비인데, 테스트는 여전히 초록이라 보호받는 줄 안다. 이 감사가 그 침묵을
    깬다 — 이름을 맞춰 놓고 등록만 안 한 흔한 경우를 잡는다.

    이름이 다른 쌍과 필드 인라인 Literal 은 여전히 못 본다. 완전한 그물이 아니라는
    뜻이고, 그래서 위 registry 의 "등록된 쌍만 대조된다" 는 단서는 그대로 유효하다.
    """
    candidates = _backend_literal_alias_names() & _frontend_string_union_names()
    unaccounted = candidates - set(WIRE_ENUM_MIRRORS) - set(INTENTIONALLY_UNMIRRORED)

    assert not unaccounted, (
        f"BE Literal 과 이름이 같은 FE union 이 등록되지 않았다: {sorted(unaccounted)}. "
        "값을 대조하려면 WIRE_ENUM_MIRRORS 에 추가하고, 일부러 안 맞추는 것이라면 "
        "INTENTIONALLY_UNMIRRORED 에 **사유와 함께** 넣을 것."
    )


def test_intentionally_unmirrored_entries_are_still_real_pairs() -> None:
    """제외 목록이 화석이 되지 않게 — 양쪽에 실재하는 쌍만 남는다.

    한쪽 타입이 사라진 뒤에도 제외 항목이 남아 있으면, 그 이름이 나중에 **다른 의미로**
    되살아났을 때 아무 사유도 없이 감사를 통과해 버린다.
    """
    stale = set(INTENTIONALLY_UNMIRRORED) - (
        _backend_literal_alias_names() & _frontend_string_union_names()
    )

    assert not stale, (
        f"INTENTIONALLY_UNMIRRORED 항목이 더는 실재 쌍이 아니다: {sorted(stale)}. "
        "한쪽이 사라졌거나 이름이 바뀌었으니 항목을 지울 것."
    )


# ── wire model 없는 라우트 동결 (ratchet) ─────────────────────────────────────

_ROUTE_METHODS = frozenset({"get", "post", "put", "delete", "patch"})
# JSON body 를 pydantic 으로 낼 수 없는(또는 낼 필요 없는) 반환형 — 애초에 대상이 아니다.
_NON_MODEL_RETURNS = frozenset({
    "None", "Response", "JSONResponse", "FileResponse",
    "StreamingResponse", "PlainTextResponse",
})

# 라우트 키는 **(method, path, 모듈)** 이다. (method, path) 만 쓰면 안 된다 — 실측
# 21건이 충돌한다(라우터 prefix 를 뗀 상대 경로라 `/status` 같은 이름이 여러 모듈에
# 산다). 모듈까지 넣으면 충돌 0이고, 함수명 변경에는 여전히 강하다.
RouteKey = tuple[str, str, str]

# **동결선 — 지금은 비어 있다.** 프로덕션 라우트 전부가 wire model 을 갖췄다
# (#1185 에서 24개로 시작해 #1190·#1191·#1193·#1194 로 0). 즉 이 아래 테스트는
# 이제 "늘지 마라" 가 아니라 **"모든 라우트는 계약을 갖고 태어난다"** 를 강제한다.
#
# **비어 있는 것을 유지하라.** 여기 항목을 추가하는 것은 출구가 아니다 — 새 라우트에
# `-> dict` 를 쓰고 싶어졌다면 그건 응답 shape 이 어디에도 선언되지 않는다는 뜻이고,
# 그 상태에서는 이 파일의 다른 두 층(필드 스냅샷·enum 값 대조)이 그 라우트를 원리적으로
# 볼 수 없다.
#
# 모델을 쓸 때의 함정은 하나다: `response_model` 은 선언 안 된 키를 **500 이 아니라
# 조용히 버린다**. 그래서 생산 함수의 키를 전수로 읽고(가능하면 실서버 응답으로) 프론트
# 소비면을 확인한 뒤에 쓴다. shape 이 유동적이면 `dict` 로 두거나 `extra="allow"` 를
# 쓰는 것이 좁혀서 버리는 것보다 낫다(`/series` 가 그 예다).
UNCLOTHED_ROUTE_BASELINE: frozenset[RouteKey] = frozenset()

# 영구 제외 — 동결선과 달리 "언젠가 입힌다" 가 아니다.
INTENTIONALLY_UNCLOTHED: dict[RouteKey, str] = {
    ("GET", "/whoami", "test_routes"): "e2e 전용",
    ("POST", "/add-stockdate", "test_routes"): "e2e 전용",
    ("POST", "/reset-stockdate", "test_routes"): "e2e 전용",
    ("POST", "/cookie_expire_at", "test_routes"): "e2e 전용",
    ("POST", "/seed-trading-days", "test_routes"): "e2e 전용",
}
# 위 셋의 공통 사유: `HOGA_ENABLE_TEST_ENDPOINTS=1` 에서만 붙는 픽스처 주입 엔드포인트다.
# 프론트 프로덕션 코드가 소비하지 않으므로 BE↔FE 미러 계약의 대상이 아니다.


def _iter_routes() -> list[tuple[RouteKey, str, str, ast.AST]]:
    """``hoga/`` 의 모든 라우트 → (키, 반환 애노테이션, 명시 response_model).

    **ast 정적 파싱이다 — 앱을 만들지 않는다.** ``default_app()`` 은 `.env` 를 읽어
    테스트 환경을 오염시키므로(실측 사고 있음) 라우트를 세자고 부를 이유가 없다.
    """
    routes: list[tuple[RouteKey, str, str, ast.AST]] = []
    for py in sorted((_REPO_ROOT / "hoga").rglob("*.py")):
        tree = ast.parse(py.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for dec in node.decorator_list:
                func = dec.func if isinstance(dec, ast.Call) else dec
                if not (isinstance(func, ast.Attribute) and func.attr in _ROUTE_METHODS):
                    continue
                path, explicit = "", ""
                if isinstance(dec, ast.Call):
                    if dec.args and isinstance(dec.args[0], ast.Constant):
                        path = str(dec.args[0].value)
                    for kw in dec.keywords:
                        if kw.arg == "response_model":
                            explicit = ast.unparse(kw.value)
                annotation = ast.unparse(node.returns) if node.returns else "<none>"
                routes.append(
                    ((func.attr.upper(), path, py.stem), annotation, explicit, node)
                )
    return routes


def _unclothed_routes() -> set[RouteKey]:
    """wire model 이 없는 라우트 — 반환형이 ``dict`` 계열이거나 아예 없는 것.

    ``list[SymbolHit]`` 은 **계약이 있다**(FastAPI 가 모델 리스트로 검증한다) — 초기
    분류에서 이걸 무계약으로 셌다가 바로잡았다. ``dict[str, str]`` 은 값 타입이 있어도
    키가 자유라 shape 계약이 아니므로 무계약으로 친다.
    """
    out: set[RouteKey] = set()
    for key, annotation, explicit, _node in _iter_routes():
        if explicit and explicit != "None":
            continue
        if annotation in _NON_MODEL_RETURNS:
            continue
        if annotation in {"<none>", "dict"} or annotation.startswith("dict["):
            out.add(key)
    return out


def test_no_new_routes_without_a_wire_model() -> None:
    """새 라우트는 wire model 을 갖고 태어나야 한다 (ADR-0004).

    반환형이 ``dict`` 면 응답 shape 이 **어디에도 선언되지 않는다**. 프론트는 그걸
    손으로 미러하는데, 위 두 층의 가드는 pydantic 모델이 있어야 볼 수 있으니 그 미러는
    아무 보호도 못 받는다.
    """
    unaccounted = _unclothed_routes() - UNCLOTHED_ROUTE_BASELINE - set(INTENTIONALLY_UNCLOTHED)

    assert not unaccounted, (
        f"wire model 없는 라우트가 새로 생겼다: {sorted(unaccounted)}. "
        "출구는 둘이다 — (1) pydantic 응답 모델을 선언한다(ADR-0004 권장), "
        "(2) 진짜 JSON 이 아니면 Response 계열로 반환형을 적는다. "
        "동결선(UNCLOTHED_ROUTE_BASELINE)에 추가하는 것은 출구가 아니다."
    )


def test_unclothed_baseline_has_no_fossils() -> None:
    """동결선은 줄어들기만 한다 — 고쳐졌거나 사라진 라우트의 항목은 지워야 한다.

    화석을 남겨 두면 같은 (method, path, 모듈) 이 나중에 **새 무계약 라우트로** 되살아났을
    때 동결선이 그걸 조용히 통과시킨다.
    """
    now_unclothed = _unclothed_routes()
    fossils = (UNCLOTHED_ROUTE_BASELINE | set(INTENTIONALLY_UNCLOTHED)) - now_unclothed

    assert not fossils, (
        f"동결선에 화석이 남았다: {sorted(fossils)}. 해당 라우트가 wire model 을 갖췄거나 "
        "사라졌다는 뜻이니 목록에서 지울 것 — 남겨 두면 같은 경로가 무계약으로 되살아나도 "
        "통과한다."
    )


# ── JSONResponse 를 직접 만드는 라우트 (4층) ─────────────────────────────────
#
# 3층은 `Response` 계열 반환형을 **대상 밖**으로 둔다 — 파일·스트림·204 가 대부분이라
# 모델을 요구할 자리가 아니기 때문이다. 그런데 그중 일부는 진짜 JSON body 를 만든다.
# `response_model` 은 Response 를 그대로 흘리므로 그 body 는 **어느 층도 못 본다**.
#
# 실측(2026-08-07): Response 계열 22개 중 20개는 본문 없음(204/None), 2개만 JSON body.
# 그 둘은 `JSONResponse` 를 쓸 **정당한 이유**가 있다 — `/health` 는 body 에 따라
# status code 를 503 으로 바꾸고, `/config.json` 은 `cache-control` 헤더를 붙인다.
# 그래서 `response_model` 로 바꾸는 대신 **body 를 모델로 만들거나 모델로 검증**한다.
#
# ⚠ 이 감지는 **구문적**이다. 함수 본문에서 `JSONResponse(...)` 호출을 찾을 뿐이라,
# 다른 곳에서 만든 Response 를 변수로 반환하거나 `ORJSONResponse` 같은 다른 클래스를
# 쓰면 못 본다. 그런 라우트를 추가하면 이 술어부터 고쳐야 한다.
JSON_RESPONSE_ROUTES: dict[RouteKey, str] = {
    ("GET", "/health", "app"): "HealthResponse (validate-then-pass — status code 를 바꿔야 해서)",
    ("GET", "/config.json", "frontend_static"): "ConfigJsonResponse (cache-control 헤더 때문에)",
}


def _routes_constructing_json_response() -> set[RouteKey]:
    """본문에서 ``JSONResponse(...)`` 를 만드는 라우트."""
    found: set[RouteKey] = set()
    for key, annotation, explicit, node in _iter_routes():
        if (explicit and explicit != "None") or annotation not in _NON_MODEL_RETURNS:
            continue
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            name = (
                call.func.id if isinstance(call.func, ast.Name)
                else call.func.attr if isinstance(call.func, ast.Attribute)
                else ""
            )
            if name == "JSONResponse":
                found.add(key)
                break
    return found


def test_json_response_routes_declare_a_wire_model() -> None:
    """JSON body 를 만드는 Response 라우트는 모델을 통해야 한다.

    등록만으로는 부족하고 **실제로 모델을 쓰는지**가 핵심인데, 그건 여기서 구문으로
    강제할 수 없다. 대신 등록 자체를 요구해서 "이 라우트의 body 계약은 어디 있나" 를
    사람이 한 번은 답하게 만든다 — 사유 문자열이 그 답이다.
    """
    unaccounted = _routes_constructing_json_response() - set(JSON_RESPONSE_ROUTES)

    assert not unaccounted, (
        f"JSONResponse 로 JSON body 를 만드는 라우트가 등록되지 않았다: {sorted(unaccounted)}. "
        "`response_model` 은 Response 를 그대로 흘리므로 이 body 는 어느 가드 층도 보지 "
        "못한다. body 를 wire model 로 만들거나(권장) 모델로 검증한 뒤, "
        "JSON_RESPONSE_ROUTES 에 **어떤 모델을 쓰는지** 적을 것."
    )


def test_json_response_registry_has_no_fossils() -> None:
    """등록만 남고 라우트가 사라지면 지운다 — 화석은 같은 경로의 재등장을 가려 준다."""
    fossils = set(JSON_RESPONSE_ROUTES) - _routes_constructing_json_response()

    assert not fossils, (
        f"JSON_RESPONSE_ROUTES 에 화석이 남았다: {sorted(fossils)}. "
        "라우트가 사라졌거나 JSONResponse 를 더는 만들지 않는다는 뜻이니 항목을 지울 것."
    )
