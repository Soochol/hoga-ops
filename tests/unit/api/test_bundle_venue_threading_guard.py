"""`hoga/api/bundle.py` 안에서 venue 를 받는 함수를 venue 없이 부르는 곳이 없는지.

**막는 방향**: 호출부가 `venue=` 를 빠뜨려 피호출부의 기본값(`Venue = "KRX"`)으로
조용히 떨어지는 것. 이 파일의 슬라이스 빌더는 전부 `engine.parquet_dir(..., venue=venue)`
로 디스크 경로를 정하므로, 누락은 곧 **다른 시장 데이터를 그 시장 것처럼** 읽는 것이다.
b64036f5(ADR-0140) 가 15곳에 venue 를 꿰면서 안쪽 호출 **5곳**을 빠뜨렸고, 증상은 두
갈래로 나왔다 — 프리마켓처럼 KRX 캡처 디렉터리가 아직 없는 시각엔 StockDateNotFound 로
`/api/range?mode=sidecar` 가 통째로 500(히트맵·매도벽·POC·증감 동시 소실), 그 밖의
시각엔 NXT/UN 차트에 KRX 값이 조용히 실렸다.

**못 보는 것** (세 가지, 다 의도적):
  * `bundle.py` **밖**의 호출부. 이 파일 안의 함수끼리만 본다.
  * `**kwargs` 나 `functools.partial` 로 넘기는 간접 전달 — AST 로 키워드가 안 보이면
    "누락" 으로 읽는다. 그런 호출을 새로 쓰면 이 가드가 위양성을 내므로, 그때는
    가드를 끄지 말고 호출을 명시적으로 쓰거나 여기에 사유와 함께 예외를 등록한다.
  * **값이 맞는지**. "venue 를 넘겼나" 만 본다. 잘못된 venue 를 넘기는 것은 못 잡는다.

**등록 의존 없음** — 이름 규칙이 아니라 `venue` 파라미터의 존재로 대상을 고른다.
자동 발견이 오탐/누락을 둘 다 조용히 내는 자리(#1199)가 아니라, 판정 근거가 AST 에
그대로 있는 자리라서 그렇다.
"""
from __future__ import annotations

import ast
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[3] / "hoga" / "api" / "bundle.py"


def _call_name(node: ast.Call) -> str | None:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def test_no_call_in_bundle_drops_venue() -> None:
    tree = ast.parse(BUNDLE.read_text(encoding="utf-8"))
    takes_venue = {
        n.name
        for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef)
        and any(a.arg == "venue" for a in [*n.args.args, *n.args.kwonlyargs])
    }
    assert takes_venue, "venue 를 받는 함수를 하나도 못 찾았다 — 파서가 덜 읽고 있다"

    dropped = [
        f"{BUNDLE.name}:{n.lineno} {_call_name(n)}(...)"
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and _call_name(n) in takes_venue
        and not any(k.arg == "venue" for k in n.keywords)
    ]
    assert not dropped, (
        "venue 를 받는 함수를 venue 없이 부른다 → 피호출부 기본값 KRX 로 조용히 떨어진다:\n  "
        + "\n  ".join(dropped)
    )
