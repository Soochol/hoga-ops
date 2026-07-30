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


# 전이 폐쇄에서 polars/pyarrow 에 닿는 오케스트레이션 표면 —
# **성능 부채가 아니다. 갚아도 회수액이 0 이다.**
#
# 원래 이 주석은 이 목록을 "고쳐야 할 부채" 라고 불렀다. 2026-07-30 실측이 그걸
# 뒤집었으므로 근거를 남긴다.
#
# 【회수액이 0 인 이유】 hoga/api/app.py:18·20·32·47 이 hoga.api.captures ·
# hoga.api.screener · hoga.live.candle_repair 를 **최상단에서 무조건** import 하고,
# 셋 다 단독으로 polars+pyarrow 를 끌어온다 — ru_maxrss(peak) 기준 각각 137.6 /
# 139.2 / 137.2 MB 이고, VmRSS(current) 로 재도 139.7~140.5MB 로 같은 결론이다.
# 대조군: 빈 인터프리터 peak 35.7 / cur 11.8MB, hoga/live/writer.py 는 peak 36.0 /
# cur 20.9MB 이고 polars·pyarrow 둘 다 False — ADR-0038 이 유일하게 이름을 지목한
# 그 모듈은 이미 클린이다. (지표를 적어 두는 이유: peak 과 current 를 섞어 인용하면
# 재현자가 "숫자가 안 맞는다" 로 결론이 갈린다. 실제로 갈렸다.)
# 셋 다 _HOT_PATH_MODULES 밖이라 이 가드가 보지 않는다. 즉 아래 5개를 전부 고쳐도
# `hoga serve` 의 기동 시간과 RSS 는 1바이트도 안 줄고, 줄어드는 것은
# "hoga.live.* 만 골라 import 하는 테스트/스크립트" 뿐이다.
#
# 【배선 자체가 승인된 것이다】 lifecycle → promote 간선은 ADR-0043 이 명시적으로
# 승인했다: "Today Promotion은 hoga/live/promote.py(jsonl writer와 분리된 모듈)에서
# 동작 — hot path 외부. 위반 아님." 즉 모듈 분리로 충분하다는 것이 accepted ADR 의
# 해석이고, promote 가 pyarrow 를 쓰는 것은 ADR-0038 이 시키는 일이다.
#
# 【그래도 목록을 유지하는 이유】 신규 유입을 막는 값은 그대로다. 새 핫패스 모듈이
# parquet 계층에 붙는 것은 여전히 설계 후퇴이고, 아래 5개는 그 판정에서 제외될 뿐
# test_hot_path_module_does_not_import_parquet(직접 import)은 계속 받는다.
#
# 【남은 진짜 구멍】
#  두 검사 모두 "라이브러리 import" 만 보고 **호출**은 안 본다. 아래 baseline 모듈에
#  `from hoga.tables.candles import write_parquet` 를 넣고 부르면 직접 검사는 모듈명이
#  안 맞아 통과하고 폐쇄 검사는 면제라 건너뛴다 — ADR-0038 이 실제로 금지한
#  "핫패스에서 Parquet **쓰기**" 가 hoga.live.stream 에서 안 잡힌다. 별건 이슈다.
#
#  ※ 과거 여기 적혀 있던 `from pkg import submod` 미해석 구멍은 닫혔다(2026-07-30).
#    _module_level_imports 가 서브모듈 후보를 내고 find_spec 이 거른다. 그 구멍이
#    위음성 5건의 단일 원인이었고, 수정 후 hoga/ 155개 전수 대조에서 정적 판정이
#    런타임 sys.modules 와 **155/155 일치**한다(위음성 0 · 위양성 0).
#
# 【경로(2026-07-30 실측, 정적 폐쇄 = 런타임 sys.modules, 15/15 일치)】
#   - hoga/api/models.py:17-18 → hoga.tables.candles(pyarrow) / snapshots(polars).
#     여기로 watchlist_projection → coverage, 그리고 lifecycle → stream 이 딸려 온다.
#     ※ lifecycle 은 promote 간선을 끊어도 settings → api.models 로 여전히 닿는다.
#   - hoga/live/api.py → screener_daily_candles.py:6, 그리고 그 간선을 끊어도
#     index_sector_rankings.py:11 `import polars as pl` 가 남는다.
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


