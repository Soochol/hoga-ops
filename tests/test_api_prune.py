"""hoga.api.prune — raw retention/prune 단위 테스트."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from hoga.api.prune import (
    _is_complete_hogaplay,
    find_prunable,
    prune_raw,
    resolve_retention_days,
)
from hoga.cli import app

_runner = CliRunner()

# check_disk_state의 meta invariant를 통과하는 최소 필드 집합
# (tests/test_api_disk_state.py:_write_meta와 동일 계열).
_META_BASE = {
    "code": "005930",
    "name": "삼성전자",
    "regular_session_open_ms": 90000000,
    "regular_session_close_ms": 153000000,
    "prev_close": 50000,
    "upper_limit": 65000,
    "lower_limit": 35000,
    "today_open": 50500,
    "today_high": 51000,
    "today_low": 50000,
    "today_close": 50800,
    "pages_collected": 47,
}


def _write_meta_flat(data_dir: Path, code: str, date: str, **fields: object) -> None:
    """Legacy flat 레이아웃: parquet/{date}/{code}/meta.json."""
    p = data_dir / "parquet" / date / code
    p.mkdir(parents=True)
    (p / "meta.json").write_text(
        json.dumps({**_META_BASE, "code": code, **fields}, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_meta_source(data_dir: Path, code: str, date: str, source: str, **fields: object) -> None:
    """Per-source 레이아웃: parquet/{date}/{code}/{source}/meta.json (ADR-0037)."""
    p = data_dir / "parquet" / date / code / source
    p.mkdir(parents=True)
    (p / "meta.json").write_text(
        json.dumps({**_META_BASE, "code": code, **fields}, ensure_ascii=False),
        encoding="utf-8",
    )


def _make_raw(data_dir: Path, code: str, date: str, *, pages: int = 2, content: str = "x" * 100) -> Path:
    """raw/{date}/{code}/first_NNNNN.tsv 디렉터리를 만든다."""
    p = data_dir / "raw" / date / code
    p.mkdir(parents=True)
    for i in range(1, pages + 1):
        (p / f"first_{i:05d}.tsv").write_text(content, encoding="utf-8")
    return p


def test_gate_legacy_flat_complete(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is True


def test_gate_per_source_hogaplay_complete(tmp_data_dir: Path) -> None:
    _write_meta_source(tmp_data_dir, "005930", "20260605", "hogaplay",
                       collection_complete=True, is_partial=False)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is True


def test_gate_per_source_hogaplay_partial_but_kis_complete(tmp_data_dir: Path) -> None:
    """핵심: aggregate=COMPLETE(kiwoom_live)여도 hogaplay가 partial이면 삭제 금지 (ADR-0075)."""
    _write_meta_source(tmp_data_dir, "005930", "20260605", "hogaplay",
                       collection_complete=True, is_partial=True)   # SOURCE_PARTIAL
    _write_meta_source(tmp_data_dir, "005930", "20260605", "kiwoom_live",
                       collection_complete=True, is_partial=False)  # COMPLETE
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_gate_client_incomplete_is_false(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605", collection_complete=False)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_gate_no_parquet_is_false(tmp_data_dir: Path) -> None:
    _make_raw(tmp_data_dir, "005930", "20260605")  # raw만, parquet 없음
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_gate_invalid_is_false(tmp_data_dir: Path) -> None:
    # regular_session_close_ms=0 trips an error-severity invariant → DiskState.INVALID
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False,
                     regular_session_close_ms=0)
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_gate_no_upstream_sentinel_is_false(tmp_data_dir: Path) -> None:
    # .no_upstream_data sentinel → DiskState.NO_UPSTREAM_DATA (not COMPLETE → keep)
    raw = tmp_data_dir / "raw" / "20260605" / "005930"
    raw.mkdir(parents=True)
    (raw / ".no_upstream_data").write_text("", encoding="utf-8")
    assert _is_complete_hogaplay(tmp_data_dir, "005930", "20260605") is False


def test_resolve_retention_days_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGA_RETENTION_DAYS", raising=False)
    assert resolve_retention_days() == 3


def test_resolve_retention_days_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOGA_RETENTION_DAYS", "7")
    assert resolve_retention_days() == 7


# 모든 find_prunable/prune_raw 테스트의 고정 기준 시각: 2026-06-13.
# cutoff(N=3) = 2026-06-10 → date < "20260610"이면 후보.
_NOW = dt.datetime(2026, 6, 13)


def test_find_prunable_old_complete_is_candidate(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    cands = find_prunable(tmp_data_dir, retention_days=3, now=_NOW)
    assert [(c.date, c.code) for c in cands] == [("20260605", "005930")]
    assert cands[0].raw_dir == raw
    assert cands[0].size_bytes == 200  # 2 pages × 100 bytes


def test_find_prunable_within_grace_is_kept(tmp_data_dir: Path) -> None:
    # 20260612 >= cutoff 20260610 → 유예 내, 후보 아님
    _write_meta_flat(tmp_data_dir, "005930", "20260612",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260612")
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_find_prunable_old_but_partial_is_kept(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=True)  # SOURCE_PARTIAL
    _make_raw(tmp_data_dir, "005930", "20260605")
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_find_prunable_no_raw_root(tmp_data_dir: Path) -> None:
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_find_prunable_cutoff_boundary_is_kept(tmp_data_dir: Path) -> None:
    # cutoff(N=3, now=2026-06-13) == 20260610. date == cutoff는 strict <에서 보존.
    _write_meta_flat(tmp_data_dir, "005930", "20260610",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260610")
    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []


def test_prune_raw_dry_run_deletes_nothing(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    result = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=False)
    assert result.deleted == 0
    assert result.reclaimed_bytes == 0
    assert len(result.candidates) == 1
    assert raw.exists()  # 디스크 불변


def test_prune_raw_execute_deletes_and_reclaims(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")  # 200 bytes
    result = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=True)
    assert result.deleted == 1
    assert result.reclaimed_bytes == 200
    assert not raw.exists()
    # parquet은 보존
    assert (tmp_data_dir / "parquet" / "20260605" / "005930" / "meta.json").exists()
    assert result.scanned == 0  # 유일 raw가 삭제됨


def test_prune_raw_execute_removes_empty_date_dir(tmp_data_dir: Path) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260605")
    prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=True)
    # 날짜 내 유일 code가 삭제됐으므로 빈 raw/{date}/도 제거
    assert not (tmp_data_dir / "raw" / "20260605").exists()


def test_prune_raw_execute_keeps_nonempty_date_dir(tmp_data_dir: Path) -> None:
    # 같은 날짜에 COMPLETE(삭제)와 INCOMPLETE(보존)가 공존 → 날짜 디렉터리 유지
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    _make_raw(tmp_data_dir, "005930", "20260605")
    _make_raw(tmp_data_dir, "000660", "20260605")  # parquet 없음 → 보존
    prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=True)
    assert (tmp_data_dir / "raw" / "20260605" / "000660").exists()
    assert not (tmp_data_dir / "raw" / "20260605" / "005930").exists()
    # 삭제 후 재스캔: 000660만 남아 scanned == 1
    rescan = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=False)
    assert rescan.scanned == 1


def test_cli_prune_rejects_days_zero() -> None:
    res = _runner.invoke(app, ["prune", "--days", "0"])
    assert res.exit_code != 0
    assert "must be >= 1" in res.output


def test_cli_prune_dry_run_reports_without_deleting(
    tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    monkeypatch.setattr("hoga.cli.resolve_data_dir", lambda: tmp_data_dir)
    monkeypatch.setattr("hoga.api.prune.now_kst", lambda: _NOW)
    res = _runner.invoke(app, ["prune", "--days", "3"])
    assert res.exit_code == 0
    assert "dry-run" in res.output
    assert raw.exists()  # 삭제 안 됨


def test_cli_prune_execute_deletes(
    tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_meta_flat(tmp_data_dir, "005930", "20260605",
                     collection_complete=True, is_partial=False)
    raw = _make_raw(tmp_data_dir, "005930", "20260605")
    monkeypatch.setattr("hoga.cli.resolve_data_dir", lambda: tmp_data_dir)
    monkeypatch.setattr("hoga.api.prune.now_kst", lambda: _NOW)
    res = _runner.invoke(app, ["prune", "--days", "3", "--execute"])
    assert res.exit_code == 0
    assert "pruned" in res.output
    assert not raw.exists()


import asyncio


def test_daily_run_calls_prune_before_trading_gate(
    tmp_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hoga.api.scheduler as sched

    calls: dict[str, bool] = {"pruned": False}

    # promotion no-op
    monkeypatch.setattr(sched, "load_watchlist", lambda _d: [])
    # 비거래일로 만들어 enqueue 단계는 건너뛰게 함 → prune이 그 '전에' 불렸는지 본다
    monkeypatch.setattr(sched, "trading_days_in_range", lambda _s, _e: set())

    import hoga.api.prune as prune_mod
    real_prune = prune_mod.prune_raw

    def _spy(data_dir, **kw):
        calls["pruned"] = True
        return real_prune(data_dir, **kw)

    monkeypatch.setattr(prune_mod, "prune_raw", _spy)

    async def _fake_promote(_d):  # promotion no-op
        return None
    monkeypatch.setattr("hoga.live.promote.promote_pending", _fake_promote)
    monkeypatch.setattr("hoga.live.promote.cleanup_archive", _fake_promote)

    asyncio.run(sched._daily_run(tmp_data_dir))
    assert calls["pruned"] is True


# ---------------------------------------------------------------------------
# --include-confirmed-gaps 옵트인 + 보존 사유 진단 (2026-07-29)
#
# ADR-0075 의 Trigger Condition("비-COMPLETE raw 누적이 디스크를 위협하면
# --include-partial 옵트인 또는 별도 진단 도구를 도입한다")이 발화했다. 실측:
# 유예 밖 raw 351GB 중 COMPLETE 는 0건, SOURCE_PARTIAL 이 1,263건 187GB.
#
# 게이트를 넓히되 **확인된 갭만** 포함한다. 그 경계가 이 묶음의 핵심이고,
# 특히 CLIENT_INCOMPLETE 가 절대 포함되지 않아야 한다 — 그 raw 는 resume 커서의
# 소스라 지우면 재개가 불가능해진다.
# ---------------------------------------------------------------------------


def _seed(data_dir: Path, code: str, date: str, **meta: object) -> None:
    _write_meta_source(data_dir, code, date, "hogaplay", **meta)
    _make_raw(data_dir, code, date)


def test_confirmed_gap_is_prunable_only_with_optin(tmp_data_dir: Path) -> None:
    """재캡처가 동일 갭을 재현한 SOURCE_PARTIAL(ADR-0093) — 옵트인해야 후보."""
    _seed(tmp_data_dir, "005930", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=2)

    assert find_prunable(tmp_data_dir, retention_days=3, now=_NOW) == []
    cands = find_prunable(
        tmp_data_dir, retention_days=3, now=_NOW, include_confirmed_gaps=True,
    )
    assert [(c.date, c.code) for c in cands] == [("20260605", "005930")]


def test_unconfirmed_gap_stays_held_even_with_optin(tmp_data_dir: Path) -> None:
    """갭이 미확정이면 decide_capture 가 재캡처를 다시 시도할 수 있다 — 보존."""
    _seed(tmp_data_dir, "005930", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=0)

    assert find_prunable(
        tmp_data_dir, retention_days=3, now=_NOW, include_confirmed_gaps=True,
    ) == []


def test_client_incomplete_never_prunable(tmp_data_dir: Path) -> None:
    """가장 중요한 안전 속성: 옵트인해도 resume 소스는 건드리지 않는다.

    CLIENT_INCOMPLETE 의 raw 는 재개 커서가 가리키는 대상이다. 지우면 그 Stock-Date
    는 처음부터 다시 받아야 하고, hogaplay 업스트림 보유가 ~18시간이라 과거분은
    영영 못 받는다.
    """
    _seed(tmp_data_dir, "005930", "20260605", collection_complete=False)

    assert find_prunable(
        tmp_data_dir, retention_days=3, now=_NOW, include_confirmed_gaps=True,
    ) == []


def test_optin_still_prunes_plain_complete(tmp_data_dir: Path) -> None:
    """옵트인이 기본 게이트를 대체하는 게 아니라 넓히는 것임을 고정."""
    _seed(tmp_data_dir, "005930", "20260605",
          collection_complete=True, is_partial=False)

    cands = find_prunable(
        tmp_data_dir, retention_days=3, now=_NOW, include_confirmed_gaps=True,
    )
    assert [(c.date, c.code) for c in cands] == [("20260605", "005930")]


def test_result_reports_why_nothing_was_prunable(tmp_data_dir: Path) -> None:
    """후보 0건일 때 사유가 남아야 한다.

    이게 없으면 "지울 게 없다" 와 "전부 게이트에 걸려 보존 중" 이 같은 출력이 된다 —
    스케줄러가 매일 "removed 0 dirs" 를 성공처럼 찍는 동안 raw 가 351GB 로 자랐다.
    """
    _seed(tmp_data_dir, "005930", "20260605", collection_complete=False)
    _seed(tmp_data_dir, "000660", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=0)

    res = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=False)

    assert res.candidates == []
    assert res.skipped_by_state["client_incomplete"] == 1
    # 20260605 는 _NOW(06-13) 기준 보유 창 밖 → 확정 경로가 닫힌 쪽으로 분류된다.
    assert res.skipped_by_state["source_partial(gap_unconfirmed,expired)"] == 1
    assert res.skipped_bytes_by_state["client_incomplete"] > 0


def test_unconfirmed_gap_split_by_retention_window(tmp_data_dir: Path) -> None:
    """미확정 갭은 "언젠가 확정됨" 과 "영원히 못 함" 으로 갈려 보고돼야 한다.

    합산하면 보고를 읽는 사람이 기다리면 줄어들 양으로 오해한다 — 2026-07-30
    실측에서 미확정 1,344건 중 확정 가능한 것은 2건(0.15%)뿐이었다.
    """
    # 06-11 = _NOW(06-13) −2일 → 보유 창 **안**. 컷오프(retention_days=1)는 통과.
    _seed(tmp_data_dir, "005930", "20260611",
          collection_complete=True, is_partial=True, identical_capture_count=0)
    # 06-05 = −8일 → 보유 창 밖.
    _seed(tmp_data_dir, "000660", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=0)

    res = prune_raw(tmp_data_dir, retention_days=1, now=_NOW, execute=False)

    assert res.skipped_by_state["source_partial(gap_unconfirmed)"] == 1
    assert res.skipped_by_state["source_partial(gap_unconfirmed,expired)"] == 1


def test_expired_unconfirmed_gap_is_still_not_prunable(tmp_data_dir: Path) -> None:
    """**두 스위치가 서로를 여는 일이 없어야 한다.**

    삭제는 "구멍 있는 채로 확정된 날짜를 다시 파싱할 권리" 를 영구히 포기하는
    결정이라, 재캡처 중단(ADR-0131, 1단계)과 별개 승인을 받았다(ADR-0135, 2단계).
    승인된 지금도 스위치는 따로다 — `include_confirmed_gaps` 가 여는 것은
    **확인된** 갭뿐이고, 만료 미확정은 자기 옵트인으로만 열린다. 합치면 한쪽을
    원한 운영자가 결이 다른 쪽까지 켜게 된다.
    """
    _seed(tmp_data_dir, "000660", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=0)

    for optin in (False, True):
        res = prune_raw(
            tmp_data_dir, retention_days=3, now=_NOW, execute=True,
            include_confirmed_gaps=optin,
        )
        assert res.candidates == [], f"include_confirmed_gaps={optin} 에서 후보가 생기면 안 된다"
        assert res.deleted == 0
        assert (tmp_data_dir / "raw" / "20260605" / "000660").exists()


def test_within_grace_is_reported_separately(tmp_data_dir: Path) -> None:
    """유예 내 보존은 '게이트에 걸림' 과 다른 사유로 구분돼야 한다."""
    _seed(tmp_data_dir, "005930", "20260613",  # _NOW 와 같은 날 → 유예 내
          collection_complete=True, is_partial=False)

    res = prune_raw(tmp_data_dir, retention_days=3, now=_NOW, execute=False)
    assert res.candidates == []
    assert res.skipped_by_state["within_grace"] == 1


def test_execute_with_optin_removes_only_confirmed(tmp_data_dir: Path) -> None:
    """실제 삭제 경로도 경계를 지킨다."""
    _seed(tmp_data_dir, "005930", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=2)
    _seed(tmp_data_dir, "000660", "20260605", collection_complete=False)

    res = prune_raw(
        tmp_data_dir, retention_days=3, now=_NOW, execute=True,
        include_confirmed_gaps=True,
    )
    assert res.deleted == 1
    assert not (tmp_data_dir / "raw" / "20260605" / "005930").exists()
    assert (tmp_data_dir / "raw" / "20260605" / "000660").exists()


def test_disk_headroom_reports_and_flags_low(tmp_data_dir: Path) -> None:
    from hoga.api.prune import DiskHeadroom, disk_headroom

    head = disk_headroom(tmp_data_dir)
    assert head is not None
    assert head.total_bytes > 0
    assert 0.0 <= head.free_pct <= 100.0

    assert DiskHeadroom(total_bytes=100, free_bytes=5).is_low is True
    assert DiskHeadroom(total_bytes=100, free_bytes=50).is_low is False
    # 0 나눗셈이 터지지 않아야 한다(진단 보조가 호출부를 죽이면 안 된다).
    assert DiskHeadroom(total_bytes=0, free_bytes=0).free_pct == 0.0


def test_disk_headroom_walks_up_to_existing_parent(tmp_data_dir: Path) -> None:
    """데이터 디렉터리가 아직 없어도 조회된다(첫 부팅)."""
    from hoga.api.prune import disk_headroom

    assert disk_headroom(tmp_data_dir / "nope" / "still-nope") is not None


def test_resolve_include_confirmed_gaps_env_optin(monkeypatch: pytest.MonkeyPatch) -> None:
    """HOGA_PRUNE_CONFIRMED_GAPS truthy 판정(#998) — 기본 off, 켜면 일일 prune
    이 확인된 업스트림 갭까지 회수한다(별도 타이머 없이 스케줄러 편승)."""
    from hoga.api.prune import resolve_include_confirmed_gaps

    monkeypatch.delenv("HOGA_PRUNE_CONFIRMED_GAPS", raising=False)
    assert resolve_include_confirmed_gaps() is False
    for truthy in ("1", "true", "yes", "on", " true "):
        monkeypatch.setenv("HOGA_PRUNE_CONFIRMED_GAPS", truthy)
        assert resolve_include_confirmed_gaps() is True, truthy
    for falsy in ("", "0", "false", "off"):
        monkeypatch.setenv("HOGA_PRUNE_CONFIRMED_GAPS", falsy)
        assert resolve_include_confirmed_gaps() is False, falsy


def test_daily_scheduler_prune_wires_the_env_optin() -> None:
    """스케줄러의 일일 prune 호출이 env 옵트인을 배선하는지 봉인 —
    resolve_include_confirmed_gaps 를 만들고 안 꽂으면 env 가 무음 무시된다
    (origin guard 의 '한 목록 공유' 봉인 테스트와 같은 형태)."""
    import inspect

    from hoga.api import scheduler

    src = inspect.getsource(scheduler._daily_run)
    assert "include_confirmed_gaps=resolve_include_confirmed_gaps()" in src
    assert "include_expired_unconfirmed=resolve_include_expired_unconfirmed()" in src


def test_expired_unconfirmed_gap_is_prunable_with_its_own_optin(
    tmp_data_dir: Path,
) -> None:
    """ADR-0135 2단계: 전용 옵트인을 켜면 만료 미확정 갭이 회수된다.

    이 클래스가 지배적이라(2026-07-29 실측 743건 110GB > confirmed 520건 77GB)
    확인된 갭만 회수해서는 raw 33GB/거래일 성장을 못 따라간다.
    """
    _seed(tmp_data_dir, "000660", "20260605",
          collection_complete=True, is_partial=True, identical_capture_count=0)

    res = prune_raw(
        tmp_data_dir, retention_days=3, now=_NOW, execute=True,
        include_expired_unconfirmed=True,
    )

    assert res.deleted == 1
    assert not (tmp_data_dir / "raw" / "20260605" / "000660").exists()


def test_expired_optin_does_not_open_the_still_confirmable_window(
    tmp_data_dir: Path,
) -> None:
    """보유 창 **안**의 미확정 갭은 전용 옵트인으로도 열리지 않는다.

    그쪽은 재캡처가 아직 갭을 확정시킬 수 있다 — 지우면 고칠 수 있던 것을 버린다.
    경계가 '미확정 전체' 가 아니라 '만료된 미확정' 인 이유.
    """
    _seed(tmp_data_dir, "005930", "20260611",  # _NOW(06-13) −2일 → 보유 창 안
          collection_complete=True, is_partial=True, identical_capture_count=0)

    res = prune_raw(
        tmp_data_dir, retention_days=1, now=_NOW, execute=True,
        include_expired_unconfirmed=True,
    )

    assert res.deleted == 0
    assert res.skipped_by_state["source_partial(gap_unconfirmed)"] == 1
    assert (tmp_data_dir / "raw" / "20260611" / "005930").exists()


def test_expired_optin_never_touches_resume_sources(tmp_data_dir: Path) -> None:
    """CLIENT_INCOMPLETE 는 어느 옵트인 조합으로도 삭제되지 않는다 —
    그 raw 가 resume 커서의 소스라 지우면 처음부터 다시 받아야 한다."""
    _seed(tmp_data_dir, "005930", "20260605", collection_complete=False)

    res = prune_raw(
        tmp_data_dir, retention_days=3, now=_NOW, execute=True,
        include_confirmed_gaps=True, include_expired_unconfirmed=True,
    )

    assert res.deleted == 0
    assert res.skipped_by_state["client_incomplete"] == 1
    assert (tmp_data_dir / "raw" / "20260605" / "005930").exists()


def test_resolve_include_expired_unconfirmed_env_optin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hoga.api.prune import resolve_include_expired_unconfirmed

    monkeypatch.delenv("HOGA_PRUNE_EXPIRED_UNCONFIRMED", raising=False)
    assert resolve_include_expired_unconfirmed() is False
    for truthy in ("1", "true", "yes", "on"):
        monkeypatch.setenv("HOGA_PRUNE_EXPIRED_UNCONFIRMED", truthy)
        assert resolve_include_expired_unconfirmed() is True, truthy
    for falsy in ("", "0", "false", "no"):
        monkeypatch.setenv("HOGA_PRUNE_EXPIRED_UNCONFIRMED", falsy)
        assert resolve_include_expired_unconfirmed() is False, falsy


# ── 파생 트리 보존 (2026-08-03) ─────────────────────────────────────────────
#
# raw 와 다른 축이다: 재계산 가능(지표 캐시)하거나 텔레메트리(timing)라 잃는 것이
# CPU 시간뿐이다. 그래서 옵트인이 아니라 기본 켜짐 — 옵트인으로 두면 ADR-0075 가
# 겪은 실패(게이트가 있는데 아무도 안 켜서 쌓임)를 그대로 재현한다.


def _touch(path: Path, size: int = 16) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_derived_prune_drops_old_indicator_cache_by_filename_date(
    tmp_data_dir: Path,
) -> None:
    """날짜는 파일명에 있다 — 트리가 종목·소스로 먼저 갈리기 때문이다."""
    from hoga.api.prune import prune_derived

    root = tmp_data_dir / "kis-past-indicators"
    _touch(root / "005930" / "hogaplay" / "20250101.ratio.json")   # 오래됨
    _touch(root / "005930" / "hogaplay" / "20260612.ratio.json")   # 창 안
    _touch(root / "005930" / "hogaplay" / "README.txt")            # 날짜 아님

    res = prune_derived(tmp_data_dir, retention_days=180, now=_NOW, execute=True)

    n, _size = res.by_tree["kis-past-indicators"]
    assert n == 1
    assert not (root / "005930" / "hogaplay" / "20250101.ratio.json").exists()
    assert (root / "005930" / "hogaplay" / "20260612.ratio.json").exists()
    # 형식을 모르는 파일을 나이로 지우면 안 된다.
    assert (root / "005930" / "hogaplay" / "README.txt").exists()


def test_derived_prune_drops_old_timing_date_dirs(tmp_data_dir: Path) -> None:
    from hoga.api.prune import prune_derived

    root = tmp_data_dir / "timing"
    _touch(root / "20250101" / "005930.json")
    _touch(root / "20260612" / "005930.json")

    res = prune_derived(tmp_data_dir, retention_days=180, now=_NOW, execute=True)

    assert res.by_tree["timing"][0] == 1
    assert not (root / "20250101").exists()
    assert (root / "20260612").exists()


def test_derived_dry_run_touches_nothing(tmp_data_dir: Path) -> None:
    from hoga.api.prune import prune_derived

    old = tmp_data_dir / "kis-past-indicators" / "005930" / "hogaplay" / "20250101.ratio.json"
    _touch(old)

    res = prune_derived(tmp_data_dir, retention_days=180, now=_NOW, execute=False)

    assert res.total_items == 1  # 회수 예상량은 보고하되
    assert old.exists()          # 디스크는 불변


def test_derived_prune_never_touches_raw_or_parquet(tmp_data_dir: Path) -> None:
    """파생 트리 회수가 진실 소스에 닿으면 안 된다 — 축이 다르다."""
    from hoga.api.prune import prune_derived

    _seed(tmp_data_dir, "005930", "20250101", collection_complete=True, is_partial=False)
    before_raw = sorted(p.name for p in (tmp_data_dir / "raw").rglob("*"))
    before_pq = sorted(p.name for p in (tmp_data_dir / "parquet").rglob("*"))

    prune_derived(tmp_data_dir, retention_days=180, now=_NOW, execute=True)

    assert sorted(p.name for p in (tmp_data_dir / "raw").rglob("*")) == before_raw
    assert sorted(p.name for p in (tmp_data_dir / "parquet").rglob("*")) == before_pq


def test_dead_trees_are_reported_but_never_auto_deleted(tmp_data_dir: Path) -> None:
    """'코드가 안 읽는다' 는 판단이고, 판단으로 지우는 것은 옵트인이어야 한다."""
    from hoga.api.prune import find_dead_trees, prune_derived, remove_dead_trees

    _touch(tmp_data_dir / "kis-past-candles" / "005930" / "20250101.json")
    _touch(tmp_data_dir / "_trash_kis_api_20260717" / "junk.bin")
    _touch(tmp_data_dir / "screener" / "stocks.parquet")   # 살아 있는 트리

    dead = find_dead_trees(tmp_data_dir)
    assert set(dead) == {"kis-past-candles", "_trash_kis_api_20260717"}

    # 일일 경로(prune_derived)는 이것들을 건드리지 않는다.
    prune_derived(tmp_data_dir, retention_days=180, now=_NOW, execute=True)
    assert (tmp_data_dir / "kis-past-candles").exists()
    assert (tmp_data_dir / "_trash_kis_api_20260717").exists()

    n, reclaimed = remove_dead_trees(tmp_data_dir)
    assert n == 2
    assert reclaimed > 0
    assert not (tmp_data_dir / "kis-past-candles").exists()
    assert (tmp_data_dir / "screener").exists()  # 살아 있는 트리는 그대로


def test_daily_scheduler_runs_derived_prune() -> None:
    """배선 봉인 — 만들고 안 꽂으면 트리는 계속 자란다(ADR-0075 의 실패 모드)."""
    import inspect

    from hoga.api import scheduler

    src = inspect.getsource(scheduler._daily_run)
    assert "prune_derived" in src
    assert "resolve_derived_retention_days()" in src


def test_resolve_derived_retention_days_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from hoga.api.prune import DERIVED_RETENTION_DAYS_DEFAULT, resolve_derived_retention_days

    monkeypatch.delenv("HOGA_DERIVED_RETENTION_DAYS", raising=False)
    assert resolve_derived_retention_days() == DERIVED_RETENTION_DAYS_DEFAULT
    monkeypatch.setenv("HOGA_DERIVED_RETENTION_DAYS", "30")
    assert resolve_derived_retention_days() == 30


def test_prune_derived_includes_investor_flow_intraday_only(tmp_data_dir: Path) -> None:
    """장중 표본은 파생 보존(180일)에 편입, **확정본은 영구**다 (#1115).

    확정본이 함께 지워지면 잠정→확정 축이 무너진다 — 확정 파일의 **존재가 곧 확정
    마커**이므로, 그 파일이 사라지면 그날이 영구히 '잠정' 으로 읽힌다.
    """
    from hoga.api.prune import prune_derived

    intraday = tmp_data_dir / "investor-flow" / "intraday"
    daily = tmp_data_dir / "investor-flow" / "daily"
    intraday.mkdir(parents=True)
    daily.mkdir(parents=True)
    (intraday / "20250101.jsonl").write_text("{}\n", encoding="utf-8")          # 오래됨
    (intraday / "20260612.jsonl").write_text("{}\n", encoding="utf-8")          # 창 안
    (intraday / "20250101.jsonl.corrupt-x").write_text("x", encoding="utf-8")   # 격리본
    (daily / "20250101.json").write_text("{}", encoding="utf-8")                # 오래된 확정본

    res = prune_derived(tmp_data_dir, retention_days=180, now=_NOW, execute=True)

    assert res.by_tree["investor-flow-intraday"][0] == 1
    assert not (intraday / "20250101.jsonl").exists()
    assert (intraday / "20260612.jsonl").exists()
    assert (intraday / "20250101.jsonl.corrupt-x").exists()  # 날짜 이름이 아니면 안 건드린다
    assert (daily / "20250101.json").exists()                # 확정본은 영구
