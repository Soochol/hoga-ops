"""Phase 1 matrix experiment driver.

For each (rate_limit_s, initial_step_ms, start_t) cell:
  1. Set up a sandbox raw_dir under /tmp/matrix-experiment/
  2. Plant a fake _progress.json with last_time_ms=start_t to drive
     _resume_state past the data-window start.
  3. Call collect_stock_date with resume=True, cancel_token=<90s timer>.
  4. Capture exceptions (HogaplayHTTPError, CookieExpiredError) as the
     cell's outcome.
  5. Read the resulting _profile.jsonl and compute throughput,
     cap_hit_rate, http_ms_p50/p95.
  6. Sleep 60s between cells (req/sec smoothing).
  7. Abort the entire matrix on the first 429/403/503.

Output: matrix-results.json with one entry per cell.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import threading
from datetime import datetime
from pathlib import Path

from hoga.collector.client import (
    CookieExpiredError,
    HogaplayClient,
    HogaplayHTTPError,
)
from hoga.collector.orchestrator import CancelToken, collect_stock_date
from hoga.config import Config

CELL_DURATION_S = 90
COOLDOWN_S = 60
SANDBOX = Path("/tmp/matrix-experiment")
OUT = Path("docs/superpowers/measurements/2026-05-23-throughput/matrix-results.json")

# (rate_limit_s, initial_step_ms) cells
CELLS = [
    (0.2, 60000), (0.2, 120000), (0.2, 240000),
    (0.1, 60000), (0.1, 120000), (0.1, 240000),
    (0.05, 60000), (0.05, 120000), (0.05, 240000),
]
# start times in HogaMs (HHMMSSmmm): open / lunch / close
START_TIMES = [
    ("open", 90000000),     # 09:00:00.000
    ("lunch", 120000000),   # 12:00:00.000
    ("close", 152000000),   # 15:20:00.000
]
CODE = "003490"  # use 대한항공 to isolate step-ceiling effect (low activity)
DATE = "20260423"  # CHANGE to an uncaptured weekday at run time


def _plant_fake_progress(raw_dir: Path, start_t: int) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / "_progress.json").write_text(json.dumps({
        "last_time_ms": start_t, "pages_done": 0, "global_seqs_seen": 0,
        "started_at": datetime.now().isoformat(), "finished_at": None,
    }))
    # Empty info.tsv so collect_stock_date's resume branch skips info.php fetch
    (raw_dir / "info.tsv").write_text("")


def _cancel_after(token: CancelToken, seconds: float) -> None:
    threading.Timer(seconds, token.cancel).start()


def _summarize_profile(profile_path: Path) -> dict:
    if not profile_path.exists():
        return {"iters": 0}
    lines = [json.loads(l) for l in profile_path.read_text().splitlines() if l]
    if not lines:
        return {"iters": 0}
    http = sorted(l["http_ms"] for l in lines)
    return {
        "iters": len(lines),
        "pages": lines[-1]["page_idx"],
        "cap_hits": sum(1 for l in lines if l["cap_hit"]),
        "cap_hit_rate": sum(1 for l in lines if l["cap_hit"]) / len(lines),
        "http_ms_p50": http[len(http) // 2],
        "http_ms_p95": http[int(len(http) * 0.95)],
        "body_len_p50": sorted(l["body_len"] for l in lines)[len(lines) // 2],
    }


def run_cell(
    client: HogaplayClient, rate_s: float, step_ms: int, start_label: str, start_t: int
) -> dict:
    cell_id = f"r{rate_s}_s{step_ms}_{start_label}"
    sandbox = SANDBOX / cell_id
    if sandbox.exists():
        shutil.rmtree(sandbox)
    raw_dir = sandbox / "raw" / DATE / CODE
    _plant_fake_progress(raw_dir, start_t)
    token = CancelToken()
    _cancel_after(token, CELL_DURATION_S)
    os.environ["HOGA_PROFILE"] = "1"
    t0 = time.perf_counter()
    outcome = "ok"
    err_msg = None
    try:
        collect_stock_date(
            client=client, code=CODE, date=DATE, data_dir=sandbox,
            rate_limit_s=rate_s, resume=True, cancel_token=token,
            initial_step_ms=step_ms,
        )
    except HogaplayHTTPError as e:
        outcome = f"http_{e.status_code}"
        err_msg = str(e)
    except CookieExpiredError as e:
        outcome = "cookie_expired"
        err_msg = str(e)
    except Exception as e:  # noqa: BLE001
        outcome = type(e).__name__
        err_msg = str(e)
    elapsed = time.perf_counter() - t0
    summary = _summarize_profile(raw_dir / "_profile.jsonl")
    return {
        "cell_id": cell_id, "rate_s": rate_s, "step_ms": step_ms,
        "start_label": start_label, "start_t": start_t,
        "elapsed_s": round(elapsed, 1), "outcome": outcome, "err": err_msg,
        **summary,
    }


def main() -> None:
    cfg = Config.from_cwd()
    cookie = cfg.cookie()
    results: list[dict] = []
    SANDBOX.mkdir(exist_ok=True)
    with HogaplayClient(cookie=cookie) as client:
        for start_label, start_t in START_TIMES:
            for rate_s, step_ms in CELLS:
                print(f"--> cell r={rate_s} s={step_ms} start={start_label}")
                r = run_cell(client, rate_s, step_ms, start_label, start_t)
                print(json.dumps(r, indent=2))
                results.append(r)
                OUT.parent.mkdir(parents=True, exist_ok=True)
                OUT.write_text(json.dumps(results, indent=2))
                if r["outcome"].startswith("http_4") or r["outcome"].startswith("http_5") or r["outcome"] == "cookie_expired":
                    print("ABORT: throttle/block signal detected")
                    return
                time.sleep(COOLDOWN_S)


if __name__ == "__main__":
    main()
