"""Daily Scheduler + Catch-up Run for the Watchlist.

See CONTEXT.md ("Daily Scheduler", "Catch-up Run"), spec
docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md,
and ADR-0034 (Scheduler is a queue client, not a peer).

The scheduler MUST go through ``captures.enqueue_items_core`` for all
enqueues. Direct manipulation of ``captures._queue`` / ``_active`` /
``_done`` is forbidden — see ADR-0034.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
from pathlib import Path

from hoga.api.calendar import trading_days_in_range
from hoga.api.calendar_policy import daily_run_allowed_by_calendar, trading_days_for_enqueue
from hoga.api.captures import enqueue_items_core
from hoga.api.disk_state import latest_complete_date
from hoga.api.eligibility import find_ineligible_dates
from hoga.api.models import EnqueueRequest, EnqueueResponse, WatchlistEntry
from hoga.api.watchlist import load_watchlist, set_last_success
from hoga.collector.orchestrator import next_kst_day, now_kst
from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)


def seconds_until_next_17_kst(now: dt.datetime) -> float:
    """Seconds from ``now`` until the next KST 17:00 boundary.

    If ``now`` is exactly 17:00 or later, returns the duration to
    *tomorrow's* 17:00. ``now`` must be tz-aware (Asia/Seoul).
    """
    today_17 = now.replace(hour=17, minute=0, second=0, microsecond=0)
    target = today_17 if now < today_17 else today_17 + dt.timedelta(days=1)
    return (target - now).total_seconds()


_DAILY_TRIGGER_HOUR = 17
# 폴링 주기. 단발 sleep 대신 짧게 반복 확인하는 이유는 _daily_loop docstring 참고.
_DAILY_POLL_INTERVAL_S = 60.0


def _scheduler_state_path(data_dir: Path) -> Path:
    return data_dir / "scheduler_state.json"


def read_last_daily_run_date(data_dir: Path) -> str | None:
    """마지막으로 시도를 마친 일일 런의 KST 날짜(YYYYMMDD). 없거나 손상되면 None.

    손상을 격리하지 않고 None 으로 접는다 — 이 마커는 캐시이고, 잃으면 그날 런이
    한 번 더 도는 것이 최악이다(런은 멱등: promote·prune·enqueue 모두 dedupe/게이트).
    """
    try:
        payload = json.loads(_scheduler_state_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get("last_daily_run_date")
    return value if isinstance(value, str) else None


def write_last_daily_run_date(data_dir: Path, date: str) -> None:
    try:
        atomic_write_json(_scheduler_state_path(data_dir), {"last_daily_run_date": date})
    except OSError:
        # 마커를 못 써도 런은 이미 끝났다. 다음 틱에 같은 날이 한 번 더 도는 것이
        # 루프를 죽이는 것보다 낫다.
        log.exception("scheduler: failed to persist last daily run date")


def daily_run_due(now: dt.datetime, last_run_date: str | None) -> bool:
    """오늘 17:00 을 지났고 오늘 아직 시도하지 않았는가.

    마커가 없으면(첫 부팅·업그레이드 직후) 17:00 이후라면 due 다 — 이건 의도한
    복구 동작이다. "17:00 을 지났는데 오늘 런 기록이 없다" 는 정확히 놓친 실행의
    정의이고, 런 자체가 멱등이라 한 번 더 도는 비용이 하루를 잃는 비용보다 싸다.
    """
    if now.hour < _DAILY_TRIGGER_HOUR:
        return False
    return last_run_date != now.strftime("%Y%m%d")


def _log_blocked(resp: EnqueueResponse, *, context: str) -> None:
    """Surface fail_streak-blocked (Code, Stock-Date)s rejected by the enqueue gate.

    The daily/catch-up sweep enqueues through ``enqueue_items_core``, whose
    ADR-0042 cap can reject a (Code, Stock-Date) as ``blocked`` — e.g. a Watchlist
    date stuck in ``stagnation_abort`` that now counts as a failed attempt
    (ADR-0042 amendment 2026-06-03). ``enqueue_items_core`` returns these on
    ``resp.blocked`` (it does NOT raise), so without this they vanish silently and
    the date quietly drops out of unattended capture. Warn so the operator knows
    to clear it via the inventory ``잠금 해제`` action.
    """
    for item in resp.blocked:
        log.warning(
            "%s: %s/%s blocked (fail_streak=%d, %s) — not enqueued; "
            "clear via inventory unblock",
            context, item.code, item.date, item.fail_streak, item.reason,
        )


async def _daily_run(data_dir: Path) -> None:
    """Enqueue ``(code, today_kst)`` for every Watchlist entry on a
    trading day. Per-entry exceptions are logged; the loop continues.
    """
    # Stage 8: Promote pending Live Capture JSONLs before hogaplay enqueue (ADR-0038).
    from hoga.live.promote import cleanup_archive, promote_pending  # noqa: PLC0415
    try:
        await promote_pending(data_dir)
        await cleanup_archive(data_dir)
    except Exception:  # one source of failure mustn't block the other
        log.exception("daily run: live promotion failed; continuing to hogaplay enqueue")

    # Stage 9: Prune COMPLETE hogaplay raw past the retention window (ADR-0075).
    # Scheduler-owned, queue-untouching (like Promotion) — runs every day,
    # before the trading-day gate, so weekends/holidays still reclaim disk.
    from hoga.api.prune import (  # noqa: PLC0415
        disk_headroom,
        prune_raw,
        resolve_retention_days,
    )
    try:
        pruned = await asyncio.to_thread(
            prune_raw, data_dir,
            retention_days=resolve_retention_days(), now=now_kst(), execute=True,
        )
        log.info(
            "daily prune: removed %d dirs, reclaimed %.2f GiB",
            pruned.deleted, pruned.reclaimed_bytes / 1024**3,
        )
        # 0건일 때 이유를 남긴다. 이 줄이 없던 동안 스케줄러는 매일
        # "removed 0 dirs, reclaimed 0.00 GiB" 만 찍었고, 그건 "지울 게 없다" 와
        # "전부 게이트에 걸려 351GB 가 영구 보존 중이다" 를 구분해 주지 않았다.
        # 성공처럼 보이는 침묵이 디스크가 차오르는 걸 가렸다.
        if pruned.deleted == 0 and pruned.skipped_by_state:
            held = ", ".join(
                f"{reason}={count}({pruned.skipped_bytes_by_state.get(reason, 0) / 1024**3:.1f}GiB)"
                for reason, count in sorted(
                    pruned.skipped_by_state.items(),
                    key=lambda kv: -pruned.skipped_bytes_by_state.get(kv[0], 0),
                )
            )
            log.info("daily prune: nothing prunable — held by state: %s", held)
        head = await asyncio.to_thread(disk_headroom, data_dir)
        if head is not None and head.is_low:
            log.warning(
                "disk headroom low: %.1f%% free (%.1f GiB of %.1f GiB). "
                "raw retention gate holds non-COMPLETE captures — "
                "`hoga prune --include-confirmed-gaps` reports what could be reclaimed.",
                head.free_pct, head.free_bytes / 1024**3, head.total_bytes / 1024**3,
            )
    except Exception:  # prune 실패가 enqueue를 막으면 안 됨
        log.exception("daily run: prune failed; continuing")

    now = now_kst()
    today = now.strftime("%Y%m%d")
    if not await daily_run_allowed_by_calendar(trading_days_in_range, today):
        log.info("daily run: %s is not a trading day, skipping", today)
        return
    for entry in load_watchlist(data_dir):
        try:
            resp = await enqueue_items_core(
                EnqueueRequest(code=entry.code, dates=[today]),
                data_dir=data_dir,
                now=now,
            )
            _log_blocked(resp, context="daily")
        except Exception:  # one bad entry mustn't kill the run
            log.exception("daily enqueue failed for %s/%s", entry.code, today)

    # Screener daily gap update (local import avoids an import cycle). A
    # screener failure must not kill the rest of the daily run.
    try:
        from hoga.api import screener  # noqa: PLC0415
        await screener.trigger_update(data_dir)
    except Exception:
        log.exception("daily run: screener update failed; continuing")

    # depth_daily 집계 갱신(스크리너 총잔량 신고 조건의 과거 기준). 디스크에 있는 모든
    # hogaplay 스톡데이트(대개 이전 거래일들)를 훑어 (code,date)당 1행으로 집계한다 —
    # 오늘 enqueue 된 캡처는 아직 큐/실행 중이므로 여기서 잡히지 않고 캡처 parse 완료
    # 훅이 처리한다. 증분(메타 mtime 미변경분은 건너뜀)이라 매일 전체 스윕해도 저렴하다.
    # 동기 polars/duckdb 이므로 to_thread 로 이벤트 루프를 막지 않는다. 실패는 삼켜서
    # 나머지 일일 작업을 죽이지 않는다.
    try:
        from hoga.api import depth_daily  # noqa: PLC0415
        res = await asyncio.to_thread(depth_daily.sweep, data_dir)
        log.info(
            "daily run: depth_daily sweep computed=%d total=%d",
            res.computed, res.total_rows,
        )
    except Exception:
        log.exception("daily run: depth_daily sweep failed; continuing")


async def catchup_one_entry(
    entry: WatchlistEntry,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Backfill one Watchlist entry. Used by:
    - _catchup_run (startup)
    - POST /api/watchlist/{code}/catchup (per-row)
    - POST /api/watchlist/catchup (run-all)

    Reconciles last_success_date with the disk first (idempotent), then
    enqueues the trading-day gap up to today (Q14-trimmed). Returns
    EnqueueResponse(enqueued=[], deduped=[]) on no-gap or fully-Q14-trimmed
    cases. Raises :class:`TradingDayUnavailableError` when the KIS calendar is
    unavailable — swallowing it here made the routes' error envelope
    unreachable, so a KIS outage reported per-entry SUCCESS (enqueued=0,
    error=None) and the gap silently persisted.
    """
    today = now.strftime("%Y%m%d")

    # Step 1: reconcile last_success_date with disk truth (bidirectional).
    # The disk classifier (DiskState.COMPLETE on meta.json) is authoritative;
    # the marker is a cache. Sync in *either* direction:
    #   - latest > marker  → advance (normal catch-up after offline period)
    #   - latest < marker  → regress (marker was stale, e.g. a previous
    #                        finalize bumped past actual COMPLETE because
    #                        of an abort_reason that wasn't yet gated on
    #                        disk_state — see captures._finalize_item)
    #   - latest is None and marker is set → reset to None (parquet wiped)
    # The finalize-side path uses bump_last_success (advance-only) for
    # race safety; reconcile uses set_last_success because it must be able
    # to repair stale-too-high markers.
    latest = latest_complete_date(data_dir, entry.code)
    if latest != entry.last_success_date:
        await set_last_success(data_dir, code=entry.code, date=latest)
    floor = latest or entry.registered_at_kst_date

    # Step 2: compute candidate dates. to_thread: cold-month KIS fetch is
    # blocking sync HTTP — keep it off the event loop. A
    # TradingDayUnavailableError propagates to the caller (routes map it to
    # their error envelope / 503; _catchup_run logs per entry).
    start = next_kst_day(floor)
    if start > today:
        return EnqueueResponse(enqueued=[], deduped=[])
    candidates = await trading_days_for_enqueue(trading_days_in_range, start, today)

    # Step 3: Q14 pre-trim.
    too_early = set(find_ineligible_dates(candidate_dates=candidates, now=now))
    candidates = [d for d in candidates if d not in too_early]
    if not candidates:
        return EnqueueResponse(enqueued=[], deduped=[])

    # Step 4: enqueue.
    return await enqueue_items_core(
        EnqueueRequest(code=entry.code, dates=candidates),
        data_dir=data_dir,
        now=now,
    )


