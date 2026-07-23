"""Typer CLI for hoga-ops."""

from __future__ import annotations

import json
from pathlib import Path

import typer
import uvicorn
from rich.console import Console
from rich.table import Table

from hoga.collector.client import HogaplayClient
from hoga.collector.orchestrator import collect_stock_date
from hoga.config import Config, CookieMissingError, resolve_data_dir
from hoga.env import load_env
from hoga.parser import parse_stock_date

app = typer.Typer(no_args_is_help=True, add_completion=False, help="hoga-ops backend CLI")
console = Console()


def _cfg() -> Config:
    # Cookie lookup stays cwd-relative (per-branch .cookie file is normal).
    # Data dir is resolved separately via resolve_data_dir() so captures
    # land in the machine-global store regardless of branch / worktree.
    return Config.from_cwd()


@app.command()
def collect(
    code: str = typer.Option(..., "--code"),
    date: str = typer.Option(..., "--date"),
    resume: bool = typer.Option(False, "--resume"),
) -> None:
    """Capture a Stock-Date from hogaplay.com."""
    cfg = _cfg()
    try:
        cookie = cfg.cookie()
    except CookieMissingError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(code=2) from e

    with HogaplayClient(cookie=cookie) as client:
        try:
            result = collect_stock_date(
                client=client,
                code=code,
                date=date,
                data_dir=resolve_data_dir(),
                resume=resume,
            )
        except Exception as e:  # noqa: BLE001
            console.print(f"[red]collect failed: {e}[/red]")
            raise typer.Exit(code=1) from e
    console.print(
        f"[green]captured[/green] {code}/{date} -> {result.raw_dir} "
        f"({result.pages_written} pages, {result.unique_events} unique events)"
    )


@app.command()
def parse(
    code: str = typer.Option(..., "--code"),
    date: str = typer.Option(..., "--date"),
    lenient: bool = typer.Option(False, "--lenient"),
    report: bool = typer.Option(False, "--report"),
) -> None:
    """Parse captured raw TSV into Parquet."""
    try:
        out = parse_stock_date(code=code, date=date, data_dir=resolve_data_dir(), lenient=lenient)
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]parse failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    console.print(f"[green]parsed[/green] {code}/{date} -> {out}")
    if report:
        meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
        for k, v in meta.items():
            if k in ("info_unknowns", "warnings", "raw_info_tsv"):
                continue
            console.print(f"  {k}: {v}")


@app.command()
def serve(port: int = typer.Option(8000, "--port")) -> None:
    """Start the FastAPI server."""
    load_env()  # ADR-0008: discover and load .env (no override at startup)
    uvicorn.run(
        "hoga.api.app:default_app",
        factory=True,
        host="127.0.0.1",
        port=port,
        reload=False,
    )


def _cache_observe_default_out() -> Path:
    return resolve_data_dir() / "cache-observe.jsonl"


_OUT_HELP = "JSONL trail (default: <data_dir>/cache-observe.jsonl)"


@app.command(name="cache-observe")
def cache_observe(
    url: str = typer.Option("http://127.0.0.1:8000", "--url", help="hoga server base URL"),
    interval: float = typer.Option(300.0, "--interval", help="seconds between samples"),
    out: Path | None = typer.Option(None, "--out", help=_OUT_HELP),
    count: int | None = typer.Option(None, "--count", help="stop after N samples (default: ∞)"),
) -> None:
    """Poll /api/live/status and append cache_stats to a JSONL trail.

    Snapshots the PR-1 cache observability counters over a real /live session so
    the deferred cache follow-ups can be gated on data. Ctrl-C to stop; read the
    trail with `hoga cache-report`.
    """
    from hoga.util.cache_observe import poll_loop  # noqa: PLC0415 — CLI-local import

    out_path = out or _cache_observe_default_out()

    def _on_sample(record, err) -> None:
        if err is not None:
            console.print(f"[yellow]fetch failed (skipped): {err}[/yellow]")
            return
        cs = record.get("cache_stats") or {}
        fresh = (cs.get("minute_backfill") or {}).get("fresh_past_fetches")
        console.print(f"[green]sample[/green] fresh_past_fetches={fresh} -> {out_path}")

    scope = "" if count is None else f" ×{count}"
    console.print(f"polling {url}{scope} every {interval:g}s → {out_path}")
    try:
        written = poll_loop(url, out_path, interval_s=interval, count=count, on_sample=_on_sample)
    except KeyboardInterrupt:
        written = None  # loop already returns on Ctrl-C; this is the outer guard
    console.print(f"[green]done[/green] wrote {written if written is not None else '?'} samples")


