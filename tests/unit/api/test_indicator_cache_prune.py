"""`hoga.api.indicator_cache_prune` — 죽은 버전 지표 캐시 정리."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.indicator_cache_prune import kind_of, prune
from hoga.api.past_indicators_cache import KIND_VERSIONS


def _write(data_dir: Path, name: str, version: int) -> Path:
    d = data_dir / "kis-past-indicators" / "005930" / "hogaplay"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text(json.dumps({"version": version, "fetched_at_ms": 0, "value": {}}),
                 encoding="utf-8")
    return p


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("20260826.ask_peak.60000.json", "ask_peak"),
        ("20260826.peak_rep.json", "peak_rep"),
        ("20260826.continuous_before.153000000.json", "continuous_before"),
        # ⚠ 파일명 접두 ≠ KIND_VERSIONS 키. 이 두 줄이 실측 결함의 회귀 가드다 —
        # 매핑이 없으면 27,312개가 "모르는 kind" 로 새어 나가 영영 안 지워졌다.
        ("20260826.trade_volume_poc.10.100.200.json", "poc"),
        ("20260826.volume_distribution.10.100.200.json", "vdist"),
        # 규약 밖(날짜 자리가 8자리 숫자가 아님)
        ("meta.json", None),
        ("notadate.ask_peak.60000.json", None),
    ],
)
def test_kind_of_maps_filename_to_version_key(filename: str, expected: str | None) -> None:
    assert kind_of(filename) == expected


def test_prune_removes_only_older_versions(tmp_path: Path) -> None:
    """낮은 버전만 지운다 — 현재는 물론 **더 높은 버전도 남긴다**.

    **막는 방향**: `!=` 로 비교하는 것. 더 새 코드가 쓴 파일을 지우면 롤백했을 때
    되살릴 수 없다. "모르는 것은 남긴다" 가 이 도구의 규약이다.
    """
    cur = KIND_VERSIONS["ask_peak"]
    old = _write(tmp_path, "20260101.ask_peak.60000.json", cur - 1)
    same = _write(tmp_path, "20260102.ask_peak.60000.json", cur)
    newer = _write(tmp_path, "20260103.ask_peak.60000.json", cur + 1)

    res = prune(tmp_path, dry_run=False)

    assert res.stale == 1
    assert res.deleted == 1
    assert not old.exists()
    assert same.exists() and newer.exists()


def test_prune_counts_poc_and_vdist_through_the_filename_map(tmp_path: Path) -> None:
    """`poc`/`vdist` 는 파일명 접두가 kind 키와 달라 매핑을 타야 한다.

    **막는 방향**: 매핑을 지우는 것 — 그러면 이 둘이 `unknown_kind` 로 빠져 계속
    쌓인다(조용한 실패라 용량으로만 드러난다).
    """
    _write(tmp_path, "20260101.trade_volume_poc.10.100.200.json", KIND_VERSIONS["poc"] - 1)
    _write(tmp_path, "20260101.volume_distribution.10.100.200.json", KIND_VERSIONS["vdist"] - 1)

    res = prune(tmp_path, dry_run=True)

    assert res.stale == 2
    assert res.unknown_kind == 0


def test_prune_removes_retired_kinds_regardless_of_version(tmp_path: Path) -> None:
    """지표째 제거된 kind 는 버전과 무관하게 전량 대상이다.

    `wall_surge` 는 2026-08-26 에 지표가 사라져 **어떤 읽기 경로도 열지 않는다**.
    버전 비교로는 잡히지 않는다(그 kind 의 현재 버전이라는 것이 없다).
    """
    p = _write(tmp_path, "20260101.wall_surge.60000.json", 99)

    res = prune(tmp_path, dry_run=False)

    assert res.retired == 1
    assert res.stale == 0
    assert not p.exists()


def test_prune_dry_run_deletes_nothing(tmp_path: Path) -> None:
    """기본은 세기만 한다 — 규모를 보고 결정할 수 있어야 한다."""
    p = _write(tmp_path, "20260101.ask_peak.60000.json", KIND_VERSIONS["ask_peak"] - 1)

    res = prune(tmp_path, dry_run=True)

    assert res.stale == 1
    assert res.deleted == 0
    assert res.bytes_freed > 0
    assert p.exists()


def test_prune_leaves_unparseable_and_unknown_files(tmp_path: Path) -> None:
    """읽을 수 없거나 모르는 kind 는 **남긴다** — 증명 못 한 것은 지우지 않는다."""
    d = tmp_path / "kis-past-indicators" / "005930" / "hogaplay"
    d.mkdir(parents=True)
    broken = d / "20260101.ask_peak.60000.json"
    broken.write_text("{ not json", encoding="utf-8")
    unknown = d / "20260101.some_future_kind.json"
    unknown.write_text(json.dumps({"version": 1}), encoding="utf-8")

    res = prune(tmp_path, dry_run=False)

    assert res.unreadable == 1
    assert res.unknown_kind == 1
    assert res.deleted == 0
    assert broken.exists() and unknown.exists()


def test_prune_on_missing_root_is_a_noop(tmp_path: Path) -> None:
    res = prune(tmp_path, dry_run=False)
    assert (res.scanned, res.stale, res.deleted) == (0, 0, 0)
