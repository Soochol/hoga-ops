# hoga-ops Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend pipeline for hoga-ops: capture orderbook + trade data from hogaplay.com, transform into queryable Parquet datasets, and serve them via a FastAPI replay API. Frontend deferred to Phase 2.

**Architecture:** Python-only single-process backend. `collector` paginates `hogaplay.com/player/first.php` mirroring the official player's call pattern, dedupes by `global_seq`, and persists raw TSV. `parser` transforms TSV into typed Parquet tables (snapshots, trades, brokers, candles). `api` exposes time-indexed replay queries via FastAPI + DuckDB. A `typer` CLI wires the three together.

**Tech Stack:** Python 3.11+, httpx, pyarrow, duckdb, FastAPI, pydantic v2, typer, ruff, pytest.

**Spec:** [`docs/superpowers/specs/2026-05-19-hoga-ops-design.md`](../specs/2026-05-19-hoga-ops-design.md)
**Schema reference:** [`docs/superpowers/specs/schema-notes.md`](../specs/schema-notes.md)
**Glossary:** [`CONTEXT.md`](../../../CONTEXT.md) — definitions of Stock-Date, Page, Page Step, Full Capture, Data Window, Regular Session, Auction Cross, TSV Section, Global Sequence.

---

## File map

| File | Responsibility |
|---|---|
| `pyproject.toml` | package metadata + runtime/dev deps |
| `ruff.toml` | lint + format config |
| `hoga/__init__.py` | package marker, `__version__` |
| `hoga/__main__.py` | `python -m hoga` entry → cli.app |
| `hoga/cli.py` | typer subcommands: collect / parse / serve / ls |
| `hoga/config.py` | paths (data dir), `.cookie` / env loading |
| `hoga/collector/__init__.py` | package marker |
| `hoga/collector/client.py` | httpx wrapper: cookie, headers, retries, `info/first/chart` fetches |
| `hoga/collector/orchestrator.py` | Page Step loop, cap detection, progress file, partial-capture guard |
| `hoga/parser/__init__.py` | top-level `parse_stock_date()` orchestrator |
| `hoga/parser/events.py` | per-event-type dataclasses (Trade, Orderbook, Broker, etc.) |
| `hoga/parser/tsv.py` | row tokenizer + event dispatcher (by `event_type` field 2) |
| `hoga/parser/writer.py` | pyarrow Table builders + Parquet writers per table |
| `hoga/api/__init__.py` | package marker |
| `hoga/api/app.py` | FastAPI factory, CORS, shared DuckDB connection |
| `hoga/api/queries.py` | DuckDB query helpers (read_parquet against data dir) |
| `hoga/api/models.py` | pydantic v2 response models |
| `hoga/api/routes.py` | route handlers |
| `tests/conftest.py` | shared fixtures (paths, tiny_tsv) |
| `tests/fixtures/tiny_tsv/info.tsv` | golden info row |
| `tests/fixtures/tiny_tsv/first_001.tsv` | hand-crafted ~12 rows covering all event types |
| `tests/fixtures/tiny_tsv/chart.tsv` | 5 candle rows |
| `tests/test_config.py` | cookie loading |
| `tests/test_collector_client.py` | http client with MockTransport |
| `tests/test_collector_orchestrator.py` | Page Step loop, cap detection, dedup |
| `tests/test_parser_tsv.py` | row dispatcher |
| `tests/test_parser_writer.py` | parquet roundtrip per table |
| `tests/test_parser_e2e.py` | tiny_tsv fixture → expected Parquet |
| `tests/test_api.py` | endpoints against fixture parquet |

---

## Task 1: Project scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `ruff.toml`
- Create: `hoga/__init__.py`
- Create: `hoga/__main__.py`
- Create: `hoga/cli.py`
- Create: `README.md`
- Modify: `.gitignore` (already exists; verify entries)

- [ ] **Step 1: Initialize git repo (skip if `.git` already present)**

Run: `cd C:\code\hoga-ops && git status`
If "fatal: not a git repository", run: `git init && git add CONTEXT.md docs/ explorer/ .gitignore && git commit -m "initial: CONTEXT, design, schema notes, explorer"`

- [ ] **Step 2: Create `pyproject.toml`**

```toml
[project]
name = "hoga-ops"
version = "0.1.0"
description = "Hogaplay orderbook + trade replay backend"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.27",
    "pyarrow>=16",
    "duckdb>=1.0",
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pydantic>=2.8",
    "typer>=0.12",
    "python-dotenv>=1.0",
    "rich>=13",
]

[project.optional-dependencies]
dev = [
    "pytest>=8",
    "pytest-cov>=5",
    "ruff>=0.6",
]

[project.scripts]
hoga = "hoga.cli:app"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["hoga*"]
exclude = ["tests*", "explorer*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-v --strict-markers"
```

- [ ] **Step 3: Create `ruff.toml`**

```toml
line-length = 100
target-version = "py311"

[lint]
select = ["E", "F", "I", "B", "UP", "SIM", "PL"]
ignore = ["PLR0913"]

[format]
quote-style = "double"
```

- [ ] **Step 4: Create `hoga/__init__.py`**

```python
__version__ = "0.1.0"
```

- [ ] **Step 5: Create `hoga/__main__.py`**

```python
from hoga.cli import app

if __name__ == "__main__":
    app()
```

- [ ] **Step 6: Create `hoga/cli.py` with empty subcommand stubs**

```python
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
    typer.echo(f"collect stub: code={code} date={date} allow_partial={allow_partial} resume={resume}")


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
```

- [ ] **Step 7: Create `README.md`**

```markdown
# hoga-ops

Personal local-first tool to capture, store, and replay Korean stock orderbook + trade data from hogaplay.com.

See [`CONTEXT.md`](./CONTEXT.md) for the glossary and [`docs/superpowers/specs/`](./docs/superpowers/specs/) for the design.

## Phase 1 status

Backend only. Frontend is Phase 2 (separate plan).

## Quickstart

```sh
pip install -e .[dev]
echo "k_=...; n_=..." > .cookie   # paste from your hogaplay session
hoga collect --code 003490 --date 20260519
hoga parse   --code 003490 --date 20260519
hoga serve
```
```

- [ ] **Step 8: Install in editable mode and verify CLI**

Run: `cd C:\code\hoga-ops && python -m pip install -e .[dev]`
Run: `python -m hoga --help`
Expected: subcommand list including `collect`, `parse`, `serve`, `ls`.
Run: `python -m hoga collect --code 003490 --date 20260519`
Expected: `collect stub: code=003490 date=20260519 allow_partial=False resume=False`

- [ ] **Step 9: Run ruff to confirm style passes**

Run: `python -m ruff check hoga/`
Expected: `All checks passed!`
Run: `python -m ruff format --check hoga/`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add pyproject.toml ruff.toml README.md hoga/
git commit -m "scaffold: pyproject, ruff, cli stubs"
```

---

## Task 2: Config module — paths and cookie loading

**Files:**
- Create: `hoga/config.py`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Create: `tests/test_config.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/conftest.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    """A fresh per-test data directory."""
    d = tmp_path / "data"
    d.mkdir()
    return d
```

Create `tests/test_config.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.config import Config, CookieMissingError


def test_cookie_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOGAPLAY_COOKIE", "k_=abc; n_=xyz")
    cfg = Config(repo_root=tmp_path)
    assert cfg.cookie() == "k_=abc; n_=xyz"


def test_cookie_from_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGAPLAY_COOKIE", raising=False)
    (tmp_path / ".cookie").write_text("k_=fromfile; n_=v\n", encoding="utf-8")
    cfg = Config(repo_root=tmp_path)
    assert cfg.cookie() == "k_=fromfile; n_=v"


def test_cookie_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGAPLAY_COOKIE", raising=False)
    cfg = Config(repo_root=tmp_path)
    with pytest.raises(CookieMissingError):
        cfg.cookie()


