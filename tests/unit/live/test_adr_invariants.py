"""ADR-0038 + ADR-0019 invariant guards for Live Capture hot-path modules.

These tests are AST-level static checks that catch the most consequential
architectural drift before runtime:

1. **ADR-0038 (write hot-path, no Parquet libs)**: writer / snapshot /
   poller / api / lifecycle / buffer / kis_client / kis_models must NOT
   import pyarrow or polars (transitive or direct). Promote.py is the
   only allowed Parquet importer — it's the cold-path converter.

   이 "transitive or direct" 는 2026-07-30 까지 **문서에만 있었다.** 검사는 파일
   하나의 AST 에서 직접 import 만 봤고, 그동안 15개 핫패스 모듈 중 **5개가 실제로는
   import 시점에 polars/pyarrow 를 로드**하고 있었다(_PARQUET_CLOSURE_BASELINE).
   전이 폐쇄까지 보도록 고쳤고, 기존 5건은 baseline 으로 명시해 신규 유입만 막는다.

2. **ADR-0019 + Eng B2 (single-worker invariant)**: importing the
   `hoga.live` package with `UVICORN_WORKERS != "1"` must fail fast.

The forbidden pattern uses a regex so we catch every variant:
`import pyarrow`, `import pyarrow.parquet`, `from pyarrow import ...`,
`from pyarrow.parquet import ...`, plus the same shapes for `polars`.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util  # `import importlib` 만으로는 .util 접근이 보장되지 않는다
import re
import subprocess
import sys
from pathlib import Path

import pytest

_FORBIDDEN_RE = re.compile(r"^(pyarrow|polars)(\..*)?$")

# Hot-path modules — must never import pyarrow/polars.
_HOT_PATH_MODULES = (
    "hoga/api/watchlist_projection.py",
    "hoga/live/__init__.py",
    "hoga/live/writer.py",
    "hoga/live/stream.py",
    "hoga/live/downsampler.py",
    "hoga/live/session_gate.py",
    "hoga/live/coverage.py",
    "hoga/live/snapshot.py",
    "hoga/live/ticks.py",  # PR-A (ADR-0118) — WsTick 모델 이주처(포트 계약 타입)
    "hoga/live/buffer.py",
    "hoga/live/api.py",
    "hoga/live/lifecycle.py",
    "hoga/live/kis_client.py",
    "hoga/live/kis_models.py",
    "hoga/live/kiwoom_frames.py",  # PR-F2 — 거래원 0F 파서가 REST 폴러를 대체(핫패스)
)


# 전이 폐쇄에서 이미 polars/pyarrow 에 닿는 핫패스 모듈 — **고쳐야 할 부채**다.
#
# 2026-07-30 실측(정적 폐쇄 = 런타임 sys.modules 비교, 15/15 일치). 뿌리는 둘이다:
#   - hoga/api/models.py:17-18 이 hoga.tables.candles / hoga.tables.snapshots 를
#     최상단에서 import 한다(ApiCandle · ApiOrderbookSnapshot 타입 제공). 여기로
#     watchlist_projection → coverage, 그리고 stream · lifecycle 이 딸려 온다.
#   - hoga/live/api.py → hoga/live/screener_daily_candles.py:6 `import polars as pl`.
#
# baseline 을 두는 이유: 위 뿌리를 끊으려면 모델 타입 배치를 바꾸는 별건 리팩터가
# 필요하다. 그때까지 **신규 유입만 막는다** — 부채를 숨기는 게 아니라 고정한다.
_PARQUET_CLOSURE_BASELINE = frozenset({
    "hoga.api.watchlist_projection",
    "hoga.live.stream",
    "hoga.live.coverage",
    "hoga.live.api",
    "hoga.live.lifecycle",
})


def _module_name(module_path: str) -> str:
    """'hoga/live/writer.py' → 'hoga.live.writer' ('__init__.py' 는 패키지 이름)."""
    p = module_path.removesuffix(".py")
    if p.endswith("/__init__"):
        p = p.removesuffix("/__init__")
    return p.replace("/", ".")


def _module_level_imports(mod: str) -> list[str]:
    """``mod`` 이 **import 시점에** 끌어오는 모듈 이름들.

    함수 본문의 지연 import 는 제외한다 — ADR-0038 이 막으려는 것은 "import 만으로
    무거운 라이브러리를 지불하는 것" 이고, 지연 import 는 호출 시에만 지불된다.
    그래서 ast.walk 가 아니라 tree.body 만 훑는다.

    ``if TYPE_CHECKING:`` / ``try: ... except ImportError:`` 안쪽도 최상단 취급한다 —
    런타임에 실제로 평가될 수 있는 자리다.

    **상대 import(`from . import x`)를 반드시 해석해야 한다.** 이걸 빠뜨리면
    hoga.live.stream 처럼 실제로는 새는 모듈이 "경로 없음" 으로 나온다 — 이 가드를
    만들면서 실제로 겪은 오분석이고, 런타임 대조로만 드러났다.
    """
    try:
        spec = importlib.util.find_spec(mod)
    except (ImportError, ValueError):
        return []
    if spec is None or not spec.origin or not spec.origin.endswith(".py"):
        return []
    try:
        tree = ast.parse(Path(spec.origin).read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return []
    pkg = mod if Path(spec.origin).name == "__init__.py" else mod.rpartition(".")[0]
    out: list[str] = []

    def visit(nodes) -> None:
        for n in nodes:
            if isinstance(n, ast.Import):
                out.extend(a.name for a in n.names)
            elif isinstance(n, ast.ImportFrom):
                if n.level:
                    base = pkg.rsplit(".", n.level - 1)[0] if n.level > 1 else pkg
                    out.append(f"{base}.{n.module}" if n.module else base)
                elif n.module:
                    out.append(n.module)
            elif isinstance(n, (ast.If, ast.Try)):
                visit(n.body)
                visit(n.orelse)
                for handler in getattr(n, "handlers", []):
                    visit(handler.body)

    visit(tree.body)
    return out


def _closure_reaches_parquet(start: str) -> list[str] | None:
    """``start`` 의 import 폐쇄가 polars/pyarrow 에 닿으면 그 경로를, 아니면 None."""
    seen = {start}
    queue: list[tuple[str, list[str]]] = [(start, [start])]
    while queue:
        mod, path = queue.pop(0)
        for imp in _module_level_imports(mod):
            if _FORBIDDEN_RE.match(imp):
                return path + [imp]
            if imp.startswith("hoga") and imp not in seen:
                seen.add(imp)
                queue.append((imp, path + [imp]))
    return None


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
def test_hot_path_module_file_exists(module_path: str) -> None:
    """목록의 파일이 실제로 존재해야 한다.

    아래 가드는 원래 파일이 없으면 ``pytest.skip`` 했다. 모듈을 리네임·이동하면
    가드가 조용히 꺼지고 그 모듈은 아무 검사도 받지 않은 채 초록이 된다.
    "검사 안 함" 과 "통과" 를 구분하는 것이 이 테스트의 전부다.
    """
    assert Path(module_path).exists(), (
        f"{module_path} 가 없다. 리네임·이동했다면 _HOT_PATH_MODULES 를 함께 고쳐라 — "
        "목록을 그대로 두면 그 모듈은 ADR-0038 검사를 받지 않는다."
    )


@pytest.mark.parametrize(
    "module_name",
    [_module_name(p) for p in _HOT_PATH_MODULES
     if _module_name(p) not in _PARQUET_CLOSURE_BASELINE],
)
def test_hot_path_import_closure_is_parquet_free(module_name: str) -> None:
    """ADR-0038 의 "transitive" 절을 실제로 검사한다.

    직접 import 만 보던 시절에는 hoga.api.models 를 한 다리 건너 import 하는 것만으로
    pyarrow 전체가 딸려 와도 초록이었다. 여기서는 import 시점 폐쇄를 따라간다.
    """
    chain = _closure_reaches_parquet(module_name)
    assert chain is None, (
        f"ADR-0038 위반(전이): {' → '.join(chain)}\n"
        "핫패스는 import 만으로 polars/pyarrow 를 지불하면 안 된다. 중간 모듈에서 해당 "
        "import 를 함수 지역으로 내리거나, 타입만 필요하면 TYPE_CHECKING 으로 옮겨라."
    )


@pytest.mark.parametrize("module_name", sorted(_PARQUET_CLOSURE_BASELINE))
def test_baseline_entry_still_leaks_or_should_be_removed(module_name: str) -> None:
    """baseline 이 썩지 않게 한다 — 고쳐졌으면 목록에서 지우라고 실패한다.

    허용 목록의 고전적 실패 모드는 "고쳤는데 아무도 목록을 안 지워서, 나중에 다시
    새도 통과" 다. 그래서 방향을 뒤집어 **더 이상 새지 않으면 실패**시킨다.
    """
    assert _closure_reaches_parquet(module_name) is not None, (
        f"{module_name} 이 더 이상 polars/pyarrow 를 끌어오지 않는다 — 고쳐졌다. "
        "_PARQUET_CLOSURE_BASELINE 에서 지워라. 남겨 두면 재발을 못 잡는다."
    )


@pytest.mark.parametrize("module_path", _HOT_PATH_MODULES)
def test_hot_path_module_does_not_import_parquet(module_path: str) -> None:
    """ADR-0038: Live Capture hot path is polars/pyarrow-free (직접 import).

    전이 검사가 생긴 뒤에도 남겨 둔다 — 직접 import 는 위반 지점이 명확해 실패
    메시지가 짧고, baseline 과 무관하게 **모든** 핫패스 모듈에 적용된다.
    """
    path = Path(module_path)
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
    result = subprocess.run(  # noqa: PLW1510 — 반환코드를 직접 검사하는 호출부
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


def test_wstick_single_source_of_truth() -> None:
    """PR-A/PR-G (ADR-0118): WsTick lives in hoga.live.ticks — 단일 SSOT.

    KIS ws_frames(파서)·거래원 REST 폴러(PR-F2) 삭제 후 남은 유일한 틱 생산자
    kiwoom_frames 가 이 한 타입만 쓰도록 고정한다 — 같은 클래스 객체를 참조해야
    isinstance/frozen-dataclass 계약이 어긋나지 않는다."""
    from hoga.live import ticks
    from hoga.live.kiwoom_frames import WsTick as KiwoomWsTick

    assert KiwoomWsTick is ticks.WsTick
