"""venue 를 받는 함수를 venue 없이 부르는 곳이 없는지 — 감시 대상 파일별로.

**막는 방향**: 호출부가 `venue=` 를 빠뜨려 피호출부의 기본값(`Venue = "KRX"`)으로
조용히 떨어지는 것. 감시 대상들은 venue 로 **디스크 경로**를 정하므로, 누락은 곧
**다른 시장 데이터를 그 시장 것처럼** 읽거나 쓰는 것이다.

b64036f5(ADR-0140) 가 15곳에 venue 를 꿰면서 안쪽 호출 **5곳**을 빠뜨렸고, 증상은 두
갈래로 나왔다 — 프리마켓처럼 KRX 캡처 디렉터리가 아직 없는 시각엔 StockDateNotFound 로
`/api/range?mode=sidecar` 가 통째로 500(히트맵·매도벽·POC·증감 동시 소실), 그 밖의
시각엔 NXT/UN 차트에 KRX 값이 조용히 실렸다.

**`past_indicators_cache.py` 가 감시 대상에 늦게 들어온 이유**가 이 가드의 존재 이유를
가장 잘 보여 준다. 같은 커밋(b64036f5)이 `_poc_path` 의 **시그니처만** 고치고 본문에
`venue=venue` 를 안 꿰었는데, 형제인 `_peak_path` 는 둘 다 고쳤다. 타입체커는 기본값이
있는 키워드 인자를 안 넘겨도 만족하므로 침묵했고, 후속 감사(#1285)도 `bundle.py` 안만
봐서 놓쳤다. 그 사이 실데이터에 흔적이 남았다 — 실측 2026-08-17, `kiwoom_live` 아래
`trade_volume_poc` 캐시가 KRX 276개 / NXT 0개 / UN 0개인데, 올바른 `_peak_path` 쪽은
61 / 3 / 3 이었다.

**못 보는 것** (세 가지, 다 의도적):
  * 감시 대상 **밖**의 호출부. 각 파일 안의 함수끼리만 본다.
  * `**kwargs` 나 `functools.partial` 로 넘기는 간접 전달 — AST 로 키워드가 안 보이면
    "누락" 으로 읽는다. 그런 호출을 새로 쓰면 이 가드가 위양성을 내므로, 그때는
    가드를 끄지 말고 호출을 명시적으로 쓰거나 여기에 사유와 함께 예외를 등록한다.
    (`past_indicators_cache._store_dir` 은 이 확장 때 venue 를 **키워드 전용**으로
    승격해 위양성을 없앴다 — 가드에 예외를 다는 것보다 호출을 명시적으로 만드는 쪽이
    낫다. 이제 위치 전달은 타입 수준에서 불가능하다.)
  * **값이 맞는지**. "venue 를 넘겼나" 만 본다. 잘못된 venue 를 넘기는 것은 못 잡는다.

**등록 의존 없음** — 이름 규칙이 아니라 `venue` 파라미터의 존재로 대상을 고른다.
자동 발견이 오탐/누락을 둘 다 조용히 내는 자리(#1199)가 아니라, 판정 근거가 AST 에
그대로 있는 자리라서 그렇다. 다만 **감시할 파일 목록은 등록 의존**이다 — venue 로
디스크 경로를 정하는 모듈을 새로 만들면 여기 추가해야 한다.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

_HOGA = Path(__file__).resolve().parents[3] / "hoga"

#: venue 로 디스크 경로를 정하는 모듈 — 새로 생기면 여기 추가한다.
GUARDED = (
    _HOGA / "api" / "bundle.py",
    _HOGA / "api" / "past_indicators_cache.py",
)


def _call_name(node: ast.Call) -> str | None:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


@pytest.mark.parametrize("path", GUARDED, ids=lambda p: p.name)
def test_no_call_drops_venue(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    takes_venue = {
        n.name
        for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef)
        and any(a.arg == "venue" for a in [*n.args.args, *n.args.kwonlyargs])
    }
    assert takes_venue, f"{path.name}: venue 를 받는 함수를 하나도 못 찾았다 — 파서가 덜 읽고 있다"

    dropped = [
        f"{path.name}:{n.lineno} {_call_name(n)}(...)"
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and _call_name(n) in takes_venue
        and not any(k.arg == "venue" for k in n.keywords)
    ]
    assert not dropped, (
        "venue 를 받는 함수를 venue 없이 부른다 → 피호출부 기본값 KRX 로 조용히 떨어진다:\n  "
        + "\n  ".join(dropped)
    )
