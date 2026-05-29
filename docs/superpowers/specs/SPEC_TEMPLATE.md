# [Feature/Change Name] — Design

**Date**: YYYY-MM-DD
**Status**: Draft | Approved | Superseded
**Scope**: 영향받는 핵심 파일/모듈 (콤마 분리)

> 새 spec을 작성할 때 이 파일을 복사해서 시작한다. **Invariants**와
> **Invariant impact** 섹션은 [ADR-0045](../../adr/0045-spec-declares-invariants.md)에
> 의해 필수다 — trivial한 변경이라도 빈 섹션을 명시적으로 둔다.

## Problem

해결하려는 문제. 사용자/시스템 관점에서 무엇이 잘못되었는지 또는 무엇이
빠져있는지. 가능하면 사용자 표현 인용.

## Invariants

이 spec이 건드리는 시스템(또는 추가되는 분기)이 **현재 보존하고 있는**
속성들. 수학적 등식, UI 불변량, 데이터 일관성 조건, 도메인 규칙 등.

각 항목은 *그 시스템을 모르는 검토자도 이해할 수 있게* 한 줄로:

- **[Invariant 1 이름]**: [한 줄 정의]. 근거: [코드/ADR/spec 위치].
- **[Invariant 2 이름]**: [한 줄 정의]. 근거: [...].

> 예시 (`2026-05-24-replay-wheel-right-wall-design.md`가 명시했어야 할 것):
> - **Mouse-anchor ratio preservation**: ctrl+wheel zoom 전후로 anchor의 화면
>   비율 `p = (anchor - from)/(to - from)`이 보존된다 — 즉 마우스 위치의 캔들이
>   화면상 같은 픽셀에 머무른다. 근거: [wheelInteractions.ts](../../../frontend/src/util/wheelInteractions.ts).
> - **Right-wall: `to ≤ lastBarIndex` after first user-initiated rightward motion**:
>   shift+pan-right와 ctrl+wheel-out이 last candle 너머로 `to`를 밀지 않는다.
>   근거: 이전 spec.

trivial한 변경이라 보존할 invariant가 없으면:

- *없음 — 이 spec은 새 분리 모듈을 추가하며 기존 시스템 속성을 건드리지 않음.*

## Invariant impact

위 invariant 각각에 대해 이 spec의 변경이:

- **보존(preserves)**
- **조건부로 깸(breaks conditionally)** — 어떤 조건에서 깨는지, 검출 가능한지
- **의도적으로 깸(intentionally breaks)** — trade-off의 정당화 필수

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Mouse-anchor ratio preservation | preserves | 양쪽 변에 같은 factor를 곱하는 수식 사용 |
| Right-wall: `to ≤ lastBarIndex` | intentionally breaks (ctrl-zoom 한정) | anchor 보존을 우선시. shift-pan branch에서는 유지. |

"intentionally breaks"가 있다면 그 줄 아래에 **왜** 이 trade-off가 정당한지
한 문단으로 적는다. 사용자에게 제시되어 동의받을 수 있는 형태로.

## Goals

이 변경이 달성하려는 것들. 측정 가능한 형태가 이상적.

## Non-Goals

이 spec의 범위 밖. 명시적으로 다루지 않는 인접 문제들.

## Design

구체적인 설계 — module 구조, 인터페이스, 데이터 흐름, 알고리즘 등.

### [하위 섹션들을 자유롭게 추가]

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| ... | ... | ... |

**Invariant 회귀 테스트**: 위 "보존" invariant 각각에 대해 회귀 테스트가
있어야 한다. 예: anchor ratio preservation의 경우
`(anchor - newFrom)/(newTo - newFrom) === pBefore`를 검증.

### Manual verification

`/replay`, `/live` 등 실제 페이지에서 확인할 시나리오.

## Risks / Open questions

알려진 위험과 미해결 질문. 후속 spec/ADR으로 다룰 항목.

## Out of Scope (Backlog)

지금은 안 하지만 같이 적어두고 싶은 follow-up.
