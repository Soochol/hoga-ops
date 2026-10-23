"""Walk chart.php backwards past its 500-candle response limit."""
from __future__ import annotations

from collections.abc import Callable

from hoga.util.timeenc import ms_from_midnight_to_unix_ms, unix_ms_to_hhmmssms

CHART_PAGE_LIMIT = 500
# One day's 1-minute candles fit in three disjoint 500-row responses. Leave
# room for overlap, but never silently accept a frozen / non-paginating API.
MAX_CHART_PAGES = 8
_DAY_MS = 86_400_000


class ChartPaginationError(RuntimeError):
    """A full chart response could not be walked back to the start."""


def fetch_full_chart(fetch_page: Callable[[int], str], *, date: str, final_time: int) -> str:
    """Fetch older pages until chart.php returns fewer than 500 rows.

    ``time`` is HHMMSSmmm; chart column 0 is linear ms from midnight. Keep
    those encodings separate, deduplicate overlap by column 0, and retain the
    newest request's verbatim row on overlap. Single-page bodies stay unchanged
    (including empty/malformed responses, whose validation belongs to parser).
    The caller owns request timing, cancellation and HTTP retry policy.
    """
    cursor = final_time
    previous_oldest: int | None = None
    merged: dict[int, str] = {}
    for page_index in range(MAX_CHART_PAGES):
        body = fetch_page(cursor)
        lines = [line for line in body.splitlines() if line.strip()]
        if page_index == 0 and len(lines) < CHART_PAGE_LIMIT:
            return body
        if not lines:
            return _encode_rows(merged)
        page: dict[int, str] = {}
        for line in lines:
            try:
                intra_ms = int(line.split("\t", 1)[0])
            except ValueError as exc:
                raise ChartPaginationError("chart.php returned an invalid candle timestamp") from exc
            if not 0 <= intra_ms < _DAY_MS:
                raise ChartPaginationError(f"chart.php timestamp outside the requested day: {intra_ms}")
            page.setdefault(intra_ms, line)
        oldest = min(page)
        if previous_oldest is not None and oldest >= previous_oldest:
            raise ChartPaginationError("chart.php pagination did not move to older candles")
        for ts_ms, line in page.items():
            merged.setdefault(ts_ms, line)
        if len(lines) < CHART_PAGE_LIMIT or oldest == 0:
            return _encode_rows(merged)
        previous_oldest = oldest
        # Request at the oldest bucket's opening, NOT raw HHMMSSmmm minus 1.
        # The endpoint can repeat a boundary candle; dedup above handles it.
        cursor = unix_ms_to_hhmmssms(date, ms_from_midnight_to_unix_ms(date, oldest))
    raise ChartPaginationError(f"chart.php exceeded {MAX_CHART_PAGES} pages without reaching the start")


def _encode_rows(rows: dict[int, str]) -> str:
    return "".join(rows[ts] + "\n" for ts in sorted(rows, reverse=True))
