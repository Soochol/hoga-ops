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
from hoga.collector.orchestrator import now_kst
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


def next_run_at_ms(now: dt.datetime) -> int:
    """다음 17:00 KST 경계의 Unix-ms (ADR-0003).

    관심목록·히트맵 두 라우트가 **같은 함수**를 쓴다 — 하나의 일일 런이 두 목록을
    적재하므로(ADR-0142) 두 화면이 다른 시각을 표시하면 그 자체가 버그다. 각자
    계산하던 시절엔 식이 갈라질 여지가 있었다.
    """
    return int((now + dt.timedelta(seconds=seconds_until_next_17_kst(now))).timestamp() * 1000)


def _scheduler_state_path(data_dir: Path) -> Path:
    return data_dir / "scheduler_state.json"


# 마커가 둘인 이유는 게이트 앞뒤의 비용이 다르기 때문이다.
#
# `last_daily_run_date` — 런 **전체**의 하루 1회 표식. 거래일 게이트 **앞**에 있는
#   promote/prune 은 전체 트리 스윕이라, 실패했다고 60초마다 재시도하면 자정까지
#   수백 번 재실행된다. 그래서 이 마커는 성공·실패 불문 찍는다(ADR-0034: 루프의
#   책임은 트리거 생존이고 재시도 정책은 별개 결정).
# `last_trading_stage_date` — 거래일 게이트 **뒤**(enqueue·스크리너·depth_daily)의
#   표식. 이쪽은 KIS 달력 판정이 **확정**됐을 때만 찍는다. 판정 불가(일시 장애)면
#   안 찍고, 루프가 다음 틱에 이 단계만 다시 시도한다 — 값싼 재시도(달력 1콜 +
#   enqueue)라 전체 런 재시도의 비용 문제가 없다. 이 분리가 없던 시절에는 17:00
#   의 KIS 블립 한 번이 그날 관심종목 캡처를 통째로 날렸다(2026-08-03).
_LAST_RUN_KEY = "last_daily_run_date"
_LAST_TRADING_STAGE_KEY = "last_trading_stage_date"


