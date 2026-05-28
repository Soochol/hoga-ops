"""Canonical broker name mapping.

Two ingest paths (hogaplay TSV, KIS REST) emit the same KRX member firm
under different short forms — e.g. KIS returns ``신한증권`` while hogaplay
returns ``신한투자증권``; KIS returns ``삼성증권`` while hogaplay returns
``삼  성`` (4-char-aligned). Treated as identity keys these split a single
broker into two entities (split nets, split sparklines, top-N truncation
displacing legitimate brokers — see "Broker Day-Trajectory" in CONTEXT.md).

This module collapses both aliases to the official KRX member-firm name.
Applied at the API boundary so storage schemas stay untouched and the
mapping can evolve without parquet migrations.
"""

from __future__ import annotations

import logging

_log = logging.getLogger(__name__)

# Maps both hogaplay TSV tokens AND KIS API tokens to a single canonical
# string. Sourced from the KRX member-firm registry. Unknown keys pass
# through unchanged (warned once per session).
_CANONICAL: dict[str, str] = {
    # 신한투자증권
    "신한증권": "신한투자증권",
    "신한투자증권": "신한투자증권",
    # 한국투자증권
    "한국증권": "한국투자증권",
    "한국투자증권": "한국투자증권",
    # 미래에셋증권
    "미래에셋": "미래에셋증권",
    "미래에셋증권": "미래에셋증권",
    # 삼성증권 — hogaplay uses 4-char-wide padded form
    "삼  성": "삼성증권",
    "삼성증권": "삼성증권",
    # 토스증권
    "토  스": "토스증권",
    "토스증권": "토스증권",
    # 모건스탠리증권
    "모건스탠리": "모건스탠리증권",
    "모건스탠리증권": "모건스탠리증권",
    # J.P. Morgan Securities Korea — hogaplay tags with city suffix
    "JP모간서울": "JP모간",
    "JP모간": "JP모간",
    # Identity-only entries below: KIS and hogaplay already agree on form,
    # but listing them here makes the mapping table the single source of
    # truth for "broker known to this system".
    "NH투자증권": "NH투자증권",
    "키움증권": "키움증권",
    "KB증권": "KB증권",
    "유안타증권": "유안타증권",
    "신영증권": "신영증권",
    "코리아에셋": "코리아에셋",
}

_unknown_seen: set[str] = set()


def canonical(raw: str) -> str:
    """Return canonical broker name; raw unchanged when unknown.

    Logs a warning the first time each unknown raw form is seen so new
    aliases surface without spamming logs on every snapshot.
    """
    mapped = _CANONICAL.get(raw)
    if mapped is not None:
        return mapped
    if raw not in _unknown_seen:
        _unknown_seen.add(raw)
        _log.warning("broker_names.unknown_alias raw=%r", raw)
    return raw
