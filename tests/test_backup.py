"""hoga.backup — 백업/복원 단위 테스트.

백업 테스트의 핵심은 "돌았다"가 아니라 **"잃었을 때 되찾을 수 있나"** 다. 그래서
마지막 테스트는 원본을 통째로 지우고 백업본만으로 복원해 바이트 단위로 비교한다.
"""
from __future__ import annotations

import datetime as dt
import json
import tarfile
from pathlib import Path

import pytest
from typer.testing import CliRunner

from hoga.backup import measure_backup, resolve_backup_dest, run_backup, verify_backup
from hoga.cli import app

_runner = CliRunner()

_PARQUET_BYTES = b"PAR1" + b"\x00" * 40 + b"PAR1"


def _make_data_dir(tmp: Path) -> Path:
    """실제 레이아웃(ADR-0037)을 축소 재현한 data_dir."""
    d = tmp / "data"
    # T0 사용자 상태
    (d).mkdir(parents=True)
    (d / "watchlist.json").write_text(json.dumps({"v": 3, "codes": ["005930"]}), encoding="utf-8")
    (d / "heatmap.json").write_text(json.dumps({"groups": []}), encoding="utf-8")
    (d / "live_settings.json").write_text(json.dumps({"kiwoom_enabled": True}), encoding="utf-8")
    (d / "study_views").mkdir()
    (d / "study_views" / "saves.json").write_text(json.dumps({"saves": []}), encoding="utf-8")
    (d / "screener").mkdir()
    (d / "screener" / "saves.json").write_text(json.dumps({"saves": []}), encoding="utf-8")
    (d / ".layout_v2").write_text("", encoding="utf-8")

    # T1 시장 데이터
    src = d / "parquet" / "20260730" / "005930" / "kiwoom_live"
    src.mkdir(parents=True)
    (src / "snapshots.parquet").write_bytes(_PARQUET_BYTES)
    (src / "meta.json").write_text(json.dumps({"code": "005930"}), encoding="utf-8")
    (d / "screener" / "daily_adjusted.parquet").write_bytes(_PARQUET_BYTES)

    # 제외 대상: 자격증명·스필·락
    (d / ".local").mkdir()
    (d / ".local" / "kis-token.json").write_text('{"access_token":"SECRET"}', encoding="utf-8")
    (d / "duckdb-tmp").mkdir()
    (d / "duckdb-tmp" / "spill.tmp").write_bytes(b"x" * 100)
    (d / ".queue.lock").write_text("12345", encoding="utf-8")

    # 옵트인 대상
    raw = d / "raw" / "20260730" / "005930"
    raw.mkdir(parents=True)
    (raw / "first_00001.tsv").write_text("1\t2\t3\n", encoding="utf-8")
    live = d / "live_kiwoom" / "20260730"
    live.mkdir(parents=True)
    (live / "005930.jsonl").write_text('{"kind":"trade"}\n', encoding="utf-8")
    return d


def test_backup_captures_state_and_market(tmp_path: Path) -> None:
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"

    result = run_backup(data_dir, dest)

    assert result.state_archive is not None
    assert result.state_archive.exists()
    # parquet 2개 + meta.json 1개 = 3 (screener/saves.json 은 상태 아카이브가 담는다)
    assert result.copied_files == 3
    assert (dest / "market" / "parquet" / "20260730" / "005930" / "kiwoom_live"
            / "snapshots.parquet").read_bytes() == _PARQUET_BYTES
    assert (dest / "MANIFEST.json").exists()


