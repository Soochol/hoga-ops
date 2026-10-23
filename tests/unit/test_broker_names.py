"""Both hogaplay and KIS aliases must collapse to the same canonical name.

A regression here would silently re-split a single broker into two
entities in any read path that uses broker name as identity.
"""

import logging

import pytest

from hoga.broker_names import canonical


@pytest.fixture(autouse=True)
def _reset_unknown_seen(monkeypatch):
    from hoga import broker_names

    monkeypatch.setattr(broker_names, "_unknown_seen", set())


@pytest.mark.parametrize(
    "hogaplay_raw,kis_raw,expected",
    [
        ("신한투자증권", "신한증권", "신한투자증권"),
        ("한국투자증권", "한국증권", "한국투자증권"),
        ("미래에셋", "미래에셋증권", "미래에셋증권"),
        ("삼  성", "삼성증권", "삼성증권"),
        ("토  스", "토스증권", "토스증권"),
        ("모건스탠리", "모건스탠리증권", "모건스탠리증권"),
        ("JP모간서울", "JP모간", "JP모간"),
        # 골드만/씨티그룹 KIS long forms removed — unverified inference, prefer
        # preserving unknown spellings over silent member-firm collapse.
        # Identity pairs: both sources already agree.
        ("NH투자증권", "NH투자증권", "NH투자증권"),
        ("키움증권", "키움증권", "키움증권"),
        ("하나증권", "하나증권", "하나증권"),
        # Member firms first observed via production unknown_alias warnings
        # (2026-05-29). Identity-only entries — full-form ↔ short-form
        # equivalences are intentionally not inferred (see 골드만/씨티그룹 lesson
        # above); a later unknown_alias for the *other* form is the safe
        # signal to add a verified mapping.
        ("대신증권", "대신증권", "대신증권"),
        ("교보증권", "교보증권", "교보증권"),
        ("SK증권", "SK증권", "SK증권"),
        ("유진증권", "유진증권", "유진증권"),
        ("메리츠", "메리츠", "메리츠"),
        # 신영증권 — hogaplay 4-char padded form collapses to the canonical
        # full name (same documented pattern as 삼  성, 토  스).
        ("신  영", "신영증권", "신영증권"),
        ("BNK증권", "BNK증권", "BNK증권"),
        ("맥쿼리증권", "맥쿼리증권", "맥쿼리증권"),
        ("유안타", "유안타", "유안타"),
        ("넥스트증권", "넥스트증권", "넥스트증권"),
        ("아이엠증권", "아이엠증권", "아이엠증권"),
        ("리딩투자", "리딩투자", "리딩투자"),
        ("H S B C", "HSBC", "HSBC"),
    ],
)
def test_both_aliases_map_to_same_canonical(
    hogaplay_raw: str, kis_raw: str, expected: str
) -> None:
    assert canonical(hogaplay_raw) == expected
    assert canonical(kis_raw) == expected


@pytest.mark.parametrize("level", [logging.INFO, logging.DEBUG])
def test_unknown_alias_passes_through_with_debug_only(
    caplog: pytest.LogCaptureFixture, level: int,
) -> None:
    with caplog.at_level(level, logger="hoga.broker_names"):
        assert canonical("새로운증권") == "새로운증권"
    records = [r for r in caplog.records if "unknown_alias" in r.message]
    if level == logging.DEBUG:
        assert len(records) == 1
        assert records[0].levelno == logging.DEBUG
    else:
        assert not records


def test_unknown_alias_logs_debug_only_once_per_process(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.DEBUG, logger="hoga.broker_names"):
        canonical("새로운증권")
        canonical("새로운증권")
        canonical("새로운증권")
    records = [r for r in caplog.records if "unknown_alias" in r.message]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG


def test_observed_names_do_not_log_unknown_alias(caplog):
    with caplog.at_level(logging.DEBUG, logger="hoga.broker_names"):
        for raw in ("넥스트증권", "아이엠증권", "리딩투자", "H S B C", "HSBC"):
            canonical(raw)
    assert not caplog.records


def test_unverified_spellings_are_not_automatically_merged():
    assert canonical("H S") == "H S"
    assert canonical("H  S B C") == "H  S B C"


