"""진단 도구도 실제 REST 파싱·stream 소비를 거쳐 지연과 실패를 구분해야 한다."""
from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest

from hoga.live import kiwoom_rest
from scripts import probe_kiwoom_http_latency as probe


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


class Body(httpx.AsyncByteStream):
    def __init__(self, request, clock, *, fail=False):
        self.request, self.clock, self.fail = request, clock, fail
        self.closed = False

    async def __aiter__(self):
        trace = self.request.extensions["trace"]
        await trace("http11.receive_response_body.started", {"secret": "DO-NOT-RECORD"})
        self.clock.now += 0.1
        yield b'{"return_code":0,"stk_min_pole_chart_qry":['
        self.clock.now += 8.5
        if self.fail:
            raise httpx.ReadTimeout("DO-NOT-RECORD")
        yield b'{"cntr_tm":"PRIVATE-MARKET-ROW"}]}'
        await trace("http11.receive_response_body.complete", {})

    async def aclose(self):
        self.closed = True


async def test_slow_body_is_detected_through_real_rest_call(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(probe, "perf_counter", clock)
    streams = []

    async def handler(request):
        assert request.headers["authorization"] == "Bearer BORROWED-SECRET"
        trace = request.extensions["trace"]
        await trace("http11.receive_response_headers.started", {})
        clock.now += 0.02
        await trace("http11.receive_response_headers.complete", {"secret": "DO-NOT-RECORD"})
        body = Body(request, clock)
        streams.append(body)
        return httpx.Response(200, stream=body)

    result = await probe.run_probe(
        "BORROWED-SECRET", "005930", "20260907", samples=1, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(handler),
    )
    assert result["verdict"] == "SLOW_REPRODUCED"
    row = result["samples"][0]
    assert row["total_ms"] == pytest.approx(8620)
    assert row["stages_ms"]["headers"] == pytest.approx(20)
    assert row["stages_ms"]["body"] == pytest.approx(8600)
    assert row["max_chunk_gap_ms"] == pytest.approx(8500)
    # The final synchronous stall must be counted even though no timer fires
    # before the response is fully consumed and the watcher is cancelled.
    assert row["loop_samples"] >= 1
    assert row["max_loop_lag_ms"] == pytest.approx(8610)
    assert row["rows"] == 1
    assert row["chunks"] == 2
    assert streams[0].closed
    assert all(secret not in json.dumps(result) for secret in (
        "BORROWED-SECRET", "PRIVATE-MARKET-ROW", "DO-NOT-RECORD",
    ))


@pytest.mark.parametrize("failure", ["auth", "rate", "read"])
async def test_error_stops_samples_without_refresh_or_retry(monkeypatch, caplog, failure):
    clock = Clock()
    monkeypatch.setattr(probe, "perf_counter", clock)
    calls = []
    streams = []

    def handler(request):
        calls.append(request)
        if failure == "read":
            body = Body(request, clock, fail=True)
            streams.append(body)
            return httpx.Response(200, stream=body)
        return httpx.Response(
            429 if failure == "rate" else 200,
            json={"return_code": 5 if failure == "rate" else 3,
                  "return_msg": "[8005:DO-NOT-RECORD]"},
        )

    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=3, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(handler),
    )
    assert result["verdict"] == "ERROR"
    assert len(calls) == len(result["samples"]) == 1
    assert result["samples"][0]["error"] == {
        "auth": "KiwoomAuthError", "rate": "KiwoomRateLimitError", "read": "KiwoomTransportError",
    }[failure]
    assert "DO-NOT-RECORD" not in json.dumps(result)
    assert "DO-NOT-RECORD" not in caplog.text
    assert all(stream.closed for stream in streams)
    kiwoom_rest.log.warning("ordinary-log-after-probe")
    assert "ordinary-log-after-probe" in caplog.text