def test_secrets_and_spill_are_never_backed_up(tmp_path: Path) -> None:
    """백업본이 유출되면 실전투자 앱키가 함께 나간다 — 담지 않는 것이 유일한 방어다."""
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"

    run_backup(data_dir, dest, include_raw=True, include_live=True)

    everything = [p for p in dest.rglob("*") if p.is_file()]
    blob = b"".join(p.read_bytes() for p in everything)
    assert b"SECRET" not in blob
    assert not any(".local" in str(p) for p in everything)
    assert not any("duckdb-tmp" in str(p) for p in everything)
    assert not any(p.name == ".queue.lock" for p in everything)

    # 상태 아카이브 **안**도 확인한다 — tar 필터가 없으면 여기로 새어 들어온다.
    with tarfile.open(dest / "state" / next(
        p.name for p in (dest / "state").iterdir() if p.name.startswith("state-")
    ), "r:gz") as tar:
        names = tar.getnames()
    assert not any(".local" in n or "token" in n for n in names)


def test_raw_and_live_are_opt_in(tmp_path: Path) -> None:
    """용량이 지배적이라(raw 실측 351GB) 기본 제외다 — 켜야만 담긴다."""
    data_dir = _make_data_dir(tmp_path)

    off = run_backup(data_dir, tmp_path / "b1")
    assert not (tmp_path / "b1" / "market" / "raw").exists()
    assert not (tmp_path / "b1" / "market" / "live_kiwoom").exists()

    on = run_backup(data_dir, tmp_path / "b2", include_raw=True, include_live=True)
    assert (tmp_path / "b2" / "market" / "raw" / "20260730" / "005930"
            / "first_00001.tsv").exists()
    assert (tmp_path / "b2" / "market" / "live_kiwoom" / "20260730" / "005930.jsonl").exists()
    assert on.copied_files > off.copied_files


def test_second_run_is_incremental(tmp_path: Path) -> None:
    """파티션이 불변이라 두 번째 실행은 아무것도 복사하지 않아야 한다."""
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"

    first = run_backup(data_dir, dest)
    second = run_backup(data_dir, dest)

    assert second.copied_files == 0
    assert second.skipped_files == first.copied_files

    # 새 거래일이 생기면 그것만 복사한다.
    new_day = data_dir / "parquet" / "20260731" / "005930" / "kiwoom_live"
    new_day.mkdir(parents=True)
    (new_day / "snapshots.parquet").write_bytes(_PARQUET_BYTES)
    third = run_backup(data_dir, dest)
    assert third.copied_files == 1


def test_mirror_never_deletes_what_source_pruned(tmp_path: Path) -> None:
    """원본의 prune(raw 3일·archive 7일)이 백업으로 전파되면 백업이 아니다."""
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"
    run_backup(data_dir, dest)

    mirrored = dest / "market" / "parquet" / "20260730" / "005930" / "kiwoom_live"
    assert mirrored.exists()

    # 원본에서 그 거래일이 통째로 사라졌다(디스크 사고 또는 오삭제).
    import shutil as _sh
    _sh.rmtree(data_dir / "parquet" / "20260730")
    run_backup(data_dir, dest)

    assert (mirrored / "snapshots.parquet").read_bytes() == _PARQUET_BYTES


def test_state_snapshots_are_generational(tmp_path: Path) -> None:
    """오삭제·손상은 시간을 거슬러야 복구된다 — 미러 하나로는 안 된다."""
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"
    base = dt.datetime(2026, 7, 30, 9, 0, tzinfo=dt.UTC)

    for i in range(5):
        run_backup(data_dir, dest, keep=3, now=base + dt.timedelta(days=i))

    archives = sorted((dest / "state").glob("state-*.tar.gz"))
    assert len(archives) == 3  # 오래된 2개는 정리됨
    assert archives[-1].name == "state-20260803T090000Z.tar.gz"


def test_symbol_master_outside_data_dir_is_included(tmp_path: Path) -> None:
    """symbol-master.json 은 data_dir 밖의 형제라 조용히 빠지기 쉽다(hoga/config.py)."""
    data_dir = _make_data_dir(tmp_path)
    master = tmp_path / "symbol-master.json"
    master.write_text(json.dumps({"symbols": [{"code": "005930"}]}), encoding="utf-8")

    run_backup(data_dir, tmp_path / "backup", symbol_master=master)

    archive = next((tmp_path / "backup" / "state").glob("state-*.tar.gz"))
    with tarfile.open(archive, "r:gz") as tar:
        assert "symbol-master.json" in tar.getnames()