@app.command(name="cache-report")
def cache_report(
    in_: Path | None = typer.Option(None, "--in", help=_OUT_HELP),
) -> None:
    """Summarize a cache-observe trail into follow-up gate metrics."""
    from hoga.util.cache_observe import format_report, read_records, summarize  # noqa: PLC0415

    path = in_ or _cache_observe_default_out()
    console.print(format_report(summarize(read_records(path))))


@app.command(name="screener-seed")
def screener_seed() -> None:
    """One-time seed of the Screener archive from the dev-tradingview DB.

    Wires export(CSV) → seed parquet → derive 수정주가 → status.json into the
    machine-global data dir. Requires the tradingview-db docker container to
    be running (export_db_to_csv shells out to `docker exec ... psql`).
    """
    import time

    from hoga.api.screener_store import seed_all

    try:
        n = seed_all(resolve_data_dir(), now_ms=int(time.time() * 1000))
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]screener-seed failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    console.print(f"[green]seeded[/green] screener archive: {n} stocks")


@app.command(name="screener-backfill")
def screener_backfill() -> None:
    """Plan-2 1회 백필: KIS 수정주가로 factors.parquet 구축 + 원주가 reconcile + 수정주가 재파생.

    ~2-4h, resumable(중단 후 재실행하면 완료 종목 skip). KIS_APP_KEY/SECRET 필요.
    """
    import asyncio
    import time

    from hoga.api.screener_backfill import run_backfill

    t0 = time.time()
    try:
        rep = asyncio.run(run_backfill(resolve_data_dir()))
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]screener-backfill failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    print(f"backfill done in {time.time() - t0:.0f}s: "
          f"factors_added={rep['factors_added']}, "
          f"reconcile(match={rep['reconcile'].value_matches}, "
          f"mismatch={rep['reconcile'].value_mismatches}, filled={rep['reconcile'].filled_rows}), "
          f"impact(changed_codes={rep['impact']['changed_codes']})")