def _is_type_checking_test(test: ast.expr) -> bool:
    """``if`` 의 조건식이 정확히 ``TYPE_CHECKING`` / ``typing.TYPE_CHECKING`` 인가.

    ``not TYPE_CHECKING`` · ``TYPE_CHECKING and X`` 같은 합성식은 False 를 돌려
    본문을 계속 세게 한다. 판정을 못 하면 "센다" 쪽으로 틀리는 것이 안전하다 —
    아래 두 갈래 모두 그 방향을 지킨다.

    속성 형태는 ``typing.TYPE_CHECKING`` 만 받는다. ``attr`` 이름만 보면
    ``cfg.TYPE_CHECKING`` 처럼 typing 과 무관한 아무 객체의 속성도 면제를 받고,
    그건 런타임에 **실제로 도는** 자리라 위음성이 된다. ``import typing as t`` 뒤의
    ``t.TYPE_CHECKING`` 은 이제 "센다" 쪽으로 틀리는데, 그게 위 약속의 방향이고
    저장소에 0건이다.

    **알려진 한계**: ``TYPE_CHECKING = True`` 로 재바인딩한 뒤 ``if TYPE_CHECKING:``
    을 쓰면 본문이 실제로 도는데 여기서는 면제된다. 잡으려면 모듈 전체의 대입을
    스캔해야 해서 비용 대비 현실성이 낮다(저장소에 0건). 이 한계를 알고 남긴다.
    """
    if isinstance(test, ast.Name):
        return test.id == "TYPE_CHECKING"
    return (
        isinstance(test, ast.Attribute)
        and test.attr == "TYPE_CHECKING"
        and isinstance(test.value, ast.Name)
        and test.value.id == "typing"
    )


