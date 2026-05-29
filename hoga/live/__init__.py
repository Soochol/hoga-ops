import os as _os

assert _os.environ.get("UVICORN_WORKERS", "1") == "1", (
    "hoga.live requires a single uvicorn worker. "
    f"UVICORN_WORKERS={_os.environ.get('UVICORN_WORKERS')} is set — Live Capture's "
    "in-memory buffers and JSONL writer assume single-worker access. See ADR-0038."
)

__doc__ = """Live Capture — KIS-based intraday polling capture.

See docs/superpowers/specs/2026-05-27-live-capture-design.md and
ADR-0037 / ADR-0038 / ADR-0039 for rationale.
"""
