"""Typer CLI for hoga-ops."""

from __future__ import annotations

import json
from collections.abc import Iterator
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
from hoga.util.atomic_write import atomic_write_json

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
        except Exception as e:
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
    except Exception as e:
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
def serve(
    port: int = typer.Option(8000, "--port"),
    host: str = typer.Option(
        "127.0.0.1",
        "--host",
        help="바인드 주소. 기본은 루프백. prod 는 tailscale 인터페이스 주소만 지정 — "
        "공인 인터페이스 바인드 금지 (ADR-0134, README 'Access model').",
    ),
) -> None:
    """Start the FastAPI server."""
    load_env()  # ADR-0008: discover and load .env (no override at startup)
    uvicorn.run(
        "hoga.api.app:default_app",
        factory=True,
        host=host,
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
    from hoga.util.cache_observe import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        format_report,
        read_records,
        summarize,
    )

    path = in_ or _cache_observe_default_out()
    console.print(format_report(summarize(read_records(path))))


@app.command(name="screener-seed")
def screener_seed() -> None:
    """One-time seed of the Screener archive from the dev-tradingview DB.

    Wires export(CSV) → seed parquet → derive 수정주가 → status.json into the
    machine-global data dir. Requires the tradingview-db docker container to
    be running (export_db_to_csv shells out to `docker exec ... psql`).
    """
    import time  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    from hoga.api.screener_store import seed_all  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    try:
        n = seed_all(resolve_data_dir(), now_ms=int(time.time() * 1000))
    except Exception as e:
        console.print(f"[red]screener-seed failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    console.print(f"[green]seeded[/green] screener archive: {n} stocks")


@app.command(name="screener-backfill")
def screener_backfill(
    factors_only: bool = typer.Option(
        False, "--factors-only", help="reconcile 을 건너뛴다 — 장중에 돌릴 수 있는 형태"),
) -> None:
    """Plan-2 1회 백필: 키움 수정주가로 factors.parquet 구축 + 원주가 reconcile + 수정주가 재파생.

    ~2-4h, resumable(중단 후 재실행하면 완료 종목 skip). KIWOOM_APP_KEY/SECRET 필요.

    ⚠ **기본형은 장 마감 후에만 돌릴 것.** reconcile 이 최근 14일을 벤더 값으로
    덮어쓰는데, 장중에는 그 「최근」에 **진행 중인 오늘 봉**이 들어 있다. 미확정 봉이
    확정본으로 굳으면 갱신기가 그 날짜를 갭으로 안 봐서 **영원히 안 고쳐진다**
    (2026-06-18 사고 — 3,541종목이 장전 스냅샷으로 굳어 두 달간 남았다).

    `--factors-only` 는 그 단계를 건너뛴다. 「계수 없는 종목에 계수를 준다」는 목적에는
    reconcile 이 필요하지 않으므로, 장중에도 안전하게 그 목적만 달성할 수 있다.
    """
    import asyncio  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
    import time  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    from hoga.api.screener_backfill import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        run_backfill,
    )

    # ⚠ **`.env` 를 여기서 읽는다.** `load_env()` 는 오랫동안 `serve` 에서만 불렸다 —
    # 그래서 이 명령은 자격증명이 설정돼 있어도 **늘 무자격으로 돌아** 「자격증명 없음」
    # 으로 죽었다(실측 2026-09-04). 죽는 방식이 loud fail 이라 조용한 실패는 아니었지만,
    # 메시지가 「설정하라」고 말하는데 **이미 설정돼 있는** 상태라 원인을 짚을 수 없다.
    # `resolve_data_dir()` 보다 먼저 불러야 한다 — 그쪽도 env 를 본다.
    load_env()
    t0 = time.time()
    try:
        rep = asyncio.run(run_backfill(resolve_data_dir(), factors_only=factors_only))
    except Exception as e:
        console.print(f"[red]screener-backfill failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    rec = rep["reconcile"]
    # `--factors-only` 면 reconcile 이 **안 돈 것**이지 0건이 아니다 — 숫자로 적으면
    # 「대조했는데 전부 일치」와 구별되지 않는다.
    rec_s = ("reconcile(건너뜀)" if rec is None else
             f"reconcile(match={rec.value_matches}, mismatch={rec.value_mismatches}, "
             f"filled={rec.filled_rows})")
    print(f"backfill done in {time.time() - t0:.0f}s: "
          f"factors_added={rep['factors_added']}, {rec_s}, "
          f"impact(changed_codes={rep['impact']['changed_codes']})")


@app.command(name="screener-history-backfill")
def screener_history_backfill(
    years: int = typer.Option(5, "--years", help="오늘로부터 몇 년 전까지를 채울지"),
    yes: bool = typer.Option(False, "--yes", help="실제로 받아 쓴다(기본은 dry-run)"),
    codes: str = typer.Option("", "--codes", help="쉼표 구분 종목코드(미지정=전 종목)"),
) -> None:
    """일봉 코퍼스의 **앞쪽 결손**을 벤더 이력으로 채운다.

    코퍼스는 CSV 시드 + 일일 증분으로만 자라서 종목마다 시작일이 다르다 — 차트에는
    2019년 캔들이 보이는데 패턴 검색은 「없다」고 하는 원인이 이것이다.

    **기본은 dry-run 이고, dry-run 은 자격증명도 벤더 호출도 필요 없다** — 계획은
    거래일 달력과 코퍼스만으로 나온다. 먼저 돌려서 대상 수를 보고 `--yes` 로 실행할 것.

    ⚠ 차트와 **같은 TR 버킷**(`ka10081`)을 쓴다. `background` 우선순위라 사용자 조작에
    양보하지만, 장중에 돌리면 그만큼 늘어진다 — **장 마감 후 실행이 자연스럽다**.
    """
    import asyncio  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
    import datetime as dt  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈)
    import time  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    from hoga.api.screener_history_backfill import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        run_history_backfill,
    )

    # ⚠ 위 `screener-backfill` 과 같은 이유로 여기서 `.env` 를 읽는다. dry-run 은
    # 자격증명이 필요 없지만 `--yes` 는 필요하고, 안 읽으면 그 경로가 **원리적으로**
    # 동작할 수 없다.
    load_env()

    today = dt.date.today()
    gap_from = today.replace(year=today.year - years)
    want = [c.strip() for c in codes.split(",") if c.strip()] or None
    t0 = time.time()
    try:
        rep = asyncio.run(run_history_backfill(
            resolve_data_dir(), gap_from=gap_from, dry_run=not yes, codes=want,
            # 종목 지정이 없으면 **그 날짜 이후에 시작하는 종목만** 후보다 —
            # 전 종목을 도는 것과 결과는 같지만 계획 단계가 훨씬 싸다.
            corpus_start_after=None if want else gap_from,
        ))
    except Exception as e:
        console.print(f"[red]screener-history-backfill failed: {e}[/red]")
        raise typer.Exit(code=1) from e

    todo = [p for p in rep.plans if p.skipped_reason is None]
    cells = rep.missing_cells
    label = "dry-run" if rep.dry_run else "done"
    console.print(
        f"[green]{label}[/green] {time.time() - t0:.0f}s · "
        f"대상 {len(todo):,}/{len(rep.plans):,}종목 · "
        f"결손 앞쪽 {cells['leading']:,} + 내부 {cells['interior']:,}칸 · "
        f"스킵 {rep.skipped} · 기록 {rep.written_rows:,}행"
    )
    if rep.leading_is_upper_bound:
        # 프로브가 모르는 종목이 섞이면 앞쪽 결손에 **「상장 전」**이 들어 있을 수 있다.
        console.print(
            "[yellow]주의[/yellow] 앞쪽 결손은 **상한**이다 — 프로브가 아직 모르는 "
            "종목이 있어 「상장 전」이 섞여 있을 수 있다. 한 번 실행하면 정확해진다."
        )


