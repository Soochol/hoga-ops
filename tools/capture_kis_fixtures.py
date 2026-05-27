"""Capture real KIS Open API responses as test fixtures.

One-shot script that hits the 5 endpoints used by the Live Capture feature
plus the token issue endpoint, and saves each JSON response under
tests/fixtures/kis_mock/responses/. The captured responses are then loaded
by unit tests via httpx.MockTransport so the test suite stays offline.

Re-run this only when KIS rotates field names or after token/credential
rotation. See plan §Task 1.0 (J-extra in Review Merge Addendum) for context.

Usage:
    uv run python tools/capture_kis_fixtures.py [--code 005930]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx

from hoga.env import load_env

REAL_BASE = "https://openapi.koreainvestment.com:9443"
FIXTURES_DIR = Path("tests/fixtures/kis_mock/responses")
SECRET_FIELDS = {"appkey", "appsecret", "access_token"}


def _redact(body: dict) -> dict:
    cleaned: dict = {}
    for k, v in body.items():
        if k.lower() in SECRET_FIELDS:
            cleaned[k] = "<REDACTED>"
        elif isinstance(v, dict):
            cleaned[k] = _redact(v)
        else:
            cleaned[k] = v
    return cleaned


def _save(name: str, payload: dict) -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    out = FIXTURES_DIR / f"{name}.json"
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"  saved {out} ({len(out.read_text())} bytes)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default="005930", help="6-digit Code to query")
    args = parser.parse_args()

    load_env()
    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        print("ERROR: KIS_APP_KEY / KIS_APP_SECRET missing in .env", file=sys.stderr)
        return 1

    # local token cache to avoid hitting KIS's "1 issuance per minute" gate
    from datetime import datetime
    token_cache = Path.home() / ".local/share/hoga-ops/kis-token-capture.json"
    token: str | None = None
    if token_cache.exists():
        try:
            cached = json.loads(token_cache.read_text())
            if cached.get("expires_at_iso") and datetime.fromisoformat(cached["expires_at_iso"]) > datetime.now():
                token = cached["access_token"]
                print(f"[1/6] cached token reused (expires {cached['expires_at_iso']})")
        except Exception:
            token = None

    with httpx.Client(base_url=REAL_BASE, timeout=15.0) as client:
        if token is None:
            import time
            for attempt in range(3):
                print(f"[1/6] POST /oauth2/tokenP (attempt {attempt + 1}/3)")
                r = client.post(
                    "/oauth2/tokenP",
                    json={"grant_type": "client_credentials", "appkey": app_key, "appsecret": app_secret},
                )
                if r.status_code == 200:
                    break
                if r.status_code == 403:
                    print(f"  403 (likely 1-per-minute rate-limit); waiting 70s before retry...")
                    time.sleep(70)
                    continue
                r.raise_for_status()
            r.raise_for_status()
            token_body = r.json()
            token = token_body["access_token"]
            _save("token", _redact(token_body))
            # local cache (not committed — gitignored via ~/.local/share)
            from datetime import timedelta
            token_cache.parent.mkdir(parents=True, exist_ok=True)
            expiry = datetime.now() + timedelta(seconds=int(token_body.get("expires_in", 86400)) - 600)
            token_cache.write_text(json.dumps({"access_token": token, "expires_at_iso": expiry.isoformat()}))
            token_cache.chmod(0o600)

        base_headers = {
            "authorization": f"Bearer {token}",
            "appkey": app_key,
            "appsecret": app_secret,
            "custtype": "P",
        }
        params = {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": args.code}

        # 2. 10호가
        print(f"[2/6] GET inquire-asking-price-exp-ccn  code={args.code}")
        r = client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            headers={**base_headers, "tr_id": "FHKST01010200"},
            params=params,
        )
        r.raise_for_status()
        _save(f"quote_{args.code}", r.json())

        # 3. 체결
        print(f"[3/6] GET inquire-ccnl  code={args.code}")
        r = client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-ccnl",
            headers={**base_headers, "tr_id": "FHKST01010300"},
            params=params,
        )
        r.raise_for_status()
        _save(f"trade_{args.code}", r.json())

        # 4. 거래원
        print(f"[4/6] GET inquire-member  code={args.code}")
        r = client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-member",
            headers={**base_headers, "tr_id": "FHKST01010600"},
            params=params,
        )
        r.raise_for_status()
        _save(f"broker_{args.code}", r.json())

        # 5. 분봉 — requires FID_ETC_CLS_CODE
        print(f"[5/6] GET inquire-time-itemchartprice  code={args.code}")
        r = client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
            headers={**base_headers, "tr_id": "FHKST03010200"},
            params={
                **params,
                "fid_input_hour_1": "153000",
                "fid_pw_data_incu_yn": "N",
                "fid_etc_cls_code": "",
            },
        )
        r.raise_for_status()
        _save(f"candle_1m_{args.code}", r.json())

        # 6. 일봉 — requires FID_INPUT_DATE_1 / FID_INPUT_DATE_2
        from datetime import datetime, timedelta, timezone
        kst_now = datetime.now(timezone(timedelta(hours=9)))
        today = kst_now.strftime("%Y%m%d")
        sixty_days_ago = (kst_now - timedelta(days=90)).strftime("%Y%m%d")
        print(f"[6/6] GET inquire-daily-itemchartprice  code={args.code}  {sixty_days_ago}~{today}")
        r = client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
            headers={**base_headers, "tr_id": "FHKST03010100"},
            params={
                **params,
                "fid_input_date_1": sixty_days_ago,
                "fid_input_date_2": today,
                "fid_period_div_code": "D",
                "fid_org_adj_prc": "0",
            },
        )
        r.raise_for_status()
        _save(f"candle_d_{args.code}", r.json())

        # 7. 시간대별 체결 (side info candidate, per 공식 샘플 inquire_time_itemconclusion)
        print(f"[7/7] GET inquire-time-itemconclusion  code={args.code}")
        r = client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
            headers={**base_headers, "tr_id": "FHPST01060000"},
            params={**params, "fid_input_hour_1": "153000"},
        )
        r.raise_for_status()
        _save(f"timeconclusion_{args.code}", r.json())

    print(f"\nAll 7 responses saved to {FIXTURES_DIR}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
