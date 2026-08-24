"""`model_copy(update=...)` 로 **모델 필드에 dict 를 넣지 않는다** — 정적 가드.

## 왜 필요한가

`model_copy(update=...)` 는 **검증을 하지 않는다.** 모델로 선언된 필드에 raw dict 를
대입해도 조용히 통과하고, 직렬화 때가 되어서야 pydantic 이 경고를 흘린다:

    PydanticSerializationUnexpectedValue(Expected `X` - serialized value may not be
    as expected [field_name='...', input_type=dict])

값은 **우연히** 같게 나가지만 검증을 건너뛴 채라, 키가 늘거나 타입이 어긋나도 그대로
지나간다. 2026-08-24 에 하루 사이 두 번 났다 — `rest_capacity_scheduler`(#1572) ·
`traded_peaks`(#1573). `hoga/api/models.py` 는 그전부터 같은 함정을 또 다른 필드
(`member_codes`)에 대해 주석으로 경고하고 있었다. **알려진 함정인데 기계가 지키지
않아 반복됐다.**

## 왜 런타임 필터로 안 되는가 (이 테스트가 따로 있는 이유)

`pyproject.toml` 의 `filterwarnings` 가 그 경고를 실패로 올린다. 그런데 **실행되지
않는 코드는 경고를 내지 않는다** — `traded_peaks` 쪽(`bundle._peak_with_rep_outputs`)은
테스트가 하나도 없어서 그 필터로는 **원리적으로** 못 잡았다(#1573 에서 실측). 둘의
사각이 서로 반대라 함께 있어야 한다:

                        커버리지 있는 경로   없는 경로
    런타임 filterwarnings        ✅              ❌
    이 정적 가드                 ✅              ✅

## 막는 방향과 못 보는 것

**막는다**: `model_copy(update={...})` 의 **dict 리터럴** 키가 모델 타입 필드이면서,
값이 dict 를 만들 수 있는 경우 — dict 리터럴 · dict 를 원소로 하는 리스트/컴프리헨션 ·
반환 애너테이션이 `dict`/`list[dict]` 인 함수 호출.

**못 본다**, 넷:

1. **`update=` 에 변수를 넘기는 곳.** dict 리터럴이 아니면 키를 못 읽는다. 현재
   2곳이고(`live/api.py` · `study_views.py`) 2026-08-24 에 손으로 확인했다 — 전자는
   넣기 전에 검증하고, 후자는 스칼라만 담는다. **늘어나면 손으로 봐야 한다.**
2. **반환 애너테이션이 없는 dict 반환 함수.** 현재 리포에 0개라 구멍이 없지만,
   애너테이션 없이 dict 를 돌려주는 함수가 생기면 그 호출은 안 보인다.
3. **필드명 과다 매칭.** 어느 모델에서든 모델 타입인 이름이면 대상으로 본다 —
   보수적인 방향(오탐 쪽)이라 의도한 것이다. 실제 대상 모델을 정적으로 못 가린다.
4. **`model_construct`** 등 다른 검증 우회 경로. 현재 사용처 0건.

**등록 의존 없음**: 소스를 직접 읽는다. 새 모델·새 `model_copy` 를 어디에도 등록할
필요가 없다.

## 빨개지면

허용 목록을 만들지 말 것 — 이 가드에는 면제가 없다. **값을 만드는 쪽이 모델을
돌려주게** 고친다(#1573 의 `_ask_candidate` 가 그 형태다). 그러면 생성자 경로와
`model_copy` 경로가 같아지고, 생성자 쪽은 모델 인스턴스를 그대로 받으므로 동작이
바뀌지 않는다.
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[3] / "hoga"


def _parsed_sources() -> dict[Path, ast.Module]:
    out: dict[Path, ast.Module] = {}
    for path in sorted(PACKAGE_ROOT.rglob("*.py")):
        try:
            out[path] = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover — 파싱 실패는 다른 게이트가 잡는다
            continue
    return out


def _pydantic_model_names(trees: dict[Path, ast.Module]) -> set[str]:
    """``BaseModel`` 을 (전이적으로) 상속하는 클래스 이름들.

    상속 사슬이 있으므로 고정점까지 돌린다 — ``class A(BaseModel)`` 뿐 아니라
    ``class B(A)`` 도 모델이다.
    """
    bases: dict[str, set[str]] = {}
    for tree in trees.values():
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                bases.setdefault(node.name, set()).update(
                    b.attr if isinstance(b, ast.Attribute) else getattr(b, "id", "")
                    for b in node.bases
                )
    models = {"BaseModel"}
    changed = True
    while changed:
        changed = False
        for name, parents in bases.items():
            if name not in models and parents & models:
                models.add(name)
                changed = True
    return models - {"BaseModel"}


def _model_typed_field_names(trees: dict[Path, ast.Module], models: set[str]) -> set[str]:
    """애너테이션이 모델 클래스를 참조하는 필드 이름들(어느 모델에서든)."""
    out: set[str] = set()
    for tree in trees.values():
        for node in ast.walk(tree):
            if not (isinstance(node, ast.ClassDef) and node.name in models):
                continue
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    text = ast.unparse(stmt.annotation)
                    if any(m in text for m in models):
                        out.add(stmt.target.id)
    return out


def _dict_returning_functions(trees: dict[Path, ast.Module]) -> set[str]:
    out: set[str] = set()
    for tree in trees.values():
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.returns is not None:
                text = ast.unparse(node.returns)
                if text.startswith(("dict", "list[dict")):
                    out.add(node.name)
    return out


def _dict_source(node: ast.expr, dict_returning: set[str]) -> str | None:
    """이 값 표현식이 dict(또는 dict 리스트)를 만들 수 있으면 사유."""
    if isinstance(node, ast.Dict):
        return "dict 리터럴"
    if isinstance(node, ast.ListComp | ast.GeneratorExp | ast.SetComp):
        return _dict_source(node.elt, dict_returning)
    if isinstance(node, ast.List):
        for element in node.elts:
            reason = _dict_source(element, dict_returning)
            if reason:
                return reason
        return None
    if isinstance(node, ast.Call):
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
        if name in dict_returning:
            return f"{name}() 가 dict 계열을 반환"
    return None


def test_model_copy_never_puts_a_dict_into_a_model_field() -> None:
    trees = _parsed_sources()
    assert trees, "hoga 패키지를 하나도 못 읽었다 — 탐침이 고장났다"

    models = _pydantic_model_names(trees)
    field_names = _model_typed_field_names(trees, models)
    dict_returning = _dict_returning_functions(trees)
    assert field_names, "모델 타입 필드를 하나도 못 찾았다 — 탐침이 고장났다"

    offenders: list[str] = []
    for path, tree in trees.items():
        rel = path.relative_to(PACKAGE_ROOT.parent)
        for node in ast.walk(tree):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "model_copy"
            ):
                continue
            for keyword in node.keywords:
                if keyword.arg != "update" or not isinstance(keyword.value, ast.Dict):
                    continue
                for key, value in zip(keyword.value.keys, keyword.value.values, strict=True):
                    if not (isinstance(key, ast.Constant) and key.value in field_names):
                        continue
                    reason = _dict_source(value, dict_returning)
                    if reason:
                        offenders.append(
                            f"{rel}:{node.lineno}  {key.value!r} ← {reason}\n"
                            f"      {ast.unparse(value)[:90]}"
                        )

    assert not offenders, "\n".join(
        [
            "`model_copy(update=...)` 가 모델 타입 필드에 dict 를 넣는다 —",
            "그 경로는 **검증을 하지 않으므로** 값이 dict 로 남고 직렬화에서 경고가 난다.",
            "허용 목록을 만들지 말고 **값을 만드는 쪽이 모델을 돌려주게** 고칠 것:",
            *offenders,
        ]
    )
