import os as _os

assert _os.environ.get("UVICORN_WORKERS", "1") == "1", (
    "hoga.live requires a single uvicorn worker. "
    f"UVICORN_WORKERS={_os.environ.get('UVICORN_WORKERS')} is set — Live Capture's "
    "in-memory buffers and JSONL writer assume single-worker access. See ADR-0038."
)

__doc__ = """Live Capture — 실시간(호가·체결·거래원·프로그램)은 키움 WS 전담,
과거·집계·참조(캔들·지수·투자자·시세폴)는 KIS REST(ADR-0116/0118 브로커 특화).
원래는 KIS 폴링 캡처였다(설계 계보: ADR-0037~0039).

See docs/superpowers/specs/2026-05-27-live-capture-design.md and
ADR-0037 / ADR-0038 / ADR-0039 / ADR-0116 / ADR-0118 for rationale.
"""
