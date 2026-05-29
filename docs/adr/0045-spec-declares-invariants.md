# 0045 — Spec은 보존되는 invariant와 변경이 그것을 깨는지 명시한다

**Status:** accepted (2026-05-28)

**Related:**
- `docs/feature-development-workflow.md` — brainstorming 단계 산출물 게이트
- `docs/superpowers/specs/SPEC_TEMPLATE.md` — 신규 spec template
- `docs/superpowers/specs/2026-05-24-replay-wheel-right-wall-design.md` — 사례
- `frontend/src/util/wheelInteractions.ts` — 수정된 코드

## Decision

`/superpowers:brainstorming` 단계가 산출하는 **모든 design spec은** 다음 두 섹션을
필수로 포함한다:

1. **Invariants** — 기존 시스템(또는 추가되는 분기)이 보존해야 하는 속성을 명시.
   수학적으로 보존되는 등식, UI 불변량(예: "마우스 위치의 캔들은 화면상 같은
   픽셀에 머무른다"), 데이터 일관성 조건 등.
2. **Invariant impact** — 이 spec의 변경이 위 invariant 각각을 **보존하는지,
   조건부로 깨는지, 의도적으로 깨는지**를 한 줄씩 명시. "의도적으로 깬다"인
   경우 그 trade-off의 정당화를 함께 기재.

template 구조와 작성 예시는 [SPEC_TEMPLATE.md](../superpowers/specs/SPEC_TEMPLATE.md)에
있다.

## Why

세 가지 대안:

**A. spec에 invariant 명시 필수화** ← 채택

근거:
- ADR-0045가 만들어진 직접 계기는 `2026-05-24-replay-wheel-right-wall-design.md`다.
  이 spec은 ctrl/cmd zoom-out에 right-wall clamp를 추가했는데, ctrl-zoom의
  핵심 invariant — "마우스 anchor의 화면 비율 `p = (anchor-from)/(to-from)`이
  zoom 전후로 보존된다" — 가 spec에 한 번도 명시되지 않았다.
- 결과적으로 clamp이 `to`만 자르고 `from`은 유지하는 분기(line 61의 표)가
  spec 검토를 통과했고, "anchor effectively migrates to the right edge"라는
  표현으로 invariant 위반이 의도된 동작으로 문서화됐다. 사용자가 보고한
  "zoom-out 시 마우스 위치 캔들이 이동" 버그가 정확히 이것이다.
- spec에 invariant 섹션이 있었다면 clamp 분기의 "newTo만 변경"이 비율 보존을
  깬다는 점이 spec 단계에서 시각화됐을 것이다.

핵심 원리: **invariant는 코드 변경의 정합성을 판정하는 기준이지만, 명시되지
않은 invariant는 검토자가 알아채지 못한다.** Tacit knowledge로 두면 동일한
부류의 버그가 spec 단계에서 통과해 구현·테스트까지 흘러간다.

**B. invariant는 코드 주석이나 테스트로 충분하다**

거부 사유:
- 주석은 *지금 보존되는* invariant를 기록하지만, *spec의 변경이 그것을 깰지*는
  검토하지 못한다 — 주석을 읽는 단계는 이미 구현 단계다.
- 테스트도 마찬가지로 사후 검증 도구다. spec 검토는 *작성 전* 단계라서 invariant를
  사전에 노출시키는 장치가 별도로 필요하다.
- right-wall spec에는 8개 단위 테스트 case가 있었지만 anchor 비율 보존을 검증하는
  케이스가 없었다. invariant가 spec에 명시되지 않았기 때문이다.

**C. spec template 없이 brainstorming skill prompt만 수정**

거부 사유:
- `/superpowers:brainstorming` skill은 marketplace cache(`~/.claude/plugins/cache/...`)에
  있어 프로젝트가 직접 소유하지 않는다. plugin 업그레이드 시 수정이 사라진다.
- 프로젝트 내 template 파일은 영구적이고 사람이 참조하기 쉽다. 변경이 코드와
  함께 review를 받는다.

## How — Enforcement

- 신규 spec 작성 시 [SPEC_TEMPLATE.md](../superpowers/specs/SPEC_TEMPLATE.md)의
  Invariants / Invariant impact 섹션을 채운다.
- [docs/feature-development-workflow.md](../feature-development-workflow.md)의
  brainstorming 게이트는 "spec에 두 섹션이 채워짐"을 요구한다.
- `/grill-with-docs` 1차 단계에서 invariant 누락도 함께 체크한다 — 기존 ADR과의
  정합성 검토 시 자연스럽게 함께 본다.

## What this does NOT mandate

- 모든 spec이 동일한 invariant 목록을 가져야 한다는 것은 아니다. invariant는
  *그 spec이 건드리는 시스템의* 보존 속성이고, 시스템마다 다르다.
- 기존 spec(`docs/superpowers/specs/`에 이미 commit된 것들)을 소급해서 재작성하지
  않는다. 새 spec과 새 ADR부터 적용한다.
- "trivial한 변경"에도 의식적으로 빈 Invariants 섹션을 두는 것은 OK다 — *없다*는
  것 자체가 검토 정보다.