def _read_marker(data_dir: Path, key: str) -> str | None:
    """스케줄러 상태 파일의 한 마커. 없거나 손상되면 None.

    손상을 격리하지 않고 None 으로 접는다 — 이 마커는 캐시이고, 잃으면 그날 런이
    한 번 더 도는 것이 최악이다(런은 멱등: promote·prune·enqueue 모두 dedupe/게이트).
    """
    try:
        payload = json.loads(_scheduler_state_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get(key)
    return value if isinstance(value, str) else None


def _write_marker(data_dir: Path, key: str, date: str) -> None:
    """한 마커만 갱신한다 — 나머지 키는 보존한다.

    통째로 덮어쓰면 두 마커가 서로를 지워 재시도 게이트가 무력화된다.
    """
    path = _scheduler_state_path(data_dir)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload[key] = date
    try:
        atomic_write_json(path, payload)
    except OSError:
        # 마커를 못 써도 런은 이미 끝났다. 다음 틱에 같은 날이 한 번 더 도는 것이
        # 루프를 죽이는 것보다 낫다.
        log.exception("scheduler: failed to persist marker %s", key)


def read_last_daily_run_date(data_dir: Path) -> str | None:
    """마지막으로 시도를 마친 일일 런의 KST 날짜(YYYYMMDD)."""
    return _read_marker(data_dir, _LAST_RUN_KEY)


def write_last_daily_run_date(data_dir: Path, date: str) -> None:
    _write_marker(data_dir, _LAST_RUN_KEY, date)


def read_last_trading_stage_date(data_dir: Path) -> str | None:
    """거래일 게이트 뒤 단계를 **확정 판정 아래** 마지막으로 마친 날짜."""
    return _read_marker(data_dir, _LAST_TRADING_STAGE_KEY)


def write_last_trading_stage_date(data_dir: Path, date: str) -> None:
    _write_marker(data_dir, _LAST_TRADING_STAGE_KEY, date)


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


async def _daily_run(data_dir: Path) -> bool:
    """일일 런 전체: 유지보수(promote·prune) → 거래일 게이트 → 오늘 몫 enqueue.

    Per-entry exceptions are logged; the loop continues. 반환값은 거래일 게이트 뒤
    단계가 매듭지어졌는지다(:func:`run_trading_stage` 참고) — 유지보수 단계의
    성패는 여기 반영되지 않는다. 두 단계의 재시도 정책이 다르기 때문이다
    (마커 주석 참고).
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
        prune_derived,
        prune_raw,
        resolve_derived_retention_days,
        resolve_include_confirmed_gaps,
        resolve_include_expired_unconfirmed,
        resolve_retention_days,
    )
    try:
        # 게이트 확장 두 단계 모두 env 옵트인이고, 별도 타이머가 아니라 이 일일
        # 실행에 편승한다(부품 최소). HOGA_PRUNE_CONFIRMED_GAPS=확인된 업스트림
        # 갭(#998) · HOGA_PRUNE_EXPIRED_UNCONFIRMED=보유 창 밖 미확정 갭(ADR-0135).
        pruned = await asyncio.to_thread(
            prune_raw, data_dir,
            retention_days=resolve_retention_days(), now=now_kst(), execute=True,
            include_confirmed_gaps=resolve_include_confirmed_gaps(),
            include_expired_unconfirmed=resolve_include_expired_unconfirmed(),
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
        # 파생 트리(재계산 가능한 지표 캐시 · 타이밍 텔레메트리)는 raw 와 다른
        # 축이라 옵트인이 아니다 — 근거는 prune.prune_derived. raw 회수가
        # 실패해도 이건 돌아야 하므로 예외 경계를 따로 둔다.
        derived = await asyncio.to_thread(
            prune_derived, data_dir,
            retention_days=resolve_derived_retention_days(),
            now=now_kst(), execute=True,
        )
        if derived.total_items:
            log.info(
                "daily prune: derived trees reclaimed %.2f GiB (%s)",
                derived.total_bytes / 1024**3,
                ", ".join(
                    f"{name}={n}" for name, (n, _) in derived.by_tree.items() if n
                ),
            )
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

    return await run_trading_stage(data_dir)


def daily_enqueue_codes(data_dir: Path) -> list[str]:
    """오늘 캡처할 종목 = 관심종목 ∪ 히트맵, 관심종목 우선·중복 제거 (ADR-0142).

    두 스토어는 겹친다 — 같은 종목이 양쪽에 있어도 디스크 Stock-Date 는 하나이므로
    **코드 단위로 dedup 해야** 한다. dedup 이 없어도 ``enqueue_items_core`` 가 같은
    (code,date) 를 deduped 로 되돌리긴 하지만, 그건 큐의 방어이지 계획의 정확성이
    아니다 — 로그의 "N종목 적재"가 실제 종목 수와 어긋난다.

    순서가 관심종목 먼저인 이유: 큐는 FIFO 이고 hogaplay 업스트림 보유가 ~18시간이라
    (271종목 기준 동시성 3 에서 전량 소진에 ~2.3시간) **뒤로 밀린 종목일수록 유실
    위험이 크다**. 관심종목이 사용자가 실제로 매매를 보는 목록이므로 앞에 둔다.
    이는 라이브 저장셋의 우선순위(coverage.plan_storage_targets)와도 같은 순서다.

    히트맵은 그룹 단위 on/off 가 없다 — 등록 = 캡처 대상이다(사용자 결정). 폴더의
    ``capture_enabled`` 는 관심종목에서도 hogaplay 캡처가 아니라 **실시간 WS 저장셋**
    을 고르는 플래그라(capture_ordered_codes) 여기서 읽지 않는다.
    """
    from hoga.api.heatmap import load_heatmap  # noqa: PLC0415 — 지연 import(순환 절단)

    codes = [e.code for e in load_watchlist(data_dir)]
    codes.extend(e.code for e in load_heatmap(data_dir))
    return list(dict.fromkeys(codes))


async def run_trading_stage(data_dir: Path) -> bool:
    """거래일 게이트와 그 뒤 단계(enqueue·스크리너·depth_daily). 확정이면 True.

    반환값은 "오늘 이 단계를 매듭지었는가" 다 — 거래일이라 실행했거나, 휴장이라
    할 일이 없음을 확인했으면 True. KIS 가 답을 못 줘서 **아직 아무것도 결론나지
    않았으면 False** 이고, 그때는 호출자가 마커를 찍지 않아 다음 틱이 다시 시도한다.
    """
    now = now_kst()
    today = now.strftime("%Y%m%d")
    verdict = await daily_run_allowed_by_calendar(trading_days_in_range, today)
    if verdict is None:
        # 휴장과 같은 INFO 로 남기면 안 된다 — 조치가 정반대다(휴장은 정상, 이건
        # 업스트림 장애). 마커를 안 찍고 False 를 돌려 다음 틱에 재시도시킨다.
        log.warning(
            "daily run: trading-day verdict unavailable for %s (KIS chk-holiday) — "
            "will retry on the next tick; today's capture enqueue has NOT run yet",
            today,
        )
        return False
    if not verdict:
        log.info("daily run: %s is not a trading day, skipping", today)
        return True
    codes = daily_enqueue_codes(data_dir)
    # 종목 수를 남긴다 — 히트맵이 캡처 대상이 된 뒤(ADR-0142) 이 값은 사용자가 종목을
    # 등록하는 대로 커지고, 큐 소진 시간(≈ N×90초÷동시성)과 하루 디스크 사용량
    # (≈ N×150MB)이 여기에 선형이다. 실측 271종목 = ~2.3시간 · ~35GB/day.
    log.info("daily run: enqueueing %d code(s) for %s", len(codes), today)
    for code in codes:
        try:
            resp = await enqueue_items_core(
                EnqueueRequest(code=code, dates=[today]),
                data_dir=data_dir,
                now=now,
            )
            _log_blocked(resp, context="daily")
        except Exception:  # one bad entry mustn't kill the run
            log.exception("daily enqueue failed for %s/%s", code, today)

    # Screener daily gap update (local import avoids an import cycle). A
    # screener failure must not kill the rest of the daily run.
    try:
        from hoga.api import screener, screener_store, symbols  # noqa: PLC0415
        # 로스터 먼저: 일봉 갱신 대상 목록이 stocks.parquet 에서 나오므로, 신규
        # 상장을 여기서 넣어야 같은 런에서 그 종목의 봉을 받기 시작한다. 시드
        # 스냅샷에는 갱신 경로가 없어 79 종목이 영영 안 보이던 상태였다(2026-08-03).
        await asyncio.to_thread(
            screener_store.merge_roster_from_master,
            data_dir / "screener" / "stocks.parquet",
            symbols.all_listed_rows(),
        )
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

    # 장중 잠정 표본 → 확정본 수렴(#1115). **멱등 마커는 확정 파일의 존재**라 별도
    # 상태를 두지 않고, 확정본이 없는 최근 거래일만 채운다 — 오늘 실패해도 내일 런이
    # 자동으로 주워 간다. 여기(거래일 게이트 뒤)에 있는 것이 중요하다: 휴장일에
    # 확정본을 만들면 그날이 영원히 "확정된 빈 날" 이 된다.
    try:
        from hoga.live import investor_flow_runtime  # noqa: PLC0415
        filled = await investor_flow_runtime.confirm_recent(data_dir, now=now)
        if filled:
            log.info("daily run: investor-flow confirmed days=%d", filled)
    except Exception:
        log.exception("daily run: investor-flow confirm failed; continuing")
    return True


async def catchup_one_entry(
    entry: WatchlistEntry,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Reconcile one Watchlist entry's marker, then enqueue TODAY only. Used by:
    - _catchup_run (startup)
    - POST /api/watchlist/{code}/catchup (per-row)
    - POST /api/watchlist/catchup (run-all)

    **Same-day only since ADR-0142** (was: every trading day from the entry's
    floor up to today). Two reasons the unbounded backfill had to go:

    1. hogaplay upstream retains roughly 18 hours, so almost every date the old
       walk-back produced was already unfetchable — it enqueued work that could
       only fail, burning fail_streak on dates that were never coming back.
    2. The heatmap joined the daily run (ADR-0142) with ~271 codes. An
       unbounded per-code backfill across that set makes a first-run queue in
       the thousands, which at ~90s/item cannot drain within the retention
       window it is racing.

    Past gaps are the 수집 다이얼로그's job (explicit range, coverage preview
    first). Returns EnqueueResponse(enqueued=[], deduped=[]) when today is not
    a trading day or is Q14-trimmed. Raises :class:`TradingDayUnavailableError`
    when the KIS calendar is unavailable — swallowing it here made the routes'
    error envelope unreachable, so a KIS outage reported per-entry SUCCESS
    (enqueued=0, error=None) and the gap silently persisted.
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

    # Step 2: today, if it is a trading day. Kept as a calendar call (rather
    # than just [today]) because the answer still has to come from the calendar
    # — enqueueing a holiday produces a permanently-failing item and a phantom
    # gap in the inventory. A TradingDayUnavailableError propagates to the
    # caller (routes map it to their error envelope / 503; _catchup_run logs
    # per entry) instead of being read as "not a trading day".
    #
    # entry.registered_at_kst_date is no longer read here — it was only ever
    # the backfill floor. The field stays on the model: it is on disk in every
    # watchlist.json and is still shown as the registration date.
    candidates = await trading_days_for_enqueue(trading_days_in_range, today, today)

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
    """Reconcile + enqueue today for every Watchlist entry on startup. Each
    entry is handled by catchup_one_entry; per-entry exceptions are logged. The
    startup sweep never aborts because one entry failed.

    Watchlist only — the heatmap has no catch-up path (ADR-0142). Its codes are
    picked up by the 17:00 daily run; a restart does not re-sweep them.
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

    하루 1회 보장은 디스크 마커(``scheduler_state.json``)가 담당하는데, **마커가
    둘이고 재시도 정책이 서로 다르다**(마커 상수 옆 주석에 근거).

    - 전체 런 마커는 성공·실패 **모두** 찍는다 — 실패마다 60초 재시도를 하면 거래일
      게이트 앞의 promote/prune(전체 트리 스윕)이 자정까지 수백 번 재실행된다.
      그 실패는 다음 날 런에 맡긴다: 이 루프의 책임은 *트리거* 생존이다(ADR-0034).
    - 거래일 단계 마커는 KIS 판정이 **확정**됐을 때만 찍는다. 판정 불가(업스트림
      일시 장애)면 안 찍고, 다음 틱이 **그 단계만** 다시 시도한다(달력 1콜 +
      enqueue — 앞단의 비용 문제가 없다). 이 분리가 없던 시절에는 17:00 의 KIS
      블립 한 번이 그날 관심종목 캡처를 통째로 날렸고, hogaplay 보유가 ~18시간
      이라 다음 날 알아채면 이미 복구 불가였다.

    한 실패가 루프를 죽이지 않는다 — ADR-0034 의 "scheduler is a queue client" 프레이밍.
    """
    while True:
        try:
            now = now_kst()
            today = now.strftime("%Y%m%d")
            if daily_run_due(now, read_last_daily_run_date(data_dir)):
                settled = False
                try:
                    settled = await _daily_run(data_dir)
                except Exception:
                    log.exception("daily run crashed; loop continues")
                write_last_daily_run_date(data_dir, today)
                if settled:
                    write_last_trading_stage_date(data_dir, today)
            elif daily_run_due(now, read_last_trading_stage_date(data_dir)):
                # 전체 런은 이미 돌았는데(비싼 앞단 완료) 거래일 판정이 안 나서
                # 뒷단만 미결인 상태다. 값싼 그 단계만 다시 시도한다 — KIS 가
                # 회복되면 다음 틱(60초)에 그날 몫이 자동으로 들어간다.
                try:
                    if await run_trading_stage(data_dir):
                        write_last_trading_stage_date(data_dir, today)
                except Exception:
                    log.exception("daily trading stage retry crashed; loop continues")
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
    # investor-flow 수집기(#1105/#1120). WS 가 아니라 스케줄러 소유인 이유: 페이지·라이브
    # 개방 여부와 무관하게 돌아야 하기 때문이다(화면 수요에 묶으면 시계열이 "누가 보고
    # 있었는가" 의 함수가 된다). 무자격이면 **태스크를 만들지 않는다** — 만들면 health 에
    # 영원히 "도는 중인데 아무것도 안 하는" 거짓 행이 남는다(ADR-0134).
    #
    # ⚠ 퍼페추얼 루프다 — `ONE_SHOT_TASK_NAMES` 에 넣으면 정상 종료로 오인돼 deep health
    # 가 영구 503 이 되고 워치독이 멀쩡한 서버를 재시작한다(ADR-0064).
    from hoga.live import investor_flow_runtime  # noqa: PLC0415 — 지연 import(순환 절단)
    collector = investor_flow_runtime.make_collector(data_dir)
    if collector is not None:
        collector.start()
        if collector.task is not None:
            tasks.append(collector.task)
    return tasks
