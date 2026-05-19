"""Typer CLI for hoga-ops. Subcommands are wired in their own modules."""
from __future__ import annotations

import typer

app = typer.Typer(no_args_is_help=True, add_completion=False, help="hoga-ops backend CLI")


@app.command()
def collect(
    code: str = typer.Option(..., "--code"),
    date: str = typer.Option(..., "--date"),
    allow_partial: bool = typer.Option(False, "--allow-partial"),
    resume: bool = typer.Option(False, "--resume"),
) -> None:
    """Capture a Stock-Date from hogaplay.com."""
    msg = f"collect stub: code={code} date={date} allow_partial={allow_partial} resume={resume}"
    typer.echo(msg)


@app.command()
def parse(
    code: str = typer.Option(..., "--code"),
    date: str = typer.Option(..., "--date"),
    lenient: bool = typer.Option(False, "--lenient"),
    report: bool = typer.Option(False, "--report"),
) -> None:
    """Parse captured raw TSV into Parquet."""
    typer.echo(f"parse stub: code={code} date={date} lenient={lenient} report={report}")


@app.command()
def serve(port: int = typer.Option(8000, "--port")) -> None:
    """Start the FastAPI server."""
    typer.echo(f"serve stub: port={port}")


@app.command()
def ls() -> None:
    """List captured/parsed Stock-Dates."""
    typer.echo("ls stub")