@app.command(name="depth-daily-sweep")
def depth_daily_sweep(
    dry_run: bool = typer.Option(False, "--dry-run", help="스캔 대상만 세고 쓰지 않음"),
    code: str | None = typer.Option(None, "--code", help="한 종목만(6자리)"),
) -> None:
    """캡처에서 (code,date,src)별 매도/매수 총잔량 당일 peak 를 집계해
    screener/depth_daily.parquet 에 박제한다(스크리너 총잔량 신고 조건의 과거 기준).

    소스는 ``depth_daily.SWEEP_SOURCES`` — hogaplay 와 kiwoom_live 를 **둘 다** 집계하고,
    읽는 쪽이 (code,date)당 hogaplay 우선으로 고른다(없으면 kiwoom_live 폴백).

    증분: 메타 mtime 이 그대로면 재계산을 건너뛴다. 멱등(반복 실행 안전).
    --dry-run 은 parquet 트리를 훑어 대상 meta.json 이 있는 (스톡데이트, 소스) 수
    (=sweep 의 scanned)만 센다 — peak 계산(DuckDB)이나 쓰기는 하지 않으므로 즉시 끝난다.
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
                    # sweep 과 같은 소스 목록을 돈다 — 하드코딩하면 dry-run 이
                    # 실제 스캔량을 과소 보고한다(소스 수만큼 어긋난다).
                    for source in depth_daily.SWEEP_SOURCES:
                        src_dir = depth_daily.resolve_source_dir(code_dir, source, "KRX")
                        if (src_dir / "meta.json").exists():
                            n += 1
        console.print(f"[green]dry-run[/green] {n} (stock-date, source) pair(s) in scope")
        return
    t0 = time.time()
    try:
        res = depth_daily.sweep(data_dir, codes=codes)
    except Exception as e:
        console.print(f"[red]depth-daily-sweep failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    console.print(
        f"[green]depth-daily-sweep done[/green] in {time.time() - t0:.0f}s: "
        f"scanned={res.scanned} computed={res.computed} skipped={res.skipped} "
        f"no_data={res.no_data} total_rows={res.total_rows}"
    )


@app.command(name="peak-prewarm")
def peak_prewarm_cmd(
    limit: int = typer.Option(0, "--limit", help="계산 상한(0=무제한). 일일 런은 2000."),
    dry_run: bool = typer.Option(False, "--dry-run", help="대상만 세고 계산하지 않음"),
    code: str | None = typer.Option(None, "--code", help="한 종목만(6자리)"),
) -> None:
    """과거일 **1분** 최대벽 캐시를 미리 채운다 — 콜드 sidecar 로드를 없앤다.

    1분 한 번이 `ask_peak`·`bid_peak`·`peak_rep` 셋을 채우고 3m~240m 은 스캔 없이
    파생되므로(실측 ~70배) 봉별로 돌 필요가 없다. 근거는 `hoga.api.peak_prewarm`
    모듈 docstring.

    같은 함수를 일일 런(17:00)이 상한 2000 으로 부른다 — 이 명령은 그 상한 없이
    **즉시 전량**을 채우고 싶을 때 쓴다(캐시 버전 범프 직후 등). 멱등·증분이라
    중단 후 재실행이 안전하다. 관심종목을 먼저 채우고 각 그룹 안에서는 최신순이다.

    ⚠ 전량은 오래 걸린다. 먼저 `--dry-run` 으로 대상 수를 보고 결정할 것 —
    hogaplay 는 스톡데이트당 ~0.37s, kiwoom_live 는 ~0.07s 다(2026-08-28 실측).
    """
    import time  # noqa: PLC0415 — CLI-local

    from hoga.api import peak_prewarm  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    t0 = time.time()
    try:
        res = peak_prewarm.prewarm(
            data_dir,
            codes={code} if code else None,
            limit=limit or None,
            dry_run=dry_run,
        )
    except Exception as e:
        console.print(f"[red]peak-prewarm failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    label = "dry-run" if dry_run else "done"
    console.print(
        f"[green]peak-prewarm {label}[/green] in {time.time() - t0:.0f}s: "
        f"scanned={res.scanned} warmed={res.warmed} skipped={res.skipped} "
        f"failed={res.failed} truncated={res.truncated}"
    )


@app.command(name="prune-indicator-cache")
def prune_indicator_cache_cmd(
    yes: bool = typer.Option(False, "--yes", help="실제로 지운다(기본은 세기만)"),
) -> None:
    """죽은 버전의 지표 캐시 파일을 지운다.

    `KIND_VERSIONS` 범프는 **읽을 때 stale 로 판정**할 뿐이라 디스크의 옛 파일이
    그대로 쌓인다. 읽기 경로가 조용히 무시하므로 정확성 문제가 아니라 **공간**
    문제이고, 그래서 언제 돌려도 안전하고 안 돌려도 동작이 바뀌지 않는다.

    기본은 세기만 한다 — 규모를 보고 `--yes` 로 실행할 것. 버전이 **낮은** 것만
    지우므로(높은 것은 더 새 코드가 쓴 것) 롤백 여지를 남긴다. 멱등.
    """
    import time  # noqa: PLC0415 — CLI-local

    from hoga.api import indicator_cache_prune  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    t0 = time.time()
    try:
        res = indicator_cache_prune.prune(data_dir, dry_run=not yes)
    except Exception as e:
        console.print(f"[red]prune-indicator-cache failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    label = "deleted" if yes else "dry-run"
    console.print(
        f"[green]prune-indicator-cache {label}[/green] in {time.time() - t0:.0f}s: "
        f"scanned={res.scanned} stale={res.stale} retired={res.retired} "
        f"deleted={res.deleted} freed={res.bytes_freed / 1e9:.2f}GB "
        f"unreadable={res.unreadable} unknown_kind={res.unknown_kind}"
    )
    if not yes and (res.stale or res.retired):
        console.print("[yellow]실제로 지우려면 --yes 를 붙여 다시 실행하세요.[/yellow]")


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
    except Exception as e:
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
    except Exception as e:
        console.print(f"[red]backfill-hogaplay-meta failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    tag = "dry-run" if dry_run else "done"
    console.print(
        f"[green]backfill-hogaplay-meta {tag}[/green]: "
        f"scanned={res.scanned} updated={res.updated} skipped={res.skipped}"
    )


@app.command(name="backfill-indicator-session")
def backfill_indicator_session_cmd(
    dry_run: bool = typer.Option(False, "--dry-run", help="갱신 대상만 세고 쓰지 않음"),
) -> None:
    """ADR-0140: 승격된 kiwoom_live/{venue}/meta.json 에 venue 별 지표 구간을 소급 기록.

    이 키가 생기기 전 승격본은 정규장 경계(09:00–15:30)만 실었고, 조회 경로가 그걸
    지표 경계로 읽어 NXT·UN 의 프리·애프터마켓 호가가 지표 집계에서 통째로 빠졌다.
    데이터는 디스크에 온전하므로 판독 경계만 고치면 된다 (과거 날짜만; 오늘은
    promote 가 다시 쓴다). 멱등.

    부수효과가 의도된 것 하나: meta.json mtime 이 지표 캐시의 정체성 토큰이라
    이 재작성이 **잘린 값으로 캐시된 지표를 자동 무효화**한다.
    """
    from hoga.live.meta_backfill import backfill_indicator_session_bounds  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    try:
        res = backfill_indicator_session_bounds(data_dir, dry_run=dry_run)
    except Exception as e:
        console.print(f"[red]backfill-indicator-session failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    tag = "dry-run" if dry_run else "done"
    console.print(
        f"[green]backfill-indicator-session {tag}[/green]: "
        f"scanned={res.scanned} updated={res.updated} skipped={res.skipped}"
    )


@app.command(name="backfill-venue-gaps")
def backfill_venue_gaps_cmd(
    dry_run: bool = typer.Option(False, "--dry-run", help="갱신 대상만 세고 쓰지 않음"),
) -> None:
    """ADR-0140: kiwoom_live/{venue}/meta.json 의 is_partial/gap_ranges 를 venue 별
    갭 창으로 재계산한다.

    하한이 09:00 고정이던 시절 NXT·UN 의 프리·애프터마켓 결손이 분석 대상 밖이었다.
    ⚠ 이 스윕은 **값을 덮어쓴다**(키 추가가 아니다) — `--dry-run` 이 is_partial
    전이 수와 gap 개수 증감을 먼저 보여 주니 그걸 확인하고 실행할 것.
    """
    from hoga.live.meta_backfill import backfill_venue_gap_ranges  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    try:
        res = backfill_venue_gap_ranges(data_dir, dry_run=dry_run)
    except Exception as e:
        console.print(f"[red]backfill-venue-gaps failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    tag = "dry-run" if dry_run else "done"
    console.print(
        f"[green]backfill-venue-gaps {tag}[/green]: "
        f"scanned={res.scanned} updated={res.updated} skipped={res.skipped}\n"
        f"  is_partial False→True={res.partial_false_to_true} "
        f"True→False={res.partial_true_to_false}  gap 개수 증감={res.gap_count_delta:+d}"
    )


@app.command(name="repair-split-candles")
def repair_split_candles_cmd(
    dry_run: bool = typer.Option(False, "--dry-run", help="대상만 세고 쓰지 않음"),
) -> None:
    """이미 쓰인 kiwoom_live candles 파케이의 쪼개진 분봉을 한 봉으로 접는다.

    실시간 분봉 합성(ADR-0125)이 한 분을 여러 행으로 내보냈다 — 봉인 뒤 도착한 틱이
    새 봉을 만들었기 때문이다(생산자는 수정됨). 그 결과 디스크가
    ``series.candles_ts_monotonic`` (Severity.error) 을 위반한 채 남아 있다.

    과거 날짜만 훑는다 — 오늘은 Today Promoter 가 주기마다 다시 쓰므로 생산자 수정
    이후 저절로 낫는다. 멱등: 2회차는 repaired=0.
    """
    from hoga.live.candle_repair import repair_split_candles  # noqa: PLC0415 — CLI-local

    data_dir = resolve_data_dir()
    try:
        res = repair_split_candles(data_dir, dry_run=dry_run)
    except Exception as e:
        console.print(f"[red]repair-split-candles failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    tag = "dry-run" if dry_run else "done"
    console.print(
        f"[green]repair-split-candles {tag}[/green]: "
        f"scanned={res.scanned} repaired={res.repaired} "
        f"clean={res.skipped_clean} unreadable={res.unreadable}\n"
        f"  행 수 {res.rows_before} → {res.rows_after} "
        f"({res.rows_after - res.rows_before:+d})"
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
    import pyarrow.parquet as _pq  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    from hoga.api.invariants import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        StockDateArtifacts,
        check_series,
    )
    from hoga.tables import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        candles as _candles,
        snapshots as _snapshots,
    )
    from hoga.tables.trades import Trade  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

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


def _iter_stock_date_metas(
    parquet_root: Path, code: str | None
) -> Iterator[tuple[str, Path]]:
    """Yield ``(label, meta_path)`` for every Stock-Date meta.json under parquet/.

    Handles BOTH on-disk layouts:

    - ADR-0037 (current): ``parquet/{date}/{code}/{source}/meta.json`` — one
      meta per Source, label ``{date}/{code}/{source}``.
    - pre-ADR-0037 (legacy residue): ``parquet/{date}/{code}/meta.json`` —
      label ``{date}/{code}``.

    Why both: the ADR-0037 migration moved captures into ``{source}/``
    subdirectories, but a flat-layout tail survives on real corpora. Measured
    2026-07-29 on the dev machine: 404 flat vs 18,809 source-scoped, i.e. the
    flat-only walk this replaces was checking **2.1%** of Stock-Dates and
    silently ``continue``-ing past the rest — then printing "All Stock-Dates
    are clean". A diagnostic tool that skips 97.9% of its corpus and reports
    safety is worse than no tool. Every test in tests/test_cli_validate.py
    seeded the flat layout, so the suite stayed green throughout.

    The yielded path is the directory-bearing meta.json, so ``--deep`` reads
    ``candles/snapshots/trades.parquet`` from ``meta_path.parent`` — which is
    the Source directory under ADR-0037, exactly where those files live.

    Mirrors ``disk_state.classify_stock_date``'s ``<stock_date_dir>/*/meta.json``
    traversal; kept here rather than reusing it because validate needs the raw
    path (for ``--fix`` write-back), not a Classification.
    """
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir():
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            if code is not None and code_dir.name != code:
                continue
            stem = f"{date_dir.name}/{code_dir.name}"
            # Source-scoped first (ADR-0037), then the legacy flat file. Both
            # can coexist mid-migration; each is a distinct row so a violation
            # in one source is never masked by a clean sibling.
            for src_dir in sorted(code_dir.iterdir()):
                if not src_dir.is_dir():
                    continue
                meta_p = src_dir / "meta.json"
                if meta_p.exists():
                    yield f"{stem}/{src_dir.name}", meta_p
            flat = code_dir / "meta.json"
            if flat.exists():
                yield stem, flat


@app.command()
def validate(  # noqa: PLR0912 — ADR 이 지정한 단일 조립점 — 분기 분할이 설계에 반한다
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
    import json as _json  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    from hoga.api.invariants import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        check as _check,
    )
    from hoga.config import resolve_data_dir  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

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

    rows: list[tuple[str, list]] = []
    fix_count = 0
    scanned = 0
    unreadable: list[str] = []
    for label, meta_p in _iter_stock_date_metas(parquet_root, code):
        scanned += 1
        try:
            meta = _json.loads(meta_p.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            # A meta.json that won't parse is a finding, not a reason to skip
            # quietly — same principle as _read's warning in --deep. Before
            # this, a corrupt meta raised and aborted the whole sweep partway,
            # leaving the operator with a partial report and a traceback.
            unreadable.append(f"{label}: {exc}")
            continue
        # Compute the full (severity-unfiltered) set ONCE — `violations`
        # is the display slice (severity-filtered); `full` is the archival
        # source. Without the cache, --deep --fix would load parquet twice
        # for every Stock-Date with violations.
        full = _check(meta)
        if deep:
            # meta_p.parent, NOT the Code directory: under ADR-0037 the
            # parquet artifacts sit beside their meta.json inside {source}/.
            full = full + _run_series_for(meta_p.parent, meta)
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
                # 원자적 쓰기 필수: 이 스윕은 19k+ 스톡데이트를 훑으므로 중간에
                # 중단되면(Ctrl+C·디스크 풀) 잘린 meta 를 하나 남긴다 — 고치려던
                # 명령이 오염을 만드는 셈이다.
                atomic_write_json(meta_p, meta)
                fix_count += 1
        if not violations:
            continue
        rows.append((label, violations))

    # Coverage before verdict. "I checked 18,805 and found nothing" and "I
    # checked nothing" are opposite outcomes that this command used to render
    # identically as "All Stock-Dates are clean" — that ambiguity is what let
    # the flat-only walk hide a 97.9% blind spot for two months. The count is
    # printed on every path, so a sudden drop is visible without --verbose.
    if scanned == 0:
        console.print(
            f"[yellow]No Stock-Date meta.json found under {parquet_root} — "
            f"nothing was checked.[/yellow]"
        )
        return

    for entry in unreadable:
        console.print(f"[yellow]  warning: unreadable meta.json {entry}[/yellow]")

    if not rows:
        if fix and fix_count:
            console.print(f"[blue]--fix: cleared stale invariant_violations on {fix_count} files.[/blue]")
        console.print(
            f"[green]All {scanned} Stock-Date sources are clean for the "
            f"requested severity.[/green]"
        )
        return

    for label, violations in rows:
        console.print(f"[bold]{label}[/bold]")
        for v in violations:
            console.print(f"  [{v.severity.value}] {v.invariant_id}: {v.message}  ctx={v.ctx}")

    console.print(
        f"\n[bold]{len(rows)} of {scanned} Stock-Date sources have violations.[/bold]"
    )
    if fix:
        console.print(f"[blue]--fix: rewrote invariant_violations on {fix_count} files.[/blue]")


def _report_derived_and_dead(
    data_dir: Path, *, execute: bool, include_dead_trees: bool,
) -> None:
    """`hoga prune` 의 raw 이후 절 — 파생 트리 회수와 죽은 트리 보고.

    prune() 본문에서 뺀 이유는 분기 수 때문만이 아니다: 이 절은 raw 게이트와
    **판정 축이 다르다**(재계산 가능 여부이지 완결성이 아니다). 섞어 두면 읽는
    사람이 같은 규칙의 연장으로 오해한다.
    """
    from hoga.api.prune import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈)
        find_dead_trees,
        prune_default_now,
        prune_derived,
        remove_dead_trees,
        resolve_derived_retention_days,
    )

    retention = resolve_derived_retention_days()
    derived = prune_derived(
        data_dir, retention_days=retention, now=prune_default_now(), execute=execute,
    )
    if derived.total_items:
        verb = "pruned" if execute else "would delete"
        console.print(f"\n[bold]derived trees[/bold] ({verb}, 보존 {retention}일)")
        for name, (n, size) in derived.by_tree.items():
            if n:
                console.print(f"  {name:<34}{n:>6} items {size / 1024**3:>8.1f} GiB")

    # 코드가 읽지 않는 트리는 **항상 보고**하고 삭제만 옵트인이다 — 안 보이면
    # 없는 것과 같아서 몇 GB 가 조용히 남는다.
    dead = find_dead_trees(data_dir)
    if not dead:
        return
    console.print("\n[bold]dead trees[/bold] (no code reads these)")
    for name, size in sorted(dead.items(), key=lambda kv: -kv[1]):
        console.print(f"  {name:<34}       {size / 1024**3:>8.1f} GiB")
    if not include_dead_trees:
        console.print(
            "\n[blue]--include-dead-trees[/blue] (with --execute) would remove them."
        )
    elif execute:
        n, reclaimed = remove_dead_trees(data_dir)
        console.print(
            f"[green]removed[/green] {n} dead trees, "
            f"{reclaimed / 1024**3:.1f} GiB reclaimed"
        )


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
    include_confirmed_gaps: bool = typer.Option(
        False, "--include-confirmed-gaps",
        help=(
            "Also prune SOURCE_PARTIAL raw whose upstream gap is CONFIRMED "
            "(re-capture reproduced it, or it abuts a session edge). Never "
            "touches CLIENT_INCOMPLETE — that raw is the resume source."
        ),
    ),
    include_expired_unconfirmed: bool = typer.Option(
        False, "--include-expired-unconfirmed",
        help=(
            "Also prune SOURCE_PARTIAL raw whose gap is UNCONFIRMED but past the "
            "upstream retention window, so confirmation is permanently impossible "
            "(ADR-0135). Irreversible: that day can never be re-parsed."
        ),
    ),
    include_stale_incomplete: bool = typer.Option(
        False, "--include-stale-incomplete",
        help=(
            "Also prune CLIENT_INCOMPLETE raw past the retention window whose "
            "parquet already exists. hogaplay upstream keeps ~18h, so past the "
            "window the resume it guards is physically impossible (ADR-0163). "
            "Raw without parquet is never touched — that is the only copy."
        ),
    ),
    include_dead_trees: bool = typer.Option(
        False, "--include-dead-trees",
        help=(
            "Also delete trees no code reads any more (kis-past-candles, _trash_*). "
            "These are reported unconditionally; deleting them is a judgement call, "
            "so it stays opt-in."
        ),
    ),
) -> None:
    """Prune hogaplay raw older than the retention window when its parquet is COMPLETE.

    Read-only by default — prints what WOULD be deleted. Pass ``--execute`` to
    delete. Only hogaplay-source COMPLETE raw past the window is removed; resume
    sources, partials, and sentinels are preserved (ADR-0075).

    ``--include-confirmed-gaps`` widens the gate to captures the system has
    already declared terminal (``decide_capture`` skips them). ADR-0075's
    Trigger Condition anticipated exactly this: "비-COMPLETE raw 누적이 디스크를
    위협하면 --include-partial 옵트인 또는 별도 진단 도구를 도입한다."

    ``--include-stale-incomplete`` opens the biggest class (ADR-0163). Measured
    2026-08-27: CLIENT_INCOMPLETE held 124.7 GiB of which only 5.1 GiB (4%) was
    still inside the upstream window — the rest reached 367 days old while being
    preserved as "resume sources" that can never be resumed.
    """
    from hoga.api.prune import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        disk_headroom,
        prune_default_now,
        prune_raw,
        resolve_retention_days,
    )

    retention = days if days is not None else resolve_retention_days()
    if retention < 1:
        raise typer.BadParameter(
            "--days must be >= 1 (a 0-day window would race in-flight captures)."
        )

    data_dir = resolve_data_dir()
    result = prune_raw(
        data_dir, retention_days=retention, now=prune_default_now(), execute=execute,
        include_confirmed_gaps=include_confirmed_gaps,
        include_expired_unconfirmed=include_expired_unconfirmed,
        include_stale_incomplete=include_stale_incomplete,
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

    # 보존 사유 내역. 후보가 0건일 때 "지울 게 없다" 와 "전부 게이트에 걸려
    # 보존 중이다" 를 구분해 주는 유일한 출력이다 — 이게 없어 raw 가 351GB 까지
    # 조용히 자랐다.
    if result.skipped_by_state:
        console.print("\n[bold]held (not prunable)[/bold]")
        for reason, count in sorted(
            result.skipped_by_state.items(),
            key=lambda kv: -result.skipped_bytes_by_state.get(kv[0], 0),
        ):
            gib = result.skipped_bytes_by_state.get(reason, 0) / 1024**3
            console.print(f"  {reason:<34}{count:>6} dirs {gib:>8.1f} GiB")
        if not include_confirmed_gaps and any(
            r.startswith("source_partial(gap_confirmed)") for r in result.skipped_by_state
        ):
            console.print(
                "\n[blue]--include-confirmed-gaps[/blue] would also prune the "
                "gap_confirmed rows above (upstream gap reproduced or session-edge; "
                "re-capture cannot improve them)."
            )
        if not include_expired_unconfirmed and any(
            r == "source_partial(gap_unconfirmed,expired)" for r in result.skipped_by_state
        ):
            console.print(
                "\n[blue]--include-expired-unconfirmed[/blue] would also prune the "
                "gap_unconfirmed,expired rows above (past the ~18h upstream window, "
                "so the gap can never be confirmed). [red]Irreversible[/red] — "
                "see ADR-0135."
            )

    _report_derived_and_dead(
        data_dir, execute=execute, include_dead_trees=include_dead_trees,
    )

    head = disk_headroom(data_dir)
    if head is not None:
        style = "red" if head.is_low else "dim"
        console.print(
            f"\n[{style}]disk: {head.free_pct:.1f}% free "
            f"({head.free_bytes / 1024**3:.0f} GiB of {head.total_bytes / 1024**3:.0f} GiB)[/{style}]"
        )
