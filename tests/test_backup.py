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

from hoga.backup import resolve_backup_dest, run_backup, verify_backup
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
