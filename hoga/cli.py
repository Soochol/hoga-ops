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
    Returns a Violation list; missing parquet files (or load errors) are
    skipped silently so the CLI degrades gracefully — diagnostics beats crashing."""
    import pyarrow.parquet as _pq

    from hoga.api.invariants import StockDateArtifacts, check_series
    from hoga.tables.candles import Candle
    from hoga.tables.snapshots import Orderbook
    from hoga.tables.trades import Trade

    def _read(path, builder):
        if not path.exists():
            return None
        try:
            table = _pq.read_table(path)
            return [builder(row) for row in table.to_pylist()]
        except Exception:
            return None

    # Orderbook fields are tuples in the dataclass but lists in parquet —
    # the kwargs constructor accepts both (Python tuple/list interop), but
    # if the parquet schema drifts, the try/except in _read silences it.
    candles = _read(stock_date_dir / "candles.parquet",
                    lambda r: Candle(**r))
    snapshots = _read(stock_date_dir / "snapshots.parquet",
                      lambda r: Orderbook(**r))
    trades = _read(stock_date_dir / "trades.parquet",
                   lambda r: Trade(**r))
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
            violations = _check(meta)
            if deep:
                violations = violations + _run_series_for(code_dir, meta)
            if severity != "all":
                violations = [v for v in violations if v.severity.value == severity]
            if not violations:
                continue
            rows.append((date_dir.name, code_dir.name, violations))
            if fix:
                # Always recompute the FULL set (both meta + series if deep)
                # for the archival field — severity-agnostic.
                full = _check(meta)
                if deep:
                    full = full + _run_series_for(code_dir, meta)
                meta["invariant_violations"] = [v.as_dict() for v in full]
                meta_p.write_text(_json.dumps(meta, ensure_ascii=False, indent=2),
                                  encoding="utf-8")

    if not rows:
        console.print("[green]All Stock-Dates are clean for the requested severity.[/green]")
        return

    for date, code_, violations in rows:
        console.print(f"[bold]{date}/{code_}[/bold]")
        for v in violations:
            console.print(f"  [{v.severity.value}] {v.invariant_id}: {v.message}  ctx={v.ctx}")

    if fix:
        console.print(f"\n[blue]--fix: rewrote invariant_violations on {len(rows)} files.[/blue]")