def test_dest_inside_data_dir_is_refused(tmp_path: Path) -> None:
    """목적지가 원본 안이면 백업이 자기 자신을 먹으며 무한히 자란다."""
    data_dir = _make_data_dir(tmp_path)
    with pytest.raises(ValueError, match="data_dir 내부"):
        run_backup(data_dir, data_dir / "backup")


def test_dry_run_touches_nothing(tmp_path: Path) -> None:
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"

    result = run_backup(data_dir, dest, dry_run=True)

    assert result.copied_files == 3
    assert not dest.exists()


def test_warns_when_daily_run_has_not_finished(tmp_path: Path) -> None:
    """일일 런 전 사본은 JSONL 이 아직 원위치일 수 있다 — 차단이 아니라 표시다."""
    data_dir = _make_data_dir(tmp_path)
    (data_dir / "scheduler_state.json").write_text(
        json.dumps({"last_daily_run_date": "20260729"}), encoding="utf-8",
    )
    now = dt.datetime(2026, 7, 30, 3, 0, tzinfo=dt.UTC)  # KST 12:00 — 아직 17시 전

    result = run_backup(data_dir, tmp_path / "backup", now=now)

    assert result.daily_run_done is False
    assert any("일일 런" in w for w in result.warnings)


def test_verify_detects_truncated_parquet(tmp_path: Path) -> None:
    """존재 확인만으로는 부족하다 — 잘린 사본도 존재는 한다."""
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"
    run_backup(data_dir, dest)
    assert verify_backup(dest).ok

    victim = dest / "market" / "parquet" / "20260730" / "005930" / "kiwoom_live" / "snapshots.parquet"
    victim.write_bytes(b"PAR1garbage")  # 앞 매직만 있고 꼬리가 없다

    result = verify_backup(dest)
    assert not result.ok
    assert any(name == "market-mirror" for name, ok, _ in result.checks if not ok)


def test_verify_detects_corrupt_state_archive(tmp_path: Path) -> None:
    data_dir = _make_data_dir(tmp_path)
    dest = tmp_path / "backup"
    run_backup(data_dir, dest)

    archive = next((dest / "state").glob("state-*.tar.gz"))
    archive.write_bytes(b"not a tarball at all")

    result = verify_backup(dest)
    assert not result.ok
    assert any(name == "state-archive" for name, ok, _ in result.checks if not ok)


def test_verify_fails_on_empty_destination(tmp_path: Path) -> None:
    """백업이 한 번도 안 돌았는데 PASS 가 나오면 그게 최악이다."""
    result = verify_backup(tmp_path / "nothing-here")
    assert not result.ok


def test_disaster_recovery_end_to_end(tmp_path: Path) -> None:
    """원본을 통째로 잃고 백업본만으로 복원한다 — 이 테스트가 백업의 존재 이유다."""
    import shutil as _sh

    data_dir = _make_data_dir(tmp_path)
    master = tmp_path / "symbol-master.json"
    master.write_text(json.dumps({"symbols": []}), encoding="utf-8")
    dest = tmp_path / "backup"
    run_backup(data_dir, dest, symbol_master=master, include_raw=True, include_live=True)

    before = {
        str(p.relative_to(data_dir)): p.read_bytes()
        for p in data_dir.rglob("*")
        if p.is_file() and ".local" not in p.parts and "duckdb-tmp" not in p.parts
        and p.name != ".queue.lock"
    }

    # 디스크가 죽었다.
    _sh.rmtree(data_dir)

    # 복원: 미러를 되돌리고 상태 아카이브를 푼다.
    restored = tmp_path / "restored"
    _sh.copytree(dest / "market", restored)
    archive = sorted((dest / "state").glob("state-*.tar.gz"))[-1]
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(restored, filter="data")

    after = {
        str(p.relative_to(restored)): p.read_bytes()
        for p in restored.rglob("*")
        if p.is_file() and p.name != "symbol-master.json"
    }

    assert after == before, "복원본이 원본과 바이트 단위로 같아야 한다"
    # 사용자 저작물이 실제로 살아 돌아왔는지 내용으로 확인한다.
    assert json.loads((restored / "watchlist.json").read_text())["codes"] == ["005930"]


