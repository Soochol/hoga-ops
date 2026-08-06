"""Classifies a (code, date) Stock-Date directory into one of four completeness states.

Shared by the parser (writes the two completeness bits into meta.json), the
worker `deciding` phase (decides skip/resume/fresh — Plan B), the calendar
endpoint (cell markers — Plan B), and `queries.list_stock_dates` (surfaces
the bits on the wire). See ADR-0007 for why this lives in its own module.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from hoga.api.invariants import Severity, Violation, check
from hoga.util.mtime_cache import MtimeLruCache
from hoga.util.timeenc import HogaMs


class DiskState(Enum):
    NONE = "none"
    NO_UPSTREAM_DATA = "no_upstream_data"   # ADR-0021
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    INVALID = "invalid"          # ADR-0020: domain invariant violated
    COMPLETE = "complete"


@dataclass(frozen=True)
class Classification:
    """The rich result of evaluating a Stock-Date's meta against the
    invariants catalog. Carries the routing decision (``state``) AND the
    violations that drove it, so callers that surface diagnostics don't
    re-run :func:`hoga.api.invariants.check`.

    Pattern: routing-only callers (eligibility, calendar) read ``.state``;
    surfacing callers (bundle's read-path) read ``.errors`` / ``.warnings``.
    The deletion test fits: removing ``Classification`` would force every
    surfacing caller to re-derive partitions inline — three call sites
    each duplicating the same Severity comparison.
    """
    state: DiskState
    violations: list[Violation] = field(default_factory=list)
    # ADR-0093: True when state==SOURCE_PARTIAL AND a full re-capture already
    # reproduced the identical gappy result (identical_capture_count >= 2) —
    # i.e. the gap is upstream-missing, not a transient collection failure.
    # Defaulted so existing Classification(state=...) constructions are valid.
    upstream_gap_confirmed: bool = False

    @property
    def errors(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == Severity.error]

    @property
    def warnings(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == Severity.warn]


def _archived_series_violations(meta: Mapping[str, object]) -> list[Violation]:
    """Series-level violations the parser archived in ``meta['invariant_violations']``.

    Series invariants run over loaded parquet (too costly to live-evaluate on
    the read path — parquet I/O breaks the per-request SLO, ADR-0020 §4.6), so
    the parser archives them at write time. Only ``series.*`` entries are
    returned: meta invariants are re-evaluated live by :func:`check`, so
    re-consuming archived meta violations would double-count *and* trust a
    possibly-stale archive (the meta may have been fixed since). Malformed or
    unknown-severity entries are skipped rather than crashing this hot helper.
    """
    archived = meta.get("invariant_violations")
    if not isinstance(archived, list):
        return []
    out: list[Violation] = []
    for d in archived:
        if not isinstance(d, Mapping):
            continue
        if not str(d.get("invariant_id", "")).startswith("series."):
            continue
        try:
            out.append(Violation.from_dict(d))
        except (KeyError, ValueError, TypeError):
            continue
    return out


def _gap_touches_session_edge(
    gap_ranges: object, open_ms: object, close_ms: object,
) -> bool:
    """True if any gap abuts a session edge — leading or trailing (ADR-0126).

    A gap reaching the session open (leading) or the closing auction start
    = ``close − 10min`` (trailing) is an upstream-window-boundary loss:
    re-capture cannot recover time that has already passed. Interior gaps are
    excluded — they may be transient collection failures worth a retry, gated
    by ADR-0093's identical-count rule instead.

    ``gap_ranges`` is the meta list of ``{start_ms, end_ms}`` in HHMMSSmmm
    (HogaMs). Boundaries are decoded to linear ms before comparison — HogaMs
    subtraction is non-linear across minute/hour boundaries (timeenc.py). An
    un-normalized ``open_ms=0`` (ADR-0063) falls back to 09:00; a non-positive
    ``close_ms`` disables the trailing check (leading still applies).
    """
    if not isinstance(gap_ranges, list) or not gap_ranges:
        return False
    open_norm = open_ms if isinstance(open_ms, int) and open_ms > 0 else int(_SESSION_OPEN_MS)
    open_intra = _hhmmssms_to_intra_ms(HogaMs(open_norm))
    trailing_edge_intra: int | None = None
    if isinstance(close_ms, int) and close_ms > 0:
        trailing_edge_intra = (
            _hhmmssms_to_intra_ms(HogaMs(close_ms)) - _AUCTION_WINDOW_DURATION_MS
        )
    for g in gap_ranges:
        if not isinstance(g, Mapping):
            continue
        start = g.get("start_ms")
        end = g.get("end_ms")
        if not isinstance(start, int) or not isinstance(end, int):
            continue
        start_intra = _hhmmssms_to_intra_ms(HogaMs(start))
        end_intra = _hhmmssms_to_intra_ms(HogaMs(end))
        if start_intra <= open_intra:
            return True  # leading gap — data began after session open
        if trailing_edge_intra is not None and end_intra >= trailing_edge_intra:
            return True  # trailing gap — stream ended before the close
    return False


def classify_from_meta(meta: Mapping[str, object]) -> Classification:
    """Classify a Stock-Date's meta into a routing decision + violations.

    Single source of truth for the meta → ``DiskState`` mapping. Used both by
    :func:`check_disk_state` (which loads meta from disk) and by callers
    that already have the meta dict in memory (e.g., ``queries.list_stock_dates``
    iterating Stock-Date directories) — sharing the helper avoids reading
    meta.json twice per row.

    Priority (ADR-0020):
      1. Any ``error``-severity invariant violation → ``INVALID``. Broken
         data shape (e.g. ``close_ms=0``) is the most serious finding and
         trumps everything: forces eligibility to fresh-capture instead of
         resuming a corrupted parquet, and lets ``build_range_bundle`` skip
         the segment regardless of whether collection completed. *Meta*
         invariants are re-checked live via :func:`check`; *series* invariants
         (too costly to live-evaluate) are read back from the parser's archive
         via :func:`_archived_series_violations`, so a series ``error`` such as
         ``series.candles_ts_monotonic`` (the chart-crash root cause) gates
         ``INVALID`` here too — not only on the write path + ``hoga validate``
         (ADR-0020 §4.6 amendment, 2026-06-03).
      2. ``collection_complete=False`` → ``CLIENT_INCOMPLETE``. Shape fine
         but capture stopped early — resume from the cursor on next run.
      3. ``warn``-severity violations don't change state (surfaced separately
         via ``Classification.warnings``).
      4. Otherwise fall through to ``is_partial`` → ``SOURCE_PARTIAL`` or
         ``COMPLETE``.

    The 5/18/003490 production case (``collection_complete=False`` AND
    ``close_ms=0``) must reach ``INVALID`` — under the previous
    ``CLIENT_INCOMPLETE``-first ordering it slipped past
    ``build_range_bundle``'s ``INVALID`` filter and re-broke the chart.

    Legacy meta (pre-foundation) lacks both completeness fields. Conservative
    default is ``CLIENT_INCOMPLETE`` so a subsequent capture run will upgrade it.
    """
    violations = check(meta) + _archived_series_violations(meta)
    if any(v.severity == Severity.error for v in violations):
        return Classification(state=DiskState.INVALID, violations=violations)

    collection_complete = bool(meta.get("collection_complete", False))
    if not collection_complete:
        return Classification(state=DiskState.CLIENT_INCOMPLETE, violations=violations)

    is_partial = bool(meta.get("is_partial", True))
    state = DiskState.SOURCE_PARTIAL if is_partial else DiskState.COMPLETE
    # A SOURCE_PARTIAL is a *confirmed* upstream gap (re-capture won't fix it,
    # so decide_capture skips it) when EITHER:
    #   - ADR-0093: a full re-capture reproduced the identical gappy result
    #     (identical_capture_count >= 2), OR
    #   - ADR-0126: a gap abuts a session edge (leading/trailing) — an upstream-
    #     window-boundary loss knowable up front, no identical-count needed.
    identical = meta.get("identical_capture_count", 0)
    identical_confirmed = (
        isinstance(identical, int)
        and not isinstance(identical, bool)
        and identical >= 2  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
    )
    edge_confirmed = _gap_touches_session_edge(
        meta.get("gap_ranges"),
        meta.get("regular_session_open_ms"),
        meta.get("regular_session_close_ms"),
    )
    upstream_gap_confirmed = state == DiskState.SOURCE_PARTIAL and (
        identical_confirmed or edge_confirmed
    )
    return Classification(
        state=state,
        violations=violations,
        upstream_gap_confirmed=upstream_gap_confirmed,
    )


def latest_complete_date(data_dir: Path, code: str) -> str | None:
    """Return the latest YYYYMMDD Stock-Date for ``code`` whose parquet
    artifact is COMPLETE on disk, or ``None`` if no Stock-Date for the
    code has reached the COMPLETE state.

    Walks ``<data_dir>/parquet/<YYYYMMDD>/<code>/`` — the canonical
    layout — and consults :func:`check_disk_state` for each candidate.
    O(date_dirs) stat calls; for a typical user (<300 captured dates
    total across all symbols) this is sub-millisecond.

    Backs Watchlist's disk-reconcile flow: ``add_entry`` seeds
    ``last_success_date`` from this helper when registering a Code, and
    ``_catchup_run`` advances stale markers to match the disk on every
    server start. Source-of-truth: hogaplay *terminal* states — COMPLETE, or a
    SOURCE_PARTIAL with a confirmed upstream-boundary gap (ADR-0126). Plain
    SOURCE_PARTIAL (fixable) and CLIENT_INCOMPLETE stay in-flight from the
    user's POV and don't advance the floor.

    Gated to ``source="hogaplay"``: this helper drives the hogaplay capture
    pipeline's catch-up floor and Watchlist markers, so a COMPLETE
    ``kiwoom_live``/``kis_api`` promotion (lower-fidelity synthesized data) must
    NOT advance the floor and skip hogaplay collection for that date.
    """
    parquet_root = data_dir / "parquet"
    if not parquet_root.exists():
        return None
    latest: str | None = None
    for date_dir in parquet_root.iterdir():
        if not date_dir.is_dir():
            continue
        date = date_dir.name
        # Cheap pre-check before the more expensive disk_state inspection.
        if not (date_dir / code).is_dir():
            continue
        # ADR-0126: terminal = COMPLETE, or a SOURCE_PARTIAL whose gap is a
        # confirmed upstream-boundary loss (re-capture can't improve it). Both
        # let the catch-up floor advance past a day that is already as good as
        # it gets — otherwise a permanently-partial day pins the floor and
        # re-invites catch-up passes that only skip via upstream_gap.
        classification = check_disk_state(data_dir, code, date, source="hogaplay")
        terminal = classification.state == DiskState.COMPLETE or (
            classification.state == DiskState.SOURCE_PARTIAL
            and classification.upstream_gap_confirmed
        )
        if not terminal:
            continue
        if latest is None or date > latest:
            latest = date
    return latest


def check_disk_state(
    data_dir: Path, code: str, date: str, *, source: str | None = None,
) -> Classification:
    """Classify the on-disk state for ``(code, date)`` under ``data_dir``.

    Resolution order (ADR-0021 + ADR-0020 + ADR-0007):
      0. ``raw/{date}/{code}/.no_upstream_data`` sentinel exists →
         ``NO_UPSTREAM_DATA``. Sentinel-first ordering protects against
         stale parquet artifacts left from a prior capture; by invariant
         (ADR-0021) the sentinel sits alone, but the ordering makes the
         contract robust to bugs that violate it.
      1. ``data/parquet/{date}/{code}/meta.json`` exists → delegate to
         :func:`classify_from_meta`. Truncated / unreadable JSON →
         ``CLIENT_INCOMPLETE`` (no violations).
      2. ``data/raw/{date}/{code}/`` has any TSV files → ``CLIENT_INCOMPLETE``.
      3. Otherwise → ``NONE``.

    ``source`` restricts the per-source lookup to a single Source (e.g.
    ``"hogaplay"``) instead of aggregating across all of them. The capture
    pipeline (eligibility, catch-up floor, coverage preview, fail_streak)
    passes ``"hogaplay"`` so a COMPLETE ``kiwoom_live``/``kis_api`` promotion —
    lower-fidelity synthesized data — cannot mark a Stock-Date as
    "already captured" and suppress hogaplay collection. When the restricted
    source has no meta, we fall through to the sentinel/legacy/raw steps, all
    of which are hogaplay-only artifacts (ADR-0075), so the fallback stays
    faithful to the requested source. ``None`` (default) keeps the
    cross-source aggregate used by display surfaces.
    """
    raw_dir = data_dir / "raw" / date / code
    if (raw_dir / ".no_upstream_data").exists():
        return Classification(state=DiskState.NO_UPSTREAM_DATA)

    parquet_dir = data_dir / "parquet" / date / code
    # Source-aware lookup (ADR-0037): prefer per-source meta.json under
    # parquet/{date}/{code}/{source}/meta.json. We aggregate across sources
    # via the same priority used by aggregate_disk_state — unless a single
    # ``source`` was requested, in which case only that Source is considered.
    per_source = classify_stock_date(parquet_dir)
    if source is not None:
        per_source = {source: per_source[source]} if source in per_source else {}
    if per_source:
        aggregated = aggregate_disk_state({src: c.state for src, c in per_source.items()})
        # classify_stock_date already parsed every source's meta and kept the
        # violations, so surface the winning source's Classification directly —
        # no second meta.json read (be-capture-03).
        # 우선순위 = sources._POLICY_ORDER 기본(hogaplay_first)과 동기 유지(import는
        # 순환이라 불가 — sources가 disk_state를 import). 아래 튜플은 SourceName 전수다.
        winning = next(
            (per_source[src] for src in ("hogaplay", "kiwoom_live", "kis_api")
             if src in per_source and per_source[src].state == aggregated),
            None,
        )
        return winning if winning is not None else Classification(state=aggregated)

    # Legacy flat-layout fallback (pre-migration / never-migrated test fixtures).
    meta_path = parquet_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            # Truncated / zero-byte / unreadable meta.json — treat as in-progress
            # so the worker re-captures rather than crashing the calendar / inventory.
            # Matches hoga/parser/__init__.py's pattern for _progress.json reads.
            return Classification(state=DiskState.CLIENT_INCOMPLETE)
        return classify_from_meta(meta)

    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        return Classification(state=DiskState.CLIENT_INCOMPLETE)

    return Classification(state=DiskState.NONE)


# ============================================================================
# Stage 6A — Source-aware helpers (ADR-0037)
# ============================================================================


# meta.json 한 개당 (읽기 + json 파싱 + invariants 검사) 결과 캐시.
#
# 왜 필요한가: `/api/range` 한 요청이 **같은 meta.json 을 세 경로에서 각자 파싱**한다 —
# queries.list_stock_dates_in_range → bundle 의 날짜 루프 → bundle 의 캔들 소스 해석.
# 60일 요청이면 3 × 60 × (소스 수) 만큼의 read+parse 가 나가고 그중 2/3 가 순수 중복이다.
# `/api/inventory/calendar` 도 날짜당 check_disk_state 를 2회 부른다.
#
# 캐시 단위를 Stock-Date 디렉터리가 아니라 **meta 파일**로 잡은 이유: 디렉터리 mtime 은
# 항목 추가/삭제 때만 바뀌고 내부 meta.json 재작성에는 반응하지 않는다. 디렉터리로
# 캐싱하면 재캡처가 무효화를 못 일으켜 stale 분류를 영구히 반환한다. 파일 단위면
# 원자적 교체(atomic_write_json)가 mtime/size 를 바꿔 자연 무효화된다.
#
# 값은 frozen dataclass 이고 소비자는 전부 읽기 전용이다(MtimeLruCache 규약).
_META_CLASSIFY_CACHE: MtimeLruCache[Classification] = MtimeLruCache(max_entries=4096)


def reset_classify_cache_for_tests() -> None:
    """meta 분류 캐시를 비운다 — 같은 tmp_path 를 재사용하는 테스트용."""
    _META_CLASSIFY_CACHE.clear()


def _classify_meta_file(meta_path: Path) -> Classification:
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return Classification(state=DiskState.INVALID)
    return classify_from_meta(meta)


def classify_stock_date(stock_date_dir: Path) -> dict[str, Classification]:
    """Return per-source :class:`Classification` for a Stock-Date directory.

    Walks `<stock_date_dir>/*/meta.json` — each immediate subdirectory is a
    Source (e.g. `hogaplay`, `kiwoom_live` per ADR-0037). Subdirs without a
    `meta.json` are skipped. Invalid JSON yields ``Classification(INVALID)``
    (no violations — the JSON didn't parse) for that source.

    Carries the full Classification (state + violations) rather than just the
    state, so :func:`check_disk_state` can surface the winning source's
    violations without reading its meta.json a second time. Aggregation callers
    project to state via ``{src: c.state for src, c in result.items()}``;
    key-only callers (``sources.resolve_source``) are unaffected.

    디렉터리 순회(iterdir)는 매번 한다 — 새 소스 디렉터리가 즉시 보여야 하고, 비용은
    read+parse 가 아니라 syscall 이다. 캐시는 파일별 read+parse 에만 걸린다.

    Returns empty dict if `stock_date_dir` doesn't exist or has no source
    subdirs.
    """
    out: dict[str, Classification] = {}
    if not stock_date_dir.is_dir():
        return out
    for src_dir in stock_date_dir.iterdir():
        if not src_dir.is_dir():
            continue
        meta_path = source_meta_path(src_dir)
        if meta_path is None:
            continue
        out[src_dir.name] = _META_CLASSIFY_CACHE.get_or_load(
            meta_path, _classify_meta_file,
        )
    return out


def source_meta_path(src_dir: Path) -> Path | None:
    """이 소스의 **완결성 meta** 경로. 없으면 ``None``.

    ⚠ venue 축이 있는 소스(`kiwoom_live`)는 meta 가 **두 종류**다(ADR-0140):

        kiwoom_live/meta.json        source 레벨 — `expected_venues`·`nxt_enabled`
        kiwoom_live/{venue}/meta.json  venue 레벨 — `collection_complete`·`is_partial`

    완결성은 **venue 레벨**에만 있다. 이 구분을 놓치면 두 가지가 동시에 깨진다
    (실측 2026-08-05, 마이그레이션 직후 477 Stock-Date 중):

    - **397건**: venue 세그먼트만 있어 `{source}/meta.json` 이 없다 → 소스가 사다리에
      **아예 안 보인다**
    - **80건**: source 레벨 meta 를 venue meta 로 오독해 `collection_complete` 부재를
      미완결로 읽는다 → **CLIENT_INCOMPLETE 오분류**

    venue 가 여럿이면 **가장 심한 상태**를 그 소스의 상태로 삼는다 — 한 시장이 부분
    결손인데 다른 시장이 완결이라고 소스 전체를 완결로 부를 수는 없다. `KRX` 를 먼저
    보는 이유는 사다리 소비자가 대부분 KRX 를 읽기 때문이고, 정렬은 결정성 때문이다.
    """
    direct = src_dir / "meta.json"
    venue_metas = sorted(
        d / "meta.json" for d in src_dir.iterdir()
        if d.is_dir() and (d / "meta.json").exists()
    )
    if not venue_metas:
        return direct if direct.exists() else None
    if len(venue_metas) == 1:
        return venue_metas[0]
    worst, worst_path = None, venue_metas[0]
    for path in venue_metas:
        state = _META_CLASSIFY_CACHE.get_or_load(path, _classify_meta_file).state
        rank = _AGGREGATE_PRIORITY.index(state) if state in _AGGREGATE_PRIORITY else -1
        if worst is None or rank > worst:
            worst, worst_path = rank, path
    return worst_path


# Severity ordering for cross-source aggregation. COMPLETE wins so a single
# COMPLETE source promotes the Stock-Date to COMPLETE even if other sources
# are missing or partial — see Pre-Stage A in the live capture plan.
_AGGREGATE_PRIORITY = (
    DiskState.COMPLETE,
    DiskState.SOURCE_PARTIAL,
    DiskState.CLIENT_INCOMPLETE,
    DiskState.NO_UPSTREAM_DATA,
    DiskState.INVALID,
    DiskState.NONE,
)


def completeness_rank(state: DiskState) -> int:
    """Rank a DiskState by completeness — **lower is better**.

    Single source of truth for "which state is more complete", shared by
    :func:`aggregate_disk_state` (calendar/capture aggregate) and
    ``sources.resolve_source_result`` under the ``completeness_first`` policy
    (ADR-0124). Keeping the ordering here — not duplicated in ``sources`` —
    means the completeness judgment can't drift across the two consumers.

    Unknown states rank last (defensive; every DiskState is currently listed).
    """
    try:
        return _AGGREGATE_PRIORITY.index(state)
    except ValueError:
        return len(_AGGREGATE_PRIORITY)


def aggregate_disk_state(per_source: dict[str, DiskState]) -> DiskState:
    """Pick the best DiskState across sources.

    Priority: COMPLETE > SOURCE_PARTIAL > CLIENT_INCOMPLETE > NO_UPSTREAM_DATA
    > INVALID > NONE. A single COMPLETE source wins even if others are
    INVALID — the user can still render that Stock-Date via Source Preference
    fallback (ADR-0039).

    Empty input → NONE.
    """
    if not per_source:
        return DiskState.NONE
    states = set(per_source.values())
    for p in _AGGREGATE_PRIORITY:
        if p in states:
            return p
    return DiskState.NONE


_SESSION_OPEN_MS: HogaMs = HogaMs(90000000)        # 09:00:00.000
_GAP_THRESHOLD_MS = 60_000                         # 1 minute (a duration, not a HogaMs)
_MIN_DATAPOINTS_FOR_GAP_ANALYSIS = 2               # need ≥2 to compute consecutive deltas
_AUCTION_WINDOW_DURATION_MS = 10 * 60 * 1000       # closing Auction Window: last 10 min of Regular Session


def _hhmmssms_to_intra_ms(t: HogaMs) -> int:
    """Decode HHMMSSmmm packed-decimal to linear ms-from-midnight.

    Mirrors the SQL helper ``hhmmssms_to_intra_ms_sql`` (timeenc.py). HogaMs
    arithmetic is NON-LINEAR — subtracting two raw values across a minute
    boundary inflates the apparent gap by ~40s, across an hour boundary by
    ~40min. This decode MUST happen before any duration math.
    """
    h = t // 10_000_000
    m = (t // 100_000) % 100
    s = (t // 1000) % 100
    ms = t % 1000
    return (h * 3600 + m * 60 + s) * 1000 + ms


def _intra_ms_to_hhmmssms(intra_ms: int) -> HogaMs:
    """Inverse of :func:`_hhmmssms_to_intra_ms`: linear ms-from-midnight →
    HHMMSSmmm packed-decimal (HogaMs).

    Used only to encode SESSION-boundary anchors (auction-window start) computed
    in linear ms back into the native HogaMs encoding for ``gap_ranges`` — never
    to round-trip an in-stream snapshot's timestamp (those keep their original
    HogaMs; see :func:`analyze_gaps`). The two known anchors (09:00 open, ~15:20
    auction start) land on whole-second boundaries, so no precision is lost.
    """
    ms = intra_ms % 1000
    total_s = intra_ms // 1000
    s = total_s % 60
    m = (total_s // 60) % 60
    h = total_s // 3600
    return HogaMs(h * 10_000_000 + m * 100_000 + s * 1000 + ms)


@dataclass(frozen=True)
class GapAnalysis:
    """Result of scanning a snapshot stream for continuous-trading gaps.

    ``gap_ranges`` carries the (last-snapshot-before-gap, first-snapshot-after-
    gap) boundary pair for each ≥1min gap. In-stream boundaries keep their
    ORIGINAL HHMMSSmmm (HogaMs) encoding — never a linear-ms value back-converted
    to HogaMs (that round-trip is unsafe across minute/hour boundaries; see
    ``_hhmmssms_to_intra_ms``). The sole exception is the ``anchor_edges=True``
    session anchors (09:00 open, ~15:20 auction start): these are fixed
    whole-second times, so ``_intra_ms_to_hhmmssms`` encodes them losslessly —
    the unsafe-round-trip rule concerns arbitrary in-stream timestamps, not these
    two constants. ``in_session_count`` is the number of datapoints inside the
    analysis window.
    """
    in_session_count: int
    gap_ranges: list[tuple[HogaMs, HogaMs]]

    @property
    def is_partial(self) -> bool:
        """The partial-data verdict: a real ≥1min gap, or too few in-session
        datapoints to prove completeness (conservative default). This is the
        single definition of ``is_partial`` — both ``has_meaningful_gaps`` and
        the parser read it, so the sparse-window rule can't drift between them.
        """
        return (
            self.in_session_count < _MIN_DATAPOINTS_FOR_GAP_ANALYSIS
            or bool(self.gap_ranges)
        )


def analyze_gaps(
    ts_ms_values: Iterable[HogaMs],
    *,
    session_close_ms: HogaMs,
    anchor_edges: bool = False,
) -> GapAnalysis:
    """Scan the continuous-trading window for ≥1min gaps, returning each gap's
    boundary pair. Pure function — no I/O.

    Operates on linear ms-from-midnight for the gap arithmetic (HogaMs
    subtraction is unsafe across minute/hour boundaries, timeenc.py:54) but
    KEEPS each timestamp's original HogaMs alongside its linear value so gap
    boundaries are reported in the native encoding without a lossy round-trip.

    The analysis window is ``[09:00, session_close - 10min)`` — continuous
    trading only. Snapshots inside the closing Auction Window (last 10 min of
    the Regular Session) are excluded: no continuous matching happens there, so
    absence of snapshot churn is normal market behavior, not a data gap.
    ``session_close_ms`` is per-Stock-Date (Half-Day-safe: a 12:30 close
    correctly bounds the analysis at 12:20).

    Args:
      ts_ms_values: snapshot timestamps as HogaMs (HHMMSSmmm encoding).
        Pre-session, Auction-Window, and post-close events are filtered out
        before analysis, so passing the full snapshot stream is safe.
      session_close_ms: this Stock-Date's ``regular_session_close_ms`` from
        meta (HogaMs / HHMMSSmmm). Required: a hardcoded default would re-
        introduce the Half-Day footgun.
      anchor_edges: when True, also flag a head gap (session open → first
        snapshot) and a tail gap (last snapshot → auction-window start) if
        either exceeds the 1-min threshold, and flag the ENTIRE window when
        there are zero in-session snapshots. The default False keeps the
        consecutive-pairs-only behavior that hogaplay's parser, ``check`` /
        ``series.snapshots_no_gaps`` invariants, and ``has_meaningful_gaps``
        rely on. Live (KIS WS/REST) promotion sets True: a stream that only
        started at 13:00 (server late-boot) or died at 11:00 (mid-session
        crash) has no interior gap yet is plainly partial, and only the edge
        anchors catch it.
    """
    open_linear = _hhmmssms_to_intra_ms(_SESSION_OPEN_MS)
    auction_start_linear = _hhmmssms_to_intra_ms(session_close_ms) - _AUCTION_WINDOW_DURATION_MS
    # (linear, original HogaMs) pairs, sorted by linear time. Retaining the
    # original lets gap boundaries stay HHMMSSmmm (no linear→HogaMs decode).
    in_session = sorted(
        (
            (intra, t) for t in ts_ms_values
            if open_linear <= (intra := _hhmmssms_to_intra_ms(t)) < auction_start_linear
        ),
        key=lambda pair: pair[0],
    )
    gap_ranges: list[tuple[HogaMs, HogaMs]] = []
    if anchor_edges and not in_session:
        # No continuous-trading data at all — the whole window is a gap. The
        # auction-start anchor is computed in linear ms, so encode it back to
        # HHMMSSmmm for a native-encoding boundary.
        gap_ranges.append((_SESSION_OPEN_MS, _intra_ms_to_hhmmssms(auction_start_linear)))
        return GapAnalysis(in_session_count=0, gap_ranges=gap_ranges)
    if anchor_edges and in_session[0][0] - open_linear >= _GAP_THRESHOLD_MS:
        gap_ranges.append((_SESSION_OPEN_MS, in_session[0][1]))
    # strict=False is correct: in_session[1:] is intentionally one shorter
    # (we're walking consecutive pairs, last element has no successor).
    for (prev_lin, prev_ts), (curr_lin, curr_ts) in zip(in_session, in_session[1:], strict=False):
        if curr_lin - prev_lin >= _GAP_THRESHOLD_MS:
            gap_ranges.append((prev_ts, curr_ts))
    if anchor_edges and auction_start_linear - in_session[-1][0] >= _GAP_THRESHOLD_MS:
        gap_ranges.append((in_session[-1][1], _intra_ms_to_hhmmssms(auction_start_linear)))
    return GapAnalysis(in_session_count=len(in_session), gap_ranges=gap_ranges)


def has_meaningful_gaps(
    ts_ms_values: Iterable[HogaMs],
    *,
    session_close_ms: HogaMs,
) -> bool:
    """True if any consecutive pair within continuous-trading hours has a gap
    ≥ 1 minute, OR the window has fewer than 2 datapoints (too sparse to prove
    completeness — conservative default). Thin wrapper over :func:`analyze_gaps`;
    signature and semantics are unchanged so existing callers (parser is_partial,
    invariants ``series.snapshots_no_gaps``) need no edits.
    """
    return analyze_gaps(ts_ms_values, session_close_ms=session_close_ms).is_partial
