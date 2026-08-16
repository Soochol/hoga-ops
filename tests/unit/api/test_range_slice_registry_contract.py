"""**RangeBundle Slice** 등록이 실제 코드와 어긋나지 않게 하는 양방향 가드.

슬라이스 하나가 화면에 닿으려면 서로를 모르는 명시 열거 목록을 전부 지나가야 한다 —
요청 술어 · 캐시 키 · placeholder 호환 · 델타 병합 · 번들 조립 · 백엔드 게이트 ·
과거일 캐시. 어느 하나가 빠져도 타입은 통과하고 증상은 한참 뒤에 온다. 호가벽
급증(``wall_surge``)이 그래서 PR 세 건(#1321 → #1325 → #1333)에 걸쳐 들어왔다.

``frontend/src/api/rangeSlices.ts`` 가 그 축들을 손으로 선언하고, 이 파일이 선언과
코드를 대조한다. ADR-0004 가 기각한 codegen 이 **아니다** — 손 미러를 유지한 채
어긋남만 검출한다.

## 이 가드가 닫는 방향

1. **정방향** — 등록에 적힌 축이 실제 코드에 그렇게 있는가.
2. **역방향** — ``RangeBundle`` 에 있는 슬라이스가 등록에 있는가. 발견원은 **pydantic
   모델**이라 이름 규칙 추측이 아니다(자동 발견은 #1199 가 오탐·누락 둘 다 조용하다는
   이유로 기각했다).

## 이 가드가 **못 보는 것**

- 병합 규칙이 **옳은지**는 안 본다. ``unfiltered`` 라고 적혀 있고 코드도 그렇다는 것만
  본다 — 그 선택이 맞는지(백엔드가 prefix 집계인가)는 사람이 판단한다.
- 프론트가 그 데이터를 **실제로 렌더하는지**는 안 본다. 배선과 픽셀은 다른 층이다.
- 양쪽이 **함께** 움직인 드리프트는 못 본다(등록과 코드를 같이 고치면 조용히 통과한다).
- 등록에 **없는** 축은 애초에 보지 않는다. 척도 환산은 여기 없다 —
  ``test_range_price_scale_contract.py`` 가 필드 단위로 이미 덮으므로, 같은 사실을 두
  목록이 들어 서로 갈리는 것을 피했다.

## 등록을 편집할 때

엔트리는 **중첩 없는 평평한 리터럴**이어야 한다. 아래 파서가 ``{...}`` 안에 ``{`` 가
없다고 가정하므로, 중첩·스프레드·계산값이 들어오면 엔트리를 못 읽고 그건 에러가 아니라
**조용한 미등록**이 된다 — 파서 결함이 드리프트로 위장하는 실패다. 그래서
``test_registry_parser_sees_every_entry`` 가 파싱 자체를 따로 검증한다.
"""
from __future__ import annotations

import re
from pathlib import Path

from hoga.api import models as m
from hoga.api.past_indicators_cache import KIND_VERSIONS

_REPO_ROOT = Path(__file__).resolve().parents[3]
_REGISTRY = _REPO_ROOT / "frontend/src/api/rangeSlices.ts"
_RANGE_REQUEST = _REPO_ROOT / "frontend/src/api/rangeRequest.ts"
_RANGE_TS = _REPO_ROOT / "frontend/src/api/range.ts"
_BUILD_LIVE_BUNDLE = _REPO_ROOT / "frontend/src/live/buildLiveBundle.ts"
_ROUTES = _REPO_ROOT / "hoga/api/routes.py"

# ``RangeBundle`` 의 스칼라 필드 — 슬라이스가 아니다(ADR-0013 의 범위 식별자).
_SCALAR_FIELDS = frozenset({"code", "from_date", "to_date", "bucket_ms"})

# 슬라이스에 대응하지 않는 캐시 kind 와 그 사유. 늘리려면 사유를 함께 적는다.
_NON_SLICE_CACHE_KINDS: dict[str, str] = {
    "continuous_before": "volume_distributions 계산의 보조값이라 wire 필드가 없다",
}