def test_result_reports_which_data_dir_was_backed_up(tmp_path: Path) -> None:
    """HOGA_DATA_DIR 를 빠뜨리면 엉뚱한(또는 빈) 디렉토리를 담고도 출력이 성공처럼
    보인다 — 실측으로 겪은 함정이라 원본 경로를 결과에 싣는다."""
    data_dir = _make_data_dir(tmp_path)
    result = run_backup(data_dir, tmp_path / "backup")
    assert result.data_dir == data_dir


def test_empty_market_is_reported_not_failed(tmp_path: Path) -> None:
    """신규 설치엔 승격분이 없다. 이걸 FAIL 로 내면 아무도 검증을 안 보게 된다 —
    대신 사본 수를 그대로 노출해 0 이면 data_dir 설정을 의심할 수 있게 한다."""
    empty = tmp_path / "data"
    empty.mkdir()
    (empty / "watchlist.json").write_text("{}", encoding="utf-8")
    dest = tmp_path / "backup"

    run_backup(empty, dest)

    assert (dest / "market").is_dir()  # 레이아웃이 스스로를 설명해야 한다
    result = verify_backup(dest)
    assert result.ok
    detail = next(d for name, _, d in result.checks if name == "market-mirror")
    assert "0개" in detail


def test_program_trade_sidecar_is_backed_up(tmp_path: Path) -> None:
    """공급원이 키움 0w push 라 과거일을 다시 받아올 REST 경로가 없다
    (program_trade_collector docstring: "fetch 가 사라지고 drain 만 남았다").
    잃으면 research/ 와 똑같이 영구 소실이므로 미러에 들어가야 한다."""
    data_dir = _make_data_dir(tmp_path)
    pt = data_dir / "kis-program-trade" / "005930"
    pt.mkdir(parents=True)
    (pt / "20260730.json").write_text(json.dumps({"rows": [1, 2]}), encoding="utf-8")

    run_backup(data_dir, tmp_path / "backup")

    assert (tmp_path / "backup" / "market" / "kis-program-trade" / "005930"
            / "20260730.json").exists()


def test_derived_caches_are_not_backed_up(tmp_path: Path) -> None:
    """판정 기준은 크기가 아니라 재취득 가능성이다 — 파생물은 담지 않는다."""
    data_dir = _make_data_dir(tmp_path)
    for name in ("cache", "kis-past-indicators", "timing"):
        d = data_dir / name / "sub"
        d.mkdir(parents=True)
        (d / "x.json").write_text("{}", encoding="utf-8")

    run_backup(data_dir, tmp_path / "backup")

    market = tmp_path / "backup" / "market"
    for name in ("cache", "kis-past-indicators", "timing"):
        assert not (market / name).exists(), f"{name} 은 재계산 가능하므로 담지 않는다"


def test_measure_market_matches_what_backup_actually_copies(tmp_path: Path) -> None:
    """측정이 실제 백업과 어긋나면 사용자는 틀린 숫자로 요금제를 고른다.

    두 경로가 같은 헬퍼(_iter_files·_is_excluded·_owned_by_state·_MARKET_ROOTS)를
    쓰는지 불변식으로 고정한다 — 한쪽만 고쳐지는 드리프트가 이 파일의 가장 큰 위험이다.
    """
    data_dir = _make_data_dir(tmp_path)

    report = measure_backup(data_dir)
    dry = run_backup(data_dir, tmp_path / "backup", dry_run=True)

    market = [c for c in report.default_scope if not c.name.startswith("state")]
    assert sum(c.files for c in market) == dry.copied_files
    assert sum(c.bytes for c in market) == dry.copied_bytes


