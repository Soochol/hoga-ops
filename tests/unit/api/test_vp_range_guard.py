"""build_volume_profile_range가 RANGE_PROFILE_GUARD.run을 경유하는지 잠근다.

가드 자체의 세마포어/single-flight 동작은 test_peak_slice_guard.py가 커버하므로,
여기서는 '경유' 사실만 spy로 검증한다 — 가드를 우회한 직접 호출이 재도입되면 red.
"""
import hoga.api.bundle as bundle_mod


def test_vp_range_routes_through_guard(tmp_path, monkeypatch):
    calls: list[object] = []

    real_run = bundle_mod.RANGE_PROFILE_GUARD.run

    def spy_run(key, compute):
        calls.append(key)
        return real_run(key, compute)

    monkeypatch.setattr(bundle_mod.RANGE_PROFILE_GUARD, "run", spy_run)

    # 파일이 하나도 없으면 가드 진입 전에 빈 프로파일로 단락되므로,
    # 최소 1개의 실제 parquet가 있어야 가드 경유를 관찰할 수 있다.
    import duckdb

    d = tmp_path / "20260701" / "005930" / "kis_live"
    d.mkdir(parents=True)
    con = duckdb.connect()
    con.execute(
        "COPY (SELECT 1000 AS price, 10 AS qty, 1 AS side, 90000000 AS ts_ms) "
        f"TO '{d / 'trades.parquet'}' (FORMAT PARQUET)"
    )

    class FakeEngine:
        conn = con

        def parquet_dir(self, date, code, source):
            return tmp_path / date / code / source

    profile = bundle_mod.build_volume_profile_range(
        FakeEngine(),
        code="005930",
        dates_with_sources=[("20260701", "kis_live")],
    )
    assert profile.bin_count == 24
    assert len(calls) == 1
    assert calls[0][0] == "vp_range"
