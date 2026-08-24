"""스크리너는 KIS 를 부르지 않는다 — ADR-0136 계약의 기계적 가드.

## 왜 필요한가

ADR-0136 은 폴링 REST 표면 11개를 키움으로 전면 이관하고 KIS 를 **파생(옵션·선물)
전용**으로 축소했다. 그 ADR 이 남긴 계약 문장은 이것이다:

> 남는 KIS 코드의 유일한 정당성은 파생(옵션)이다. 파생 아닌 용도로 KIS 를 다시
> 부르는 코드는 이 ADR 위반이다.

**그 문장을 지금까지 아무 기계도 지키지 않았다.** 스크리너는 그 이관의 최대 소비자다
— 일봉(`ka10081`) · 장중 시세(`ka10095`) · 종목 마스터(`ka10099`) · 거래일 달력(정적
시드)이 전부 스크리너를 거친다. 되돌아갈 자리가 넓다.

되돌아가는 방식은 악의가 아니라 **관성**이다. 이 리포에는 KIS 시절의 주석·라벨이
오래 남아 있었고(2026-08-24 정리), 그 문서를 읽고 "여기는 KIS 를 쓰는 자리" 라고
결론내는 것이 자연스러웠다. 사람이 그렇게 읽었다면 다음 사람도 그렇게 읽는다.

## 막는 방향과 못 보는 것

**막는다**: 스크리너 모듈에서 **정적 import 로 새로 도달하게 되는** KIS 모듈.
전이적으로 본다 — 스크리너가 직접 import 하지 않아도 3단계 건너서 닿으면 잡힌다.
상대 import(``from . import kis_runtime``)도 푼다.

**못 본다**, 넷:

1. **동적 import** — ``importlib.import_module(name)`` 의 name 이 계산되면 AST 는
   모른다.
2. **주입** — 호출자가 이미 만든 ``KisClient`` 를 인자로 넘기면 import 가 안 생긴다.
3. **모듈 없는 직접 호출** — ``httpx`` 로 KIS 호스트를 직접 때리는 코드.
4. **스크리너 밖** — 이 가드는 스크리너 축만 본다. ADR-0136 계약 전체(다른 비파생
   표면에서의 KIS 부활)는 여전히 사람이 지킨다.

즉 이것은 **가장 흔한 복귀 경로 하나**를 닫는 가드이지 계약의 증명이 아니다.

## 등록 의존

새 스크리너 모듈을 **등록할 필요는 없다** — 파일명에 ``screener`` 가 들어가면 자동으로
시드가 된다(:func:`_screener_seed_modules`). 반대로 :data:`_ALLOWED_KIS_EDGES` 는
**손으로 등록**하는 허용 목록이고, 여기에 줄을 더하는 것이 이 가드를 무력화하는
유일한 방법이다. 그래서 각 줄은 사유를 달고, 사유는 "왜 이것이 데이터 소스가 아닌가"
여야 한다.

이 테스트가 빨개지면 **허용 목록에 추가하는 것은 답이 아니다.** 실패 메시지가 찍는
경로를 따라가 그 import 를 없애는 것이 답이다.
"""

from __future__ import annotations

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = REPO_ROOT / "hoga"

#: 허용되는 「비-KIS 모듈 → KIS 모듈」 간선. 각 항목은 **데이터 소스가 아닌 이유**를 단다.
_ALLOWED_KIS_EDGES: dict[tuple[str, str], str] = {
    ("hoga.live.error_policy", "hoga.live.kis_client"): (
        "예외 타입만 가져온다(KisApiError·KisAuthError·KisRateLimitError·KisTransportError). "
        "ADR-0136 이 '에러 모델은 error_policy.py 재사용' 으로 명시 승인한 자리다 — "
        "두 벤더의 예외를 한 처방 테이블로 번역하려면 양쪽 타입이 다 필요하다."
    ),
}


def _module_name(path: Path) -> str:
    return ".".join(path.relative_to(REPO_ROOT).with_suffix("").parts)