def test_measure_optin_matches_include_flags(tmp_path: Path) -> None:
    data_dir = _make_data_dir(tmp_path)

    report = measure_backup(data_dir)
    base = run_backup(data_dir, tmp_path / "b1", dry_run=True)
    both = run_backup(
        data_dir, tmp_path / "b2", include_raw=True, include_live=True, dry_run=True,
    )

    assert report.optin_total().files == both.copied_files - base.copied_files
    assert report.optin_total().bytes == both.copied_bytes - base.copied_bytes


def test_measure_counts_state_directories_recursively(tmp_path: Path) -> None:
    """study_views/ 같은 디렉토리 항목을 1개로 세면 state 크기가 과소보고된다."""
    data_dir = _make_data_dir(tmp_path)
    (data_dir / "study_views" / "extra.json").write_text('{"a":1}', encoding="utf-8")

    report = measure_backup(data_dir)
    state = next(c for c in report.default_scope if c.name.startswith("state"))

    # watchlist·heatmap·live_settings·study_views/saves.json·extra.json·
    # screener/saves.json·.layout_v2 = 7
    assert state.files == 7
    assert state.bytes > 0

    # dry-run 도 같은 재귀 합계를 보고해야 한다(디렉토리 0바이트 버그 회귀 방지).
    dry = run_backup(data_dir, tmp_path / "backup", dry_run=True)
    assert dry.state_bytes == state.bytes
    assert dry.state_items == state.files
    assert dry.state_archive_bytes is None  # 압축을 안 했으므로 모른다


def test_state_fields_mean_the_same_thing_in_both_modes(tmp_path: Path) -> None:
    """같은 필드가 모드에 따라 다른 것을 의미하면 비교가 성립하지 않는다.

    이전에는 실제 실행이 (tar 멤버 수, **압축** 크기)를, dry-run 이 (최상위 항목 수,
    비압축 크기)를 같은 이름으로 돌려줬다 — 크기 산정에 그대로 쓰이는 값이라
    조용히 틀린 요금 판단으로 이어진다.
    """
    data_dir = _make_data_dir(tmp_path)

    real = run_backup(data_dir, tmp_path / "b1")
    dry = run_backup(data_dir, tmp_path / "b2", dry_run=True)

    assert real.state_items == dry.state_items
    assert real.state_bytes == dry.state_bytes

    # 압축 크기는 별도 필드이고, 실제 파일 크기와 일치해야 한다.
    assert real.state_archive_bytes == real.state_archive.stat().st_size


def test_measure_excludes_secrets_from_totals_but_reports_them(tmp_path: Path) -> None:
    """제외 대상은 합계에 들어가면 안 되고, 크기는 보여 줘야 결정에 쓸 수 있다."""
    data_dir = _make_data_dir(tmp_path)

    report = measure_backup(data_dir)

    names = {c.name for c in report.default_scope} | {c.name for c in report.optin}
    assert ".local" not in names
    assert "duckdb-tmp" not in names
    excluded = {c.name: c for c in report.excluded}
    assert excluded[".local"].files == 1       # kis-token.json
    assert excluded["duckdb-tmp"].files == 1   # spill.tmp


def test_measure_recent_window_filters_by_mtime(tmp_path: Path) -> None:
    """최근 N일 변경분이 일일 증분 근사다 — 전송량·요청수 추정의 입력값이다."""
    import os as _os

    data_dir = _make_data_dir(tmp_path)
    old = data_dir / "parquet" / "20260730" / "005930" / "kiwoom_live" / "snapshots.parquet"
    long_ago = dt.datetime(2026, 1, 1, tzinfo=dt.UTC).timestamp()
    _os.utime(old, (long_ago, long_ago))

    report = measure_backup(data_dir, recent_days=1)

    assert report.recent.files >= 1              # meta.json 등 방금 만든 것들
    assert old.stat().st_size not in (report.recent.bytes,)  # 오래된 건 빠졌다
    assert report.recent.files < report.default_total().files


