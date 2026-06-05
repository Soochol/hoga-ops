"""KIS .mst symbol master — download + parse (Phase 2).

Uses static KIS .mst downloads (no auth),
so symbol search works without KIS credentials (SPEC §7).

Parsing is BYTE-based: cp949 한글명 is 2 bytes/char, so decoding the whole row
before slicing misaligns the fixed-width byte offsets. Slice raw bytes, decode
the pieces.

part2 width differs by market and EXCLUDES the newline: KOSPI 227, KOSDAQ 221.
The official KIS parsers slice ``row[-228:]`` / ``row[-222:]`` on rows that
still carry their ``\\n`` (field-spec sums are 227/221) — we strip the newline
first, so our tail is one byte narrower. Using 228/222 here reads the group
code one byte early, pulling the last name byte into part2[0]: full-40-byte
names then yield garbage group codes and are silently dropped (verified against
the committed real-download fixtures). 증권그룹구분코드 (part2[0:2]) classifies
the row with the official 2-char codes ('ST'/'EF'/'EN'/...).
"""
from __future__ import annotations

import io
import urllib.request
import zipfile
from typing import Literal, NamedTuple

SecurityType = Literal["stock", "etf", "etn"]
Market = Literal["KOSPI", "KOSDAQ"]


class MasterRow(NamedTuple):
    code: str
    name: str
    market: Market
    security_type: SecurityType


class KisMasterFetchError(Exception):
    """download/unzip/parse failure. Maps to UpstreamCode.KIS_MASTER_FETCH_FAILED."""


_MARKETS: dict[str, tuple[str, int]] = {
    # tail = part2 width on a newline-STRIPPED row (official 228/222 minus '\n')
    "KOSPI": ("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", 227),
    "KOSDAQ": ("https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip", 221),
}


def _classify(group: str) -> SecurityType | None:
    """증권그룹구분코드 → security_type, or None to drop the row.

    Official 2-char codes (fixture-verified 2026-06-05 at the corrected offset):
    'ST'=보통주, 'EF'=ETF, 'EN'=ETN. 리츠('RT')/외국주('FS')/예탁증서('DR')/
    기타('BC','PF','IF','MF')는 SPEC scope(보통주+ETF+ETN) 밖이라 제외.
    ELW is absent from these files entirely.
    """
    if group == "ST":
        return "stock"
    if group == "EF":
        return "etf"
    if group == "EN":
        return "etn"
    return None


def download_master(market: str) -> bytes:
    """Download + unzip a .mst (no auth). Raises KisMasterFetchError on failure."""
    url, _ = _MARKETS[market]
    try:
        data = urllib.request.urlopen(url, timeout=60).read()
        z = zipfile.ZipFile(io.BytesIO(data))
        return z.read(z.namelist()[0])
    except Exception as e:  # noqa: BLE001 — network/zip errors are all fetch failures
        raise KisMasterFetchError(f"{market} .mst download/unzip failed: {e}") from e


def parse_master(raw: bytes, market: str) -> list[MasterRow]:
    """Parse raw .mst bytes into classified rows. Raises on empty/HTML/malformed
    (so the caller persists disk only on a real catalog, never an empty one)."""
    _, tail = _MARKETS[market]
    out: list[MasterRow] = []
    for row in raw.split(b"\n"):
        row = row.rstrip(b"\r")
        if len(row) <= tail:
            continue
        part1 = row[: len(row) - tail]
        part2 = row[len(row) - tail :]
        st = _classify(part2[0:2].decode("cp949", errors="replace"))
        if st is None:
            continue
        code = part1[0:9].decode("cp949", errors="replace").strip()
        name = part1[21:].decode("cp949", errors="replace").strip()
        if code and name:
            out.append(MasterRow(code, name, market, st))  # type: ignore[arg-type]
    if not out:
        raise KisMasterFetchError(
            f"{market} .mst parsed 0 rows — empty/HTML/malformed response"
        )
    return out


def fetch_symbol_master() -> list[MasterRow]:
    """Download + parse both markets. Blocking I/O — callers offload to a
    threadpool (see symbols._fetch_symbol_master)."""
    rows: list[MasterRow] = []
    for market in ("KOSPI", "KOSDAQ"):
        rows.extend(parse_master(download_master(market), market))
    return rows
