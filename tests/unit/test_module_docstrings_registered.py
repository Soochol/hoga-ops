"""모듈 docstring 이 실제로 __doc__ 에 등록되는지 — 소스 텍스트가 아니라 런타임 기준.

2026-07-30 에 `hoga/api/depth_daily.py` 와 `hoga/api/screener_depth.py` 에서 발견된
결함을 고정한다. 두 파일 모두 `from __future__ import annotations` 를 **모듈
docstring 보다 앞** 에 두고 있었다:

    from __future__ import annotations

    \"\"\"이 문자열은 docstring 이 아니다\"\"\"

PEP 236 은 `__future__` import 가 "첫 문장" 이어야 한다고 정하면서 **모듈 docstring
만 예외** 로 허용한다. 순서를 뒤집으면 뒤따르는 문자열은 docstring 자격을 잃고 그냥
평가된 뒤 버려지는 표현식이 되어 `__doc__` 이 None 이 된다.

**문법 오류가 아니라 조용히 사라진다** — 그래서 이 테스트가 필요하다. 파일을 열어
보면 docstring 이 멀쩡히 있으므로 코드 리뷰로는 잡히지 않고, ruff 도 E402(import
not at top) 로만 경고해 원인이 드러나지 않는다. 실제로 ADR-0076·ADR-0062 v3 의
설계 근거를 담은 설명 두 편이 런타임에서 통째로 소실된 상태였다.
"""
from __future__ import annotations

import ast
import importlib
import pkgutil
from pathlib import Path

import pytest

import hoga


def _modules_with_source_docstring() -> list[str]:
    """소스에 모듈 docstring 이 **있는** 모듈만 고른다.

    ast 로 판정하는 이유: 파일 앞부분을 문자열로 훑으면 함수 docstring 이나 주석 속
    삼중따옴표에 오탐이 난다. ast.get_docstring 은 "이 문자열이 모듈 docstring 위치에
    있는가" 를 문법 수준에서 답한다 — 다만 `__future__` 가 앞서면 그것도 None 을
    돌려주므로, 여기서는 **모듈 본문의 첫 문자열 리터럴** 을 직접 찾는다.
    """
    out: list[str] = []
    for info in pkgutil.walk_packages(hoga.__path__, "hoga."):
        try:
            spec = importlib.util.find_spec(info.name)
        except Exception:  # noqa: BLE001 — import 불가 모듈은 이 테스트 관심 밖
            continue
        if spec is None or not spec.origin or not spec.origin.endswith(".py"):
            continue
        try:
            tree = ast.parse(Path(spec.origin).read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in tree.body:
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, str):
                out.append(info.name)      # 문자열 리터럴 문장이 본문에 있다
                break
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                # import 를 먼저 만났다 = 그 뒤의 문자열은 docstring 이 될 수 없다.
                # 단 __future__ 뒤에 문자열이 오는 바로 그 결함 케이스를 잡아야 하므로
                # 계속 훑는다.
                continue
    return sorted(set(out))


@pytest.mark.parametrize("module_path", _modules_with_source_docstring())
def test_module_docstring_reaches_dunder_doc(module_path: str) -> None:
    """소스에 모듈 docstring 이 있으면 __doc__ 에도 있어야 한다."""
    mod = importlib.import_module(module_path)
    assert mod.__doc__ is not None, (
        f"{module_path}: 소스에 모듈 docstring 이 있는데 __doc__ 이 None 이다. "
        "`from __future__ import ...` 가 docstring 보다 앞에 있는지 확인하라 — "
        "PEP 236 상 docstring 이 먼저여야 한다."
    )


def test_detects_the_future_before_docstring_shape(tmp_path: Path) -> None:
    """가드가 실제로 그 형태를 잡는지 — 회귀를 모사해 확인한다.

    이 테스트가 없으면 위 파라미터화가 대상 0개를 돌면서도 초록일 수 있다.
    """
    broken = tmp_path / "broken.py"
    broken.write_text(
        'from __future__ import annotations\n\n"""docstring 처럼 보이지만 아니다."""\n',
        encoding="utf-8",
    )
    ns: dict[str, object] = {}
    exec(compile(broken.read_text(encoding="utf-8"), str(broken), "exec"), ns)  # noqa: S102
    assert ns.get("__doc__") is None

    fixed = tmp_path / "fixed.py"
    fixed.write_text(
        '"""진짜 docstring."""\nfrom __future__ import annotations\n',
        encoding="utf-8",
    )
    ns2: dict[str, object] = {}
    exec(compile(fixed.read_text(encoding="utf-8"), str(fixed), "exec"), ns2)  # noqa: S102
    assert ns2.get("__doc__") == "진짜 docstring."
