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

#: **기본값 있는 키워드 전용 `venue`** 를 가진 함수가 사는 모듈 — 새로 생기면 여기
#: 추가한다. 아래 `test_guarded_list_covers_every_module` 가 누락을 잡는다.
GUARDED = (
    _HOGA / "api" / "bundle.py",
    _HOGA / "api" / "past_indicators_cache.py",
    _HOGA / "api" / "queries.py",
    _HOGA / "api" / "heatmap_group_flow.py",
    _HOGA / "live" / "api.py",
    _HOGA / "live" / "promote.py",
    # 아래 넷은 **등록 누락 감사가 잡아서** 들어왔다 — 손으로 훑을 때 `async def` 를
    # 통째로 빠뜨렸다. 목록을 사람이 적는 한 같은 일이 또 생기므로 그 감사가 있다.
    _HOGA / "live" / "kiwoom_adjust_factors.py",
    _HOGA / "live" / "kiwoom_daily_candles.py",
    _HOGA / "live" / "kiwoom_minute_candles.py",
    _HOGA / "live" / "kiwoom_multi_quote.py",
)


def _call_name(node: ast.Call) -> str | None:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _risky_functions(tree: ast.Module) -> set[str]:
    """**기본값 있는 키워드 전용** `venue` 를 받는 함수 이름.

    판정식이 이 형태인 이유가 이 가드의 핵심이다. venue 파라미터는 셋으로 갈리는데
    **위험한 것은 하나뿐이다**:

      * `venue: Venue`(기본값 없는 위치인자) — 안 넘기면 `TypeError`. 언어가 이미
        막으므로 가드가 필요 없다.
      * `*, venue: Venue`(기본값 없는 키워드 전용) — 같은 이유로 안전하다.
      * `*, venue: Venue = "KRX"`(**기본값 있는 키워드 전용**) — 안 넘겨도 조용히
        KRX 로 떨어진다. **여기만 위험하다.**

    기본값 있는 **위치**인자는 일부러 뺐다. 위치로 넘긴 것을 AST 로 확인하려면
    피호출부 시그니처와 인자 순서를 맞춰야 하고, 그 매칭이 틀리면 위양성이 난다 —
    상시 빨간 가드는 무시되기 시작해 메커니즘 전체를 죽인다. 키워드 전용은 반드시
    `venue=` 로 넘겨야 하므로 **위양성이 원리적으로 0**이다.
    """
    out: set[str] = set()
    for n in ast.walk(tree):
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        names = [a.arg for a in n.args.kwonlyargs]
        if "venue" not in names:
            continue
        if n.args.kw_defaults[names.index("venue")] is not None:
            out.add(n.name)
    return out


@pytest.mark.parametrize("path", GUARDED, ids=lambda p: p.name)
def test_no_call_drops_venue(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    risky = _risky_functions(tree)
    assert risky, f"{path.name}: 대상 함수를 하나도 못 찾았다 — 파서가 덜 읽고 있다"

    dropped = [
        f"{path.name}:{n.lineno} {_call_name(n)}(...)"
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and _call_name(n) in risky
        and not any(k.arg == "venue" for k in n.keywords)
    ]
    assert not dropped, (
        "venue 를 받는 함수를 venue 없이 부른다 → 피호출부 기본값 KRX 로 조용히 떨어진다:\n  "
        + "\n  ".join(dropped)
    )


def test_guarded_list_covers_every_module() -> None:
    """감시 목록이 전수인지 — **등록을 잊는 실패 모드**를 막는다.

    `GUARDED` 는 손으로 적는 목록이라 새 모듈이 생기면 조용히 무방비가 된다. 그런데
    테스트는 여전히 초록이라 보호받는 줄 안다. 여기서 그 침묵을 깬다: `hoga/` 전체를
    스캔해 대상 함수가 있는 모듈을 찾고 목록과 대조한다.

    이 가드가 왜 필요한지는 이력이 말해 준다 — 원래 목록은 `bundle.py` 하나였고,
    그래서 `past_indicators_cache._poc_path` 의 venue 누락을 열흘 넘게 못 봤다.
    """
    found = {
        p
        for p in _HOGA.rglob("*.py")
        if _risky_functions(ast.parse(p.read_text(encoding="utf-8")))
    }
    missing = sorted(str(p.relative_to(_HOGA)) for p in found - set(GUARDED))
    assert not missing, (
        "기본값 있는 키워드 전용 venue 를 가진 모듈이 감시 목록에 없다 — GUARDED 에 추가할 것:\n  "
        + "\n  ".join(missing)
    )
