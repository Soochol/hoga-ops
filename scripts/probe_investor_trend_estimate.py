#!/usr/bin/env python3
"""Probe KIS investor-trend-estimate and print redacted row-shape data.

Run manually during regular KRX session after at least the 11:20 KST input
window. This script must not persist credentials, headers, tokens, or account
identifiers.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

from hoga.live import kis_runtime

_KST = timezone(timedelta(hours=9))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default="005930")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    kis = kis_runtime.ensure_kis_client_from_env(data_dir)
    if kis is None:
        raise SystemExit("KIS client is not initialized (credentials missing)")

    rows = await kis.fetch_investor_trend_estimate(args.code)
    payload = {
        "probed_at_kst": datetime.now(_KST).isoformat(),
        "code": args.code,
        "row_count": len(rows),
        "rows": [row.model_dump() for row in rows],
        "shape": "full_history" if len(rows) > 1 else "latest_only_or_empty",
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