def test_measure_reports_state_as_one_compressed_object(tmp_path: Path) -> None:
    """state 는 파일 N개가 아니라 tar.gz **1개 객체**로 올라간다.

    비압축 합계로 보고하면 JSON 텍스트라 객체 수도 바이트도 과대보고되고, 그 숫자로
    요금제를 고르게 된다. 그리고 그 객체는 세대만큼 쌓인다.
    """
    data_dir = _make_data_dir(tmp_path)

    report = measure_backup(data_dir, keep=14)

    assert report.state_archive_bytes > 0
    assert report.state_steady_bytes() == report.state_archive_bytes * 14

    # 실제로 백업했을 때의 아카이브 크기와 일치해야 한다(추정이 아니라 실측이므로).
    real = run_backup(data_dir, tmp_path / "backup")
    assert abs(report.state_archive_bytes - real.state_archive_bytes) < 200


def test_measure_counts_small_objects_for_minimum_billing(tmp_path: Path) -> None:
    """S3 IA·Glacier 는 128KB 미만도 128KB 로 과금한다 — 평균으로는 안 보인다."""
    data_dir = _make_data_dir(tmp_path)
    big = data_dir / "parquet" / "20260731" / "005930" / "kiwoom_live"
    big.mkdir(parents=True)
    (big / "snapshots.parquet").write_bytes(b"PAR1" + b"\x00" * 200_000 + b"PAR1")

    report = measure_backup(data_dir)

    # meta.json·작은 parquet 들은 세고, 200KB 짜리는 안 센다.
    assert report.small_objects >= 1
    assert report.small_objects < report.default_total().files


def test_measure_recent_covers_optin_roots_separately(tmp_path: Path) -> None:
    """raw 를 켤지 정하려면 그 증가율을 봐야 하는데, 기본 범위만 재면 항상 0 이다."""
    data_dir = _make_data_dir(tmp_path)

    report = measure_backup(data_dir, recent_days=1)

    assert report.recent_optin.files >= 1  # 방금 만든 raw·live_kiwoom 파일
    assert report.recent_optin.bytes > 0


def test_unclassified_reveals_a_gap_in_backup_scope(tmp_path: Path) -> None:
    """새 최상위 디렉토리를 목록에 넣는 걸 잊으면 조용히 백업에서 빠진다.

    kis-program-trade 누락이 정확히 이 방식으로 드러났다 — 총합 대조가 없으면
    아무도 모른 채 그 데이터가 영영 백업되지 않는다.
    """
    data_dir = _make_data_dir(tmp_path)
    rogue = data_dir / "brand-new-feature-data"
    rogue.mkdir()
    (rogue / "important.json").write_text('{"irreplaceable": true}', encoding="utf-8")

    report = measure_backup(data_dir)

    assert report.unclassified.files >= 1
    assert report.unclassified.bytes > 0


def test_symbol_master_does_not_mask_a_scope_gap(tmp_path: Path) -> None:
    """symbol-master.json 은 data_dir **밖**이라 전체 합계에는 없는데 분류 합계에는
    들어간다. 그대로 빼면 미분류 1건을 정확히 상쇄해 진짜 구멍을 가린다 —
    실측으로 그 상쇄를 확인하고 고쳤다.
    """
    data_dir = _make_data_dir(tmp_path)
    master = tmp_path / "symbol-master.json"
    master.write_text(json.dumps({"symbols": []}), encoding="utf-8")
    rogue = data_dir / "brand-new-feature-data"
    rogue.mkdir()
    (rogue / "important.json").write_text('{"irreplaceable": true}', encoding="utf-8")

    with_master = measure_backup(data_dir, symbol_master=master)
    without = measure_backup(data_dir)

    # symbol master 유무가 대조 결과를 바꾸면 안 된다.
    assert with_master.unclassified.files == without.unclassified.files >= 1


