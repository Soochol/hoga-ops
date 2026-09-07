"""Read-only, bounded ka10080 latency probe using the real KiwoomRestClient.

Run from the repository root: uv run python -m scripts.probe_kiwoom_http_latency
  --token-file <existing-token-cache.json> --code 005930 --date 20260907
  --samples 6 --out /tmp/kiwoom-http.json

No credential loading, token issuance/refresh/invalidation, WS, or candle-cache writes.
Requests share a connection pool and wait >=1.25s AFTER each completed request. This
isolated pacing is not the running application's capacity scheduler. Exit 0 means the
threshold was not exceeded, 1 means slow requests, 2 means an error (stop immediately).
Only timings, sizes and error class names are retained; never trace callback payloads.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import datetime as dt
import json
import logging
import math
import re
from contextvars import ContextVar
from pathlib import Path
from time import perf_counter
from typing import Any

import httpx

from hoga.live import kiwoom_http
from hoga.live.kiwoom_rest import KiwoomRestClient, log as rest_log

_MIN_PACE_S = 1.25
_MAX_SAMPLES = 20
_REQUEST_DEADLINE_S = 30
_LOOP_INTERVAL_S = 0.01
_PROBE_LOG_SCOPE: ContextVar[bool] = ContextVar("kiwoom_latency_probe", default=False)
_STAGES = {
    "connection.connect_tcp": "tcp",
    "connection.start_tls": "tls",
    "http11.send_request_headers": "send_headers",
    "http11.send_request_body": "send_body",
    "http11.receive_response_headers": "headers",
    "http11.receive_response_body": "body",
}


def read_token(path: Path) -> str:
    payload = json.loads(path.read_text())
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise ValueError("cached token unavailable")
    return token


class _BorrowedToken:
    def __init__(self, token: str):
        self._token = token

    def get_token(self) -> str:
        return self._token


class _ProbeLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not _PROBE_LOG_SCOPE.get()


@contextlib.contextmanager
def _quiet_transport_logs():
    """REST warnings include exception text; only the probe's safe result is emitted.

    Context-local filtering leaves unrelated calls in other tasks/threads untouched.
    """
    guard = _ProbeLogFilter()
    token = _PROBE_LOG_SCOPE.set(True)
    # Parent logger filters do not filter descendant records. HTTPX/httpcore have
    # loaded their concrete loggers by the time this call's client is constructed.
    loggers = [rest_log, *(
        logger for name, logger in list(logging.root.manager.loggerDict.items())
        if isinstance(logger, logging.Logger) and (name == "httpx" or name.startswith("httpcore."))
    )]
    for logger in loggers:
        logger.addFilter(guard)
    try:
        yield
    finally:
        for logger in loggers:
            logger.removeFilter(guard)
        _PROBE_LOG_SCOPE.reset(token)


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, inner: httpx.AsyncByteStream, row: dict[str, Any]):
        self.inner, self.row = inner, row

    async def __aiter__(self):
        previous = perf_counter()
        async for chunk in self.inner:
            now = perf_counter()
            self.row["max_chunk_gap_ms"] = max(self.row["max_chunk_gap_ms"], (now - previous) * 1000)
            self.row["body_bytes"] += len(chunk)
            self.row["chunks"] += 1
            previous = now
            yield chunk

    async def aclose(self):
        await self.inner.aclose()


class _TraceTransport(httpx.AsyncBaseTransport):
    """One sequential probe owns this pool. A fresh record is installed per request."""

    def __init__(self, inner: httpx.AsyncBaseTransport):
        self.inner = inner
        self.row: dict[str, Any] = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        row = self.row
        started: dict[str, float] = {}

        async def trace(name: str, _info: dict) -> None:
            event, _, phase = name.rpartition(".")
            if event not in _STAGES:
                return
            now = perf_counter()
            if phase == "started":
                started[event] = now
            elif phase in ("complete", "failed") and event in started:
                stage = _STAGES[event]
                elapsed = (now - started.pop(event)) * 1000
                # Connection retries can emit the same stage more than once.
                row["stages_ms"][stage] = row["stages_ms"].get(stage, 0) + elapsed

        request.extensions["trace"] = trace
        response = await self.inner.handle_async_request(request)
        row["status"] = response.status_code
        response.stream = _ChunkStream(response.stream, row)
        return response

    async def aclose(self):
        await self.inner.aclose()


async def _watch_loop(row: dict[str, Any]) -> None:
    while True:
        before = perf_counter()
        row["_loop_expected_at"] = before + _LOOP_INTERVAL_S
        await asyncio.sleep(_LOOP_INTERVAL_S)
        lag = max(0, (perf_counter() - before - _LOOP_INTERVAL_S) * 1000)
        row["loop_samples"] += 1
        row["max_loop_lag_ms"] = max(row["max_loop_lag_ms"] or 0, lag)


async def run_probe(
    token: str, code: str, date: str, *, samples: int, pace_s: float, threshold_ms: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    measured = _TraceTransport(transport if transport is not None else kiwoom_http.async_transport())
    client = KiwoomRestClient(_BorrowedToken(token), transport=measured)
    result: dict[str, Any] = {
        "code": code, "date": date, "api_id": "ka10080", "requested_samples": samples,
        "pace_after_response_s": pace_s, "threshold_ms": threshold_ms,
        "keepalive_s": kiwoom_http.keepalive_s(), "samples": [], "verdict": "NOT_REPRODUCED",
        "started_at": dt.datetime.now(dt.UTC).isoformat(),
    }
    try:
        for index in range(samples):
            if index:
                await asyncio.sleep(pace_s)
            row: dict[str, Any] = {
                "sample": index + 1, "stages_ms": {}, "status": None,
                "body_bytes": 0, "chunks": 0, "max_chunk_gap_ms": 0,
                "loop_samples": 0, "max_loop_lag_ms": None,
            }
            measured.row = row
            watcher = asyncio.create_task(_watch_loop(row))
            start = perf_counter()
            try:
                # Keep startup inside finally's scope so cancellation cannot leak the watcher.
                await asyncio.sleep(0)
                async with asyncio.timeout(_REQUEST_DEADLINE_S):
                    with _quiet_transport_logs():
                        page = await client.call("ka10080", {
                            "stk_cd": code, "base_dt": date, "tic_scope": "1", "upd_stkpc_tp": "0",
                        })
                row["rows"] = len(page.rows)
                if not page.rows:
                    row["error"] = "EmptyResult"
                    result["verdict"] = "ERROR"
                elif any(not isinstance(item, dict) for item in page.rows):
                    row["error"] = "InvalidRows"
                    result["verdict"] = "ERROR"
            except Exception as exc:  # noqa: BLE001 — diagnostics return ERROR without unsafe exception text
                row["error"] = type(exc).__name__
                result["verdict"] = "ERROR"
            finally:
                finished = perf_counter()
                row["total_ms"] = (finished - start) * 1000
                # The final chunk/JSON parse can block until completion without
                # yielding to an overdue watcher. Count that interval before cancelling.
                expected = row.pop("_loop_expected_at", None)
                if expected is not None and finished >= expected:
                    row["loop_samples"] += 1
                    lag = (finished - expected) * 1000
                    row["max_loop_lag_ms"] = max(row["max_loop_lag_ms"] or 0, lag)
                watcher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watcher
                result["samples"].append(row)
            if result["verdict"] == "ERROR":
                break
            if row["total_ms"] > threshold_ms:
                result["verdict"] = "SLOW_REPRODUCED"
    finally:
        await client.aclose()
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--code", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--samples", type=int, default=6)
    parser.add_argument("--pace-s", type=float, default=_MIN_PACE_S)
    parser.add_argument("--assert-under-ms", type=float, default=1000)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.samples <= _MAX_SAMPLES:
        parser.error(f"--samples must be between 1 and {_MAX_SAMPLES}")
    if not math.isfinite(args.pace_s) or args.pace_s < _MIN_PACE_S:
        parser.error(f"--pace-s must be finite and >= {_MIN_PACE_S}")
    if not math.isfinite(args.assert_under_ms) or args.assert_under_ms <= 0:
        parser.error("--assert-under-ms must be finite and positive")
    if not re.fullmatch(r"[0-9]{6}", args.code):
        parser.error("--code must contain six digits")
    try:
        if not re.fullmatch(r"[0-9]{8}", args.date):
            raise ValueError("date format")
        dt.datetime.strptime(args.date, "%Y%m%d")
    except ValueError:
        parser.error("--date must be a valid YYYYMMDD date")
    if args.out is not None and args.out.resolve() == args.token_file.resolve():
        parser.error("--out must differ from --token-file")
    if args.out is not None and args.out.exists():
        parser.error("--out already exists; choose a new evidence file")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        token = read_token(args.token_file)
    except (OSError, ValueError) as exc:
        print(json.dumps({"verdict": "ERROR", "error": type(exc).__name__}))
        return 2
    result = asyncio.run(run_probe(
        token, args.code, args.date, samples=args.samples, pace_s=args.pace_s,
        threshold_ms=args.assert_under_ms,
    ))
    rendered = json.dumps(result, indent=2)
    if args.out is not None:
        # Exclusive create also prevents overwriting a token through a hard link.
        try:
            with args.out.open("x") as output:
                output.write(rendered + "\n")
        except OSError as exc:
            print(rendered)
            print(json.dumps({"verdict": "ERROR", "error": type(exc).__name__}))
            return 2
    print(rendered)
    return {"NOT_REPRODUCED": 0, "SLOW_REPRODUCED": 1, "ERROR": 2}[result["verdict"]]


if __name__ == "__main__":
    raise SystemExit(main())
