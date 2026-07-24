import json

import pytest

from tools.bench_live_buffer import build_parser, main, run_benchmark


def test_small_benchmark_returns_stable_schema() -> None:
    result = run_benchmark(
        codes=2,
        ticks_per_code=3,
        levels=2,
        retention_ms=1_000_000,
    )

    assert result["entries"] == 6
    assert result["codes"] == 2
    assert result["published_total"] == 6
    assert result["elapsed_ms"] >= 0
    assert result["tracemalloc_peak_bytes"] > 0
    assert result["max_rss_bytes"] > 0


def test_benchmark_reports_live_buffer_current_memory() -> None:
    result = run_benchmark(
        codes=4,
        ticks_per_code=20,
        levels=10,
        retention_ms=1_000_000,
    )

    assert result["tracemalloc_current_bytes"] > 100_000


@pytest.mark.parametrize(
    ("option", "value"),
    [
        ("--codes", "0"),
        ("--ticks-per-code", "-1"),
        ("--levels", "0"),
        ("--retention-ms", "-1"),
    ],
)
def test_cli_rejects_non_positive_configuration(option: str, value: str) -> None:
    args = [
        "--codes",
        "1",
        "--ticks-per-code",
        "1",
        "--levels",
        "1",
        "--retention-ms",
        "1",
    ]
    args[args.index(option) + 1] = value

    with pytest.raises(SystemExit) as exc:
        build_parser().parse_args(args)

    assert exc.value.code == 2


def test_cli_prints_one_json_result(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        "sys.argv",
        [
            "bench_live_buffer.py",
            "--codes",
            "1",
            "--ticks-per-code",
            "1",
            "--levels",
            "1",
            "--retention-ms",
            "1",
        ],
    )

    main()

    stdout_lines = capsys.readouterr().out.splitlines()
    assert len(stdout_lines) == 1
    assert json.loads(stdout_lines[0])["published_total"] == 1
