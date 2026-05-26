"""Typer CLI for hoga-ops."""

from __future__ import annotations

import json

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
    from hoga.tables import snapshots as _snapshots
    from hoga.tables.candles import Candle
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

    candles = _read(stock_date_dir / "candles.parquet",
                    lambda p: _read_dataclass(p, Candle))
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
