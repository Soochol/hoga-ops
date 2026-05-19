"""Hogaplay API explorer. Fetches raw TSV from info/first/chart endpoints."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx

BASE = "https://hogaplay.com/player"
DEFAULT_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": f"{BASE}/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
}

ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT / "data" / "raw"


def load_cookie() -> str:
    cookie = os.environ.get("HOGAPLAY_COOKIE")
    if cookie:
        return cookie.strip()
    cookie_file = ROOT / ".cookie"
    if cookie_file.exists():
        return cookie_file.read_text(encoding="utf-8").strip()
    sys.exit("Set HOGAPLAY_COOKIE env var or create .cookie file with 'k_=...; n_=...'")


def fetch(client: httpx.Client, endpoint: str, params: dict) -> str:
    url = f"{BASE}/{endpoint}"
    r = client.get(url, params=params, timeout=60.0)
    r.raise_for_status()
    return r.text


def save(text: str, code: str, date: str, endpoint: str, suffix: str = "") -> Path:
    out_dir = DATA_RAW / date / code
    out_dir.mkdir(parents=True, exist_ok=True)
    name = endpoint.replace(".php", "") + (f"_{suffix}" if suffix else "") + ".tsv"
    path = out_dir / name
    path.write_text(text, encoding="utf-8")
    return path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--code", required=True, help="stock code, e.g. 003490")
    p.add_argument("--date", required=True, help="YYYYMMDD, e.g. 20260519")
    p.add_argument("--time", default="90000000", help="start time HHMMSSmmm")
    p.add_argument("--bong", default="1", help="candle type")
    p.add_argument("--gap", default="60000", help="candle gap in ms")
    args = p.parse_args()

    cookie = load_cookie()
    headers = {**DEFAULT_HEADERS, "Cookie": cookie}

    with httpx.Client(headers=headers, follow_redirects=True) as client:
        endpoints = [
            ("info.php", {"date": args.date, "code": args.code}),
            ("first.php", {"date": args.date, "code": args.code, "time": args.time}),
            ("chart.php", {
                "date": args.date, "code": args.code,
                "time": args.time, "bong": args.bong, "gap": args.gap,
            }),
        ]
        for ep, params in endpoints:
            print(f"[fetch] {ep} {params}", file=sys.stderr)
            text = fetch(client, ep, params)
            path = save(text, args.code, args.date, ep)
            lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
            size_kb = len(text.encode("utf-8")) / 1024
            print(f"  -> {path}  ({lines} lines, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