def _module_level_imports(mod: str) -> list[str]:
    """``mod`` 이 **import 시점에** 끌어오는 모듈 이름들.

    함수 본문의 지연 import 는 제외한다 — ADR-0038 이 막으려는 것은 "import 만으로
    무거운 라이브러리를 지불하는 것" 이고, 지연 import 는 호출 시에만 지불된다.
    그래서 ast.walk 가 아니라 tree.body 만 훑는다.

    ``try: ... except ImportError:`` 안쪽은 최상단 취급한다 — 런타임에 실제로
    평가되는 자리다. 다른 ``if`` (예: ``if sys.version_info >= ...``) 도 마찬가지다.

    **``if TYPE_CHECKING:`` 은 제외한다.** 그 블록은 런타임에 절대 평가되지 않으므로
    (``typing.TYPE_CHECKING`` 은 언제나 False) import 비용이 0 이고, 이 함수가 재려는
    것은 정확히 그 비용이다. 세면 위양성이 난다 — 실증: hoga/api/invariants.py:245 는
    바로 이 패턴으로 pyarrow 를 피하고 있는데("avoids forcing every consumer ... to
    also pull in pyarrow / tables"), 세던 시절 이 가드는 그 모듈이 pyarrow 에 닿는다고
    판정했다. 런타임 sys.modules 대조는 False 였다.

    ``if not TYPE_CHECKING:`` 처럼 뒤집힌 형태는 본문이 실제로 돌므로 계속 센다 —
    판정은 "테스트가 정확히 TYPE_CHECKING 이름인가" 로만 한다(보수적인 방향).

    **상대 import(`from .foo import bar`)의 패키지 접두사를 반드시 복원해야 한다.**
    이걸 빠뜨리면 hoga.live.stream 처럼 실제로는 새는 모듈이 "경로 없음" 으로 나온다 —
    이 가드를 만들면서 실제로 겪은 오분석이고, 런타임 대조로만 드러났다.

    **``from pkg import submod`` 도 서브모듈까지 내려가야 한다.** ``n.module`` 만
    기록하면 탐색이 ``pkg/__init__.py`` 에서 멈춘다 — hoga/tables/__init__.py 는
    비어 있으므로 거기서 끝난다. 즉 핫패스에 ``from hoga.tables import candles``
    한 줄이면 런타임엔 polars+pyarrow 가 둘 다 붙는데 가드는 통과시킨다. 이 형태는
    가공 사례가 아니라 이미 쓰인다(hoga/api/queries.py 등 68파일).

    가져오는 이름이 서브모듈인지 함수인지는 **정적으로 구분할 수 없으므로**
    (``from hoga.config import resolve_data_dir`` 는 함수다) 후보로 내보내고
    ``find_spec`` 이 걸러내게 한다 — 모듈이 아니면 spec 이 없어 [] 를 돌려준다.
    과다 생성은 무해하고, 누락은 위음성이 된다.
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
                    resolved = f"{base}.{n.module}" if n.module else base
                elif n.module:
                    resolved = n.module
                else:
                    continue
                out.append(resolved)
                # `from pkg import submod` 의 submod 도 후보로 낸다. 이름이 모듈인지
                # 함수인지는 정적으로 못 가리므로 둘 다 내고 find_spec 이 거른다.
                out.extend(
                    f"{resolved}.{a.name}" for a in n.names if a.name != "*"
                )
            elif isinstance(n, ast.If):
                # TYPE_CHECKING 본문은 런타임에 안 돈다 → 비용 0 → 세지 않는다.
                # else 절은 반대로 **실제로 도는** 자리이므로 항상 센다.
                if not _is_type_checking_test(n.test):
                    visit(n.body)
                visit(n.orelse)
            elif isinstance(n, ast.Try):
                visit(n.body)
                visit(n.orelse)
                for handler in n.handlers:
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
        "핫패스는 import 만으로 polars/pyarrow 를 지불하면 안 된다. 고치는 방법은 둘이고, "
        "**첫 번째를 먼저 시도하라**:\n"
        "  1) 중간 모듈에서 해당 import 를 함수 지역으로 내린다. 이 저장소의 관례이고"
        " (hoga/ 에 107곳), 런타임 동작이 안 바뀐다. 다만 첫 호출이 어디서 일어나는지"
        " 확인하라 — /live 라우터 핸들러는 전부 async 라, 거기서 처음 import 하면"
        " 이벤트 루프가 통째로 멈춘다(실측 polars: 웜 ~90ms, 콜드/부하 120~250ms).\n"
        "  2) 타입으로만 쓰인다면 **중간 모듈에서** `if TYPE_CHECKING:` 으로 옮긴다"
        " (hoga/api/invariants.py:245 가 선례). **단 pydantic 모델의 필드 애노테이션에는"
        " 쓸 수 없다** — 런타임에 애노테이션을 해석해야 하므로 첫 인스턴스화에서"
        " PydanticUserError 로 죽는다. hoga/api/models.py 가 정확히 그 경우다.\n"
        "두 처방 모두 **핫패스 파일 자신에는 못 쓴다** — 형제 가드"
        " test_hot_path_module_does_not_import_parquet 은 ast.walk 라 함수 본문이든"
        " TYPE_CHECKING 블록이든 `import polars` 를 그대로 잡는다. 핫패스 파일이 직접"
        " 무거운 것을 원하면 그건 설계를 바꿀 일이지 우회할 일이 아니다."
    )


def _write_probe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, src: str) -> str:
    """tmp_path 에 import 가능한 단일 모듈을 만들고 이름을 돌려준다.

    ``monkeypatch.syspath_prepend`` 를 쓰는 이유: 케이스마다 tmp_path 가 다르므로
    직접 ``sys.path.insert`` 하면 파라미터 수만큼 경로가 쌓이고, pytest 가 나중에
    그 디렉터리를 지우면 **존재하지 않는 경로가 검색 1순위로 남는다.** monkeypatch 는
    테스트 종료 시 되돌린다.
    """
    (tmp_path / f"{name}.py").write_text(src, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()
    return name


_TC = "from typing import TYPE_CHECKING\n"


@pytest.mark.parametrize(
    ("label", "src", "counted"),
    [
        ("type_checking", _TC + "if TYPE_CHECKING:\n    import polars\n", False),
        ("typing_qualified", "import typing\nif typing.TYPE_CHECKING:\n    import polars\n", False),
        ("type_checking_else", _TC + "if TYPE_CHECKING:\n    pass\nelse:\n    import polars\n", True),
        ("not_type_checking", _TC + "if not TYPE_CHECKING:\n    import polars\n", True),
        # typing 이 아닌 객체의 .TYPE_CHECKING 은 런타임에 실제로 도는 자리다 → 센다.
        ("alien_attr", "import cfgmod\nif cfgmod.TYPE_CHECKING:\n    import polars\n", True),
        # `import typing as t` 는 판정 불가 → 보수적으로 센다(면제하면 위음성).
        ("typing_aliased", "import typing as t\nif t.TYPE_CHECKING:\n    import polars\n", True),
        ("try_import_error", "try:\n    import polars\nexcept ImportError:\n    polars = None\n", True),
        ("version_gate", "import sys\nif sys.version_info >= (3, 9):\n    import polars\n", True),
    ],
)
def test_type_checking_block_is_not_import_time_cost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, label: str, src: str, counted: bool
) -> None:
    """``if TYPE_CHECKING:`` 만 비용 0 으로 취급하고 나머지 분기는 계속 센다.

    이 구분이 없으면 가드가 자기 실패 메시지의 조언(2번)을 거부한다. 실제로
    hoga/api/invariants.py:245 가 그 패턴으로 pyarrow 를 피하는데, 세던 시절
    가드는 그 모듈이 pyarrow 에 닿는다고 판정했다 — 런타임은 아니었다.

    반대 방향도 같이 못 박는다: ``else`` 절·``not TYPE_CHECKING``·``try/except
    ImportError``·버전 게이트는 **런타임에 실제로 도는** 자리라 계속 세야 한다.
    """
    mod = _write_probe(tmp_path, monkeypatch, f"adr0038_probe_{label}", src)
    reached = _closure_reaches_parquet(mod) is not None
    assert reached is counted, (
        f"{label}: polars 를 {'세야' if counted else '세지 말아야'} 하는데 "
        f"{'셌다' if reached else '안 셌다'}. _is_type_checking_test 판정을 확인하라."
    )


@pytest.mark.parametrize(
    ("label", "src", "reached"),
    [
        # 핵심 케이스: 패키지에서 서브모듈을 꺼내는 형태. hoga/tables/__init__.py 가
        # 비어 있어, 여기서 멈추면 candles.py 의 pyarrow 를 영영 못 본다.
        ("from_pkg_import_submod", "from hoga.tables import candles\n", True),
        # 대조군 1 — 직접 서브모듈 경로. 고치기 전에도 잡히던 형태.
        ("direct_submod", "from hoga.tables.candles import ApiCandle\n", True),
        # 대조군 2 — 같은 문법이지만 가져오는 이름이 **함수**다. find_spec 이 걸러
        # 내야 하고, 무해한 후보 생성이 오탐으로 이어지면 안 된다.
        ("from_module_import_func", "from hoga.config import resolve_data_dir\n", False),
        # 여러 이름 중 하나만 모듈인 혼합 형태.
        ("mixed_names", "from hoga.tables import dispatch, candles\n", True),
    ],
)
def test_from_package_import_submodule_is_followed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, label: str, src: str, reached: bool
) -> None:
    """``from pkg import submod`` 가 서브모듈까지 내려가야 한다.

    이걸 빠뜨리면 핫패스에 ``from hoga.tables import candles`` 한 줄을 넣어도
    **두 검사가 모두 통과**한다 — 직접 검사는 모듈명이 polars/pyarrow 가 아니라
    안 걸리고, 폐쇄 검사는 빈 ``hoga/tables/__init__.py`` 에서 멈춘다. 그런데
    런타임에는 polars 와 pyarrow 가 둘 다 적재된다.

    2026-07-30 전수 대조에서 이 구멍이 위음성 5건의 단일 원인이었고, 그중 넷이
    ``hoga.live.*`` 였다 — 감시 대상 계층에서 실제로 일어나고 있었다.
    """
    mod = _write_probe(tmp_path, monkeypatch, f"adr0038_submod_{label}", src)
    assert (_closure_reaches_parquet(mod) is not None) is reached


# 2026-07-30 전수 대조에서 **실제로 위음성이었던** 모듈들. 원인은 하나 —
# `from pkg import submod` 를 서브모듈로 해석하지 않아 탐색이 빈 __init__.py 에서
# 멈춘 것. 핫패스 목록 밖이라 위 파라미터 대조만으로는 재발을 못 잡는다.
# 넷이 hoga.live.* 라는 점이 이 구멍이 추상적 위험이 아니었음을 보여준다.
_HISTORICALLY_DRIFTED = (
    "hoga.api.calendar_policy",
    "hoga.live.live_candle_backfill",
    "hoga.live.live_daily_candle_backfill",
    "hoga.live.live_index_investor_net",
    "hoga.live.live_investor_net_backfill",
)


def test_static_closure_matches_runtime_for_hot_path() -> None:
    """정적 판정이 런타임 sys.modules 와 일치하는가 — 가드의 근본 계약.

    이 가드는 AST 근사이므로 언제든 실제와 어긋날 수 있고, 어긋나는 방향이
    위음성이면 **초록인 채로 새게 된다**. 그래서 근사를 진실과 직접 대조한다.

    대상을 핫패스 + 과거 드리프트 모듈로 한정하는 이유는 비용이다(모듈당
    서브프로세스 1개). hoga/ 155개 전수 대조는 2026-07-30 에 수행했고 수정 후
    위음성·위양성 모두 0 이었다(수정 전 위음성 5).
    """
    targets = [_module_name(p) for p in _HOT_PATH_MODULES] + list(_HISTORICALLY_DRIFTED)
    for mod in targets:
        static_leaks = _closure_reaches_parquet(mod) is not None
        probe = subprocess.run(
            [sys.executable, "-c",
             f"import sys, {mod};"
             "print(any(k.split('.')[0] in ('polars','pyarrow') for k in sys.modules))"],
            capture_output=True, text=True, check=False,
        )
        assert probe.returncode == 0, f"{mod} import 실패: {probe.stderr[-400:]}"
        runtime_leaks = probe.stdout.strip().splitlines()[-1] == "True"
        assert static_leaks == runtime_leaks, (
            f"{mod}: 정적={static_leaks} 런타임={runtime_leaks} — 가드가 실제와 어긋난다. "
            "위음성이면 이 모듈은 초록인 채로 새고 있다."
        )


def test_type_checking_precedent_module_is_closure_clean() -> None:
    """정적 판정이 런타임과 일치하는지 실제 모듈로 대조한다.

    hoga/api/invariants.py 는 무거운 도메인 타입을 ``if TYPE_CHECKING:`` 뒤에 두어
    "consumer 가 pyarrow 를 같이 끌어오지 않게" 한다(그 파일의 주석). 정적 가드가
    그걸 위반으로 보면, 가드가 옳은 코드를 벌주는 것이다.
    """
    chain = _closure_reaches_parquet("hoga.api.invariants")
    assert chain is None, (
        f"정적 폐쇄가 {' → '.join(chain)} 로 판정했다. 런타임 sys.modules 에는 "
        "pyarrow 가 없다(실측). TYPE_CHECKING 을 최상단으로 세고 있지 않은지 확인하라."
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