def test_permission_errors_are_surfaced_not_swallowed(tmp_path: Path) -> None:
    """os.walk 는 기본으로 진입 실패를 조용히 건너뛴다 — 트리 절반만 담고도 성공한다.

    백업에서 그건 조용한 데이터 유실이다. 접근 실패는 반드시 표면화해야 한다.
    """
    import os as _os
    import stat as _stat

    if _os.geteuid() == 0:
        pytest.skip("root 는 권한 검사를 우회해 이 시나리오를 만들 수 없다")

    data_dir = _make_data_dir(tmp_path)
    locked = data_dir / "parquet" / "20260731" / "005930" / "kiwoom_live"
    locked.mkdir(parents=True)
    (locked / "snapshots.parquet").write_bytes(_PARQUET_BYTES)
    _os.chmod(locked, 0o000)
    try:
        report = measure_backup(data_dir)
        result = run_backup(data_dir, tmp_path / "backup")
    finally:
        _os.chmod(locked, _stat.S_IRWXU)

    assert report.problems, "접근 실패가 보고되어야 한다"
    assert any("접근하지 못한" in w for w in result.warnings)


def test_symlinked_subtree_is_reported_not_silently_dropped(tmp_path: Path) -> None:
    """큰 parquet 트리를 다른 디스크로 심링크해 둔 구성이면 통째로 빠진다."""
    import os as _os

    data_dir = _make_data_dir(tmp_path)
    elsewhere = tmp_path / "other-disk" / "20260731"
    elsewhere.mkdir(parents=True)
    (elsewhere / "snapshots.parquet").write_bytes(_PARQUET_BYTES)
    _os.symlink(elsewhere, data_dir / "parquet" / "20260731")

    report = measure_backup(data_dir)

    assert any("심볼릭 링크" in p for p in report.problems)


def test_measure_writes_nothing(tmp_path: Path) -> None:
    data_dir = _make_data_dir(tmp_path)
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))

    measure_backup(data_dir)

    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before


def test_cli_backup_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data_dir = _make_data_dir(tmp_path)
    master = tmp_path / "symbol-master.json"
    master.write_text("{}", encoding="utf-8")
    monkeypatch.setattr("hoga.cli.resolve_data_dir", lambda: data_dir)
    monkeypatch.setattr("hoga.cli.resolve_symbol_master_path", lambda: master)

    res = _runner.invoke(app, ["backup-size"])

    assert res.exit_code == 0, res.output
    assert "기본 백업 범위" in res.output
    assert "첫 업로드 크기" in res.output


def test_resolve_dest_requires_explicit_target(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGA_BACKUP_DEST", raising=False)
    with pytest.raises(ValueError, match="백업 목적지"):
        resolve_backup_dest(None)
    monkeypatch.setenv("HOGA_BACKUP_DEST", "/tmp/x")
    assert resolve_backup_dest(None) == Path("/tmp/x")


def test_cli_backup_and_verify(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data_dir = _make_data_dir(tmp_path)
    master = tmp_path / "symbol-master.json"
    master.write_text("{}", encoding="utf-8")
    monkeypatch.setattr("hoga.cli.resolve_data_dir", lambda: data_dir)
    monkeypatch.setattr("hoga.cli.resolve_symbol_master_path", lambda: master)
    dest = tmp_path / "backup"

    res = _runner.invoke(app, ["backup", "--dest", str(dest)])
    assert res.exit_code == 0, res.output
    assert "market" in res.output

    ver = _runner.invoke(app, ["backup-verify", "--dest", str(dest)])
    assert ver.exit_code == 0, ver.output
    assert "복원 가능" in ver.output


def test_cli_verify_exits_nonzero_when_broken(tmp_path: Path) -> None:
    """타이머가 실패를 알아채려면 종료코드가 달라야 한다."""
    res = _runner.invoke(app, ["backup-verify", "--dest", str(tmp_path / "empty")])
    assert res.exit_code == 1
