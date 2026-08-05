"""venue 축이 있는 소스의 완결성 meta 위치 (ADR-0140, PR-D2).

⚠ **마이그레이션 직후 실제로 깨져 있었다.** `classify_stock_date` 는
`{source}/meta.json` 만 걸었는데, venue 세그먼트가 생기면서 완결성 meta 가
`{source}/{venue}/meta.json` 으로 내려갔다. 실측 2026-08-05 (477 Stock-Date):

- **397건** — venue 세그먼트만 있어 `{source}/meta.json` 부재 → 소스가 사다리에
  **아예 안 보인다**
- **80건** — PR-E 가 둔 source 레벨 meta(`expected_venues`)를 venue meta 로 오독해
  `collection_complete` 부재를 미완결로 읽는다 → **CLIENT_INCOMPLETE 오분류**

두 번째가 특히 조용하다: 값이 없는 게 아니라 **그럴듯하게 틀린 값**이 나온다.
"""
import json

from hoga.api.disk_state import DiskState, classify_stock_date

_COMPLETE = {"collection_complete": True, "is_partial": False}
_PARTIAL = {"collection_complete": True, "is_partial": True}
_SOURCE_META = {"expected_venues": ["KRX", "NXT"], "nxt_enabled": True}


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


def test_venue_level_meta_is_used_for_completeness(tmp_path):
    """완결성은 `{source}/{venue}/meta.json` 에서 읽는다."""
    _write(tmp_path / "kiwoom_live" / "KRX" / "meta.json", _COMPLETE)

    out = classify_stock_date(tmp_path)

    assert out["kiwoom_live"].state is DiskState.COMPLETE


def test_source_level_meta_is_not_read_as_venue_meta(tmp_path):
    """⚠ 회귀 가드. source 레벨 meta 에는 `collection_complete` 가 없다 — 그걸 venue
    meta 로 읽으면 완결인 날이 **미완결로 보인다**."""
    _write(tmp_path / "kiwoom_live" / "meta.json", _SOURCE_META)
    _write(tmp_path / "kiwoom_live" / "KRX" / "meta.json", _COMPLETE)

    out = classify_stock_date(tmp_path)

    assert out["kiwoom_live"].state is DiskState.COMPLETE  # source meta 를 안 봤다


def test_worst_venue_state_wins(tmp_path):
    """venue 가 여럿이면 **가장 심한 상태**가 소스 상태다 — 한 시장이 부분 결손인데
    다른 시장이 완결이라고 소스 전체를 완결로 부를 수는 없다."""
    _write(tmp_path / "kiwoom_live" / "KRX" / "meta.json", _COMPLETE)
    _write(tmp_path / "kiwoom_live" / "NXT" / "meta.json", _PARTIAL)

    out = classify_stock_date(tmp_path)

    assert out["kiwoom_live"].state is DiskState.SOURCE_PARTIAL


def test_venueless_source_still_reads_flat_meta(tmp_path):
    """venue 축이 없는 소스(hogaplay)는 예전 그대로 `{source}/meta.json` 이다."""
    _write(tmp_path / "hogaplay" / "meta.json", _COMPLETE)

    out = classify_stock_date(tmp_path)

    assert out["hogaplay"].state is DiskState.COMPLETE


def test_source_with_only_source_level_meta_is_skipped_gracefully(tmp_path):
    """venue 디렉터리가 아직 없고 source meta 만 있으면 — 그건 완결성 정보가 아니다.

    현행은 그 파일을 읽어 분류한다(하위호환: venue 축 없던 시절 meta 와 모양이 같다).
    **이 테스트는 그 동작을 고정할 뿐 옹호하지 않는다** — venue 디렉터리가 하나도
    없는 `kiwoom_live` 는 마이그레이션 후 존재할 수 없다.
    """
    _write(tmp_path / "kiwoom_live" / "meta.json", _COMPLETE)

    out = classify_stock_date(tmp_path)

    assert out["kiwoom_live"].state is DiskState.COMPLETE