def test_paths(tmp_path: Path) -> None:
    cfg = Config(repo_root=tmp_path)
    assert cfg.raw_dir("20260519", "003490") == tmp_path / "data" / "raw" / "20260519" / "003490"
    assert cfg.parquet_dir("20260519", "003490") == tmp_path / "data" / "parquet" / "20260519" / "003490"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_config.py -v`
Expected: ImportError or `ModuleNotFoundError: No module named 'hoga.config'`.

- [ ] **Step 3: Implement `hoga/config.py`**

```python
"""Paths and cookie loading."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class CookieMissingError(RuntimeError):
    """Raised when no cookie source is available."""


@dataclass(frozen=True)
class Config:
    repo_root: Path

    def cookie(self) -> str:
        env = os.environ.get("HOGAPLAY_COOKIE")
        if env:
            return env.strip()
        cookie_file = self.repo_root / ".cookie"
        if cookie_file.exists():
            return cookie_file.read_text(encoding="utf-8").strip()
        raise CookieMissingError(
            "No cookie found. Set HOGAPLAY_COOKIE env var or create .cookie file "
            "with 'k_=...; n_=...' (copy from your hogaplay browser session)."
        )

    @property
    def data_dir(self) -> Path:
        return self.repo_root / "data"

    def raw_dir(self, date: str, code: str) -> Path:
        return self.data_dir / "raw" / date / code

    def parquet_dir(self, date: str, code: str) -> Path:
        return self.data_dir / "parquet" / date / code

    @classmethod
    def from_cwd(cls) -> "Config":
        return cls(repo_root=Path.cwd())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_config.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/config.py tests/
git commit -m "feat(config): paths + cookie loading"
```

---

## Task 3: Collector HTTP client

**Files:**
- Create: `hoga/collector/__init__.py`
- Create: `hoga/collector/client.py`
- Create: `tests/test_collector_client.py`

- [ ] **Step 1: Create `hoga/collector/__init__.py`**

```python
```
(empty file — package marker)

- [ ] **Step 2: Write the failing tests**

Create `tests/test_collector_client.py`:

```python
from __future__ import annotations

import httpx
import pytest

from hoga.collector.client import (
    CookieExpiredError,
    HogaplayClient,
    HogaplayHTTPError,
)


def make_client(handler: httpx.MockTransport) -> HogaplayClient:
    return HogaplayClient(cookie="k_=test; n_=user", transport=handler)


def test_fetch_info_builds_correct_url() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, content=b"info-body")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_info("003490", "20260519")
    assert body == "info-body"
    req = captured["req"]
    assert req.url.path == "/player/info.php"
    assert dict(req.url.params) == {"date": "20260519", "code": "003490"}
    assert req.headers["cookie"] == "k_=test; n_=user"
    assert req.headers["x-requested-with"] == "XMLHttpRequest"
    assert req.headers["referer"] == "https://hogaplay.com/player/"


def test_fetch_first_includes_time() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"first-body")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_first("003490", "20260519", time_ms=90000000)
    assert body == "first-body"


def test_fetch_chart_includes_bong_gap() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, content=b"chart-body")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_chart("003490", "20260519", time_ms=153100000, bong=1, gap=60000)
    assert body == "chart-body"
    assert dict(captured["req"].url.params) == {
        "date": "20260519",
        "code": "003490",
        "time": "153100000",
        "bong": "1",
        "gap": "60000",
    }


def test_401_raises_cookie_expired() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, content=b"unauthorized")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(CookieExpiredError):
        c.fetch_info("003490", "20260519")


def test_403_raises_cookie_expired() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, content=b"forbidden")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(CookieExpiredError):
        c.fetch_info("003490", "20260519")


def test_500_retries_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(500, content=b"server error")
        return httpx.Response(200, content=b"ok")

    c = make_client(httpx.MockTransport(handler))
    body = c.fetch_info("003490", "20260519")
    assert body == "ok"
    assert calls["n"] == 3


def test_500_persistent_raises_http_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"server error")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(HogaplayHTTPError):
        c.fetch_info("003490", "20260519")


def test_400_other_4xx_raises_http_error_no_retry() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, content=b"bad request")

    c = make_client(httpx.MockTransport(handler))
    with pytest.raises(HogaplayHTTPError):
        c.fetch_info("003490", "20260519")
    assert calls["n"] == 1
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tests/test_collector_client.py -v`
Expected: `ModuleNotFoundError: No module named 'hoga.collector.client'`.

- [ ] **Step 4: Implement `hoga/collector/client.py`**

```python
"""HTTP client for hogaplay.com player endpoints."""
from __future__ import annotations

import time
from typing import Final

import httpx

BASE_URL: Final = "https://hogaplay.com/player"

DEFAULT_HEADERS: Final = {
    "Accept": "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": f"{BASE_URL}/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
}


class CookieExpiredError(RuntimeError):
    """401/403 from hogaplay — session cookie expired."""


class HogaplayHTTPError(RuntimeError):
    """Other 4xx, or persistent 5xx after retries."""


class HogaplayClient:
    """Thin httpx wrapper. Sync, single connection, manual retries on 5xx."""

    def __init__(
        self,
        cookie: str,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
    ) -> None:
        headers = {**DEFAULT_HEADERS, "Cookie": cookie}
        self._client = httpx.Client(headers=headers, transport=transport, timeout=timeout)
        self._max_retries = max_retries
        self._backoff_base = backoff_base

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HogaplayClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def fetch_info(self, code: str, date: str) -> str:
        return self._get("info.php", {"date": date, "code": code})

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        return self._get(
            "first.php", {"date": date, "code": code, "time": str(time_ms)}
        )

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        return self._get(
            "chart.php",
            {
                "date": date,
                "code": code,
                "time": str(time_ms),
                "bong": str(bong),
                "gap": str(gap),
            },
        )

    def _get(self, endpoint: str, params: dict[str, str]) -> str:
        url = f"{BASE_URL}/{endpoint}"
        last_error: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                r = self._client.get(url, params=params)
            except httpx.HTTPError as e:
                last_error = e
                time.sleep(self._backoff_base * (2 ** attempt))
                continue
            if r.status_code in (401, 403):
                raise CookieExpiredError(
                    f"hogaplay returned {r.status_code} for {endpoint}. "
                    "Refresh your .cookie from a logged-in browser session."
                )
            if r.status_code >= 500:
                last_error = HogaplayHTTPError(
                    f"{r.status_code} from {endpoint}: {r.text[:200]}"
                )
                time.sleep(self._backoff_base * (2 ** attempt))
                continue
            if r.status_code >= 400:
                raise HogaplayHTTPError(
                    f"{r.status_code} from {endpoint}: {r.text[:500]}"
                )
            return r.text
        assert last_error is not None
        raise HogaplayHTTPError(f"exhausted retries for {endpoint}: {last_error}")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_collector_client.py -v`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add hoga/collector/ tests/test_collector_client.py
git commit -m "feat(collector): http client with retries"
```

---

## Task 4: Collector orchestrator — Page Step loop

**Files:**
- Create: `hoga/collector/orchestrator.py`
- Create: `tests/test_collector_orchestrator.py`

The orchestrator is the most complex single piece of Phase 1. It paginates, detects the response cap, writes progress, handles partial-capture warnings, and respects rate limiting.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_collector_orchestrator.py`:

```python
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.collector.orchestrator import collect_stock_date

# A fake client that returns canned Page bodies keyed by `time` query.

@dataclass
class _Call:
    endpoint: str
    code: str
    date: str
    time_ms: int


class FakeClient:
    """Test double matching the HogaplayClient surface."""

    def __init__(self, info_body: str, first_pages: dict[int, str], chart_body: str) -> None:
        self.info_body = info_body
        self.first_pages = first_pages
        self.chart_body = chart_body
        self.calls: list[_Call] = []

    def fetch_info(self, code: str, date: str) -> str:
        self.calls.append(_Call("info", code, date, 0))
        return self.info_body

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        self.calls.append(_Call("first", code, date, time_ms))
        return self.first_pages.get(time_ms, "")

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        self.calls.append(_Call("chart", code, date, time_ms))
        return self.chart_body


def _row(tsv_section: int, etype: int, sub_seq: int, global_seq: int, event_time: int) -> str:
    """Build a minimal TSV row with required first 5 fields. Other fields are zeros to keep field count valid per event type."""
    if etype == 1:  # trade: 19 fields
        return "\t".join(
            [
                str(tsv_section), "1", str(sub_seq), str(global_seq), str(event_time),
                "0", "0", "0", "+1", "1", "1", "0", "0", "0", "0", "0", "0", "0",
            ]
        ) + "\n"
    if etype == 2:  # orderbook: 71 fields
        fields = [str(tsv_section), "2", str(sub_seq), str(global_seq), str(event_time), "0"]
        fields += ["0"] * 64  # 10 ask price + 10 ask qty + 10 ask delta + 10 bid price + 10 bid qty + 10 bid delta + 4 totals = 64
        # Field count target: 70 + trailing empty = 71. We have 6 header + 64 = 70, plus the trailing '' that split('\t') yields if the line ends with tab.
        return "\t".join(fields) + "\t\n"
    raise ValueError(f"unsupported etype {etype} for test row")


def test_collect_writes_info_first_chart_progress(tmp_path: Path) -> None:
    # One Page that already covers the whole Data Window window 08:40 → 16:00.
    # event_time 84000000 → 159000000. The cap-detector should be happy because the
    # Page covers the requested window fully.
    page_body = (
        _row(1, 1, 0, 1, 84000000)
        + _row(2, 2, 1, 2, 84000060)  # within first Page Step
        + _row(2, 2, 2, 3, 159000000)  # near end, covers full target
    )
    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages={t: page_body for t in range(84000000, 160000001, 60000)},
        chart_body="55140000\t15:19:02\t100\t100\t100\t100\t1\t1\t0\t1\t1\n",
    )

    result = collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,  # no sleep in tests
        allow_partial=True,  # bypass the today-check
    )

    raw_dir = tmp_path / "data" / "raw" / "20260519" / "003490"
    assert (raw_dir / "info.tsv").read_text(encoding="utf-8").startswith("1\t003490")
    assert (raw_dir / "chart.tsv").read_text(encoding="utf-8").startswith("55140000")
    assert (raw_dir / "_progress.json").exists()
    # At least one first_*.tsv file.
    first_files = sorted(raw_dir.glob("first_*.tsv"))
    assert len(first_files) >= 1
    assert result.unique_events >= 3  # dedup left the 3 distinct seqs


def test_collect_dedupes_overlapping_pages(tmp_path: Path) -> None:
    # Two distinct Pages that overlap on seq=2.
    page_a = _row(1, 1, 0, 1, 84000000) + _row(2, 1, 1, 2, 84060000)
    page_b = _row(1, 1, 0, 2, 84060000) + _row(2, 1, 1, 3, 84120000)
    pages = {84000000: page_a, 84060000: page_b}
    # Subsequent calls return empty so termination triggers.
    pages.update({t: "" for t in range(84120000, 160000001, 60000)})

    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages=pages,
        chart_body="",
    )
    result = collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
        allow_partial=True,
    )
    assert result.unique_events == 3  # seqs {1, 2, 3} unique


def test_collect_cap_detection_halves_step(tmp_path: Path) -> None:
    # First call at t=84000000 returns events only up to t+15s (cap hit before t+60s).
    # The orchestrator should retry with step/2, then step/4, eventually covering the window.
    page_short = _row(2, 1, 0, 1, 84000000) + _row(2, 1, 1, 2, 84015000)
    page_normal = _row(2, 1, 0, 3, 84030000) + _row(2, 1, 1, 4, 84089000)
    pages: dict[int, str] = {
        84000000: page_short,    # cap hit at 60s step
        84030000: page_normal,   # cap hit at 30s step from 84000000 → retry at 84030000 covers
    }
    # All later times empty so termination triggers.
    pages.update({t: "" for t in range(84060000, 160000001, 60000)})

    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages=pages,
        chart_body="",
    )
    result = collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
        allow_partial=True,
    )
    # 4 distinct seqs across the two Pages
    assert result.unique_events == 4
    # At least one retry happened: should have called fetch_first at non-60s-aligned time
    first_times = [c.time_ms for c in fake.calls if c.endpoint == "first"]
    assert any(t == 84030000 for t in first_times), f"expected step-halved retry at 84030000, got {first_times[:5]}"


def test_partial_capture_today_aborts_without_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from hoga.collector import orchestrator as orch
    import datetime as dt

    # Pretend "today" is 20260519 and the time is 10am KST (before close)
    fixed_now = dt.datetime(2026, 5, 19, 10, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
    monkeypatch.setattr(orch, "_now_kst", lambda: fixed_now)

    fake = FakeClient(info_body="", first_pages={}, chart_body="")
    with pytest.raises(orch.PartialCaptureRefused):
        collect_stock_date(
            client=fake,
            code="003490",
            date="20260519",
            data_dir=tmp_path / "data",
            rate_limit_s=0.0,
            allow_partial=False,
        )


def test_partial_capture_today_allowed_with_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from hoga.collector import orchestrator as orch
    import datetime as dt

    fixed_now = dt.datetime(2026, 5, 19, 10, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
    monkeypatch.setattr(orch, "_now_kst", lambda: fixed_now)

    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages={t: "" for t in range(84000000, 160000001, 60000)},
        chart_body="",
    )
    # Should not raise.
    collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
        allow_partial=True,
    )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_collector_orchestrator.py -v`
Expected: `ModuleNotFoundError: No module named 'hoga.collector.orchestrator'`.

- [ ] **Step 3: Implement `hoga/collector/orchestrator.py`**

```python
"""Page Step pagination loop for hogaplay first.php + chart.php capture."""
from __future__ import annotations

import datetime as dt
import json
import time as _time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

# Time constants in HHMMSSmmm encoding.
DATA_WINDOW_START_MS = 84000000   # 08:40:00.000
DATA_WINDOW_END_MS = 160000000    # 16:00:00.000
CHART_FINAL_TIME_MS = 153100000   # 15:31:00.000 — last cumulative chart pull

DEFAULT_PAGE_STEP_MS = 60000       # 1 minute
MIN_PAGE_STEP_MS = 1000            # 1 second floor
TERMINATION_EMPTY_PAGES = 3        # stop after N empty Pages past Data Window end

KST = dt.timezone(dt.timedelta(hours=9))


class HogaplayClientProto(Protocol):
    def fetch_info(self, code: str, date: str) -> str: ...
    def fetch_first(self, code: str, date: str, time_ms: int) -> str: ...
    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str: ...


class PartialCaptureRefused(RuntimeError):
    """Capture target is today + Regular Session not yet closed and --allow-partial not set."""


@dataclass
class CollectResult:
    raw_dir: Path
    pages_written: int
    unique_events: int


def _now_kst() -> dt.datetime:
    return dt.datetime.now(tz=KST)


def _is_partial_capture(date: str, now: dt.datetime) -> bool:
    """True if `date` is today (KST) and current KST time is before 16:00."""
    try:
        d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:8]))
    except (ValueError, IndexError):
        return False
    if d != now.date():
        return False
    return now.hour < 16


def _max_event_time(page_body: str) -> int | None:
    """Return the largest field-5 value (event_time) across all rows. None if empty."""
    best: int | None = None
    for line in page_body.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        try:
            t = int(parts[4])
        except ValueError:
            continue
        if best is None or t > best:
            best = t
    return best


def _seqs(page_body: str) -> set[int]:
    out: set[int] = set()
    for line in page_body.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        try:
            out.add(int(parts[3]))
        except ValueError:
            continue
    return out


def _write_progress(path: Path, *, last_time_ms: int, pages_done: int, seq_count: int, started_at: str, finished_at: str | None) -> None:
    path.write_text(
        json.dumps(
            {
                "last_time_ms": last_time_ms,
                "pages_done": pages_done,
                "global_seqs_seen": seq_count,
                "started_at": started_at,
                "finished_at": finished_at,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _resume_state(raw_dir: Path) -> tuple[set[int], int, int]:
    """Read existing first_*.tsv files and _progress.json to seed a resumed run.

    Returns (seen_seqs, last_page_idx, last_time_ms).
    """
    seen: set[int] = set()
    last_idx = 0
    for page_path in sorted(raw_dir.glob("first_*.tsv")):
        last_idx += 1
        text = page_path.read_text(encoding="utf-8")
        seen.update(_seqs(text))
    last_t = DATA_WINDOW_START_MS
    progress_path = raw_dir / "_progress.json"
    if progress_path.exists():
        try:
            data = json.loads(progress_path.read_text(encoding="utf-8"))
            last_t = int(data.get("last_time_ms", DATA_WINDOW_START_MS))
        except (ValueError, KeyError):
            pass
    return seen, last_idx, last_t


def collect_stock_date(
    *,
    client: HogaplayClientProto,
    code: str,
    date: str,
    data_dir: Path,
    rate_limit_s: float = 0.2,
    allow_partial: bool = False,
    resume: bool = False,
) -> CollectResult:
    """Drive the full capture for one Stock-Date.

    Strategy (per design doc):
      1. info.php once (skipped on resume if info.tsv already exists).
      2. Page Step loop on first.php starting at DATA_WINDOW_START_MS (or last_time_ms on resume).
         If a Page does not cover the requested window, halve the step (floor MIN_PAGE_STEP_MS).
      3. Terminate when t >= DATA_WINDOW_END_MS and TERMINATION_EMPTY_PAGES consecutive
         Pages contain no new global_seq.
      4. chart.php once at CHART_FINAL_TIME_MS.
    """
    now = _now_kst()
    if not allow_partial and _is_partial_capture(date, now):
        raise PartialCaptureRefused(
            f"date={date} is today (KST) and Regular Session has not closed. "
            "Pass --allow-partial to capture anyway."
        )

    raw_dir = data_dir / "raw" / date / code
    raw_dir.mkdir(parents=True, exist_ok=True)
    started_at = now.isoformat()

    # 1. info.php (skip if resuming and file exists)
    info_path = raw_dir / "info.tsv"
    if not (resume and info_path.exists()):
        info_body = client.fetch_info(code, date)
        info_path.write_text(info_body, encoding="utf-8")
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)

    # 2. Page Step loop (resume-aware seeding)
    if resume:
        seen_seqs, page_idx, t = _resume_state(raw_dir)
    else:
        seen_seqs = set()
        page_idx = 0
        t = DATA_WINDOW_START_MS
    empty_in_a_row = 0
    step = DEFAULT_PAGE_STEP_MS

    while True:
        body = client.fetch_first(code, date, t)
        new_seqs = _seqs(body) - seen_seqs
        if body:
            page_idx += 1
            (raw_dir / f"first_{page_idx:03d}.tsv").write_text(body, encoding="utf-8")
            seen_seqs.update(_seqs(body))
        max_t = _max_event_time(body)

        target = t + step
        covered = max_t is not None and max_t >= target
        if max_t is None and t < DATA_WINDOW_END_MS:
            # No events at all — accept and advance with the current step.
            pass
        if not covered and max_t is not None and step > MIN_PAGE_STEP_MS and t < DATA_WINDOW_END_MS:
            # Cap detected: response stopped short of the requested window.
            step = max(step // 2, MIN_PAGE_STEP_MS)
            # Advance t to just past the last covered event.
            t = max_t + 1
            empty_in_a_row = 0
            _write_progress(
                raw_dir / "_progress.json",
                last_time_ms=t,
                pages_done=page_idx,
                seq_count=len(seen_seqs),
                started_at=started_at,
                finished_at=None,
            )
            if rate_limit_s > 0:
                _time.sleep(rate_limit_s)
            continue

        if not new_seqs:
            empty_in_a_row += 1
        else:
            empty_in_a_row = 0
            # Successful Page restores step toward default.
            if step < DEFAULT_PAGE_STEP_MS:
                step = min(step * 2, DEFAULT_PAGE_STEP_MS)

        _write_progress(
            raw_dir / "_progress.json",
            last_time_ms=t,
            pages_done=page_idx,
            seq_count=len(seen_seqs),
            started_at=started_at,
            finished_at=None,
        )

        t += step

        if t >= DATA_WINDOW_END_MS and empty_in_a_row >= TERMINATION_EMPTY_PAGES:
            break
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)

    # 3. chart.php once
    chart_body = client.fetch_chart(code, date, CHART_FINAL_TIME_MS)
    (raw_dir / "chart.tsv").write_text(chart_body, encoding="utf-8")

    finished_at = _now_kst().isoformat()
    _write_progress(
        raw_dir / "_progress.json",
        last_time_ms=t,
        pages_done=page_idx,
        seq_count=len(seen_seqs),
        started_at=started_at,
        finished_at=finished_at,
    )

    return CollectResult(raw_dir=raw_dir, pages_written=page_idx, unique_events=len(seen_seqs))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_collector_orchestrator.py -v`
Expected: 5 passed.

If `test_collect_cap_detection_halves_step` fails because the step halving lands on a different time than expected, inspect the logged `fake.calls` to see what the orchestrator picked and adjust either the assertion or the orchestrator logic to match the design intent (advancing `t = max_t + 1` after a short Page).

- [ ] **Step 5: Commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_orchestrator.py
git commit -m "feat(collector): Page Step loop with cap detection"
```

---

## Task 5: Parser event dataclasses

**Files:**
- Create: `hoga/parser/__init__.py` (stub for now; filled in Task 8)
- Create: `hoga/parser/events.py`

- [ ] **Step 1: Create `hoga/parser/__init__.py`**

```python
"""Stock-Date TSV → typed Parquet."""
```

- [ ] **Step 2: Implement `hoga/parser/events.py`**

This is data-only — no tests needed; later tasks exercise these via parsing.

```python
"""Per-event-type dataclasses produced by the TSV dispatcher."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

