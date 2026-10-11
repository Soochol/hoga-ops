"""KIS 종목 뉴스 제목. 2026-10-11 실응답은 URL 없이 최대 40행, 종목 슬롯 10개다."""
from __future__ import annotations

from typing import Any


class KisNewsEndpointsMixin:
    async def fetch_stock_news(self, code: str, date: str | None = None) -> list[dict[str, Any]]:
        body = await self._get(  # type: ignore[attr-defined]
            path="/uapi/domestic-stock/v1/quotations/news-title",
            tr_id="FHKST01011800",
            params={
                "FID_INPUT_ISCD": code,
                "FID_NEWS_OFER_ENTP_CODE": "",
                "FID_COND_MRKT_CLS_CODE": "",
                "FID_TITL_CNTT": "",
                "FID_INPUT_DATE_1": f"00{date}" if date else "",
                "FID_INPUT_HOUR_1": "0000235959" if date else "",
                "FID_RANK_SORT_CLS_CODE": "",
                "FID_INPUT_SRNO": "",
            },
        )
        rows = body.get("output")
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("invalid news output")
        return rows
