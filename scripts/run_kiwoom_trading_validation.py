"""Run the design validation with external TCP connections and env reload disabled.

Usage: python scripts/run_kiwoom_trading_validation.py [pytest options]
Loopback sockets remain available for the local WebSocket retirement test.
This guard is scoped to this Python process, not an operating-system firewall.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
from pathlib import Path

TESTS = [
    "tests/unit/api/test_broker_trading.py",
    "tests/unit/api/test_toss_trading.py",
    "tests/unit/api/test_toss_rate_limits.py",
    "tests/unit/api/test_paper_trading.py",
    "tests/unit/live/test_kiwoom_capacity.py",
    "tests/unit/live/test_kiwoom_rest_seam.py",
    "tests/unit/live/test_kiwoom_rest_runtime_accounts.py",
    "tests/unit/live/test_kiwoom_session.py",
    "tests/unit/live/test_kiwoom_ws_client.py",
    "tests/unit/live/test_kiwoom_control_isolation.py",
    "tests/unit/live/test_kiwoom_session_retirement.py",
    "tests/unit/live/test_kiwoom_trading_design_evidence.py",
    "tests/unit/live/test_kiwoom_trading_events.py",
    "tests/unit/live/test_kiwoom_runtime.py",
    "tests/unit/live/test_collector_process.py",
    "tests/unit/live/test_collector_readiness.py",
    "tests/unit/test_probe_kiwoom_trading_readonly.py",
]


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    sys.path.insert(0, str(root))
    for name in list(os.environ):
        if name.startswith(("KIWOOM_", "TOSSINVEST_", "KIS_")):
            os.environ.pop(name)

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def allowed(sock: socket.socket, address: object) -> bool:
        if sock.family == socket.AF_UNIX:
            return True
        if not isinstance(address, tuple) or not isinstance(address[0], str):
            return False
        try:
            return ipaddress.ip_address(address[0]).is_loopback
        except ValueError:
            return False

    def guarded_connect(sock: socket.socket, address: object):
        if not allowed(sock, address):
            raise RuntimeError("External TCP disabled for trading design validation")
        return original_connect(sock, address)

    def guarded_connect_ex(sock: socket.socket, address: object):
        if not allowed(sock, address):
            raise RuntimeError("External TCP disabled for trading design validation")
        return original_connect_ex(sock, address)

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    import hoga.env  # noqa: PLC0415 — install the guard before repository imports

    hoga.env.load_env = lambda **_kwargs: None
    import pytest  # noqa: PLC0415 — test discovery must run after isolation

    return pytest.main([*TESTS, *sys.argv[1:]])


if __name__ == "__main__":
    raise SystemExit(main())
