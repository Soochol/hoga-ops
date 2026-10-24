"""Operational recovery commands. No env loading, token issuance or WS connections.

Execution uses the production server's client and governor by default.
Standalone execution requires the primary checkout, an existing production
token, and the production server stopped.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import socket
import urllib.request
from pathlib import Path

from hoga.api import screener_recovery as recovery
from hoga.api.screener_recovery_provider import collector
from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.util.timeenc import KST


class CachedToken:
    """Read the existing token only. Auth rejection never deletes/renews the cache."""
    def __init__(self, path):
        self.path, self.invalid = path, False

    def get_token(self):
        payload = json.loads(self.path.read_text())
        expiry = dt.datetime.fromisoformat(payload["expires_at"])
        if (self.invalid or payload.get("environment") != "real" or expiry.tzinfo is None
                or expiry <= dt.datetime.now(KST) + dt.timedelta(minutes=10)):
            raise recovery.RecoveryStop("existing_production_token_unavailable")
        return payload["access_token"]

    def invalidate(self):
        self.invalid = True


def server_stopped(port):
    with socket.socket() as connection:
        connection.settimeout(.2)
        if connection.connect_ex(("127.0.0.1", port)) == 0:
            raise recovery.RecoveryStop("production_server_is_running_use_its_owner")


async def standalone(data_dir, plan_id, *, resume, server_port):
    repo = Path(__file__).resolve().parents[2]
    if not (repo / ".git").is_dir():
        raise recovery.RecoveryStop("standalone_production_collection_requires_primary_checkout")
    server_stopped(server_port)
    provider = CachedToken(data_dir / ".local/kiwoom-token.json")
    provider.get_token()
    client = KiwoomRestClient(provider)
    scheduler = KiwoomCapacityScheduler()
    fetch = collector(data_dir, client=client, scheduler=scheduler)

    async def checked_fetch(target, anchor, check):
        def checked():
            server_stopped(server_port)
            check()
        return await fetch(target, anchor, checked)
    try:
        return await recovery.run(data_dir, plan_id, fetch=checked_fetch, resume=resume)
    finally:
        await scheduler.aclose()
        await client.aclose()


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=[
        "plan", "run", "resume", "status", "cancel", "compare", "review", "review-plan",
    ])
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--plan-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--comparison-dir", type=Path)
    parser.add_argument("--server-port", type=int, default=8000)
    parser.add_argument("--server-url", default="http://127.0.0.1:8000")
    parser.add_argument("--standalone", action="store_true", help="primary checkout only, server must be stopped")
    return parser


def main():
    args = _parser().parse_args()
    if args.command == "plan":
        spec = recovery.RecoverySpec.model_validate_json(args.input.read_text())
        result = {"plan_id": recovery.create_plan(args.data_dir, spec)}
    elif args.command == "review-plan":
        from hoga.api.screener_review_plan import create_plan  # noqa: PLC0415 — offline plan adoption
        result = {"plan_id": create_plan(args.data_dir, args.plan_id, json.loads(args.input.read_text()))}
    elif args.command == "status":
        result = recovery.load_job(args.data_dir, args.plan_id).model_dump(mode="json")
    elif args.command == "cancel":
        recovery.cancel(args.data_dir, args.plan_id)
        result = {"cancel_requested": True}
    elif args.command == "compare":
        from hoga.api.screener_recovery_compare import compare  # noqa: PLC0415 — offline only
        result = asyncio.run(compare(args.data_dir, args.plan_id, args.comparison_dir))
    elif args.command == "review":
        if recovery.load_plan(args.data_dir, args.plan_id).review_binding is not None:
            from hoga.api.screener_review_plan import apply_plan  # noqa: PLC0415 — offline batch review
            result = apply_plan(args.data_dir, args.plan_id,
                                payload=json.loads(args.input.read_text()) if args.input else None)
        else:
            result = recovery.review_corrections(args.data_dir, args.plan_id, json.loads(args.input.read_text()))
    elif args.standalone:
        result = asyncio.run(standalone(
            args.data_dir, args.plan_id, resume=args.command == "resume", server_port=args.server_port,
        )).model_dump(mode="json")
    else:
        recovery.load_plan(args.data_dir, args.plan_id)
        request = urllib.request.Request(
            f"{args.server_url.rstrip('/')}/api/screener/recovery/{args.plan_id}/run",
            data=json.dumps({"resume": args.command == "resume"}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    if args.output:
        from hoga.util.atomic_write import atomic_write_json  # noqa: PLC0415 — CLI output
        atomic_write_json(args.output, result)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