async def _run_repair_sweep(data_dir: Path, *, dry_run: bool) -> None:
    from hoga.api import study_views  # noqa: PLC0415 — CLI-local
    from hoga.api.queries import QueryEngine  # noqa: PLC0415
    from hoga.live import candle_repair  # noqa: PLC0415
    from hoga.live.kis_runtime import ensure_kis_client_from_env  # noqa: PLC0415

    saves = study_views.load_saves(data_dir).saves
    if not saves:
        console.print("[yellow]no saved study views[/yellow]")
        return
    engine = QueryEngine(data_dir)

    if dry_run:
        total_gap = 0
        for save in saves:
            gaps = candle_repair.scan_saved_view_gaps(
                engine, code=save.code,
                from_date=save.range.from_date, to_date=save.range.to_date,
            )
            total_gap += len(gaps)
            if gaps:
                console.print(
                    f"  {save.code} {save.range.from_date}-{save.range.to_date}: "
                    f"{len(gaps)} gap day(s): {', '.join(gaps)}"
                )
        console.print(
            f"[green]dry-run[/green] {len(saves)} view(s), {total_gap} gap day(s) total"
        )
        return

    client = ensure_kis_client_from_env(data_dir)  # account 0; also registers globally
    if client is None:
        console.print(
            "[red]KIS credentials not set (KIS_APP_KEY/SECRET) — cannot repair[/red]"
        )
        return

    async def _fetch(code: str, date_s: str):
        return await client.fetch_past_minute_candles(
            code, date_s, venue="KRX", foreground=True,
        )

    tot_r = tot_s = tot_u = tot_e = 0
    for save in saves:
        summary = await candle_repair.repair_saved_view_range(
            engine, data_dir,
            code=save.code, from_date=save.range.from_date, to_date=save.range.to_date,
            fetch=_fetch,
        )
        if summary is None:
            console.print("[yellow]repair gated off (kis_rest_bypass enabled)[/yellow]")
            return
        tot_r += len(summary.repaired)
        tot_s += len(summary.skipped)
        tot_u += len(summary.unavailable)
        tot_e += len(summary.errors)
        if summary.repaired or summary.unavailable or summary.errors:
            console.print(
                f"  {save.code} {save.range.from_date}-{save.range.to_date}: "
                f"repaired={summary.repaired} unavailable={summary.unavailable} "
                f"errors={summary.errors}"
            )
    console.print(
        f"[green]repair done[/green] repaired={tot_r} skipped={tot_s} "
        f"unavailable={tot_u} errors={tot_e}"
    )


@app.command(name="repair-study-candles")
def repair_study_candles(
    dry_run: bool = typer.Option(False, "--dry-run", help="공백만 리포트하고 쓰지 않음"),
) -> None:
    """저장된 /study 뷰들의 hogaplay 캡처 공백을 KIS 분봉으로 1회 복구.

    저장뷰가 실제로 가리키는 (종목, 구간)의 과거 거래일 중 캔들이 비는 날만 KIS
    과거 분봉으로 메워 kis_api/candles.parquet에 박제한다. 멱등(이미 있으면 스킵).
    KIS_APP_KEY/SECRET 필요. --dry-run은 KIS 미접근으로 공백만 보고한다.
    """
    import asyncio  # noqa: PLC0415 — CLI-local

    load_env()  # ADR-0008: KIS 자격증명을 .env에서 로드
    data_dir = resolve_data_dir()
    try:
        asyncio.run(_run_repair_sweep(data_dir, dry_run=dry_run))
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]repair-study-candles failed: {e}[/red]")
        raise typer.Exit(code=1) from e


@app.command(name="depth-daily-sweep")
def depth_daily_sweep(
    dry_run: bool = typer.Option(False, "--dry-run", help="스캔 대상만 세고 쓰지 않음"),
    code: str | None = typer.Option(None, "--code", help="한 종목만(6자리)"),
) -> None:
    """hogaplay 캡처에서 (code,date)별 매도/매수 총잔량 당일 peak 를 집계해
    screener/depth_daily.parquet 에 박제한다(스크리너 총잔량 신고 조건의 과거 기준).

    증분: 메타 mtime 이 그대로면 재계산을 건너뛴다. 멱등(반복 실행 안전).
    --dry-run 은 parquet 트리를 훑어 hogaplay meta.json 이 있는 스톡데이트 수(=sweep 의
    scanned)만 센다 — peak 계산(DuckDB)이나 쓰기는 하지 않으므로 즉시 끝난다.
    """
    import time  # noqa: PLC0415 — CLI-local

    from hoga.api import depth_daily  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    codes = {code} if code else None
    if dry_run:
        # 실계산 없이 대상 후보만 센다 — 메타 존재 여부까지만 확인.
        parquet_root = data_dir / "parquet"
        n = 0
        if parquet_root.exists():
            for date_dir in sorted(parquet_root.iterdir()):
                if not date_dir.is_dir() or not depth_daily.is_yyyymmdd(date_dir.name):
                    continue
                for code_dir in sorted(date_dir.iterdir()):
                    if not code_dir.is_dir():
                        continue
                    if codes is not None and code_dir.name not in codes:
                        continue
                    src_dir = depth_daily.resolve_source_dir(code_dir, depth_daily.HOGAPLAY)
                    if (src_dir / "meta.json").exists():
                        n += 1
        console.print(f"[green]dry-run[/green] {n} hogaplay stock-date(s) in scope")
        return
    t0 = time.time()
    try:
        res = depth_daily.sweep(data_dir, codes=codes)
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]depth-daily-sweep failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    console.print(
        f"[green]depth-daily-sweep done[/green] in {time.time() - t0:.0f}s: "
        f"scanned={res.scanned} computed={res.computed} skipped={res.skipped} "
        f"no_data={res.no_data} total_rows={res.total_rows}"
    )


