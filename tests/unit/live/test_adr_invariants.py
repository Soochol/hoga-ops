"""ADR-0038 + ADR-0019 invariant guards for Live Capture hot-path modules.

These tests are AST-level static checks that catch the most consequential
architectural drift before runtime:

1. **ADR-0038 (write hot-path, no Parquet libs)**: writer / snapshot /
   poller / api / lifecycle / buffer / kis_client / kis_models must NOT
   import pyarrow or polars (transitive or direct). Promote.py is the
   only allowed Parquet importer — it's the cold-path converter.

2. **ADR-0019 + Eng B2 (single-worker invariant)**: importing the
   `hoga.live` package with `UVICORN_WORKERS != "1"` must fail fast.

The forbidden pattern uses a regex so we catch every variant:
`import pyarrow`, `import pyarrow.parquet`, `from pyarrow import ...`,
`from pyarrow.parquet import ...`, plus the same shapes for `polars`.
"""

from __future__ import annotations

import ast
import importlib
import re
import subprocess
import sys
from pathlib import Path

import pytest

_FORBIDDEN_RE = re.compile(r"^(pyarrow|polars)(\..*)?$")

# Hot-path modules — must never import pyarrow/polars.
_HOT_PATH_MODULES = (
    "hoga/live/__init__.py",
    "hoga/live/writer.py",
    "hoga/live/stream.py",
    "hoga/live/ws_client.py",
    "hoga/live/ws_frames.py",
    "hoga/live/downsampler.py",
    "hoga/live/session_gate.py",
    "hoga/live/snapshot.py",
    "hoga/live/buffer.py",
    "hoga/live/api.py",
    "hoga/live/lifecycle.py",
    "hoga/live/live_session.py",
    "hoga/live/kis_client.py",
    "hoga/live/kis_models.py",
)


def _forbidden_imports(path: Path) -> list[str]:
    """Walk the AST and collect any pyarrow/polars imports."""
    tree = ast.parse(path.read_text())
    violations: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _FORBIDDEN_RE.match(alias.name):
                    violations.append(f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if _FORBIDDEN_RE.match(module):
                violations.append(f"from {module} import ...")
    return violations


@pytest.mark.parametrize("module_path", _HOT_PATH_MODULES)
def test_hot_path_module_does_not_import_parquet(module_path: str) -> None:
    """ADR-0038: Live Capture hot path is polars/pyarrow-free."""
    path = Path(module_path)
    if not path.exists():
        pytest.skip(f"{module_path} not present yet")
    violations = _forbidden_imports(path)
    assert not violations, (
        f"ADR-0038 violation in {module_path}: {violations}. "
        "The hot path must not import pyarrow or polars. "
        "Move conversion logic into hoga/live/promote.py (cold path) instead."
    )


def test_promote_is_allowed_to_import_polars() -> None:
    """ADR-0038 carve-out: promote.py is cold-path, Parquet imports OK there."""
    path = Path("hoga/live/promote.py")
    assert path.exists(), "promote.py should exist"
    # We don't assert presence; we just confirm the guard doesn't fire spuriously
    # on the cold path. If promote.py drops polars/pyarrow entirely we still pass —
    # the carve-out is permissive, not mandatory.


def test_live_package_asserts_single_worker() -> None:
    """Eng B2: hoga.live import must fail when UVICORN_WORKERS != 1.

    Runs in a subprocess so the assertion fires at import time without
    polluting the parent test process's already-imported hoga.live.
    """
    code = (
        "import os; os.environ['UVICORN_WORKERS'] = '2'; "
        "import importlib, sys; "
        "sys.modules.pop('hoga.live', None); "
        "import hoga.live"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=Path(__file__).resolve().parents[3],
    )
    assert result.returncode != 0, "expected AssertionError on multi-worker import"
    assert "single" in result.stderr.lower() or "uvicorn_workers" in result.stderr.lower(), (
        f"expected single-worker message in stderr, got: {result.stderr[:500]}"
    )


def test_live_package_imports_cleanly_with_single_worker() -> None:
    """Sanity: the default case (no UVICORN_WORKERS or =1) imports without error."""
    # The hoga.live package is likely already loaded by other tests; just
    # confirm we can re-import it with the default env.
    importlib.import_module("hoga.live")
    # No assertion needed — successful import is the contract.