BrokerSide = Literal["buy", "sell"]


@dataclass(frozen=True)
class Trade:
    ts_ms: int
    seq: int
    price: int
    change_pct: float
    qty: int
    side: int  # +1 buy-aggressor, -1 sell-aggressor, 0 auction-cross or unknown
    cum_vol: int
    cum_trades: int
    low_so_far: int
    high_so_far: int
    net_pressure: int
    # Unknown fields kept for forensics:
    unknown_14: int
    unknown_16: float
    unknown_17: float
    unknown_18: float


@dataclass(frozen=True)
class Orderbook:
    ts_ms: int
    seq: int
    ask_p: tuple[int, ...]  # length 10
    ask_q: tuple[int, ...]
    ask_d: tuple[int, ...]
    bid_p: tuple[int, ...]
    bid_q: tuple[int, ...]
    bid_d: tuple[int, ...]
    tot_ask: int
    tot_ask_d: int
    tot_bid: int
    tot_bid_d: int


@dataclass(frozen=True)
class BrokerRow:
    """Long-format: one row per broker slot per snapshot."""
    ts_ms: int
    seq: int
    side: BrokerSide
    rank: int  # 1..5
    broker: str
    qty_today: int
    qty_delta: int


@dataclass(frozen=True)
class Candle:
    ts_ms: int
    open_: int
    close_: int
    high: int
    low: int
    vol_a: int
    vol_b: int


@dataclass(frozen=True)
class StockInfo:
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    raw_line: str
    unknowns: dict[str, str]  # positions 11, 16, 17, 21, 22 etc.
```

- [ ] **Step 3: Verify import works**

Run: `python -c "from hoga.parser.events import Trade, Orderbook, BrokerRow, Candle, StockInfo; print('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add hoga/parser/__init__.py hoga/parser/events.py
git commit -m "feat(parser): event dataclasses"
```

---

## Task 6: TSV tokenizer + dispatcher

**Files:**
- Create: `hoga/parser/tsv.py`
- Create: `tests/test_parser_tsv.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_parser_tsv.py`:

```python
from __future__ import annotations

import pytest

from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade
from hoga.parser.tsv import (
    FieldCountError,
    parse_candle_row,
    parse_info_row,
    parse_row,
)


def test_parse_trade_signed_positive() -> None:
    line = "\t".join([
        "2", "1", "25", "2123", "90008726", "32408726",
        "274500", "-2.31", "+4", "789300", "216275",
        "274000", "274500", "274000", "-32765914", "2.35", "0.01", "500.00",
    ])
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.ts_ms == 90008726
    assert ev.seq == 2123
    assert ev.price == 274500
    assert ev.qty == 4
    assert ev.side == 1
    assert ev.cum_vol == 789300


def test_parse_trade_signed_negative() -> None:
    line = "\t".join([
        "2", "1", "27", "2125", "90008900", "32408900",
        "274000", "-2.49", "-3", "789307", "216277",
        "274000", "274500", "274000", "-32765917", "2.35", "0.01", "500.00",
    ])
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.qty == 3
    assert ev.side == -1


def test_parse_trade_auction_cross_unsigned() -> None:
    line = "\t".join([
        "2", "1", "24", "2122", "90008618", "32408618",
        "274000", "-2.49", "788290", "789296", "216274",
        "274000", "274000", "274000", "-32765918", "2.35", "0.01", "500.00",
    ])
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.qty == 788290
    assert ev.side == 0  # Auction Cross


