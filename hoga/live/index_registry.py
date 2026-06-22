"""Representative index catalog for /live.

The catalog intentionally separates the app's stable index id from the KIS
index code. KRX100/KRX300 stay disabled until a KIS probe confirms usable data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

LiveIndexId = Literal["KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150", "KRX100", "KRX300"]
InvestorScope = Literal["market", "index", "none"]


class UnknownRepresentativeIndex(ValueError):
    pass


@dataclass(frozen=True)
class RepresentativeIndex:
    id: LiveIndexId
    label: str
    kis_index_code: str | None
    investor_scope: InvestorScope
    enabled_by_default: bool


_REPRESENTATIVE_INDICES: tuple[RepresentativeIndex, ...] = (
    RepresentativeIndex(
        id="KOSPI",
        label="KOSPI",
        kis_index_code="0001",
        investor_scope="market",
        enabled_by_default=True,
    ),
    RepresentativeIndex(
        id="KOSDAQ",
        label="KOSDAQ",
        kis_index_code="1001",
        investor_scope="market",
        enabled_by_default=True,
    ),
    RepresentativeIndex(
        id="KOSPI200",
        label="KOSPI 200",
        kis_index_code="2001",
        investor_scope="none",
        enabled_by_default=True,
    ),
    RepresentativeIndex(
        id="KOSDAQ150",
        label="KOSDAQ 150",
        kis_index_code="3003",
        investor_scope="none",
        enabled_by_default=True,
    ),
    RepresentativeIndex(
        id="KRX100",
        label="KRX 100",
        kis_index_code="4001",
        investor_scope="none",
        enabled_by_default=True,
    ),
    RepresentativeIndex(
        id="KRX300",
        label="KRX 300",
        kis_index_code=None,
        investor_scope="none",
        enabled_by_default=False,
    ),
)


def list_representative_indices(
    *, include_unverified: bool = False,
) -> list[RepresentativeIndex]:
    return [
        index
        for index in _REPRESENTATIVE_INDICES
        if include_unverified or index.enabled_by_default
    ]


def get_representative_index(index_id: str) -> RepresentativeIndex:
    for index in _REPRESENTATIVE_INDICES:
        if index.id == index_id:
            return index
    raise UnknownRepresentativeIndex(index_id)