async def test_fast_request_has_no_invented_transport_stages():
    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=1, pace_s=1.25,
        threshold_ms=1_000_000, transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"return_code": 0, "stk_min_pole_chart_qry": [{}]}),
        ),
    )
    assert result["verdict"] == "NOT_REPRODUCED"
    assert result["samples"][0]["stages_ms"] == {}


async def test_cancellation_closes_stream_and_probe_tasks():
    entered = asyncio.Event()
    closed = asyncio.Event()

    class WaitingBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            entered.set()
            await asyncio.Event().wait()
            yield b""

        async def aclose(self):
            closed.set()

    before = asyncio.all_tasks()
    filters_before = list(kiwoom_rest.log.filters)
    task = asyncio.create_task(probe.run_probe(
        "secret", "005930", "20260907", samples=1, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=WaitingBody())),
    ))
    await asyncio.wait_for(entered.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()
    assert asyncio.all_tasks() <= before
    assert kiwoom_rest.log.filters == filters_before


@pytest.mark.parametrize("extra", [
    ["--samples", "0"], ["--samples", "21"], ["--pace-s", "0"],
    ["--pace-s", "nan"], ["--assert-under-ms", "inf"],
    ["--date", "20261301"], ["--code", "not-a-code"],
    ["--date", "2026097"],
])
def test_cli_rejects_unbounded_or_invalid_input(extra):
    with pytest.raises(SystemExit) as exc:
        probe.parse_args(["--token-file", "/unused", "--code", "005930", "--date", "20260907", *extra])
    assert exc.value.code == 2


def test_token_file_is_read_only(tmp_path):
    path = tmp_path / "token.json"
    original = b'{"access_token":"borrowed", "expires_dt":"20260908000000"}'
    path.write_bytes(original)
    assert probe.read_token(path) == "borrowed"
    assert path.read_bytes() == original


async def test_empty_response_is_not_a_fast_success():
    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=3, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"return_code": 0, "stk_min_pole_chart_qry": []}),
        ),
    )
    assert result["verdict"] == "ERROR"
    assert len(result["samples"]) == 1
    assert result["samples"][0]["error"] == "EmptyResult"


@pytest.mark.parametrize("alias", ["same", "symlink", "hardlink"])
def test_output_cannot_overwrite_token_cache(tmp_path, alias):
    token = tmp_path / "token.json"
    token.write_text('{"access_token":"KEEP"}')
    output = tmp_path / "result.json"
    if alias == "symlink":
        output.symlink_to(token)
    elif alias == "hardlink":
        output.hardlink_to(token)
    else:
        output = token
    with pytest.raises(SystemExit) as exc:
        probe.parse_args([
            "--token-file", str(token), "--code", "005930", "--date", "20260907", "--out", str(output),
        ])
    assert exc.value.code == 2
    assert token.read_text() == '{"access_token":"KEEP"}'


async def test_real_httpcore_events_are_observed_over_local_socket():
    """MockTransport cannot prove the installed httpcore invokes the trace extension."""
    seen = asyncio.Event()

    async def serve(reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = next(int(line.split(b":", 1)[1]) for line in headers.split(b"\r\n")
                          if line.lower().startswith(b"content-length:"))
            await reader.readexactly(length)
            payload = b'{"return_code":0,"stk_min_pole_chart_qry":[{"cntr_tm":"1"}]}'
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(payload)).encode()
                         + b"\r\nConnection: close\r\n\r\n" + payload)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            seen.set()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    measured = probe._TraceTransport(httpx.AsyncHTTPTransport())
    measured.row = {"stages_ms": {}, "max_chunk_gap_ms": 0, "body_bytes": 0, "chunks": 0}
    client = probe.KiwoomRestClient(
        probe._BorrowedToken("local-fake"), base_url=f"http://127.0.0.1:{port}", transport=measured,
    )
    try:
        async with server:
            page = await client.call("ka10080", {"stk_cd": "005930", "tic_scope": "1", "upd_stkpc_tp": "0"})
            await asyncio.wait_for(seen.wait(), timeout=1)
        assert len(page.rows) == 1
        assert {"tcp", "send_headers", "send_body", "headers", "body"} <= measured.row["stages_ms"].keys()
        assert "tls" not in measured.row["stages_ms"], "plain HTTP must not invent a TLS timing"
        assert measured.row["body_bytes"] > 0
    finally:
        await client.aclose()
        server.close()
        await server.wait_closed()


