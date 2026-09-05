"""기준 커밋과 현재 검색 진입점을 같은 합성 parquet에서 대조한다.

루트에서 PYTHONPATH=. python <이 파일> 로 실행. 외부 API/운영 데이터는 사용하지
않는다. cold는 앱 코퍼스 캐시만 비우며 OS 파일 캐시는 비우지 않는다.
"""
import gc
import importlib.util
import json
import math
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import polars as pl

from hoga.api import screener_pattern as current
from hoga.api.models import PatternSearchRequest

BASE = "fd3cbe3c7f8ecf582cf61dd583c109a60bb29059"
SYMBOLS, BARS, KEEP = 100, 10_000, 252
ROOT = Path(__file__).resolve().parents[3]


def assert_same(actual, expected):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys()
        for key in expected:
            if key != "elapsed_ms":
                assert_same(actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a, b in zip(actual, expected, strict=True):
            assert_same(a, b)
    elif isinstance(expected, float):
        assert math.isclose(actual, expected, abs_tol=1e-8, rel_tol=1e-8), (actual, expected)
    else:
        assert actual == expected, (actual, expected)


def make_data(root):
    rng = np.random.default_rng(20260905)
    dates = np.busday_offset("2026-09-04", np.arange(1 - BARS, 1)).astype("datetime64[D]")
    rows = []
    for i in range(SYMBOLS):
        close = 100 * np.exp(rng.normal(0, .004, BARS).cumsum())
        op = close * np.exp(rng.normal(0, .002, BARS))
        rows.append(pl.DataFrame({
            "code": [f"{i + 1:06}"] * BARS, "date": dates,
            "open": op, "high": np.maximum(op, close) * 1.003,
            "low": np.minimum(op, close) * .997, "close": close,
            "volume": rng.integers(10**8, 10**9, BARS),
        }))
    sdir = root / "screener"
    sdir.mkdir()
    pl.concat(rows).write_parquet(sdir / "daily_adjusted.parquet")
    return str(dates[-KEEP]).replace("-", "")


def measure(module, root, req):
    wall, cpu = time.perf_counter(), time.process_time()
    response = module.run_pattern_search(root, req)
    return response, {
        "wall_ms": (time.perf_counter() - wall) * 1000,
        "cpu_ms": (time.process_time() - cpu) * 1000,
    }


def main():
    with tempfile.TemporaryDirectory(prefix="hoga-pattern-comparison-") as temp:
        root = Path(temp)
        source = subprocess.check_output(
            ["git", "show", f"{BASE}:hoga/api/screener_pattern.py"], cwd=ROOT,
        )
        old_path = root / "baseline_pattern.py"
        old_path.write_bytes(source)
        spec = importlib.util.spec_from_file_location("hoga.api._benchmark_baseline", old_path)
        baseline = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = baseline
        spec.loader.exec_module(baseline)
        since = make_data(root)
        modules = {"before": baseline, "after": current}
        cases = []
        for structure in (False, True):
            req = PatternSearchRequest(
                code="000001", mode="history", timeframe="D", lengths=[15], flex_bars=2,
                ma_preset="short", since=since, top=100, min_tv_eok=50,
                exclude_etf=True, no_overlap=True, per_code=1, forward_days=20,
                struct_tolerance=2 if structure else None,
            )
            trials = {state: {name: [] for name in modules} for state in ("cold", "warm")}
            expected = None
            for state, repeats in (("cold", 3), ("warm", 7)):
                for repeat in range(repeats):
                    names = list(modules) if repeat % 2 == 0 else list(reversed(modules))
                    for name in names:
                        module = modules[name]
                        if state == "cold":
                            module.reset_cache()
                            gc.collect()
                        response, timing = measure(module, root, req)
                        trials[state][name].append(timing)
                        dumped = response.model_dump(mode="json")
                        if expected is None:
                            expected = dumped
                        assert_same(dumped, expected)
            cases.append({
                "request": req.model_dump(mode="json", by_alias=True),
                "responses_equal_except_elapsed_ms": True,
                "float_tolerance": {"absolute": 1e-8, "relative": 1e-8},
                "result_lengths": [r["length"] for r in expected["results"]],
                "median_ms": {
                    state: {name: {metric: statistics.median(t[metric] for t in ts)
                                   for metric in ("wall_ms", "cpu_ms")}
                            for name, ts in variants.items()}
                    for state, variants in trials.items()
                },
                "trials": trials,
            })
        print(json.dumps({
            "baseline_commit": BASE, "python": platform.python_version(),
            "numpy": np.__version__, "polars": pl.__version__,
            "symbols": SYMBOLS, "bars_per_symbol": BARS, "selected_tail_bars": KEEP,
            "seed": 20260905, "boundary": "run_pattern_search including model construction",
            "cold_definition": "empty application corpus cache; OS file cache retained",
            "excludes": ["process spawn", "worker queue", "HTTP", "browser"],
            "cases": cases,
        }, indent=2))


if __name__ == "__main__":
    main()
