"""`nxtEnable` 3상태 — True / False / **None(모름)** (ADR-0140 §4, #1127).

`None` 과 `False` 를 합치면 안 된다. 판정 규칙이 *"meta 부재 = 모름, 결손으로 단정
금지"* 를 요구하고, 거래일 달력이 커버리지 밖을 `None` 으로 두는 것과 같은 규율이다.
구 시드/구 캐시가 `False` 로 읽히면 **"전 종목 NXT 미상장"이라 거짓 증언**한다.
"""
import json

import pytest

from hoga.api.kiwoom_master import MasterRow, load_seed, parse_row


def _row(**over):
    return {"code": "005930", "name": "삼성전자", "marketCode": "0", **over}


@pytest.mark.parametrize(("raw", "expected"), [
    ("Y", True),
    ("N", False),
    (None, None),   # 필드 자체가 없다 → 모름
])
def test_parse_row_three_states(raw, expected):
    row = _row() if raw is None else _row(nxtEnable=raw)
    assert parse_row(row, "KOSPI").nxt_enabled is expected


def test_seed_carries_real_flags():
    """커밋된 시드(schema 4)가 실제 값을 들고 있어야 무자격 부팅에서도 판별된다."""
    rows = load_seed()
    by_code = {r.code: r for r in rows}
    assert by_code["005930"].nxt_enabled is True    # #1106 실측
    assert by_code["028050"].nxt_enabled is False   # #1106 실측
    n_true = sum(1 for r in rows if r.nxt_enabled is True)
    assert n_true == 606, "전체 NXT 상장 수(#1106 실측)"


def test_legacy_seed_reads_as_unknown_not_unlisted(tmp_path, monkeypatch):
    """⚠ **구 시드(schema 3, 4-tuple)는 `None` 이다 — `False` 가 아니다.**

    이걸 `False` 로 읽으면 구 시드 하나가 "전 종목 NXT 미상장"이라 거짓 증언하고,
    완결성 판정이 통째로 뒤집힌다(있어야 할 NXT 결손을 정상으로 삼킨다).
    """
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps({
        "schema_version": 3,
        "rows": [["005930", "삼성전자", "KOSPI", "stock"]],
    }), encoding="utf-8")
    monkeypatch.setattr("hoga.api.kiwoom_master.SEED_PATH", seed)

    (row,) = load_seed()
    assert row == MasterRow("005930", "삼성전자", "KOSPI", "stock", None)
    assert row.nxt_enabled is not False