def test_parse_orderbook() -> None:
    # 71-field row: 6 header + 10 ask_p + 10 ask_q + 10 ask_d + 10 bid_p + 10 bid_q + 10 bid_d + 4 totals + 1 trailing empty
    header = ["2", "2", "835", "847", "90000435", "32400435"]
    ask_p = ["25700", "25750", "25800"] + ["0"] * 7
    ask_q = ["657", "72", "111"] + ["0"] * 7
    ask_d = ["0"] * 10
    bid_p = ["25650", "25600", "25550"] + ["0"] * 7
    bid_q = ["2776", "4193", "4259"] + ["0"] * 7
    bid_d = ["0"] * 10
    totals = ["840", "-2387", "11228", "6383"]
    line = "\t".join(header + ask_p + ask_q + ask_d + bid_p + bid_q + bid_d + totals) + "\t"  # trailing tab
    ev = parse_row(line)
    assert isinstance(ev, Orderbook)
    assert ev.ts_ms == 90000435
    assert ev.seq == 847
    assert ev.ask_p[:3] == (25700, 25750, 25800)
    assert ev.ask_q[:3] == (657, 72, 111)
    assert ev.bid_p[:3] == (25650, 25600, 25550)
    assert ev.tot_ask == 840
    assert ev.tot_bid == 11228


def test_parse_broker_row_returns_list() -> None:
    header = ["2", "4", "0", "912", "90019919", "32419919"]
    sell_names = ["미래에셋", "NH투자증권", "키움증권", "한국투자증권", "신한투자증권"]
    sell_today = ["1798", "1291", "1210", "1164", "804"]
    sell_delta = ["1798", "1291", "1210", "1164", "804"]
    buy_names = ["아이엠증권", "유비에스증권", "NH투자증권", "JP모간서울", "키움증권"]
    buy_today = ["3450", "1236", "968", "602", "549"]
    buy_delta = ["3450", "1236", "968", "602", "549"]
    extras = ["0", "0", "1838", "1838", "1838", "1838"]
    line = "\t".join(header + sell_names + sell_today + sell_delta + buy_names + buy_today + buy_delta + extras)
    rows = parse_row(line)
    assert isinstance(rows, list)
    assert all(isinstance(r, BrokerRow) for r in rows)
    assert len(rows) == 10  # 5 sell + 5 buy
    sells = [r for r in rows if r.side == "sell"]
    buys = [r for r in rows if r.side == "buy"]
    assert [r.broker for r in sells] == sell_names
    assert [r.qty_today for r in sells] == [int(x) for x in sell_today]
    assert [r.broker for r in buys] == buy_names


def test_parse_premarket_row_returns_trade_with_side_zero() -> None:
    line = "1\t3\t10\t11\t84000352\t31200352\t0\t0\t501\t0"
    ev = parse_row(line)
    assert isinstance(ev, Trade)
    assert ev.ts_ms == 84000352
    assert ev.qty == 501
    assert ev.side == 0


def test_parse_unknown_event_type_raises() -> None:
    line = "2\t9\t0\t1\t90000000\t0"
    with pytest.raises(ValueError, match="unknown event type"):
        parse_row(line)


def test_parse_wrong_field_count_raises() -> None:
    line = "2\t1\t0\t1\t90000000"  # too short
    with pytest.raises(FieldCountError):
        parse_row(line)


def test_parse_info_row() -> None:
    line = "1\t005930\t삼성전자\t0\t90000000\t153000000\t520235\t83000216\t160000326\t30186229\t8264833\t274000\t281500\t266000\t275500\t365000\t197000\t281000\t269500\t271000\t267000\t267500"
    info = parse_info_row(line)
    assert isinstance(info, StockInfo)
    assert info.code == "005930"
    assert info.name == "삼성전자"
    assert info.regular_session_open_ms == 90000000
    assert info.regular_session_close_ms == 153000000
    assert info.prev_close == 274000
    assert info.upper_limit == 281500
    assert info.lower_limit == 266000
    assert info.today_open == 275500
    assert info.today_high == 281000
    assert info.today_low == 269500
    assert info.today_close == 271000


def test_parse_candle_row() -> None:
    line = "30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t0\t0\t43\t5"
    c = parse_candle_row(line)
    assert isinstance(c, Candle)
    assert c.ts_ms == 30600000
    assert c.open_ == c.close_ == c.high == c.low == 281000
    assert c.vol_a == 119
    assert c.vol_b == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_parser_tsv.py -v`
Expected: `ModuleNotFoundError: No module named 'hoga.parser.tsv'`.

- [ ] **Step 3: Implement `hoga/parser/tsv.py`**

```python
"""TSV row tokenizer + dispatcher.

Each first.tsv row is identified by its event type (field 2). The TSV Section
marker (field 1) is informational only and ignored here.
"""
from __future__ import annotations

from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade

EXPECTED_FIELD_COUNTS = {
    1: 18,   # trade
    2: 70,   # orderbook (10 ask_p + 10 ask_q + 10 ask_d + 10 bid_p + 10 bid_q + 10 bid_d + 4 totals + 6 header)
    3: 10,   # pre-market summary
    4: 42,   # broker (6 header + 5 sell names + 5+5 sell qty + 5 buy names + 5+5 buy qty + 6 trailing)
}


class FieldCountError(ValueError):
    """A row's tab-separated field count doesn't match its event_type's expectation."""


def _split(line: str) -> list[str]:
    """Tokenize a TSV row.

    Hogaplay rows often end with a trailing tab (yielding an empty final field
    when split). Strip both \\r/\\n and one trailing empty field so the
    significant field count is stable.
    """
    cleaned = line.rstrip("\n").rstrip("\r")
    parts = cleaned.split("\t")
    if parts and parts[-1] == "":
        parts.pop()
    return parts


def parse_row(line: str) -> Trade | Orderbook | list[BrokerRow]:
    """Dispatch on field 2 (event_type). Returns Trade | Orderbook | list[BrokerRow]."""
    parts = _split(line)
    if len(parts) < 2:
        raise FieldCountError(f"row too short: {len(parts)} fields")
    try:
        event_type = int(parts[1])
    except ValueError as e:
        raise FieldCountError(f"non-numeric event_type: {parts[1]!r}") from e

    if event_type not in EXPECTED_FIELD_COUNTS:
        raise ValueError(f"unknown event type {event_type}")
    expected = EXPECTED_FIELD_COUNTS[event_type]
    if len(parts) != expected:
        raise FieldCountError(
            f"event_type={event_type} expects {expected} fields, got {len(parts)}"
        )

    if event_type == 1:
        return _parse_trade(parts)
    if event_type == 2:
        return _parse_orderbook(parts)
    if event_type == 3:
        return _parse_premarket(parts)
    if event_type == 4:
        return _parse_broker(parts)
    raise AssertionError("unreachable")  # pragma: no cover


def _parse_trade(parts: list[str]) -> Trade:
    qty_raw = parts[8]
    if qty_raw.startswith("+"):
        side = 1
        qty = int(qty_raw[1:])
    elif qty_raw.startswith("-"):
        side = -1
        qty = int(qty_raw[1:])
    else:
        side = 0  # Auction Cross
        qty = int(qty_raw)

    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=int(parts[6]),
        change_pct=float(parts[7]),
        qty=qty,
        side=side,
        cum_vol=int(parts[9]),
        cum_trades=int(parts[10]),
        low_so_far=int(parts[11]),
        high_so_far=int(parts[12]),
        net_pressure=int(parts[14]),
        unknown_14=int(parts[13]),
        unknown_16=float(parts[15]),
        unknown_17=float(parts[16]),
        unknown_18=float(parts[17]),
    )


def _parse_orderbook(parts: list[str]) -> Orderbook:
    base = 6
    ask_p = tuple(int(x) for x in parts[base : base + 10])
    ask_q = tuple(int(x) for x in parts[base + 10 : base + 20])
    ask_d = tuple(int(x) for x in parts[base + 20 : base + 30])
    bid_p = tuple(int(x) for x in parts[base + 30 : base + 40])
    bid_q = tuple(int(x) for x in parts[base + 40 : base + 50])
    bid_d = tuple(int(x) for x in parts[base + 50 : base + 60])
    totals_start = base + 60
    tot_ask = int(parts[totals_start])
    tot_ask_d = int(parts[totals_start + 1])
    tot_bid = int(parts[totals_start + 2])
    tot_bid_d = int(parts[totals_start + 3])
    return Orderbook(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        ask_p=ask_p,
        ask_q=ask_q,
        ask_d=ask_d,
        bid_p=bid_p,
        bid_q=bid_q,
        bid_d=bid_d,
        tot_ask=tot_ask,
        tot_ask_d=tot_ask_d,
        tot_bid=tot_bid,
        tot_bid_d=tot_bid_d,
    )


def _parse_premarket(parts: list[str]) -> Trade:
    """`(*, 3)` pre-market summary stored as a side=0 trade.

    Field layout (10 significant fields, from CONTEXT.md / schema-notes.md):
        parts[0]=tsv_section, parts[1]=3, parts[2]=sub_seq, parts[3]=global_seq,
        parts[4]=event_time, parts[5]=rel_time,
        parts[6..9] = (unclear; field 8 is most likely the qty).
    """
    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=0,
        change_pct=0.0,
        qty=int(parts[8]),
        side=0,
        cum_vol=0,
        cum_trades=0,
        low_so_far=0,
        high_so_far=0,
        net_pressure=0,
        unknown_14=int(parts[6]),
        unknown_16=float(parts[7]),
        unknown_17=float(parts[9]),
        unknown_18=0.0,
    )


def _parse_broker(parts: list[str]) -> list[BrokerRow]:
    ts_ms = int(parts[4])
    seq = int(parts[3])
    base = 6
    rows: list[BrokerRow] = []
    # Layout: 5 sell names, 5 sell qty_today, 5 sell qty_delta, 5 buy names, 5 buy qty_today, 5 buy qty_delta
    sell_names = parts[base : base + 5]
    sell_today = parts[base + 5 : base + 10]
    sell_delta = parts[base + 10 : base + 15]
    buy_names = parts[base + 15 : base + 20]
    buy_today = parts[base + 20 : base + 25]
    buy_delta = parts[base + 25 : base + 30]
    for i, (name, today, delta) in enumerate(zip(sell_names, sell_today, sell_delta), start=1):
        rows.append(BrokerRow(ts_ms=ts_ms, seq=seq, side="sell", rank=i, broker=name, qty_today=int(today), qty_delta=int(delta)))
    for i, (name, today, delta) in enumerate(zip(buy_names, buy_today, buy_delta), start=1):
        rows.append(BrokerRow(ts_ms=ts_ms, seq=seq, side="buy", rank=i, broker=name, qty_today=int(today), qty_delta=int(delta)))
    return rows


def parse_info_row(line: str) -> StockInfo:
    parts = _split(line)
    if len(parts) < 22:
        raise FieldCountError(f"info row expects >=22 fields, got {len(parts)}")
    unknowns = {
        "f11": parts[10] if len(parts) > 10 else "",
        "f16": parts[15] if len(parts) > 15 else "",
        "f17": parts[16] if len(parts) > 16 else "",
        "f21": parts[20] if len(parts) > 20 else "",
        "f22": parts[21] if len(parts) > 21 else "",
    }
    return StockInfo(
        code=parts[1],
        name=parts[2],
        regular_session_open_ms=int(parts[4]),
        regular_session_close_ms=int(parts[5]),
        prev_close=int(parts[11]),
        upper_limit=int(parts[12]),
        lower_limit=int(parts[13]),
        today_open=int(parts[14]),
        today_high=int(parts[17]),
        today_low=int(parts[18]),
        today_close=int(parts[19]),
        raw_line=line.rstrip("\n"),
        unknowns=unknowns,
    )