@app.command(name="backfill-live-meta")
def backfill_live_meta_cmd(
    dry_run: bool = typer.Option(False, "--dry-run", help="갱신 대상만 세고 쓰지 않음"),
) -> None:
    """이미 승격된 KIS live/REST meta.json 에 완결성 필드를 소급 기록한다.

    변경 이전에 승격된 kis_live/kis_api Stock-Date 는 collection_complete/
    is_partial/gap_ranges 가 없어 캘린더에서 영구 ✕ 로 남는다. 이 스윕은
    snapshots.parquet 의 ts_ms 로 갭 분석을 재계산해 그 세 필드를 채운다
    (과거 날짜만; 오늘은 Today Promoter 가 15:35 에 최종화). 멱등.
    """
    from hoga.live.meta_backfill import backfill_live_meta  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    try:
        res = backfill_live_meta(data_dir, dry_run=dry_run)
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]backfill-live-meta failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    tag = "dry-run" if dry_run else "done"
    console.print(
        f"[green]backfill-live-meta {tag}[/green]: "
        f"scanned={res.scanned} updated={res.updated} skipped={res.skipped}"
    )


@app.command(name="backfill-hogaplay-meta")
def backfill_hogaplay_meta_cmd(
    dry_run: bool = typer.Option(False, "--dry-run", help="갱신 대상만 세고 쓰지 않음"),
) -> None:
    """ADR-0126: 과거 hogaplay meta의 is_partial/gap_ranges를 세션 엣지 앵커로 재계산.

    anchor_edges=False 로 기록돼 선행 갭(다음날 아침 수집으로 오전 소실)을
    COMPLETE 로 오판한 hogaplay meta 를 snapshots.parquet 에서 재파생한다.
    is_partial/gap_ranges 만 rewrite 하고 collection_complete 등 나머지 필드는
    보존한다 (과거 날짜만). 멱등: 2회차는 diff 가 없어 skip.
    """
    from hoga.live.meta_backfill import backfill_hogaplay_meta  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    try:
        res = backfill_hogaplay_meta(data_dir, dry_run=dry_run)
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]backfill-hogaplay-meta failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    tag = "dry-run" if dry_run else "done"
    console.print(
        f"[green]backfill-hogaplay-meta {tag}[/green]: "
        f"scanned={res.scanned} updated={res.updated} skipped={res.skipped}"
    )


@app.command(name="ls")
def list_stock_dates() -> None:
    """Show captured/parsed Stock-Dates."""
    raw_root = resolve_data_dir() / "raw"
    parquet_root = resolve_data_dir() / "parquet"
    pairs: dict[tuple[str, str], dict[str, bool]] = {}
    if raw_root.exists():
        for date_dir in raw_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir():
                    continue
                pairs[(date_dir.name, code_dir.name)] = {"raw": True, "parsed": False}
    if parquet_root.exists():
        for date_dir in parquet_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir():
                    continue
                key = (date_dir.name, code_dir.name)
                pairs.setdefault(key, {"raw": False, "parsed": False})
                pairs[key]["parsed"] = (code_dir / "meta.json").exists()
    table = Table(title="hoga-ops captures")
    table.add_column("date")
    table.add_column("code")
    table.add_column("raw")
    table.add_column("parsed")
    for (d, c), state in sorted(pairs.items()):
        table.add_row(
            d,
            c,
            "[green]Y[/green]" if state["raw"] else "-",
            "[green]Y[/green]" if state["parsed"] else "-",
        )
    console.print(table)


