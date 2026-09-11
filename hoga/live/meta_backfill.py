"""Backfill completeness fields into already-promoted live meta.json files.

Live promotions written before the completeness change (hoga/live/promote.py's
``_build_meta``) lack ``collection_complete`` / ``is_partial`` / ``gap_ranges``,
so ``classify_from_meta`` freezes them at CLIENT_INCOMPLETE (✕) forever. This
one-shot sweep recomputes those three fields from the on-disk
``snapshots.parquet`` and merges them into each stale meta, so past KIS live/REST
Stock-Dates render honestly on the capture calendar (complete_live / partial_live).

Cold path — allowed to import polars (like promote.py). Not on any hot path.

Only PAST Stock-Dates (``date < today_kst``) are touched: today's stream may
still be live, and the Today Promoter owns finalizing it at 15:35.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import polars as pl

from hoga.api.invariants import normalize_session_bounds
from hoga.api.sources import source_venue_dir
from hoga.live.promote import _completeness_fields
from hoga.live.stock_sessions import krx_continuous_windows
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST, HogaMs

_log = logging.getLogger(__name__)

# Live sources whose meta this sweep repairs. hogaplay is excluded — its parser
# already writes the completeness fields at capture time. 승격 소스는 승격 후 메타
# 복구가 필요하다(kiwoom_live: ADR-0116).
#
# `kis_live`는 소스에서 제거됐지만(2026-08-06) 목록에 **남긴다** — 이 스윕은 디스크에
# 실재하는 디렉터리만 훑는 소급 복구라, 아카이브를 되돌린 사용자나 아직 옮기지 않은
# 배포본에서 옛 디렉터리를 만나도 그대로 고쳐 준다. 없으면 그냥 건너뛴다.
_LIVE_SOURCES: tuple[str, ...] = ("kis_live", "kiwoom_live", "kis_api")
# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST


@dataclass(frozen=True)
class BackfillResult:
    scanned: int = 0   # live meta.json files inspected
    updated: int = 0   # metas that gained completeness fields
    skipped: int = 0   # already finalized (collection_complete=True) or today/future
    invalid: int = 0   # unreadable/schema-invalid files; path and reason are logged


def _is_yyyymmdd(name: str) -> bool:
    if len(name) != 8 or not name.isdigit():  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        return False
    try:
        datetime.strptime(name, "%Y%m%d")
    except ValueError:
        return False
    return True


def _validate_session_bounds(meta: dict) -> None:
    for prefix in ("regular_session", "indicator_session"):
        for edge in ("open", "close"):
            key = f"{prefix}_{edge}_ms"
            if key not in meta:
                continue
            value = meta[key]
            if type(value) is not int or value < 0:
                raise ValueError(f"{key} must be a nonnegative HHMMSSmmm integer")
            hour, remainder = divmod(value, 10_000_000)
            minute, remainder = divmod(remainder, 100_000)
            second = remainder // 1000
            if hour >= 24 or minute >= 60 or second >= 60:  # noqa: PLR2004 — native clock fields
                raise ValueError(f"{key} is not a valid clock time")
        opening, closing = meta.get(f"{prefix}_open_ms"), meta.get(f"{prefix}_close_ms")
        if opening is not None and closing is not None and opening >= closing:
            raise ValueError(f"{prefix} must open before close")


def _load_meta(path: Path) -> dict | None:
    """Validate one file before a sweep changes it; isolate input errors."""
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(meta, dict):
            raise ValueError("meta must be an object")
        if "date" in meta and (not isinstance(meta["date"], str) or not _is_yyyymmdd(meta["date"])):
            raise ValueError("invalid date")
        _validate_session_bounds(meta)
        for key in ("collection_complete", "is_partial", "krx_aftermarket_eligible"):
            if key in meta and meta[key] is not None and type(meta[key]) is not bool:
                raise ValueError(f"{key} must be boolean or null")
        for key in ("gap_ranges", "indicator_continuous_windows"):
            if key in meta and not isinstance(meta[key], list):
                raise ValueError(f"{key} must be a list")
        normalized = normalize_session_bounds(meta)[0]
        _validate_session_bounds(normalized)
        return normalized
    except (OSError, ValueError, TypeError) as exc:
        _log.warning("meta_backfill.invalid path=%s reason=%s", path, exc)
        return None


def _recompute_fields(
    snapshots_path: Path, *,
    session_open_ms: HogaMs | None = None,
    session_close_ms: HogaMs | None = None,
    collection_complete: bool = True,
    continuous_windows: tuple[tuple[int, int], ...] | None = None,
) -> dict:
    """Recompute the three completeness fields from a snapshots.parquet.

    Delegates the gap analysis + wire shape to ``promote._completeness_fields``
    (the same builder the live promoter uses) so backfill can't drift from it.
    Missing / unreadable parquet → zero in-session snapshots, which the shared
    ``analyze_gaps(anchor_edges=True)`` treats as a full-window gap
    (is_partial=True). ``collection_complete`` defaults True — the live sweep
    only runs on past dates, whose streams have ended; hogaplay backfill
    (ADR-0126) passes the meta's own value to preserve it. ``session_close_ms``
    defaults to the regular-session close; hogaplay backfill passes the meta's
    per-date close for half-day safety.
    """
    ts_values: list[HogaMs] = []
    if snapshots_path.exists():
        try:
            df = pl.read_parquet(snapshots_path, columns=["ts_ms"])
            ts_values = [HogaMs(int(v)) for v in df["ts_ms"].to_list()]
        except Exception:  # noqa: BLE001 — corrupt parquet → treat as empty
            _log.warning("meta_backfill.snapshots_unreadable path=%s", snapshots_path)
    return _completeness_fields(
        ts_values,
        collection_complete=collection_complete,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
        continuous_windows=continuous_windows,
    )


def backfill_live_meta(
    data_dir: Path, *, dry_run: bool = False, now: datetime | None = None,
) -> BackfillResult:
    """Sweep ``parquet/{date}/{code}/{_LIVE_SOURCES}/meta.json`` and add the
    completeness fields to any past-date meta that lacks a finalized
    ``collection_complete``. Idempotent: a meta already at
    ``collection_complete=True`` is skipped.
    """
    today = (now or datetime.now(_KST)).strftime("%Y%m%d")
    parquet_root = data_dir / "parquet"
    scanned = updated = skipped = invalid = 0
    if not parquet_root.exists():
        return BackfillResult()
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name):
            continue
        if date_dir.name >= today:  # today/future: still-live or midnight-race
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            for source in _LIVE_SOURCES:
                src_dir = source_venue_dir(code_dir, source, "KRX")
                meta_path = src_dir / "meta.json"
                if not meta_path.exists():
                    continue
                scanned += 1
                meta = _load_meta(meta_path)
                if meta is None:
                    skipped += 1
                    invalid += 1
                    continue
                if meta.get("collection_complete") is True:
                    skipped += 1
                    continue
                open_ms = int(meta.get("indicator_session_open_ms", meta.get("regular_session_open_ms", 90000000)))
                close_ms = int(meta.get("indicator_session_close_ms", meta.get("regular_session_close_ms", 153000000)))
                fields = _recompute_fields(
                    src_dir / "snapshots.parquet", session_open_ms=HogaMs(open_ms), session_close_ms=HogaMs(close_ms),
                    continuous_windows=krx_continuous_windows(
                        date_dir.name, "KRX", open_ms, close_ms,
                        regular_close_ms=meta.get("regular_session_close_ms"),
                    ),
                )
                if dry_run:
                    updated += 1
                    continue
                meta.update(fields)
                atomic_write_json(meta_path, meta, indent=2)
                updated += 1
    return BackfillResult(scanned=scanned, updated=updated, skipped=skipped, invalid=invalid)


def backfill_hogaplay_meta(
    data_dir: Path, *, dry_run: bool = False, now: datetime | None = None,
) -> BackfillResult:
    """Rewrite stale hogaplay ``is_partial``/``gap_ranges`` with the ADR-0126
    session-edge anchors.

    hogaplay meta written before ADR-0126 ran ``analyze_gaps`` with
    ``anchor_edges=False``, so a leading gap — a next-morning capture past the
    ~18h upstream window that lost the AM session — was recorded as
    ``is_partial=false`` and mis-ranked as COMPLETE. This one-shot sweep
    recomputes the gap verdict and continuous-window provenance from the on-disk
    ``snapshots.parquet`` using the edge anchors and the meta's per-date close,
    rewriting ``is_partial``/``gap_ranges`` and available
    ``indicator_continuous_windows``. ``collection_complete`` and every other field
    are preserved (unlike the live sweep, which *adds* missing fields). Idempotent:
    a second run finds no diff and skips.

    Only PAST Stock-Dates are touched (``date < today_kst``): today's capture may
    still be running and the parser owns finalizing it.
    """
    today = (now or datetime.now(_KST)).strftime("%Y%m%d")
    parquet_root = data_dir / "parquet"
    scanned = updated = skipped = invalid = 0
    if not parquet_root.exists():
        return BackfillResult()
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name):
            continue
        if date_dir.name >= today:  # today/future: still-live or midnight-race
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            meta_path = code_dir / "hogaplay" / "meta.json"
            if not meta_path.exists():
                continue
            scanned += 1
            meta = _load_meta(meta_path)
            if meta is None:
                skipped += 1
                invalid += 1
                continue
            close_raw = meta.get("regular_session_close_ms")
            close_ms = (
                HogaMs(close_raw) if isinstance(close_raw, int) and close_raw > 0 else None
            )
            new_fields = _recompute_fields(
                code_dir / "hogaplay" / "snapshots.parquet",
                session_close_ms=close_ms,
                collection_complete=bool(meta.get("collection_complete", True)),
                continuous_windows=krx_continuous_windows(
                    date_dir.name, "KRX", 90000000, int(close_ms or 153000000),
                    regular_close_ms=int(close_ms or 153000000),
                ),
            )
            gap_fields = {key: new_fields[key] for key in
                          ("is_partial", "gap_ranges", "indicator_continuous_windows") if key in new_fields}
            if all(meta.get(key) == value for key, value in gap_fields.items()):
                skipped += 1
                continue
            if dry_run:
                updated += 1
                continue
            meta.update(gap_fields)
            atomic_write_json(meta_path, meta, indent=2)
            updated += 1
    return BackfillResult(scanned=scanned, updated=updated, skipped=skipped, invalid=invalid)


def _repair_indicator_bounds(meta: dict, date: str, venue: str) -> tuple[int, int]:
    from hoga.live.promote import indicator_session_for_date  # noqa: PLC0415 — session policy

    defaults = indicator_session_for_date(date, venue, aftermarket_eligible=meta.get("krx_aftermarket_eligible"))
    current = (meta.get("indicator_session_open_ms"), meta.get("indicator_session_close_ms"))
    regular = (meta.get("regular_session_open_ms", 90000000), meta.get("regular_session_close_ms", 153000000))
    legacy = (90000000, 153000000)
    if None not in current and current != legacy:
        return current
    if venue == "KRX" and regular != legacy:
        return regular
    if current == legacy:
        return defaults
    return tuple(value if value is not None else default for value, default in zip(current, defaults, strict=True))


def backfill_indicator_session_bounds(
    data_dir: Path, *, dry_run: bool = False,
) -> BackfillResult:
    """venue 별 지표 구간(``indicator_session_open/close_ms``)을 이미 승격된
    ``kiwoom_live/{venue}/meta.json`` 에 소급으로 실어 준다.

    이 키가 생기기 전 승격본은 정규장 경계(09:00–15:30)만 실었고, 조회 경로가 그걸
    지표 경계로 읽어 **NXT·UN 의 프리·애프터마켓 호가 스냅샷이 통째로 집계에서
    배제**됐다(2026-08-07 실측: 그 날 NXT/UN 스냅샷의 49.1%). 데이터는 디스크에
    온전하므로 손실이 아니라 **판독 경계만 고치면 되는** 소급이다.

    위 두 스윕과 다른 점 셋:

    - **KRX 도 훑는다.** 날짜·참여 여부에 따른 기본값을 보완하되 명시된 예외
      거래시간을 보존한다. 경계가 바뀌면 연속매매 창과 결손 판정도 함께 갱신한다.
    - **``collection_complete`` 를 보지 않는다.** 대상은 전부 True(이미 마감된 과거일)
      이라 live 스윕의 스킵 조건을 그대로 쓰면 **한 건도 안 고친다**.
    - **오늘·미래는 건드리지 않는다.** 오늘 것은 promote 가 계속 다시 쓰므로 새 코드가
      도는 순간 저절로 맞는다(위 두 스윕과 같은 규율).

    ⚠ 부수효과가 하나 있고, 그게 **의도된 것**이다: 지표 캐시
    (``kis-past-indicators``)의 정체성 토큰이 meta.json 의 파일 세대라
    (``past_indicators_cache._capture_generation``), 이 재작성이 **잘린 값으로 캐시된
    지표를 자동 무효화**한다. 이 스윕 없이 판독부만 고치면 캐시가 stale 인 채 남아
    화면이 안 바뀐다.

    멱등: 이미 값이 맞는 meta 는 skip 한다.
    """
    from hoga.live.promote import _VENUE_INDICATOR_SESSION_MS  # noqa: PLC0415 — session policy

    parquet_root = data_dir / "parquet"
    scanned = updated = skipped = invalid = 0
    if not parquet_root.exists():
        return BackfillResult()
    today = datetime.now(_KST).strftime("%Y%m%d")
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name):
            continue
        if date_dir.name >= today:
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            for venue in _VENUE_INDICATOR_SESSION_MS:
                meta_path = code_dir / "kiwoom_live" / venue / "meta.json"
                if not meta_path.exists():
                    continue
                scanned += 1
                meta = _load_meta(meta_path)
                if meta is None:
                    skipped += 1
                    invalid += 1
                    continue
                open_ms, close_ms = _repair_indicator_bounds(meta, date_dir.name, venue)
                if open_ms >= close_ms:
                    _log.warning("meta_backfill.invalid path=%s reason=inferred open must precede close", meta_path)
                    skipped += 1
                    invalid += 1
                    continue
                if (
                    meta.get("indicator_session_open_ms") == int(open_ms)
                    and meta.get("indicator_session_close_ms") == int(close_ms)
                ):
                    skipped += 1
                    continue
                if dry_run:
                    updated += 1
                    continue
                meta["indicator_session_open_ms"] = int(open_ms)
                meta["indicator_session_close_ms"] = int(close_ms)
                meta.update(_recompute_fields(
                    meta_path.parent / "snapshots.parquet",
                    session_open_ms=HogaMs(open_ms), session_close_ms=HogaMs(close_ms),
                    collection_complete=bool(meta.get("collection_complete", True)),
                    continuous_windows=krx_continuous_windows(
                        date_dir.name, venue, open_ms, close_ms,
                        regular_close_ms=meta.get("regular_session_close_ms"),
                    ),
                ))
                atomic_write_json(meta_path, meta, indent=2)
                updated += 1
    return BackfillResult(scanned=scanned, updated=updated, skipped=skipped, invalid=invalid)


@dataclass(frozen=True)
class GapRecomputeResult(BackfillResult):
    """``BackfillResult`` + is_partial 전이 카운트.

    갭 스윕은 **재계산으로 덮어쓰는** 소급이라(키 추가가 아니다) 값이 어떻게
    움직이는지를 dry-run 이 말해 줘야 한다. `is_partial` 은 보관함 배지·재캡처
    게이트·hogaplay `already_complete` 스킵이 읽으므로, 뒤집히는 파일 수가 곧
    파급 규모다.
    """
    partial_false_to_true: int = 0
    partial_true_to_false: int = 0
    gap_count_delta: int = 0   # 새 gap_ranges 총개수 − 옛 총개수


def _recompute_one_gap_meta(meta_path: Path) -> tuple[dict, dict] | None:
    """meta 하나를 읽어 (옛 값, 새 값) 을 돌려준다. 대상 아니면 None.

    루프 본문을 여기로 뺀 것은 분기 수 때문만이 아니다 — "무엇을 skip 하는가" 가
    한 화면에 모이면 스윕이 무엇을 안 건드리는지 읽힌다.
    """
    from hoga.api.invariants import (  # noqa: PLC0415 — 순환 절단(지연)
        indicator_session_bounds,
        normalize_session_bounds,
    )

    meta = _load_meta(meta_path)
    if meta is None:
        return None
    norm_meta, _ = normalize_session_bounds(meta)
    try:
        open_ms, close_ms = indicator_session_bounds(norm_meta)
    except KeyError:
        # 경계 키가 없는 meta — 창을 추측하지 않는다(갭을 지어낼 자리다).
        _log.warning("meta_backfill.invalid path=%s reason=missing session bounds", meta_path)
        return None
    new_fields = _recompute_fields(
        meta_path.parent / "snapshots.parquet",
        session_open_ms=HogaMs(open_ms),
        session_close_ms=HogaMs(close_ms),
        collection_complete=bool(meta.get("collection_complete", True)),
        continuous_windows=krx_continuous_windows(
            str(meta.get("date", "")),
            meta_path.parent.name if meta_path.parent.name in ("KRX", "NXT", "UN") else "KRX",
            open_ms, close_ms, regular_close_ms=norm_meta.get("regular_session_close_ms"),
        ),
    )
    return meta, new_fields


def backfill_venue_gap_ranges(
    data_dir: Path, *, dry_run: bool = False,
) -> GapRecomputeResult:
    """``kiwoom_live/{venue}/meta.json`` 의 ``is_partial``/``gap_ranges`` 를 venue 별
    갭 창으로 재계산한다.

    갭 분석 하한이 09:00 모듈 상수이던 시절, NXT·UN 은 08:00–20:00 을 저장하는데
    분석 창이 KRX 정규장이라 **프리·애프터마켓의 실제 결손이 분석 대상 밖**이었다.
    그 지문이 "세 venue 의 gap_ranges 가 밀리초까지 동일" 이다(2026-08-10 실측).

    ``backfill_hogaplay_meta`` 와 같은 규율: **diff 없으면 skip**, 나머지 필드는
    보존, 과거 날짜만. 다른 점은 venue 디렉터리를 훑고 경계를 meta 의
    ``indicator_session_*`` 에서 읽는다는 것뿐이다(#1243 이 실은 키).

    ⚠ hogaplay 는 대상이 아니다 — KRX 전용 업스트림이라(ADR-0003) 창이 안 바뀐다.
    """
    from hoga.live.promote import _VENUE_INDICATOR_SESSION_MS  # noqa: PLC0415 — 순환 절단(지연)

    parquet_root = data_dir / "parquet"
    scanned = updated = skipped = invalid = 0
    f2t = t2f = gap_delta = 0
    if not parquet_root.exists():
        return GapRecomputeResult()
    today = datetime.now(_KST).strftime("%Y%m%d")
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name) or date_dir.name >= today:
            continue
        for code_dir in sorted(date_dir.iterdir()):
            for venue in _VENUE_INDICATOR_SESSION_MS:
                meta_path = code_dir / "kiwoom_live" / venue / "meta.json"
                if not meta_path.exists():
                    continue
                scanned += 1
                pair = _recompute_one_gap_meta(meta_path)
                if pair is None:
                    skipped += 1
                    invalid += 1
                    continue
                meta, new_fields = pair
                old_partial, old_gaps = meta.get("is_partial"), meta.get("gap_ranges")
                gap_fields = {key: new_fields[key] for key in
                              ("is_partial", "gap_ranges", "indicator_continuous_windows") if key in new_fields}
                if all(meta.get(key) == value for key, value in gap_fields.items()):
                    skipped += 1
                    continue
                if old_partial is False and new_fields["is_partial"] is True:
                    f2t += 1
                elif old_partial is True and new_fields["is_partial"] is False:
                    t2f += 1
                gap_delta += len(new_fields["gap_ranges"]) - len(old_gaps or [])
                updated += 1
                if dry_run:
                    continue
                meta.update(gap_fields)
                atomic_write_json(meta_path, meta, indent=2)
    return GapRecomputeResult(
        scanned=scanned, updated=updated, skipped=skipped, invalid=invalid,
        partial_false_to_true=f2t, partial_true_to_false=t2f,
        gap_count_delta=gap_delta,
    )