def parse_candle_row(line: str) -> Candle:
    parts = _split(line)
    if len(parts) < 8:
        raise FieldCountError(f"candle row expects >=8 fields, got {len(parts)}")
    return Candle(
        ts_ms=int(parts[0]),
        open_=int(parts[2]),
        close_=int(parts[3]),
        high=int(parts[4]),
        low=int(parts[5]),
        vol_a=int(parts[6]),
        vol_b=int(parts[7]),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_parser_tsv.py -v`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/parser/tsv.py tests/test_parser_tsv.py
git commit -m "feat(parser): row tokenizer + dispatcher"
```

---

## Task 7: Parquet writers

**Files:**
- Create: `hoga/parser/writer.py`
- Create: `tests/test_parser_writer.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_parser_writer.py`:

```python
from __future__ import annotations

from pathlib import Path

import pyarrow.parquet as pq

from hoga.parser.events import BrokerRow, Candle, Orderbook, Trade
from hoga.parser.writer import (
    write_brokers_parquet,
    write_candles_parquet,
    write_snapshots_parquet,
    write_trades_parquet,
)


def test_trades_roundtrip(tmp_path: Path) -> None:
    trades = [
        Trade(
            ts_ms=90000000, seq=1, price=25800, change_pct=0.39, qty=100, side=1,
            cum_vol=100, cum_trades=1, low_so_far=25800, high_so_far=25800,
            net_pressure=100, unknown_14=25800, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
        ),
        Trade(
            ts_ms=90001000, seq=2, price=25750, change_pct=0.20, qty=50, side=-1,
            cum_vol=150, cum_trades=2, low_so_far=25750, high_so_far=25800,
            net_pressure=50, unknown_14=25750, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
        ),
    ]
    out = tmp_path / "trades.parquet"
    write_trades_parquet(trades, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2
    cols = tbl.column_names
    for c in ("ts_ms", "seq", "price", "qty", "side", "cum_vol"):
        assert c in cols
    assert tbl.column("side").to_pylist() == [1, -1]
    assert tbl.column("ts_ms").to_pylist() == [90000000, 90001000]


def test_snapshots_roundtrip(tmp_path: Path) -> None:
    ob = Orderbook(
        ts_ms=90000000, seq=1,
        ask_p=tuple([25800] + [0] * 9),
        ask_q=tuple([100] + [0] * 9),
        ask_d=tuple([0] * 10),
        bid_p=tuple([25750] + [0] * 9),
        bid_q=tuple([200] + [0] * 9),
        bid_d=tuple([0] * 10),
        tot_ask=100, tot_ask_d=0, tot_bid=200, tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_snapshots_parquet([ob], out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 1
    assert tbl.column("ask_p1").to_pylist() == [25800]
    assert tbl.column("bid_p1").to_pylist() == [25750]
    assert tbl.column("ask_q1").to_pylist() == [100]
    assert tbl.column("tot_bid").to_pylist() == [200]
    # All 10-level columns must exist
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            assert f"{prefix}{i}" in tbl.column_names


def test_brokers_roundtrip(tmp_path: Path) -> None:
    rows = [
        BrokerRow(ts_ms=90000000, seq=1, side="sell", rank=1, broker="미래에셋", qty_today=1000, qty_delta=1000),
        BrokerRow(ts_ms=90000000, seq=1, side="buy", rank=1, broker="키움", qty_today=900, qty_delta=900),
    ]
    out = tmp_path / "brokers.parquet"
    write_brokers_parquet(rows, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2
    assert set(tbl.column("side").to_pylist()) == {"sell", "buy"}


def test_candles_roundtrip(tmp_path: Path) -> None:
    candles = [
        Candle(ts_ms=30600000, open_=281000, close_=281000, high=281000, low=281000, vol_a=119, vol_b=0),
        Candle(ts_ms=30660000, open_=281000, close_=281000, high=281000, low=281000, vol_a=10, vol_b=2),
    ]
    out = tmp_path / "candles.parquet"
    write_candles_parquet(candles, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2
    assert tbl.column("ts_ms").to_pylist() == [30600000, 30660000]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_parser_writer.py -v`
Expected: `ModuleNotFoundError: No module named 'hoga.parser.writer'`.

- [ ] **Step 3: Implement `hoga/parser/writer.py`**

```python
"""Convert event dataclasses into pyarrow Tables and write Parquet."""
from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from hoga.parser.events import BrokerRow, Candle, Orderbook, Trade


def write_trades_parquet(trades: Iterable[Trade], path: Path) -> None:
    rows = sorted(trades, key=lambda t: t.ts_ms)
    cols = {
        "ts_ms": pa.array([t.ts_ms for t in rows], type=pa.int64()),
        "seq": pa.array([t.seq for t in rows], type=pa.int32()),
        "price": pa.array([t.price for t in rows], type=pa.int32()),
        "change_pct": pa.array([t.change_pct for t in rows], type=pa.float32()),
        "qty": pa.array([t.qty for t in rows], type=pa.int32()),
        "side": pa.array([t.side for t in rows], type=pa.int8()),
        "cum_vol": pa.array([t.cum_vol for t in rows], type=pa.int64()),
        "cum_trades": pa.array([t.cum_trades for t in rows], type=pa.int32()),
        "low_so_far": pa.array([t.low_so_far for t in rows], type=pa.int32()),
        "high_so_far": pa.array([t.high_so_far for t in rows], type=pa.int32()),
        "net_pressure": pa.array([t.net_pressure for t in rows], type=pa.int64()),
        "unknown_14": pa.array([t.unknown_14 for t in rows], type=pa.int32()),
        "unknown_16": pa.array([t.unknown_16 for t in rows], type=pa.float32()),
        "unknown_17": pa.array([t.unknown_17 for t in rows], type=pa.float32()),
        "unknown_18": pa.array([t.unknown_18 for t in rows], type=pa.float32()),
    }
    pq.write_table(pa.table(cols), path)


def write_snapshots_parquet(snapshots: Iterable[Orderbook], path: Path) -> None:
    rows = sorted(snapshots, key=lambda o: o.ts_ms)
    cols: dict[str, pa.Array] = {
        "ts_ms": pa.array([o.ts_ms for o in rows], type=pa.int64()),
        "seq": pa.array([o.seq for o in rows], type=pa.int32()),
    }
    for prefix, attr in (("ask_p", "ask_p"), ("ask_q", "ask_q"), ("ask_d", "ask_d"),
                         ("bid_p", "bid_p"), ("bid_q", "bid_q"), ("bid_d", "bid_d")):
        for i in range(10):
            cols[f"{prefix}{i + 1}"] = pa.array(
                [getattr(o, attr)[i] for o in rows], type=pa.int32()
            )
    cols["tot_ask"] = pa.array([o.tot_ask for o in rows], type=pa.int32())
    cols["tot_ask_d"] = pa.array([o.tot_ask_d for o in rows], type=pa.int32())
    cols["tot_bid"] = pa.array([o.tot_bid for o in rows], type=pa.int32())
    cols["tot_bid_d"] = pa.array([o.tot_bid_d for o in rows], type=pa.int32())
    pq.write_table(pa.table(cols), path)


def write_brokers_parquet(brokers: Iterable[BrokerRow], path: Path) -> None:
    rows = sorted(brokers, key=lambda r: (r.ts_ms, r.side, r.rank))
    cols = {
        "ts_ms": pa.array([r.ts_ms for r in rows], type=pa.int64()),
        "seq": pa.array([r.seq for r in rows], type=pa.int32()),
        "side": pa.array([r.side for r in rows], type=pa.string()),
        "rank": pa.array([r.rank for r in rows], type=pa.int8()),
        "broker": pa.array([r.broker for r in rows], type=pa.string()),
        "qty_today": pa.array([r.qty_today for r in rows], type=pa.int32()),
        "qty_delta": pa.array([r.qty_delta for r in rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols), path)


def write_candles_parquet(candles: Iterable[Candle], path: Path) -> None:
    rows = sorted(candles, key=lambda c: c.ts_ms)
    cols = {
        "ts_ms": pa.array([c.ts_ms for c in rows], type=pa.int64()),
        "open": pa.array([c.open_ for c in rows], type=pa.int32()),
        "close": pa.array([c.close_ for c in rows], type=pa.int32()),
        "high": pa.array([c.high for c in rows], type=pa.int32()),
        "low": pa.array([c.low for c in rows], type=pa.int32()),
        "vol_a": pa.array([c.vol_a for c in rows], type=pa.int32()),
        "vol_b": pa.array([c.vol_b for c in rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols), path)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_parser_writer.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/parser/writer.py tests/test_parser_writer.py
git commit -m "feat(parser): parquet writers per table"
```

---

## Task 8: Parser orchestration end-to-end

**Files:**
- Modify: `hoga/parser/__init__.py`
- Create: `tests/fixtures/tiny_tsv/info.tsv`
- Create: `tests/fixtures/tiny_tsv/first_001.tsv`
- Create: `tests/fixtures/tiny_tsv/chart.tsv`
- Create: `tests/test_parser_e2e.py`

- [ ] **Step 1: Create fixture `tests/fixtures/tiny_tsv/info.tsv`**

```
1	003490	대한항공	0	90000000	153000000	48854	83000215	160000230	1956286	50299	25700	26450	25100	25800	33200	17900	25550	25750	25900	25450	25550
```

(Single line, ending with newline. 22 tab-separated fields.)

- [ ] **Step 2: Create fixture `tests/fixtures/tiny_tsv/first_001.tsv`**

Build a small but representative TSV covering every event type the parser handles. Save to `tests/fixtures/tiny_tsv/first_001.tsv` exactly as below (each row ends with `\n`; orderbook rows have a trailing tab before `\n`):

```
1	3	10	11	84000352	31200352	0	0	501	0
1	2	834	846	85959530	32399530	25800	25850	25900	0	0	0	0	0	0	0	111	131	2985	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	25750	25700	25650	0	0	0	0	0	0	0	1281	788	2776	0	0	0	0	0	0	0	-14	0	0	0	0	0	0	0	0	0	3227	0	4845	-14	
2	1	0	847	90010023	32410023	25700	0.59	7868	7868	202	25700	25700	25700	-1248627	0.63	0.00	500.00
2	1	1	848	90010160	32410160	25750	0.78	+3	7871	202	25700	25750	25700	-1248624	0.63	0.00	500.00
2	1	2	849	90010173	32410173	25750	0.78	+1	7872	202	25700	25750	25700	-1248623	0.63	0.00	500.00
2	1	3	850	90010335	32410335	25750	0.78	+3	7875	202	25700	25750	25700	-1248620	0.63	0.00	500.00
2	1	4	851	90010351	32410351	25700	0.59	-3	7878	202	25700	25750	25700	-1248617	0.63	0.00	233.33
2	2	5	852	90010435	32410435	25700	25750	25800	0	0	0	0	0	0	0	657	72	111	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	25650	25600	25550	0	0	0	0	0	0	0	2776	4193	4259	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	0	840	-2387	11228	6383	
2	4	0	853	90019919	32419919	미래에셋	NH투자증권	키움증권	한국투자증권	신한투자증권	1798	1291	1210	1164	804	1798	1291	1210	1164	804	아이엠증권	유비에스증권	NH투자증권	JP모간서울	키움증권	3450	1236	968	602	549	3450	1236	968	602	549	0	0	1838	1838	1838	1838
```

(That's 9 rows: 1 premarket, 1 initial orderbook, 5 trades, 1 streaming orderbook, 1 broker.)

- [ ] **Step 3: Create fixture `tests/fixtures/tiny_tsv/chart.tsv`**

```
55140000	15:19:02	25700	25650	25750	25600	5454	2054	0	48003	47877
30600000	08:30:00	281000	281000	281000	281000	119	0	0	43	5
```

(Note: real chart.tsv is descending by `ts_ms`; we mimic that. Parser should re-sort ascending.)

- [ ] **Step 4: Write the failing end-to-end test**

Create `tests/test_parser_e2e.py`:

```python
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture
def staged_raw(tmp_path: Path) -> Path:
    """Copy tiny_tsv fixture into a temp data/raw/{date}/{code}/ tree."""
    raw_dir = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw_dir.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw_dir / name)
    return tmp_path


def test_parser_writes_all_tables(staged_raw: Path) -> None:
    out_dir = parse_stock_date(
        code="003490",
        date="20260519",
        data_dir=staged_raw / "data",
    )
    for name in ("snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet", "meta.json"):
        assert (out_dir / name).exists(), f"missing {name}"


def test_parser_trades_table(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "trades.parquet")
    # 1 premarket + 5 streaming trades = 6
    assert tbl.num_rows == 6
    sides = tbl.column("side").to_pylist()
    # premarket → 0; first streaming trade (auction cross) → 0; +3 +1 +3 -3 → 1, 1, 1, -1
    assert sides == [0, 0, 1, 1, 1, -1]
    qtys = tbl.column("qty").to_pylist()
    assert qtys == [501, 7868, 3, 1, 3, 3]


def test_parser_snapshots_table(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "snapshots.parquet")
    assert tbl.num_rows == 2  # 1 initial + 1 streaming
    assert tbl.column("ask_p1").to_pylist() == [25800, 25700]


def test_parser_brokers_table(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "brokers.parquet")
    assert tbl.num_rows == 10  # 5 buy + 5 sell
    assert set(tbl.column("side").to_pylist()) == {"buy", "sell"}


def test_parser_candles_table_sorted_ascending(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "candles.parquet")
    assert tbl.num_rows == 2
    ts = tbl.column("ts_ms").to_pylist()
    assert ts == sorted(ts), "candles must be sorted ascending"


def test_parser_meta_json(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["code"] == "003490"
    assert meta["name"] == "대한항공"
    assert meta["regular_session_open_ms"] == 90000000
    assert meta["regular_session_close_ms"] == 153000000
    assert "raw_info_tsv" in meta
    assert isinstance(meta["total_unique_events"], int)


def test_parser_dedups_global_seq(tmp_path: Path) -> None:
    raw_dir = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw_dir.mkdir(parents=True)
    shutil.copy(FIXTURE_DIR / "info.tsv", raw_dir / "info.tsv")
    # Two Page files sharing rows.
    page = (FIXTURE_DIR / "first_001.tsv").read_text(encoding="utf-8")
    (raw_dir / "first_001.tsv").write_text(page, encoding="utf-8")
    (raw_dir / "first_002.tsv").write_text(page, encoding="utf-8")  # identical → all dup
    shutil.copy(FIXTURE_DIR / "chart.tsv", raw_dir / "chart.tsv")

    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    trades_tbl = pq.read_table(out_dir / "trades.parquet")
    assert trades_tbl.num_rows == 6, "duplicates by global_seq must be removed"
```

- [ ] **Step 5: Run the failing test**

Run: `python -m pytest tests/test_parser_e2e.py -v`
Expected: `AttributeError` or `ImportError` for `parse_stock_date`.

- [ ] **Step 6: Implement `hoga/parser/__init__.py` orchestrator**

```python
"""Stock-Date TSV → typed Parquet orchestrator."""
from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path

from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade
from hoga.parser.tsv import (
    FieldCountError,
    parse_candle_row,
    parse_info_row,
    parse_row,
)
from hoga.parser.writer import (
    write_brokers_parquet,
    write_candles_parquet,
    write_snapshots_parquet,
    write_trades_parquet,
)

PARSER_VERSION = "0.1.0"


class ParserError(RuntimeError):
    """Raised on strict-mode validation failures."""


def _iter_first_lines(raw_dir: Path) -> Iterable[tuple[Path, int, str]]:
    for page_path in sorted(raw_dir.glob("first_*.tsv")):
        text = page_path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(keepends=False), start=1):
            if not line:
                continue
            yield page_path, lineno, line


def parse_stock_date(
    *,
    code: str,
    date: str,
    data_dir: Path,
    lenient: bool = False,
) -> Path:
    """Parse one Stock-Date's raw TSV into Parquet + meta.json.

    Returns the output directory (data/parquet/{date}/{code}).
    """
    raw_dir = data_dir / "raw" / date / code
    out_dir = data_dir / "parquet" / date / code
    out_dir.mkdir(parents=True, exist_ok=True)

    # info.tsv → StockInfo
    info_text = (raw_dir / "info.tsv").read_text(encoding="utf-8").strip()
    info = parse_info_row(info_text)

    # first_*.tsv → dedup by global_seq, dispatch by event_type
    seen_seqs: set[int] = set()
    trades: list[Trade] = []
    snapshots: list[Orderbook] = []
    brokers: list[BrokerRow] = []
    skipped: list[tuple[str, int, str]] = []

    for page_path, lineno, line in _iter_first_lines(raw_dir):
        try:
            parsed = parse_row(line)
        except (FieldCountError, ValueError) as e:
            msg = f"{page_path.name}:{lineno} {e}"
            if lenient:
                skipped.append((page_path.name, lineno, str(e)))
                continue
            raise ParserError(msg) from e

        # Dedup by global_seq. Field 4 is exposed on each event via .seq.
        if isinstance(parsed, list):  # broker rows share the same seq
            sample_seq = parsed[0].seq if parsed else None
            if sample_seq is not None and sample_seq in seen_seqs:
                continue
            if sample_seq is not None:
                seen_seqs.add(sample_seq)
            brokers.extend(parsed)
            continue

        if parsed.seq in seen_seqs:
            continue
        seen_seqs.add(parsed.seq)
        if isinstance(parsed, Trade):
            trades.append(parsed)
        elif isinstance(parsed, Orderbook):
            snapshots.append(parsed)

    # Validation
    _validate_trades_monotonic(trades, lenient=lenient)
    _validate_snapshot_price_order(snapshots, lenient=lenient)

    # chart.tsv → candles
    candles: list[Candle] = []
    chart_path = raw_dir / "chart.tsv"
    if chart_path.exists():
        for line in chart_path.read_text(encoding="utf-8").splitlines():
            if not line:
                continue
            try:
                candles.append(parse_candle_row(line))
            except (FieldCountError, ValueError) as e:
                if lenient:
                    skipped.append(("chart.tsv", 0, str(e)))
                    continue
                raise ParserError(f"chart.tsv: {e}") from e

    # Write Parquet
    write_trades_parquet(trades, out_dir / "trades.parquet")
    write_snapshots_parquet(snapshots, out_dir / "snapshots.parquet")
    write_brokers_parquet(brokers, out_dir / "brokers.parquet")
    write_candles_parquet(candles, out_dir / "candles.parquet")

    # meta.json
    meta = _build_meta(info=info, seen_seqs=seen_seqs, skipped=skipped, raw_dir=raw_dir)
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return out_dir


def _validate_trades_monotonic(trades: list[Trade], *, lenient: bool) -> None:
    sorted_trades = sorted(trades, key=lambda t: t.ts_ms)
    prev = -1
    for t in sorted_trades:
        if t.cum_vol < prev:
            msg = f"cum_vol decreased at seq={t.seq}: {prev} → {t.cum_vol}"
            if lenient:
                continue
            raise ParserError(msg)
        prev = t.cum_vol


def _validate_snapshot_price_order(snapshots: list[Orderbook], *, lenient: bool) -> None:
    for ob in snapshots:
        # Ask prices should be non-decreasing (zeros at the end are placeholders).
        nz_ask = [p for p in ob.ask_p if p > 0]
        if nz_ask != sorted(nz_ask):
            msg = f"ask prices not sorted at seq={ob.seq}: {nz_ask}"
            if lenient:
                continue
            raise ParserError(msg)
        # Bid prices should be non-increasing.
        nz_bid = [p for p in ob.bid_p if p > 0]
        if nz_bid != sorted(nz_bid, reverse=True):
            msg = f"bid prices not sorted at seq={ob.seq}: {nz_bid}"
            if lenient:
                continue
            raise ParserError(msg)


def _build_meta(*, info: StockInfo, seen_seqs: set[int], skipped: list[tuple[str, int, str]], raw_dir: Path) -> dict[str, object]:
    pages = sorted(raw_dir.glob("first_*.tsv"))
    return {
        "code": info.code,
        "name": info.name,
        "regular_session_open_ms": info.regular_session_open_ms,
        "regular_session_close_ms": info.regular_session_close_ms,
        "prev_close": info.prev_close,
        "upper_limit": info.upper_limit,
        "lower_limit": info.lower_limit,
        "today_open": info.today_open,
        "today_high": info.today_high,
        "today_low": info.today_low,
        "today_close": info.today_close,
        "info_unknowns": info.unknowns,
        "raw_info_tsv": info.raw_line,
        "pages_collected": len(pages),
        "total_unique_events": len(seen_seqs),
        "parser_version": PARSER_VERSION,
        "warnings": [{"file": f, "line": ln, "reason": r} for f, ln, r in skipped],
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `python -m pytest tests/test_parser_e2e.py -v`
Expected: 7 passed.

If any test fails, inspect the fixture row by row against the parser's expected field counts. The most likely culprit is field-count drift in the hand-crafted `first_001.tsv` (count tabs in each row and confirm orderbook rows = 71 fields, broker rows = 43 fields, trade rows = 19 fields, pre-market row = 11 fields).

- [ ] **Step 8: Run all parser tests together**

Run: `python -m pytest tests/test_parser_tsv.py tests/test_parser_writer.py tests/test_parser_e2e.py -v`
Expected: 21 passed (10 + 4 + 7).

- [ ] **Step 9: Commit**

```bash
git add hoga/parser/__init__.py tests/fixtures/tiny_tsv/ tests/test_parser_e2e.py
git commit -m "feat(parser): end-to-end orchestration"
```

---

## Task 9: API queries + response models

**Files:**
- Create: `hoga/api/__init__.py`
- Create: `hoga/api/queries.py`
- Create: `hoga/api/models.py`

These two files are tested as part of Task 10 via the FastAPI TestClient.

- [ ] **Step 1: Create `hoga/api/__init__.py`**

```python
```
(empty)

- [ ] **Step 2: Implement `hoga/api/models.py`**

```python
"""Pydantic v2 response models."""
from __future__ import annotations

from pydantic import BaseModel, Field


class StockDate(BaseModel):
    """Inventory entry: one captured Stock-Date with its boundaries."""
    date: str
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int


class OrderbookSnapshot(BaseModel):
    ts_ms: int
    seq: int
    ask_p: list[int]   # length 10
    ask_q: list[int]
    bid_p: list[int]
    bid_q: list[int]
    tot_ask: int
    tot_bid: int


class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: OrderbookSnapshot | None


class Trade(BaseModel):
    ts_ms: int
    seq: int
    price: int
    qty: int
    side: int  # -1, 0, +1
    cum_vol: int


class TradesResponse(BaseModel):
    trades: list[Trade]


class Candle(BaseModel):
    ts_ms: int
    open: int = Field(serialization_alias="open")
    close: int
    high: int
    low: int
    vol_a: int
    vol_b: int


class CandlesResponse(BaseModel):
    candles: list[Candle]


class BrokerEntry(BaseModel):
    side: str  # "buy" | "sell"
    rank: int
    broker: str
    qty_today: int
    qty_delta: int


class BrokersResponse(BaseModel):
    ts_ms: int | None
    entries: list[BrokerEntry]


class Meta(BaseModel):
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    pages_collected: int
    total_unique_events: int
    parser_version: str
```

- [ ] **Step 3: Implement `hoga/api/queries.py`**

```python
"""DuckDB queries against the Parquet data lake."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb


class StockDateNotFound(LookupError):
    """No parquet directory for (code, date)."""


class QueryEngine:
    """One-process shared DuckDB connection."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._conn = duckdb.connect(database=":memory:", read_only=False)

    def close(self) -> None:
        self._conn.close()

    def parquet_dir(self, date: str, code: str) -> Path:
        d = self.data_dir / "parquet" / date / code
        if not d.exists():
            raise StockDateNotFound(f"{date}/{code}")
        return d

    def list_stock_dates(self) -> list[dict[str, Any]]:
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[dict[str, Any]] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            for code_dir in sorted(date_dir.iterdir()):
                if not (code_dir / "meta.json").exists():
                    continue
                meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
                ts_range = self._snapshot_time_bounds(code_dir / "snapshots.parquet")
                out.append({
                    "date": date_dir.name,
                    "code": code_dir.name,
                    "name": meta["name"],
                    "regular_session_open_ms": meta["regular_session_open_ms"],
                    "regular_session_close_ms": meta["regular_session_close_ms"],
                    "data_window_first_ms": ts_range[0] if ts_range else meta["regular_session_open_ms"],
                    "data_window_last_ms": ts_range[1] if ts_range else meta["regular_session_close_ms"],
                })
        return out

    def _snapshot_time_bounds(self, parquet_path: Path) -> tuple[int, int] | None:
        if not parquet_path.exists():
            return None
        row = self._conn.execute(
            "SELECT min(ts_ms), max(ts_ms) FROM read_parquet(?)",
            [str(parquet_path)],
        ).fetchone()
        if row is None or row[0] is None:
            return None
        return int(row[0]), int(row[1])

    def get_meta(self, date: str, code: str) -> dict[str, Any]:
        path = self.parquet_dir(date, code) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def get_orderbook_at(self, date: str, code: str, t_ms: int) -> dict[str, Any] | None:
        path = self.parquet_dir(date, code) / "snapshots.parquet"
        row = self._conn.execute(
            "SELECT * FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1",
            [str(path), t_ms],
        ).fetchone()
        if row is None:
            return None
        cols = [d[0] for d in self._conn.description]
        return dict(zip(cols, row, strict=True))

    def first_snapshot_ts(self, date: str, code: str) -> int | None:
        path = self.parquet_dir(date, code) / "snapshots.parquet"
        row = self._conn.execute(
            "SELECT min(ts_ms) FROM read_parquet(?)", [str(path)]
        ).fetchone()
        if row is None or row[0] is None:
            return None
        return int(row[0])

    def get_trades_up_to(self, date: str, code: str, t_ms: int, limit: int) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "trades.parquet"
        rows = self._conn.execute(
            "SELECT ts_ms, seq, price, qty, side, cum_vol FROM read_parquet(?) "
            "WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
            [str(path), t_ms, limit],
        ).fetchall()
        cols = ["ts_ms", "seq", "price", "qty", "side", "cum_vol"]
        return [dict(zip(cols, r, strict=True)) for r in rows]

    def get_candles(self, date: str, code: str) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "candles.parquet"
        rows = self._conn.execute(
            'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b FROM read_parquet(?) ORDER BY ts_ms ASC',
            [str(path)],
        ).fetchall()
        cols = ["ts_ms", "open", "close", "high", "low", "vol_a", "vol_b"]
        return [dict(zip(cols, r, strict=True)) for r in rows]

    def get_brokers_at(self, date: str, code: str, t_ms: int) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "brokers.parquet"
        # Pick the most recent ts_ms <= t_ms, then return all 10 rows at that ts.
        latest = self._conn.execute(
            "SELECT max(ts_ms) FROM read_parquet(?) WHERE ts_ms <= ?",
            [str(path), t_ms],
        ).fetchone()
        if latest is None or latest[0] is None:
            return []
        rows = self._conn.execute(
            "SELECT ts_ms, side, rank, broker, qty_today, qty_delta FROM read_parquet(?) "
            "WHERE ts_ms = ? ORDER BY side, rank",
            [str(path), latest[0]],
        ).fetchall()
        cols = ["ts_ms", "side", "rank", "broker", "qty_today", "qty_delta"]
        return [dict(zip(cols, r, strict=True)) for r in rows]
```

- [ ] **Step 4: Run a smoke import to catch syntax errors**

Run: `python -c "from hoga.api.queries import QueryEngine; from hoga.api.models import StockDate; print('ok')"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/__init__.py hoga/api/queries.py hoga/api/models.py
git commit -m "feat(api): duckdb queries + pydantic models"
```

---

## Task 10: API endpoints

**Files:**
- Create: `hoga/api/routes.py`
- Create: `hoga/api/app.py`
- Create: `tests/test_api.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_api.py`:

```python
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture
def app_client(tmp_path: Path) -> TestClient:
    """Set up data/parquet/20260519/003490 from the tiny_tsv fixture and return a TestClient."""
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    app = create_app(data_dir=tmp_path / "data")
    return TestClient(app)


def test_stock_dates(app_client: TestClient) -> None:
    r = app_client.get("/api/stock-dates")
    assert r.status_code == 200
    entries = r.json()
    assert isinstance(entries, list)
    assert len(entries) == 1
    s = entries[0]
    assert s["code"] == "003490"
    assert s["date"] == "20260519"
    assert s["name"] == "대한항공"


def test_meta(app_client: TestClient) -> None:
    r = app_client.get("/api/meta", params={"code": "003490", "date": "20260519"})
    assert r.status_code == 200
    m = r.json()
    assert m["code"] == "003490"
    assert m["regular_session_open_ms"] == 90000000


def test_meta_unknown_returns_404(app_client: TestClient) -> None:
    r = app_client.get("/api/meta", params={"code": "999999", "date": "20260519"})
    assert r.status_code == 404


def test_orderbook_at_returns_latest(app_client: TestClient) -> None:
    # The fixture has 2 snapshots: at ts 85959530 and 90010435.
    r = app_client.get(
        "/api/orderbook",
        params={"code": "003490", "date": "20260519", "t": 90020000},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["snapshot"] is not None
    assert payload["snapshot"]["ts_ms"] == 90010435
    assert payload["snapshot"]["ask_p"][:3] == [25700, 25750, 25800]


def test_orderbook_before_any_data(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/orderbook",
        params={"code": "003490", "date": "20260519", "t": 80000000},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["snapshot"] is None
    assert payload["available_from"] == 85959530


def test_trades_up_to(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/trades",
        params={"code": "003490", "date": "20260519", "t": 90010500, "limit": 10},
    )
    assert r.status_code == 200
    trades = r.json()["trades"]
    # Pre-market trade (84000352) + 5 streaming trades through 90010351 = 6
    assert len(trades) == 6
    # Trades should be ordered descending by ts_ms.
    ts = [t["ts_ms"] for t in trades]
    assert ts == sorted(ts, reverse=True)


def test_trades_limit(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/trades",
        params={"code": "003490", "date": "20260519", "t": 90010500, "limit": 3},
    )
    assert r.status_code == 200
    assert len(r.json()["trades"]) == 3


def test_candles(app_client: TestClient) -> None:
    r = app_client.get("/api/candles", params={"code": "003490", "date": "20260519"})
    assert r.status_code == 200
    candles = r.json()["candles"]
    assert len(candles) == 2
    ts = [c["ts_ms"] for c in candles]
    assert ts == sorted(ts), "candles ascending"


def test_brokers_at(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/brokers",
        params={"code": "003490", "date": "20260519", "t": 90020000},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["ts_ms"] == 90019919
    entries = payload["entries"]
    assert len(entries) == 10
    sides = {e["side"] for e in entries}
    assert sides == {"buy", "sell"}


def test_brokers_before_any_data(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/brokers",
        params={"code": "003490", "date": "20260519", "t": 80000000},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["ts_ms"] is None
    assert payload["entries"] == []
```

- [ ] **Step 2: Run the failing tests**

Run: `python -m pytest tests/test_api.py -v`
Expected: ImportError for `hoga.api.app.create_app`.

- [ ] **Step 3: Implement `hoga/api/routes.py`**

```python
"""Route handlers."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import (
    BrokerEntry,
    BrokersResponse,
    Candle,
    CandlesResponse,
    Meta,
    OrderbookResponse,
    OrderbookSnapshot,
    StockDate,
    Trade,
    TradesResponse,
)
from hoga.api.queries import QueryEngine, StockDateNotFound


def build_router(engine: QueryEngine) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDate])
    def stock_dates() -> list[StockDate]:
        return [StockDate(**s) for s in engine.list_stock_dates()]

    @router.get("/meta", response_model=Meta)
    def meta(code: str, date: str) -> Meta:
        try:
            m = engine.get_meta(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return Meta(**{k: m[k] for k in Meta.model_fields})

    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(code: str, date: str, t: int = Query(...)) -> OrderbookResponse:
        try:
            row = engine.get_orderbook_at(date, code, t)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        if row is None:
            first_ts = engine.first_snapshot_ts(date, code)
            return OrderbookResponse(available_from=first_ts, snapshot=None)
        snap = OrderbookSnapshot(
            ts_ms=row["ts_ms"],
            seq=row["seq"],
            ask_p=[row[f"ask_p{i}"] for i in range(1, 11)],
            ask_q=[row[f"ask_q{i}"] for i in range(1, 11)],
            bid_p=[row[f"bid_p{i}"] for i in range(1, 11)],
            bid_q=[row[f"bid_q{i}"] for i in range(1, 11)],
            tot_ask=row["tot_ask"],
            tot_bid=row["tot_bid"],
        )
        return OrderbookResponse(available_from=None, snapshot=snap)

    @router.get("/trades", response_model=TradesResponse)
    def trades(code: str, date: str, t: int = Query(...), limit: int = 50) -> TradesResponse:
        try:
            rows = engine.get_trades_up_to(date, code, t, limit)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return TradesResponse(trades=[Trade(**r) for r in rows])

    @router.get("/candles", response_model=CandlesResponse)
    def candles(code: str, date: str) -> CandlesResponse:
        try:
            rows = engine.get_candles(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return CandlesResponse(candles=[Candle(**r) for r in rows])

    @router.get("/brokers", response_model=BrokersResponse)
    def brokers(code: str, date: str, t: int = Query(...)) -> BrokersResponse:
        try:
            rows = engine.get_brokers_at(date, code, t)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        if not rows:
            return BrokersResponse(ts_ms=None, entries=[])
        ts = rows[0]["ts_ms"]
        entries = [
            BrokerEntry(side=r["side"], rank=r["rank"], broker=r["broker"], qty_today=r["qty_today"], qty_delta=r["qty_delta"])
            for r in rows
        ]
        return BrokersResponse(ts_ms=ts, entries=entries)

    return router
```

- [ ] **Step 4: Implement `hoga/api/app.py`**

```python
"""FastAPI factory."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router


def create_app(data_dir: Path) -> FastAPI:
    app = FastAPI(title="hoga-ops API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    engine = QueryEngine(data_dir)
    app.include_router(build_router(engine))
    app.state.engine = engine

    @app.on_event("shutdown")
    def _close() -> None:
        engine.close()

    return app
```

- [ ] **Step 5: Run the API tests**

Run: `python -m pytest tests/test_api.py -v`
Expected: 10 passed.

- [ ] **Step 6: Run the full test suite**

Run: `python -m pytest -v`
Expected: all tests passing (config 4 + collector_client 8 + collector_orchestrator 5 + parser_tsv 10 + parser_writer 4 + parser_e2e 7 + api 10 = 48).

- [ ] **Step 7: Commit**

```bash
git add hoga/api/routes.py hoga/api/app.py tests/test_api.py
git commit -m "feat(api): FastAPI endpoints"
```

---

## Task 11: Wire CLI subcommands to real implementations

**Files:**
- Modify: `hoga/cli.py`

- [ ] **Step 1: Replace `hoga/cli.py` with the wired version**

```python
"""Typer CLI for hoga-ops."""
from __future__ import annotations

from pathlib import Path

import typer
import uvicorn
from rich.console import Console
from rich.table import Table

from hoga.collector.client import HogaplayClient
from hoga.collector.orchestrator import collect_stock_date
from hoga.config import Config, CookieMissingError
from hoga.parser import parse_stock_date

app = typer.Typer(no_args_is_help=True, add_completion=False, help="hoga-ops backend CLI")
console = Console()


def _cfg() -> Config:
    return Config.from_cwd()


@app.command()
def collect(
    code: str = typer.Option(..., "--code"),
    date: str = typer.Option(..., "--date"),
    allow_partial: bool = typer.Option(False, "--allow-partial"),
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
                data_dir=cfg.data_dir,
                allow_partial=allow_partial,
                resume=resume,
            )
        except Exception as e:  # noqa: BLE001 - top-level CLI handler
            console.print(f"[red]collect failed: {e}[/red]")
            raise typer.Exit(code=1) from e
    console.print(
        f"[green]captured[/green] {code}/{date} → {result.raw_dir} "
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
    cfg = _cfg()
    try:
        out = parse_stock_date(code=code, date=date, data_dir=cfg.data_dir, lenient=lenient)
    except Exception as e:  # noqa: BLE001
        console.print(f"[red]parse failed: {e}[/red]")
        raise typer.Exit(code=1) from e
    console.print(f"[green]parsed[/green] {code}/{date} → {out}")
    if report:
        import json
        meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
        for k, v in meta.items():
            if k in ("info_unknowns", "warnings", "raw_info_tsv"):
                continue
            console.print(f"  {k}: {v}")


@app.command()
def serve(port: int = 8000) -> None:
    """Start the FastAPI server."""
    cfg = _cfg()
    uvicorn.run(
        "hoga.api.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=port,
        reload=False,
        # uvicorn factory functions don't accept kwargs directly; we use a module-level
        # app helper instead via env-driven data dir:
    )


@app.command(name="ls")
def list_stock_dates() -> None:
    """Show captured/parsed Stock-Dates."""
    cfg = _cfg()
    raw_root = cfg.data_dir / "raw"
    parquet_root = cfg.data_dir / "parquet"
    pairs: dict[tuple[str, str], dict[str, bool]] = {}
    if raw_root.exists():
        for date_dir in raw_root.iterdir():
            for code_dir in date_dir.iterdir():
                pairs[(date_dir.name, code_dir.name)] = {"raw": True, "parsed": False}
    if parquet_root.exists():
        for date_dir in parquet_root.iterdir():
            for code_dir in date_dir.iterdir():
                key = (date_dir.name, code_dir.name)
                pairs.setdefault(key, {"raw": False, "parsed": False})
                pairs[key]["parsed"] = (code_dir / "meta.json").exists()
    table = Table(title="hoga-ops captures")
    table.add_column("date")
    table.add_column("code")
    table.add_column("raw")
    table.add_column("parsed")
    for (d, c), state in sorted(pairs.items()):
        table.add_row(d, c, "[green]Y[/green]" if state["raw"] else "-", "[green]Y[/green]" if state["parsed"] else "-")
    console.print(table)
```

Note: the `serve` command above passes a factory, but `create_app` needs a `data_dir`. Fix that by adding a thin wrapper.

- [ ] **Step 2: Add a no-arg app factory used by uvicorn**

Append to `hoga/api/app.py`:

```python


def default_app() -> FastAPI:
    """Factory used by uvicorn — reads data dir from cwd."""
    from hoga.config import Config
    cfg = Config.from_cwd()
    return create_app(cfg.data_dir)
```

And change `hoga/cli.py`'s `serve` to call it:

```python
@app.command()
def serve(port: int = 8000) -> None:
    """Start the FastAPI server."""
    uvicorn.run(
        "hoga.api.app:default_app",
        factory=True,
        host="127.0.0.1",
        port=port,
        reload=False,
    )
```

- [ ] **Step 3: Verify CLI smoke tests**

Run: `python -m hoga --help`
Expected: lists `collect`, `parse`, `serve`, `ls`.
Run: `python -m hoga ls`
Expected: prints a table (likely empty rows if no captures yet) without error.

- [ ] **Step 4: Verify the full test suite still passes**

Run: `python -m pytest -v`
Expected: all 48 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hoga/cli.py hoga/api/app.py
git commit -m "feat(cli): wire collect/parse/serve/ls"
```

---

## Task 12: End-to-end manual validation against real hogaplay data

This task has no automated test — it's the spec's "manual validation" gate. Failure to verify against real data means we don't know if the schema interpretation is right.

- [ ] **Step 1: Ensure cookie is fresh**

Open hogaplay.com in a browser, log in, copy the `Cookie` request header for `/player/info.php`, paste into `C:\code\hoga-ops\.cookie` overwriting the old value.

- [ ] **Step 2: Collect a past Stock-Date for 대한항공 + 삼성전자**

Pick a recent business day with a completed Regular Session (e.g., yesterday). Replace `<DATE>` below with a YYYYMMDD value.

Run: `python -m hoga collect --code 003490 --date <DATE>`
Run: `python -m hoga collect --code 005930 --date <DATE>`
Expected: both finish with non-zero `unique_events`. Inspect `data/raw/<DATE>/003490/_progress.json` — `finished_at` should be populated.

- [ ] **Step 3: Parse both Stock-Dates**

Run: `python -m hoga parse --code 003490 --date <DATE> --report`
Run: `python -m hoga parse --code 005930 --date <DATE> --report`
Expected: each prints `parsed ... → data/parquet/<DATE>/<code>` and a metadata summary. No errors raised.

- [ ] **Step 4: Inspect Parquet via DuckDB**

Run:
```sh
python -c "import duckdb; print(duckdb.sql(\"SELECT count(*), min(ts_ms), max(ts_ms) FROM read_parquet('data/parquet/<DATE>/003490/trades.parquet')\").df())"
```
Expected: `count > 0`, `min(ts_ms)` near 09:00 (or earlier for pre-market), `max(ts_ms)` near 15:30 (or 15:30 sharp).

Same for `snapshots.parquet` and `candles.parquet`.

- [ ] **Step 5: Start the server**

Run: `python -m hoga serve --port 8000`
Leave running in a separate terminal.

- [ ] **Step 6: Hit each endpoint with curl**

Run: `curl -s http://127.0.0.1:8000/api/stock-dates | python -m json.tool`
Expected: lists both Stock-Dates.

Run: `curl -s "http://127.0.0.1:8000/api/meta?code=003490&date=<DATE>" | python -m json.tool`
Expected: prev_close/upper_limit/etc populated.

Run: `curl -s "http://127.0.0.1:8000/api/orderbook?code=003490&date=<DATE>&t=100000000" | python -m json.tool`
Expected: snapshot with 10 ask + 10 bid prices, all positive integers (or zeros for empty slots).

Run: `curl -s "http://127.0.0.1:8000/api/trades?code=003490&date=<DATE>&t=100000000&limit=5" | python -m json.tool`
Expected: 5 trades, descending by `ts_ms`, `side` ∈ {-1, 0, 1}.

Run: `curl -s "http://127.0.0.1:8000/api/candles?code=003490&date=<DATE>" | python -m json.tool | head -50`
Expected: candles ascending by `ts_ms`, OHLC values plausible.

Run: `curl -s "http://127.0.0.1:8000/api/brokers?code=003490&date=<DATE>&t=140000000" | python -m json.tool`
Expected: 10 broker entries (5 buy + 5 sell) — *or* empty if no broker events appeared by that time (low-volume stocks).

- [ ] **Step 7: Spot-check against hogaplay's player**

In a browser, open hogaplay.com player for the same Stock-Date and same timestamp. Compare the orderbook ladder values to your `/api/orderbook` response. They should match exactly. If they don't:
- Mismatched price levels → field positions in `_parse_orderbook` are wrong; cross-check against `schema-notes.md`.
- Off-by-one or off-by-1ms → check `t_ms <= t` vs `<` in DuckDB query.

If they match, Phase 1 is validated end-to-end. Document the verified date in a final commit.

- [ ] **Step 8: Final commit (verification record)**

```bash
git add CONTEXT.md docs/  # any notes you updated during verification
git commit --allow-empty -m "verify: end-to-end validated against hogaplay player for <DATE>"
```

---

## Plan complete

The Phase 1 backend is shippable after Task 12. Phase 2 (frontend) starts with a fresh brainstorming pass and a separate plan.