def _run_series_for(stock_date_dir, meta):
    """Load parquet artifacts for one Stock-Date dir and run series invariants.

    Missing parquet files (path doesn't exist) skip silently and return an
    empty result — that's the legitimate 'nothing to check' path.

    Load errors (read failure, schema drift) print a yellow warning and
    return an empty list for that artifact — converting a silent false-clean
    into an explicit 'I couldn't check' signal. The CLI is a diagnostic
    tool; hiding load failures would be the worst UX choice.
    """
    import pyarrow.parquet as _pq

    from hoga.api.invariants import StockDateArtifacts, check_series
    from hoga.tables import candles as _candles
    from hoga.tables import snapshots as _snapshots
    from hoga.tables.trades import Trade

    def _read(path, loader):
        # Returns None (not []) for missing/unreadable — the series invariants
        # use None as the "skip, nothing to check" sentinel. An empty list
        # would falsely look like 'data is loaded but empty' which fires
        # series.snapshots_no_gaps (has_meaningful_gaps treats <2 datapoints
        # as suspicious).
        if not path.exists():
            return None
        try:
            return loader(path)
        except Exception as exc:  # noqa: BLE001 — diagnostic surface
            console.print(
                f"[yellow]  warning: could not load {path.name}: {exc}[/yellow]"
            )
            return None

    def _read_dataclass(path, ctor):
        return [ctor(**row) for row in _pq.read_table(path).to_pylist()]

    # Candles use the dedicated reader (not _read_dataclass): the parquet
    # columns are open/close but the Candle fields are open_/close_, so
    # Candle(**row) raises. candles.read_parquet owns that remap — see its
    # docstring for why a naive loader silently broke validate --deep.
    candles = _read(stock_date_dir / "candles.parquet", _candles.read_parquet)
    # Orderbook flat-schema round-trip lives in the snapshots module so the
    # write/read pair stays symmetric (ADR-0020 §3c — see snapshots.read_parquet).
    snapshots = _read(stock_date_dir / "snapshots.parquet",
                      _snapshots.read_parquet)
    trades = _read(stock_date_dir / "trades.parquet",
                   lambda p: _read_dataclass(p, Trade))
    return check_series(StockDateArtifacts(
        meta=meta, candles=candles, snapshots=snapshots, trades=trades,
    ))