@pytest.mark.parametrize("verdict,exit_code", [
    ("NOT_REPRODUCED", 0), ("SLOW_REPRODUCED", 1), ("ERROR", 2),
])
def test_cli_writes_evidence_and_returns_measurement_verdict(tmp_path, monkeypatch, capsys, verdict, exit_code):
    token = tmp_path / "token.json"
    original = '{"access_token":"BORROWED-SECRET"}'
    token.write_text(original)
    output = tmp_path / "evidence.json"
    result = {"verdict": verdict, "samples": [{"total_ms": 123}]}

    async def run(token_value, code, date, **kwargs):
        assert (token_value, code, date) == ("BORROWED-SECRET", "005930", "20260907")
        assert kwargs == {"samples": 2, "pace_s": 1.5, "threshold_ms": 500.0}
        return result

    monkeypatch.setattr(probe, "run_probe", run)
    assert probe.main([
        "--token-file", str(token), "--code", "005930", "--date", "20260907",
        "--samples", "2", "--pace-s", "1.5", "--assert-under-ms", "500", "--out", str(output),
    ]) == exit_code
    stdout = capsys.readouterr().out
    assert json.loads(stdout) == json.loads(output.read_text()) == result
    assert "BORROWED-SECRET" not in stdout
    assert token.read_text() == original


@pytest.mark.parametrize("payload,error", [
    (None, "FileNotFoundError"), ("PRIVATE-MALFORMED", "JSONDecodeError"),
    ('{"access_token":123}', "ValueError"), ("[]", "ValueError"),
])
def test_cli_token_read_errors_do_not_issue_requests(tmp_path, monkeypatch, capsys, payload, error):
    token = tmp_path / "token.json"
    if payload is not None:
        token.write_text(payload)

    def unexpected_request(*args, **kwargs):
        pytest.fail("invalid token cache must fail before any request")

    monkeypatch.setattr(probe, "run_probe", unexpected_request)
    assert probe.main([
        "--token-file", str(token), "--code", "005930", "--date", "20260907",
    ]) == 2
    assert json.loads(capsys.readouterr().out) == {"verdict": "ERROR", "error": error}
    if payload is not None:
        assert token.read_text() == payload


@pytest.mark.parametrize("failure", ["parent_missing", "file_appears_during_probe"])
def test_cli_output_failure_preserves_evidence_on_stdout(tmp_path, monkeypatch, capsys, failure):
    token = tmp_path / "token.json"
    token.write_text('{"access_token":"SECRET"}')
    output = tmp_path / "missing" / "result.json" if failure == "parent_missing" else tmp_path / "result.json"
    result = {"verdict": "NOT_REPRODUCED", "samples": [{"total_ms": 10}]}

    async def run(*args, **kwargs):
        if failure == "file_appears_during_probe":
            output.write_text("KEEP-EXISTING")
        return result

    monkeypatch.setattr(probe, "run_probe", run)
    assert probe.main([
        "--token-file", str(token), "--code", "005930", "--date", "20260907", "--out", str(output),
    ]) == 2
    stdout = capsys.readouterr().out
    evidence, position = json.JSONDecoder().raw_decode(stdout)
    error = json.loads(stdout[position:])
    assert evidence == result
    assert error == {"verdict": "ERROR", "error": (
        "FileNotFoundError" if failure == "parent_missing" else "FileExistsError"
    )}
    if failure == "file_appears_during_probe":
        assert output.read_text() == "KEEP-EXISTING"


