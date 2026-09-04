"""GC 정지 프로브 — `hoga.api.gc_probe`.

이 프로브가 답해야 하는 질문은 하나다: **GC 가 몇 번, 얼마나 오래 앱을 멈추는가.**
2026-09-04 에 그 답을 손으로 구해야 했다(정지 순간의 스레드별 CPU 를 밖에서 측정).
여기 테스트는 그 측정이 앱 안에서 재현되는지, 그리고 비싼 조사가 **두 겹 게이트** 없이는
절대 돌지 않는지를 고정한다.
"""
from __future__ import annotations

import gc
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api import gc_probe
from hoga.api.app import create_app


@pytest.fixture(autouse=True)
def _no_leaked_callback():
    """테스트가 콜백을 남기면 다음 테스트의 수집마다 불린다 — 각 테스트 뒤에 뗀다."""
    before = list(gc.callbacks)
    yield
    gc_probe.uninstall()
    assert gc.callbacks == before, "gc.callbacks 에 잔여물이 남았다"


# ── env 해석 ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({}, gc_probe.DEFAULT_PAUSE_WARN_MS),                       # 미설정
        ({gc_probe.ENV_PAUSE_WARN_MS: "50"}, 50.0),
        ({gc_probe.ENV_PAUSE_WARN_MS: "0"}, 0.0),                   # 경고 끔
        ({gc_probe.ENV_PAUSE_WARN_MS: "나쁜값"}, gc_probe.DEFAULT_PAUSE_WARN_MS),
        ({gc_probe.ENV_PAUSE_WARN_MS: "-5"}, 0.0),                  # 음수는 0 으로
    ],
)
def test_pause_warn_ms_from_env(raw: dict, expected: float) -> None:
    assert gc_probe.pause_warn_ms_from_env(raw) == expected


def test_introspect_is_off_unless_explicitly_true() -> None:
    assert gc_probe.introspect_enabled({}) is False
    assert gc_probe.introspect_enabled({gc_probe.ENV_INTROSPECT_ENABLED: "1"}) is False
    assert gc_probe.introspect_enabled({gc_probe.ENV_INTROSPECT_ENABLED: "yes"}) is False
    assert gc_probe.introspect_enabled({gc_probe.ENV_INTROSPECT_ENABLED: " True "}) is True


# ── 정지 계측 ───────────────────────────────────────────────────────────────────

def test_recorder_times_a_generation_2_collection() -> None:
    rec = gc_probe.install(warn_ms=0)
    assert rec is not None
    gc.collect(2)
    snap = rec.snapshot()
    gen2 = snap["by_generation"]["2"]
    assert gen2["collections"] >= 1
    assert gen2["max_ms"] > 0, "정지 시간이 0 이면 계측이 안 붙은 것이다"
    assert gen2["last_at_ms"] > 0
    assert snap["thresholds"] == list(gc.get_threshold())


def test_recorder_ignores_a_stop_without_start() -> None:
    """수집 도중에 콜백이 붙으면 stop 만 본다 — 그 한 건이 음수 정지로 통계를 오염시키면
    전체가 못 쓰게 된다."""
    rec = gc_probe.GcPauseRecorder(warn_ms=0)
    rec("stop", {"generation": 2, "collected": 1, "uncollectable": 0})
    assert rec.snapshot()["by_generation"] == {}


def test_recorder_warns_only_over_threshold(caplog) -> None:
    rec = gc_probe.GcPauseRecorder(warn_ms=1_000_000)  # 실제 수집으로는 절대 못 넘는 값
    with caplog.at_level(logging.WARNING, logger="hoga.api.gc_probe"):
        rec("start", {})
        rec("stop", {"generation": 2, "collected": 3, "uncollectable": 0})
    assert rec.over_threshold == 0
    assert "gc_pause" not in caplog.text

    rec2 = gc_probe.GcPauseRecorder(warn_ms=0.0001)  # 어떤 수집이든 넘는 값
    with caplog.at_level(logging.WARNING, logger="hoga.api.gc_probe"):
        rec2("start", {})
        rec2("stop", {"generation": 2, "collected": 3, "uncollectable": 0})
    assert rec2.over_threshold == 1
    assert "hoga_perf gc_pause gen=2" in caplog.text