def _import_targets(tree: ast.Module, package: str) -> set[str]:
    """모듈이 이름 붙이는 모든 ``hoga.*`` 대상. 절대·상대 import 를 함께 푼다.

    ``from hoga.live import kiwoom_access`` 처럼 **서브모듈을 이름으로 가져오는** 형태가
    흔하므로, ``base`` 뿐 아니라 ``base.<alias>`` 도 후보로 낸다. 실재하는 모듈인지는
    :func:`_resolve` 가 가린다.
    """
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                base = ".".join(parts[: len(parts) - node.level + 1])
                if node.module:
                    base = f"{base}.{node.module}"
            else:
                base = node.module or ""
            if not base:
                continue
            out.add(base)
            out.update(f"{base}.{alias.name}" for alias in node.names)
    return {t for t in out if t == "hoga" or t.startswith("hoga.")}


def _build_graph() -> dict[str, set[str]]:
    graph: dict[str, set[str]] = {}
    for path in sorted(PACKAGE_ROOT.rglob("*.py")):
        module = _module_name(path)
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover — 파싱 실패는 다른 게이트가 잡는다
            continue
        graph[module] = _import_targets(tree, module.rsplit(".", 1)[0])
    return graph


def _resolve(target: str, graph: dict[str, set[str]]) -> str | None:
    """``hoga.live.kiwoom_daily_candles.fetch_daily_candles`` → 실재하는 최장 모듈 접두."""
    while target and target not in graph:
        target = target.rsplit(".", 1)[0] if "." in target else ""
    return target or None


def _screener_seed_modules(graph: dict[str, set[str]]) -> list[str]:
    return sorted(m for m in graph if "screener" in m.rsplit(".", 1)[-1])


def _is_kis_module(module: str) -> bool:
    return module.rsplit(".", 1)[-1].startswith("kis_")


def _reachable_kis_edges(graph: dict[str, set[str]]) -> dict[tuple[str, str], list[str]]:
    """스크리너에서 도달 가능한 「비-KIS → KIS」 간선 → 시드까지의 경로."""
    parent: dict[str, str] = {}
    seen: set[str] = set()
    edges: dict[tuple[str, str], list[str]] = {}
    queue = _screener_seed_modules(graph)
    while queue:
        module = queue.pop()
        if module in seen:
            continue
        seen.add(module)
        for target in graph.get(module, ()):
            resolved = _resolve(target, graph)
            if resolved is None or resolved == module:
                continue
            if _is_kis_module(resolved) and not _is_kis_module(module):
                chain, cur = [resolved, module], module
                while cur in parent:
                    cur = parent[cur]
                    chain.append(cur)
                edges.setdefault((module, resolved), list(reversed(chain)))
            if resolved not in seen:
                parent.setdefault(resolved, module)
                queue.append(resolved)
    return edges


def test_screener_reaches_no_unapproved_kis_module() -> None:
    graph = _build_graph()
    seeds = _screener_seed_modules(graph)
    assert seeds, "스크리너 모듈을 하나도 못 찾았다 — 탐침이 고장났다(파일명 규칙 변경?)"

    edges = _reachable_kis_edges(graph)
    unapproved = {edge: chain for edge, chain in edges.items() if edge not in _ALLOWED_KIS_EDGES}
    assert not unapproved, "\n".join(
        [
            "스크리너에서 승인되지 않은 KIS 모듈에 정적으로 도달한다 (ADR-0136 위반).",
            "허용 목록에 추가하지 말고 아래 경로의 import 를 없앨 것:",
            *(f"  {src} -> {dst}\n    경로: {' -> '.join(chain)}" for (src, dst), chain in sorted(unapproved.items())),
        ]
    )


def test_allowlist_has_no_dead_entries() -> None:
    """허용 목록이 실재하지 않는 간선을 담고 있으면 그 줄은 죽은 면제다.

    죽은 면제는 조용히 범위를 넓힌다 — 나중에 같은 이름의 간선이 **다른 이유로**
    생기면 이미 승인된 것처럼 통과한다.
    """
    edges = _reachable_kis_edges(_build_graph())
    dead = sorted(edge for edge in _ALLOWED_KIS_EDGES if edge not in edges)
    assert not dead, f"허용 목록의 죽은 항목 — 지울 것: {dead}"