async def test_deadline_stops_probe_and_closes_transport(monkeypatch):
    real_timeout = asyncio.timeout
    deadlines = []

    def controlled_deadline(seconds):
        assert seconds == 30
        deadline = real_timeout(None)
        deadlines.append(deadline)
        return deadline

    monkeypatch.setattr(probe.asyncio, "timeout", controlled_deadline)

    class WaitingTransport(httpx.AsyncBaseTransport):
        calls = 0
        closed = False

        async def handle_async_request(self, request):
            self.calls += 1
            deadlines[0].reschedule(asyncio.get_running_loop().time())
            await asyncio.Future()

        async def aclose(self):
            self.closed = True

    transport = WaitingTransport()
    before = asyncio.all_tasks()
    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=3, pace_s=1.25,
        threshold_ms=1000, transport=transport,
    )
    assert result["verdict"] == "ERROR"
    assert len(result["samples"]) == transport.calls == 1
    assert result["samples"][0]["error"] == "TimeoutError"
    assert transport.closed
    assert asyncio.all_tasks() <= before


async def test_sequential_samples_reuse_transport_pace_after_response_and_keep_slow_verdict(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(probe, "perf_counter", clock)
    real_sleep = asyncio.sleep
    events = []

    async def sleep(delay):
        if delay:
            events.append(("pace", clock.now, delay))
            clock.now += delay
        await real_sleep(0)

    async def watcher(row):
        await asyncio.Future()

    class Payload(httpx.AsyncByteStream):
        def __init__(self, rows):
            self.rows = rows

        async def __aiter__(self):
            yield json.dumps({"return_code": 0, "stk_min_pole_chart_qry": [{}] * self.rows}).encode()

    class SequentialTransport(httpx.AsyncBaseTransport):
        calls = 0
        closes = 0

        async def handle_async_request(self, request):
            self.calls += 1
            events.append(("request", clock.now))
            trace = request.extensions["trace"]
            await trace("http11.receive_response_headers.started", {})
            clock.now += 2 if self.calls == 1 else 0.05
            await trace("http11.receive_response_headers.complete", {})
            return httpx.Response(200, stream=Payload(self.calls))

        async def aclose(self):
            self.closes += 1

    monkeypatch.setattr(probe.asyncio, "sleep", sleep)
    monkeypatch.setattr(probe, "_watch_loop", watcher)
    transport = SequentialTransport()
    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=2, pace_s=1.25,
        threshold_ms=1000, transport=transport,
    )
    assert events == [("request", 0), ("pace", 2, 1.25), ("request", 3.25)]
    assert transport.calls == 2
    assert transport.closes == 1
    assert result["verdict"] == "SLOW_REPRODUCED"
    first, second = result["samples"]
    assert [first["rows"], second["rows"]] == [1, 2]
    assert [first["total_ms"], second["total_ms"]] == pytest.approx([2000, 50])
    assert first["stages_ms"] == {"headers": pytest.approx(2000)}
    assert second["stages_ms"] == {"headers": pytest.approx(50)}
    assert second["body_bytes"] > first["body_bytes"] > 0


def test_cli_without_output_file_prints_evidence(tmp_path, monkeypatch, capsys):
    token = tmp_path / "token.json"
    token.write_text('{"access_token":"SECRET"}')

    async def run(*args, **kwargs):
        return {"verdict": "NOT_REPRODUCED", "samples": []}

    monkeypatch.setattr(probe, "run_probe", run)
    assert probe.main([
        "--token-file", str(token), "--code", "005930", "--date", "20260907",
    ]) == 0
    assert json.loads(capsys.readouterr().out) == {"verdict": "NOT_REPRODUCED", "samples": []}
    assert list(tmp_path.iterdir()) == [token]