def test_install_is_idempotent_and_uninstall_removes_the_callback() -> None:
    before = len(gc.callbacks)
    first = gc_probe.install(warn_ms=0)
    assert len(gc.callbacks) == before + 1
    assert gc_probe.install(warn_ms=999) is first, "두 번 설치하면 콜백이 쌓인다"
    assert len(gc.callbacks) == before + 1
    gc_probe.uninstall()
    assert len(gc.callbacks) == before
    assert gc_probe.recorder() is None


def test_stats_snapshot_says_so_when_no_probe_is_installed() -> None:
    """빈 dict 는 '수집이 없었다' 와 '재고 있지 않다' 를 구별하지 못한다."""
    snap = gc_probe.stats_snapshot()
    assert snap["enabled"] is False
    assert snap["thresholds"] == list(gc.get_threshold())


# ── 객체 조사 ───────────────────────────────────────────────────────────────────

def test_introspect_counts_types_it_can_see() -> None:
    class _Marker:
        __slots__ = ("x",)

        def __init__(self) -> None:
            self.x = 1

    keep = [_Marker() for _ in range(500)]
    out = gc_probe.introspect_objects(top_n=200)
    assert out["total_tracked_objects"] > 0
    assert out["elapsed_ms"] >= 0
    counts = {row["type"]: row["count"] for row in out["top_types"]}
    assert counts.get("_Marker", 0) >= 500, "방금 만든 객체가 히스토그램에 없다"
    assert len(keep) == 500  # keep 를 살려 둔다(수집되면 위 단언이 무의미)


# ── /health 배선 ────────────────────────────────────────────────────────────────

def test_deep_health_carries_gc_counters(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path)) as client:
        gc.collect(2)
        body = client.get("/health?deep=1").json()
    section = body["gc"]
    assert section["enabled"] is True, "lifespan 이 프로브를 설치해야 한다"
    assert section["thresholds"] and "by_generation" in section
    assert "objects" not in section, "조사는 요청하지 않으면 돌지 않는다"


def test_shallow_health_has_no_gc_section(tmp_path: Path) -> None:
    """감독자가 무는 얕은 경로는 그대로 둔다 — 여기 무엇을 얹어도 폴링 비용이 된다."""
    with TestClient(create_app(tmp_path)) as client:
        body = client.get("/health").json()
    assert body.get("gc") is None


def test_object_introspection_needs_both_gates(tmp_path: Path, monkeypatch) -> None:
    """쿼리 파라미터만으로는 안 된다 — env 옵트인이 있어야 돈다. 거부는 **이유를 실어**
    돌려준다(조용히 빈 값을 주면 부른 쪽이 '객체 0개' 로 읽는다)."""
    with TestClient(create_app(tmp_path)) as client:
        refused = client.get("/health?deep=1&gc_objects=1").json()["gc"]
        assert "skipped" in refused["objects"]
        assert gc_probe.ENV_INTROSPECT_ENABLED in refused["objects"]["skipped"]

        monkeypatch.setenv(gc_probe.ENV_INTROSPECT_ENABLED, "true")
        allowed = client.get("/health?deep=1&gc_objects=1").json()["gc"]
    objects = allowed["objects"]
    assert objects["total_tracked_objects"] > 0
    assert objects["top_types"] and objects["distinct_types"] > 0


def test_lifespan_removes_the_probe_so_repeated_apps_do_not_stack_callbacks(
    tmp_path: Path,
) -> None:
    before = len(gc.callbacks)
    for _ in range(3):
        with TestClient(create_app(tmp_path)):
            assert len(gc.callbacks) == before + 1
        assert len(gc.callbacks) == before