def _strip_ts_comments(text: str) -> str:
    """TS 주석 제거. ``test_range_price_scale_contract.py`` 의 같은 기법이다 —
    주석에 남은 이름을 코드로 착각하면 가드가 **초록으로 샌다**(그쪽 파일이 red-check
    에서 실제로 그렇게 새는 것을 확인했다)."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?m)//.*$", "", text)


def _balanced_block(text: str, header: str, opener_token: str = "{", *, last: bool = False) -> str:
    """``header`` 뒤 ``opener_token`` 부터 균형이 맞는 닫힘까지. 없으면 실패시킨다 —
    빈 문자열을 돌려주면 이후 검사가 전부 "등장하지 않음" 으로 조용히 기울어진다.

    ``opener_token`` 이 한 글자가 아닌 이유를 두 실측이 만들었다. 배열 선언에서 ``{`` 를
    찾으면 **첫 원소만** 잡히고, ``[`` 를 찾으면 타입 표기 ``RangeSliceSpec[]`` 의 빈
    괄호가 먼저 걸려 **빈 블록**이 나온다. 그래서 ``= [`` 처럼 대입까지 포함해 지목한다.
    """
    opener = opener_token[-1]
    closer = {"{": "}", "[": "]"}[opener]
    start = text.rindex(header) if last else text.index(header)
    open_at = text.index(opener_token, start) + len(opener_token) - 1
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == opener:
            depth += 1
        elif text[i] == closer:
            depth -= 1
            if depth == 0:
                return text[open_at : i + 1]
    raise AssertionError(f"{header!r} 의 블록이 닫히지 않는다 — 파서가 볼 수 없는 형태다")


def _declares(block: str, field: str) -> bool:
    """객체 리터럴이 ``field`` 를 담는가. ``field:`` 와 shorthand ``field,`` 를 모두 본다 —
    shorthand 를 빠뜨리면 ``segments`` 처럼 이름이 같은 변수로 실리는 항목을 못 본다."""
    return re.search(rf"^\s+{field}[,:]", block, flags=re.M) is not None


def _value(entry: str, key: str) -> str | int | bool | None:
    m_ = re.search(rf"\b{key}:\s*('(?:[^'\\]|\\.)*'|null|true|false|-?\d+)", entry)
    assert m_, f"등록 엔트리에 {key} 가 없다: {entry[:80]!r}"
    raw = m_.group(1)
    if raw == "null":
        return None
    if raw in ("true", "false"):
        return raw == "true"
    if raw.startswith("'"):
        return raw[1:-1]
    return int(raw)


def _registry() -> list[dict[str, str | int | bool | None]]:
    text = _strip_ts_comments(_REGISTRY.read_text(encoding="utf-8"))
    body = _balanced_block(text, "RANGE_BUNDLE_SLICES", "= [")
    entries = []
    for raw in re.findall(r"\{([^{}]*)\}", body, flags=re.S):
        if "field:" not in raw:
            continue
        entries.append(
            {
                key: _value(raw, key)
                for key in (
                    "field",
                    "httpFlag",
                    "requestOption",
                    "queryKeyIndex",
                    "placeholderCompatible",
                    "backendGate",
                    "mergeRule",
                    "inChartBundle",
                    "cacheKind",
                    "note",
                )
            }
        )
    return entries


def _wire_slice_fields() -> frozenset[str]:
    return frozenset(m.RangeBundle.model_fields) - _SCALAR_FIELDS


def test_registry_parser_sees_every_entry() -> None:
    """파서가 엔트리를 다 읽는가 — **파서 결함은 드리프트로 위장한다.**

    아래 검사들은 전부 "등록에 있는가" 를 묻는데, 파서가 엔트리를 놓치면 그 슬라이스는
    조용히 검사 대상에서 빠진다. 그래서 개수를 wire 필드 수와 직접 맞춘다.
    """
    entries = _registry()
    assert len(entries) == len(_wire_slice_fields()), (
        f"등록 엔트리 {len(entries)}개 vs RangeBundle 슬라이스 필드 "
        f"{len(_wire_slice_fields())}개. **원인이 둘이고 처방이 다르다** — "
        "(1) 슬라이스를 추가·삭제하고 등록을 안 고쳤거나, "
        "(2) 엔트리에 중첩 객체·스프레드·계산값이 들어가 파서가 그것을 못 읽거나. "
        "함께 실패한 test_registry_covers_exactly_the_wire_slices 가 어느 쪽인지 말해 준다: "
        "거기에 **이름이 찍히면 (1)**, 이름은 다 맞는데 개수만 어긋나면 (2)다."
    )
    assert len({e["field"] for e in entries}) == len(entries), "등록에 중복 field 가 있다"


def test_registry_covers_exactly_the_wire_slices() -> None:
    """역방향 — 발견원은 **pydantic 모델**이라 이름 규칙 추측이 아니다."""
    registered = {e["field"] for e in _registry()}
    actual = set(_wire_slice_fields())
    missing = actual - registered
    extra = registered - actual
    assert registered == actual, (
        f"RANGE_BUNDLE_SLICES 가 RangeBundle 과 어긋난다. "
        f"등록에 없는 슬라이스={sorted(missing)} 모델에 없는 등록={sorted(extra)}. "
        "슬라이스를 추가했다면 frontend/src/api/rangeSlices.ts 에 같은 PR 에서 등록한다."
    )


def test_http_flags_match_the_route_signature() -> None:
    routes_src = _ROUTES.read_text(encoding="utf-8")
    signature = routes_src[routes_src.index("async def api_range(") : routes_src.index("-> RangeBundle:")]
    declared = set(re.findall(r"^\s{8}(\w+):", signature, flags=re.M))
    for entry in _registry():
        flag, field = entry["httpFlag"], entry["field"]
        if flag is None:
            continue
        assert flag in declared, (
            f"{field} 의 httpFlag={flag!r} 가 /api/range 시그니처에 없다. "
            "라우트에 Query 를 추가하거나 등록을 null 로 고친다."
        )


def test_request_options_match_the_frontend_request_builder() -> None:
    text = _strip_ts_comments(_RANGE_REQUEST.read_text(encoding="utf-8"))
    options_block = _balanced_block(text, "type RangeRequestOptions", "= {")
    declared = set(re.findall(r"^\s+(\w+)\??:", options_block, flags=re.M))
    for entry in _registry():
        option, field = entry["requestOption"], entry["field"]
        if option is None:
            continue
        assert option in declared, (
            f"{field} 의 requestOption={option!r} 가 RangeRequestOptions 에 없다. "
            "프론트가 이 슬라이스를 요청으로 끌 수 없다는 뜻이면 등록을 null 로 고친다."
        )


def test_placeholder_compatibility_matches_the_index_list() -> None:
    """``placeholderCompatible`` 이 실제 상수와 맞는가.

    이 축이 어긋나면 옵션을 바꿔도 placeholder 가 유지돼 **옛 데이터가 화면에 남는다**.
    그런데 기존 테스트들은 새 인덱스를 양쪽 키에서 같은 값으로 고정하므로 누락이
    무증상이다 — 실제로 venue·depth_delta 가 그렇게 빠져 있었다(#1340).
    """
    text = _strip_ts_comments(_RANGE_REQUEST.read_text(encoding="utf-8"))
    block = _balanced_block(text, "PLACEHOLDER_COMPATIBLE_KEY_INDICES", "= [")
    indices = {int(n) for n in re.findall(r"\d+", block)}
    for entry in _registry():
        index, field = entry["queryKeyIndex"], entry["field"]
        expected = entry["placeholderCompatible"]
        if index is None:
            assert expected is False, f"{field}: queryKeyIndex 가 없는데 placeholderCompatible=true"
            continue
        assert (index in indices) is expected, (
            f"{field}: queryKeyIndex={index} 의 placeholder 호환이 "
            f"등록({expected})과 PLACEHOLDER_COMPATIBLE_KEY_INDICES({index in indices})에서 다르다. "
            "queryKey 에 축을 더하면 그 목록도 같이 늘린다."
        )


def test_merge_rules_match_the_delta_merger() -> None:
    """``spread`` 는 최상위 ``...next`` 로 낙착된다는 뜻이므로 병합 함수에 **없어야** 한다.

    이 방향이 중요하다 — 병합 항목을 빠뜨리면 청크를 이어 붙일 때마다 앞 구간이 통째로
    사라지는데(#1333), 그때 코드에는 아무 흔적이 없다.
    """
    text = _strip_ts_comments(_RANGE_TS.read_text(encoding="utf-8"))
    block = _balanced_block(text, "export function mergeRangeBundles")
    for entry in _registry():
        field, rule = entry["field"], entry["mergeRule"]
        present = _declares(block, str(field))
        if rule == "spread":
            assert not present, (
                f"{field}: 등록은 mergeRule='spread'(병합 없음)인데 mergeRangeBundles 에 항목이 있다."
            )
        else:
            assert present, (
                f"{field}: 등록은 mergeRule={rule!r} 인데 mergeRangeBundles 에 항목이 없다 — "
                "최상위 ...next 로 낙착돼 좌측 팬에서 앞 구간이 사라진다(#1333)."
            )


def test_chart_bundle_membership_matches_the_builder() -> None:
    text = _strip_ts_comments(_BUILD_LIVE_BUNDLE.read_text(encoding="utf-8"))
    fn = _balanced_block(text, "function buildChartBundle")
    # 마지막 ``return {`` — 함수 안에 early return 이 있어도 최종 조립을 잡는다.
    returned = _balanced_block(fn, "return {", last=True)
    for entry in _registry():
        field, expected = entry["field"], entry["inChartBundle"]
        present = _declares(returned, str(field))
        assert present is expected, (
            f"{field}: buildChartBundle 반환 목록 등장 여부가 등록({expected})과 실제({present})에서 "
            "다르다. 캔들 경로 번들에서 빠지면 '응답엔 있고 화면엔 없는' 형태가 된다(#1333)."
        )


def test_cache_kinds_match_kind_versions() -> None:
    registered = {str(e["cacheKind"]) for e in _registry() if e["cacheKind"] is not None}
    unknown = registered - set(KIND_VERSIONS)
    assert not unknown, f"KIND_VERSIONS 에 없는 cacheKind: {sorted(unknown)}"
    unmapped = set(KIND_VERSIONS) - registered - set(_NON_SLICE_CACHE_KINDS)
    assert not unmapped, (
        f"슬라이스에 대응하지 않는 캐시 kind: {sorted(unmapped)}. 등록의 cacheKind 를 채우거나 "
        "_NON_SLICE_CACHE_KINDS 에 사유와 함께 넣는다."
    )


def test_unresolved_asymmetries_are_written_down() -> None:
    """축이 빈 슬라이스는 **사유를 갖는다.**

    비대칭 자체는 결함이 아니다(정당한 것이 여럿 있다). 어디에도 기록되지 않은 결손이
    문제다 — 다음 사람이 그것을 의도로 읽을지 누락으로 읽을지 알 방법이 없다.
    """
    for entry in _registry():
        if entry["backendGate"] is not None and entry["httpFlag"] is None:
            assert entry["note"], (
                f"{entry['field']}: 백엔드 게이트는 있는데 HTTP 토글이 없다 — "
                "의도라면 note 에 사유를 적는다."
            )
        if entry["cacheKind"] is None and entry["httpFlag"] is not None:
            assert entry["note"], (
                f"{entry['field']}: 옵션 슬라이스인데 과거일 캐시 kind 가 없다 — "
                "의도라면 note 에 사유를 적는다."
            )
