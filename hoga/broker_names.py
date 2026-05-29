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
    # 골드만삭스증권 서울지점 — hogaplay short form only.
    # The KIS-side long form was previously inferred (``골드만삭스증권`` →
    # ``골드만``) but unverified inference risks silently collapsing two
    # distinct member firms into one. Removed: an unknown_alias warning
    # on the actual KIS form is the loud-and-safe failure mode.
    "골드만": "골드만",
    # 씨티그룹글로벌마켓증권 — same stance as above.
    "씨티그룹": "씨티그룹",
    # Identity-only entries below: KIS and hogaplay already agree on form,
    # but listing them here makes the mapping table the single source of
    # truth for "broker known to this system".
    "NH투자증권": "NH투자증권",
    "키움증권": "키움증권",
    "KB증권": "KB증권",
    "유안타증권": "유안타증권",
    "신영증권": "신영증권",
    "하나증권": "하나증권",
    "코리아에셋": "코리아에셋",
    "대신증권": "대신증권",
    "교보증권": "교보증권",
    "SK증권": "SK증권",
    "유진증권": "유진증권",
    # 메리츠증권 — observed in production logs as the *short* form "메리츠".
    # The full form (메리츠증권) hasn't been seen yet from either ingest path.
    # Identity-only entry: if the other path emits 메리츠증권, a fresh
    # unknown_alias will surface it for an explicit, verified mapping —
    # preferable to a silent collapse on a guessed equivalence (the
    # 골드만/씨티그룹 lesson).
    "메리츠": "메리츠",
    # 신영증권 — hogaplay emits 4-char-aligned padded form, same pattern as
    # 삼  성 → 삼성증권 and 토  스 → 토스증권 documented in the module header.
    # The space padding is a hogaplay TSV column-width artifact, not an
    # alias inference, so collapsing to the canonical full form is safe.
    "신  영": "신영증권",
    # BNK증권 — observed as a short form. The KRX-registered full name is
    # BNK투자증권; identity-only for now (골드만/씨티그룹 lesson) so that the
    # full form, if it ever appears from KIS, surfaces a loud unknown_alias
    # rather than getting silently merged with an unverified equivalence.
    "BNK증권": "BNK증권",
    "맥쿼리증권": "맥쿼리증권",
    # 유안타 — observed as the *short* form. 유안타증권 (the full form) is
    # already registered above as identity. Not inferring equivalence here:
    # if the same KRX member is meant, the user can collapse them once
    # verified against the source path that emitted each form.
    "유안타": "유안타",
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
