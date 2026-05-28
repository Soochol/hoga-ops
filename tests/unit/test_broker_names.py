"""Both hogaplay and KIS aliases must collapse to the same canonical name.

A regression here would silently re-split a single broker into two
entities in any read path that uses broker name as identity.
"""

import logging

import pytest

from hoga.broker_names import canonical


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
        ("골드만", "골드만삭스증권", "골드만"),
        ("씨티그룹", "씨티그룹글로벌마켓증권", "씨티그룹"),
        # Identity pairs: both sources already agree.
        ("NH투자증권", "NH투자증권", "NH투자증권"),
        ("키움증권", "키움증권", "키움증권"),
        ("하나증권", "하나증권", "하나증권"),
    ],
)
def test_both_aliases_map_to_same_canonical(
    hogaplay_raw: str, kis_raw: str, expected: str
) -> None:
    assert canonical(hogaplay_raw) == expected
    assert canonical(kis_raw) == expected


def test_unknown_alias_passes_through_with_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Reset session-cache so the warning fires deterministically.
    from hoga import broker_names

    broker_names._unknown_seen.clear()

    with caplog.at_level(logging.WARNING, logger="hoga.broker_names"):
        assert canonical("새로운증권") == "새로운증권"
    assert any("unknown_alias" in r.message for r in caplog.records)


def test_unknown_alias_warns_only_once_per_session(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from hoga import broker_names

    broker_names._unknown_seen.clear()

    with caplog.at_level(logging.WARNING, logger="hoga.broker_names"):
        canonical("새로운증권")
        canonical("새로운증권")
        canonical("새로운증권")
    warns = [r for r in caplog.records if "unknown_alias" in r.message]
    assert len(warns) == 1


