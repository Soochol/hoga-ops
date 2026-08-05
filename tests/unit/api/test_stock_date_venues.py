"""보관함 날짜 행의 venue 축 — `_venue_states` (ADR-0140 §7, PR-I).

**자리 유무가 두 사실을 가른다.** 자리가 없으면 "이 시장에 미상장"이고, 자리가
비어 있으면 "기대됐으나 없음"이다. 미상장 종목의 NXT 를 빈 배지로 그리면 결손처럼
읽히므로, 자리 자체를 안 만드는 것이 '정상적으로 없음'을 모양으로 말하는 방법이다.
"""
import json

from hoga.api.queries import _venue_states


def _sd(tmp_path, *, expected=None, venues=None):
    """Stock-Date 디렉터리 하나. ``venues`` = {venue: meta dict}."""
    sd = tmp_path / "20260805" / "005930"
    src = sd / "kiwoom_live"
    src.mkdir(parents=True)
    if expected is not None:
        (src / "meta.json").write_text(json.dumps({"expected_venues": expected}))
    for venue, meta in (venues or {}).items():
        d = src / venue
        d.mkdir()
        (d / "meta.json").write_text(json.dumps(meta))
        (d / "snapshots.parquet").write_bytes(b"x" * 10)
    return sd


_COMPLETE = {"collection_complete": True, "is_partial": False}
_PARTIAL = {"collection_complete": True, "is_partial": True}


def test_no_kiwoom_live_means_no_venue_axis(tmp_path):
    """`kiwoom_live` 가 없으면 빈 목록 — hogaplay 전용 행은 화면이 그대로다."""
    (tmp_path / "20260805" / "005930" / "hogaplay").mkdir(parents=True)
    assert _venue_states(tmp_path / "20260805" / "005930") == []


def test_flat_layout_has_no_venue_axis(tmp_path):
    """마이그레이션 전 평면 `kiwoom_live/` 는 source meta 가 없어 빈 목록이다.

    **회귀 가드**: 여기서 venue 를 추측해 만들면 마이그레이션 전 전 행에 가짜 자리가
    생긴다 — 그 자리는 전부 비어 보여 결손으로 읽힌다.
    """
    sd = tmp_path / "20260805" / "005930"
    (sd / "kiwoom_live").mkdir(parents=True)
    (sd / "kiwoom_live" / "snapshots.parquet").write_bytes(b"x")
    assert _venue_states(sd) == []


def test_not_listed_gets_no_slot(tmp_path):
    """NXT 미상장 종목은 `expected_venues=["KRX"]` 라 **자리가 하나뿐**이다."""
    sd = _sd(tmp_path, expected=["KRX"], venues={"KRX": _COMPLETE})
    out = _venue_states(sd)
    assert [v.venue for v in out] == ["KRX"]
    assert out[0].disk_state == "complete"


def test_expected_but_absent_keeps_an_empty_slot(tmp_path):
    """기대됐는데 디렉터리가 없으면 **자리는 남고 상태가 None** 이다.

    미상장(자리 없음)과 갈리는 지점 — 이 구분이 이 축의 전부다.
    """
    sd = _sd(tmp_path, expected=["KRX", "NXT", "UN"], venues={"KRX": _COMPLETE})
    out = {v.venue: v.disk_state for v in _venue_states(sd)}
    assert out == {"KRX": "complete", "NXT": None, "UN": None}


def test_each_venue_carries_its_own_state(tmp_path):
    """venue 마다 상태가 독립이다 — 한 시장의 부분 결손이 다른 시장을 오염시키지 않는다."""
    sd = _sd(tmp_path, expected=["KRX", "NXT"],
             venues={"KRX": _COMPLETE, "NXT": _PARTIAL})
    out = {v.venue: v.disk_state for v in _venue_states(sd)}
    assert out == {"KRX": "complete", "NXT": "source_partial"}


def test_slot_order_follows_expected_venues(tmp_path):
    """자리 순서는 서버가 준 순서 그대로 — 프론트가 재정렬하지 않는다."""
    sd = _sd(tmp_path, expected=["UN", "KRX", "NXT"], venues={"KRX": _COMPLETE})
    assert [v.venue for v in _venue_states(sd)] == ["UN", "KRX", "NXT"]


def test_corrupt_source_meta_falls_back_to_no_axis(tmp_path):
    """손상된 source meta 는 빈 목록 — 인벤토리 한 행이 전체를 죽이지 않는다."""
    sd = tmp_path / "20260805" / "005930"
    (sd / "kiwoom_live").mkdir(parents=True)
    (sd / "kiwoom_live" / "meta.json").write_text("{")
    assert _venue_states(sd) == []