async def test_loop_watcher_counts_samples_and_keeps_maximum_lag(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(probe, "perf_counter", clock)
    delays = iter([0.04, 0.005, None])

    async def sleep(interval):
        assert interval == 0.01
        elapsed = next(delays)
        if elapsed is None:
            raise asyncio.CancelledError
        clock.now += elapsed

    monkeypatch.setattr(probe.asyncio, "sleep", sleep)
    row = {"loop_samples": 0, "max_loop_lag_ms": None}
    with pytest.raises(asyncio.CancelledError):
        await probe._watch_loop(row)
    assert row["loop_samples"] == 2
    assert row["max_loop_lag_ms"] == pytest.approx(30)


async def test_trace_ignores_unmatched_events_and_sums_retried_stages(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(probe, "perf_counter", clock)

    async def handler(request):
        trace = request.extensions["trace"]
        await trace("connection.connect_tcp.complete", {"secret": "SECRET"})
        await trace("connection.connect_tcp.started", {})
        clock.now += 0.1
        await trace("connection.connect_tcp.failed", {})
        await trace("connection.connect_tcp.started", {})
        clock.now += 0.2
        await trace("connection.connect_tcp.complete", {})
        await trace("unknown.payload.started", {"secret": "SECRET"})
        return httpx.Response(200, json={"return_code": 0, "stk_min_pole_chart_qry": [{}]})

    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=1, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(handler),
    )
    assert result["samples"][0]["stages_ms"] == {"tcp": pytest.approx(300)}
    assert "SECRET" not in json.dumps(result)


@pytest.mark.parametrize("payload", [[], None])
async def test_invalid_top_level_json_stops_with_structured_error_and_closes_transport(payload):
    class MalformedTransport(httpx.AsyncBaseTransport):
        calls = 0
        closed = False

        async def handle_async_request(self, request):
            self.calls += 1
            return httpx.Response(200, content=json.dumps(payload))

        async def aclose(self):
            self.closed = True

    transport = MalformedTransport()
    before = asyncio.all_tasks()
    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=3, pace_s=1.25,
        threshold_ms=1000, transport=transport,
    )
    assert result["verdict"] == "ERROR"
    assert len(result["samples"]) == transport.calls == 1
    assert result["samples"][0]["error"] == "AttributeError"
    assert transport.closed
    assert asyncio.all_tasks() <= before


@pytest.mark.parametrize("logger_name", ["hoga.live.kiwoom_rest", "httpcore.http11", "httpx"])
async def test_probe_log_filter_preserves_unrelated_task_logs(caplog, logger_name):
    entered = asyncio.Event()
    release = asyncio.Event()
    logger = logging.getLogger(logger_name)
    caplog.set_level(logging.DEBUG, logger=logger_name)
    filters_before = list(logger.filters)

    async def handler(request):
        entered.set()
        await release.wait()
        logger.debug("send_request_headers.failed exception=%r", httpx.LocalProtocolError("PRIVATE-TOKEN-DETAIL"))
        raise httpx.ReadTimeout("PRIVATE-TRANSPORT-DETAIL")

    task = asyncio.create_task(probe.run_probe(
        "secret", "005930", "20260907", samples=1, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(handler),
    ))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        logger.debug("unrelated-task-during-probe")
    finally:
        release.set()
        result = await task
    assert result["verdict"] == "ERROR"
    assert "unrelated-task-during-probe" in caplog.text
    assert "PRIVATE-TRANSPORT-DETAIL" not in caplog.text
    assert "PRIVATE-TOKEN-DETAIL" not in caplog.text
    assert logger.filters == filters_before


@pytest.mark.parametrize("rows", [[None], [123]])
async def test_non_object_rows_stop_with_invalid_rows_error(rows):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"return_code": 0, "stk_min_pole_chart_qry": rows})

    result = await probe.run_probe(
        "secret", "005930", "20260907", samples=3, pace_s=1.25,
        threshold_ms=1000, transport=httpx.MockTransport(handler),
    )
    assert result["verdict"] == "ERROR"
    assert len(result["samples"]) == len(calls) == 1
    assert result["samples"][0]["error"] == "InvalidRows"
