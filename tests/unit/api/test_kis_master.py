"""KIS .mst parser tests (Phase 2). Uses committed real-.mst fixtures.

Regression guard for the tail-width off-by-one (2026-06-05 review finding):
the official 228/222 widths are newline-INCLUSIVE; on newline-stripped rows the
tail is 227/221. At the wrong width, full-40-byte-name rows read garbage group
codes and are silently dropped — so these tests assert exact codes/counts, not
just set membership.
"""
from pathlib import Path

import pytest

from hoga.api.kis_master import KisMasterFetchError, parse_master

FIX = Path(__file__).parent / "fixtures"


def test_parse_kospi_classifies_and_filters() -> None:
    rows = parse_master((FIX / "mst_sample_kospi.bin").read_bytes(), "KOSPI")
    by_type = {t: {r.code for r in rows if r.security_type == t} for t in ("stock", "etf", "etn")}
    # 보통주: 000020 동화약품 (' S' artifact would also match — the ETF set below is the real guard)
    assert "000020" in by_type["stock"]
    # ETF 4행 전부 — 풀네임 행 3개(0000D0/0008S0/0127V0)는 옛 228 tail에서 무음 드롭되던 회귀 대상
    assert by_type["etf"] == {"0000D0", "0000H0", "0008S0", "0127V0"}
    # ETN: 옛 코드는 'BE'/'NE' 아티팩트로 우연히 잡았다 — 진짜 'EN' 오프셋으로 잡혀야 함
    assert by_type["etn"] == {"Q500093", "Q520066"}
    # 리츠(RT)/외국주(FS)/펀드(BC,IF,MF)/우선주(PF)/DR은 scope 밖 — 드롭 확인
    dropped = {"F70100026", "0030R0", "0106J0", "088980", "094800", "950210", "900140"}
    assert dropped.isdisjoint({r.code for r in rows})
    for r in rows:
        assert r.code and r.name and r.market == "KOSPI"


def test_parse_kosdaq_uses_221_tail() -> None:
    rows = parse_master((FIX / "mst_sample_kosdaq.bin").read_bytes(), "KOSDAQ")
    assert all(r.market == "KOSDAQ" for r in rows)
    # 영숫자 6자 코드의 일반 주식(KRX 신규 티커 체계) — 'ST'로 분류되어야 함
    assert {r.code for r in rows if r.security_type == "stock"} == {"0001A0"}
    # 외국주(FS)/DR 드롭
    assert {"900110", "950190"}.isdisjoint({r.code for r in rows})


def test_korean_name_not_truncated_or_overrun() -> None:
    rows = parse_master((FIX / "mst_sample_kospi.bin").read_bytes(), "KOSPI")
    assert any("KODEX" in r.name for r in rows)
    # 풀네임 ETF 행이 드롭되지 않고 이름이 깨끗하게 디코드되는지 (옛 버그는 행을
    # 드롭해서 이 assertion을 우회했다)
    names = {r.code: r.name for r in rows}
    assert "TIGER" in names["0008S0"]
    assert all("�" not in n for n in names.values())


def test_parse_empty_raises() -> None:
    with pytest.raises(KisMasterFetchError):
        parse_master(b"", "KOSPI")


def test_parse_html_error_response_raises() -> None:
    with pytest.raises(KisMasterFetchError):
        parse_master(b"<html><body>error</body></html>\n", "KOSPI")