async def _catchup_run(data_dir: Path) -> None:
    """Backfill every Watchlist entry on startup. Each entry is handled
    by catchup_one_entry; per-entry exceptions are logged. The startup
    sweep never aborts because one entry failed.
    """
    now = now_kst()
    for entry in load_watchlist(data_dir):
        try:
            resp = await catchup_one_entry(entry, data_dir=data_dir, now=now)
            _log_blocked(resp, context="catch-up")
        except Exception:
            log.exception("catch-up failed for %s", entry.code)


async def _daily_loop(data_dir: Path) -> None:
    """Perpetual: 매 틱 벽시계를 다시 읽어 "오늘 17:00 을 지났고 오늘 아직 안 돌았다" 를
    판정해 _daily_run 을 실행한다.

    다음 17:00 까지 한 번에 자는(≈23시간) 방식이 아닌 이유가 둘이다:

    1. **놓친 실행 복구.** 16:00 에 죽고 17:30 에 재기동하면 그날 17:00 런(승격 ·
       prune · 오늘 enqueue · 스크리너 · depth_daily)이 영구히 건너뛰어졌다. 다음 날
       런도 그 날짜를 메우지 않는다(``dates=[today]`` 뿐) — 메우는 경로는 기본 off 인
       startup catch-up 하나였다.
    2. **절전 드리프트.** 단일 사용자 로컬 도구(대개 노트북)에서 장시간
       ``asyncio.sleep`` 은 suspend 구간만큼 늦게 깬다. 매 틱 ``now_kst()`` 를 다시
       읽으면 깨어난 직후 판정이 정확하다.

    하루 1회 보장은 디스크 마커(``scheduler_state.json``)가 담당한다. 마커는 성공·실패
    **모두** 찍는다 — 실패 시 60초마다 재시도하면 거래일 게이트 앞에 있는
    promote/prune(전체 트리 스윕)이 자정까지 수백 번 재실행된다. 오늘의 실패는 기존과
    동일하게 다음 날 런에 맡긴다: 이 루프의 책임은 *트리거* 생존이고(ADR-0034),
    재시도 정책은 별개 결정이다.

    한 실패가 루프를 죽이지 않는다 — ADR-0034 의 "scheduler is a queue client" 프레이밍.
    """
    while True:
        try:
            now = now_kst()
            if daily_run_due(now, read_last_daily_run_date(data_dir)):
                today = now.strftime("%Y%m%d")
                try:
                    await _daily_run(data_dir)
                except Exception:
                    log.exception("daily run crashed; loop continues")
                write_last_daily_run_date(data_dir, today)
        except Exception:
            # 판정·마커 읽기 실패도 루프를 죽이면 안 된다.
            log.exception("daily loop tick failed; loop continues")
        await asyncio.sleep(_DAILY_POLL_INTERVAL_S)


def startup_catchup_enabled_from_env() -> bool:
    """Whether startup should run the one-shot watchlist catch-up.

    Default is false so process boot does not fan out into KIS calendar/capture
    work. Operators can opt in locally with HOGA_STARTUP_CATCHUP_ENABLED=true.
    """
    return os.environ.get("HOGA_STARTUP_CATCHUP_ENABLED") == "true"


def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
    """Spawn scheduler-owned background tasks.

    Startup catch-up is opt-in only; daily-loop remains always-on.
    """
    tasks = [
        asyncio.create_task(_daily_loop(data_dir), name="watchlist-daily-loop"),
    ]
    if startup_catchup_enabled_from_env():
        tasks.append(asyncio.create_task(_catchup_run(data_dir), name="watchlist-catchup"))
    return tasks