@app.command()
def validate(
    code: str | None = typer.Option(None, "--code", help="Limit to a single Code (e.g. 005930)."),
    severity: str = typer.Option("error", "--severity",
                                 help="Filter: 'error', 'warn', or 'all'."),
    fix: bool = typer.Option(False, "--fix",
                             help="Rewrite invariant_violations archival field (data untouched)."),
    deep: bool = typer.Option(False, "--deep",
                              help="Also run series invariants (loads candles/snapshots/trades parquet)."),
) -> None:
    """Sweep all parquet Stock-Dates and report invariant violations.

    Read-only by default. ``--fix`` rewrites only the archival
    ``invariant_violations`` field in meta.json — the underlying capture
    data is never modified or deleted. The fix path is for refreshing the
    archival snapshot after the invariants catalog changes; data repair
    means re-capturing.
    """
    import json as _json

    from hoga.api.invariants import check as _check
    from hoga.config import resolve_data_dir

    valid_severities = {"error", "warn", "all"}
    if severity not in valid_severities:
        raise typer.BadParameter(
            f"--severity must be one of {sorted(valid_severities)}, got {severity!r}"
        )

    data_dir = resolve_data_dir()
    parquet_root = data_dir / "parquet"
    if not parquet_root.exists():
        console.print("[yellow]No parquet directory found.[/yellow]")
        return

    rows: list[tuple[str, str, list]] = []
    fix_count = 0
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir():
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            if code is not None and code_dir.name != code:
                continue
            meta_p = code_dir / "meta.json"
            if not meta_p.exists():
                continue
            meta = _json.loads(meta_p.read_text(encoding="utf-8"))
            # Compute the full (severity-unfiltered) set ONCE — `violations`
            # is the display slice (severity-filtered); `full` is the archival
            # source. Without the cache, --deep --fix would load parquet twice
            # for every Stock-Date with violations.
            full = _check(meta)
            if deep:
                full = full + _run_series_for(code_dir, meta)
            violations = (full if severity == "all"
                          else [v for v in full if v.severity.value == severity])
            # --fix reconciles archival_violations both directions: writes new
            # entries AND clears stale ones (e.g. when an invariant tightens
            # OR loosens). The previous "skip when display-empty" branch
            # short-circuited BEFORE the fix block, so files whose computed
            # set dropped to empty (catalog loosening case) kept their stale
            # archival list forever. Concrete loss: when the
            # series.candles_ts_monotonic false-positive fix landed, --fix
            # cleared only 66/805 affected files; the other 739 had only the
            # stale candles entries (nothing else to display), so they were
            # silently skipped.
            if fix:
                stored = meta.get("invariant_violations") or []
                computed = [v.as_dict() for v in full]
                if stored != computed:
                    if computed:
                        meta["invariant_violations"] = computed
                    else:
                        meta.pop("invariant_violations", None)
                    meta_p.write_text(_json.dumps(meta, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
                    fix_count += 1
            if not violations:
                continue
            rows.append((date_dir.name, code_dir.name, violations))

    if not rows:
        if fix and fix_count:
            console.print(f"[blue]--fix: cleared stale invariant_violations on {fix_count} files.[/blue]")
        console.print("[green]All Stock-Dates are clean for the requested severity.[/green]")
        return

    for date, code_, violations in rows:
        console.print(f"[bold]{date}/{code_}[/bold]")
        for v in violations:
            console.print(f"  [{v.severity.value}] {v.invariant_id}: {v.message}  ctx={v.ctx}")

    if fix:
        console.print(f"\n[blue]--fix: rewrote invariant_violations on {fix_count} files.[/blue]")


@app.command()
def prune(
    days: int | None = typer.Option(
        None, "--days",
        help="Retention window in CALENDAR days (default: HOGA_RETENTION_DAYS or 3).",
    ),
    execute: bool = typer.Option(
        False, "--execute",
        help="Actually delete. Default is dry-run (report only).",
    ),
) -> None:
    """Prune hogaplay raw older than the retention window when its parquet is COMPLETE.

    Read-only by default — prints what WOULD be deleted. Pass ``--execute`` to
    delete. Only hogaplay-source COMPLETE raw past the window is removed; resume
    sources, partials, and sentinels are preserved (ADR-0075).
    """
    from hoga.api.prune import prune_default_now, prune_raw, resolve_retention_days

    retention = days if days is not None else resolve_retention_days()
    if retention < 1:
        raise typer.BadParameter(
            "--days must be >= 1 (a 0-day window would race in-flight captures)."
        )

    result = prune_raw(
        resolve_data_dir(), retention_days=retention, now=prune_default_now(), execute=execute,
    )
    if execute:
        gib = result.reclaimed_bytes / 1024**3
        console.print(f"[green]pruned[/green] {result.deleted} dirs, {gib:.1f} GiB reclaimed")
    else:
        cand_gib = sum(c.size_bytes for c in result.candidates) / 1024**3
        console.print(
            f"[yellow]dry-run[/yellow]: would delete {len(result.candidates)} dirs, "
            f"~{cand_gib:.1f} GiB (pass --execute to delete)"
        )
