---
description: Brainstorming → spec → grill → plan → review → execute → verify → architecture → simplify → review 전체 파이프라인 오케스트레이션
---

# Full Pipeline (brainstorming → review)

이 슬래시 커맨드는 9단계 파이프라인을 끝까지 오케스트레이션한다. 각 단계는 Skill 도구로 해당 스킬을 invoke해서 실행한다. 단계 사이에 **GATE** 표시가 있는 곳은 반드시 사용자 응답을 기다린다 — 자동으로 다음 단계로 넘어가지 말 것.

## 인자

사용자가 이 커맨드와 함께 자유 텍스트로 주제를 적었으면 그것이 brainstorming의 시작 토픽이다. 비어 있으면 사용자에게 한 줄로 "이번 파이프라인의 주제는 무엇입니까?"를 물어본 뒤 시작한다.

## Auto-decision 정책

이 파이프라인은 두 곳에서 자동 결정을 적용한다:

- **grill-with-docs**: 문서(CONTEXT.md / docs/adr/) 변경은 자동 적용. 만약 grill이 코드 변경을 제안하면 그것은 plan에 반영해야 하므로 spec/plan 파일 수정으로 처리하고 코드는 건드리지 않는다.
- **improve-codebase-architecture**: 자동 적용한다. 사후 검증에서 실패가 발견되면 fix-forward(디버깅 스킬로 원인 수정)로만 대응한다. 자동 rollback / 자동 revert는 하지 않는다.

다른 단계의 결정은 모두 사용자 확인을 받는다.

### Architecture auto-apply 안전망

improve-codebase-architecture 단계의 auto-apply는 다음 절차를 따른다:

1. **체크포인트 커밋** — 단계 7 시작 직전 Bash 도구로 working tree에 변경이 있으면 `git add -A && git commit -m "checkpoint: pre-architecture refactor"` 를 실행한다. clean이면 `git rev-parse HEAD` 출력만 변수로 보관해둔다. 이 체크포인트는 자동 복구에는 쓰지 않고, 사용자가 나중에 수동으로 되돌리고 싶을 때 참조점이 된다.
2. **사후 검증** — 모든 제안 적용 후 단계 6의 검증 명령을 재실행한다(`uv run pytest` + scope가 frontend/both이면 `cd frontend && npm run build`). 실패하면 `superpowers:systematic-debugging` 또는 `diagnose` 스킬을 invoke해서 fix-forward 한다. 검증이 통과할 때까지 fix-forward를 반복하되, **연속 3회 실패하면 멈추고** 사용자에게 현재 상태(실패 로그 + `git diff <체크포인트 SHA>..HEAD --stat`)를 보고하고 지시를 기다린다.

## 파이프라인

### 1. Brainstorming → Spec

Skill 도구로 `superpowers:brainstorming` 을 invoke한다. 스킬의 절차에 따라 spec 파일이 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 에 작성되고 git에 커밋될 때까지 진행한다.

**GATE 1**: 스킬이 사용자에게 spec 리뷰를 요청하면 거기서 멈춘다. 사용자가 spec을 승인할 때까지 다음 단계로 가지 않는다.

### 2. Grill with docs

Skill 도구로 `grill-with-docs` 를 invoke한다. spec 파일 경로를 컨텍스트로 전달한다.

자동 결정 규칙:
- CONTEXT.md / ADR 문서 변경 제안 → **자동 적용 + 사용자에게 한 줄 보고**
- spec 파일 수정 제안 → **자동 적용 + diff를 사용자에게 보여주기**
- 코드 변경 제안 → **plan 단계로 이월** (지금은 적용하지 않음, 메모만 남김)

스킬 종료 후 한 줄 보고: "grill 단계 완료. 단계 3 /writing-plans 로 자동 진행합니다." 사용자 응답을 기다리지 않고 곧바로 단계 3을 시작한다.

### 3. Writing plans

Skill 도구로 `superpowers:writing-plans` 를 invoke한다. spec 파일과 grill에서 누적된 메모를 입력으로 전달한다.

plan 파일이 `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md` 에 작성될 때까지 진행한다. plan 파일 첫머리에 다음 필드를 강제로 포함시킨다:

```yaml
scope: frontend | backend | both
```

### 4. Plan reviews (parallel)

plan의 `scope` 값에 따라 분기:

- `scope: backend` → Agent 도구로 `/plan-eng-review` 만 실행
- `scope: frontend` → Agent 도구로 `/plan-design-review` 만 실행
- `scope: both` → **두 review를 병렬로** Agent 도구로 동시에 실행 (한 메시지에서 두 Agent 호출)

review 결과 머지 규칙:
- **Blocker / Critical** 피드백 → plan 파일에 자동 반영
- **Suggestion / Nit** → plan 끝에 `## Deferred review notes` 섹션에 누적
- **두 review의 충돌** → 양쪽 의견을 정리해서 사용자에게 어느 쪽을 따를지 묻기

**GATE 2**: 머지된 plan을 사용자에게 보여주고 "이대로 실행할까요?" 승인 대기.

### 5. Subagent-driven development

Skill 도구로 `superpowers:subagent-driven-development` 를 invoke한다. 승인된 plan 파일 경로를 전달한다.

스킬이 종료될 때까지 진행한다.

### 6. Verification gate

검증 게이트를 실행한다:

1. Bash 도구로 `uv run pytest` 실행 (백엔드 테스트)
2. plan의 scope가 frontend 또는 both 인 경우, Bash 도구로 `cd frontend && npm run build` 실행
3. 두 명령이 모두 성공할 때까지 실패를 수정한다 (`superpowers:systematic-debugging` 또는 `diagnose` 스킬을 필요 시 invoke)

검증 통과 후 한 줄 보고: "테스트 N개 통과, frontend 빌드 통과. 단계 7로 자동 진행합니다." 사용자 응답을 기다리지 않고 곧바로 단계 7을 시작한다.

### 7. Improve codebase architecture (auto-apply)

먼저 "Architecture auto-apply 안전망" 절차 1번(체크포인트 커밋)을 실행한다.

그 다음 Skill 도구로 `improve-codebase-architecture` 를 invoke한다. **scope는 이번 세션에서 변경된 파일로 제한**한다 — Bash 도구로 `git diff --name-only main...HEAD` 의 출력을 컨텍스트로 전달한다. 스킬은 제안을 자동으로 적용하도록 한다.

적용이 끝나면 "Architecture auto-apply 안전망" 절차 2번(사후 검증)을 실행한다. 검증을 통과하면 단계 8로 넘어간다. 실패하면 안전망 절차에 따라 fix-forward를 시도한다.

### 8. Simplify (current session only)

Skill 도구로 `simplify` 를 invoke한다. 컨텍스트:

- 대상 파일: `git diff --name-only main...HEAD` 의 출력 (단계 7에서 추가된 파일까지 포함)
- 제약: 기능 변경 금지, 가독성/중복 제거/효율성만 다룰 것

스킬 종료 후 변경사항을 사용자에게 요약 보고한다.

### 9. Review (current session only)

Skill 도구로 `review` 를 invoke한다. 컨텍스트는 단계 8과 동일한 파일 범위.

review에서 발견된 critical 이슈는 즉시 수정하고, nit은 사용자에게 보고만 한다.

### 10. Landing 안내

파이프라인 종료. 사용자에게 다음 옵션을 안내한다:

> "전체 파이프라인 완료. 다음 중 어떻게 마무리할까요?
> - (A) /ship — 자동 PR 생성
> - (B) gh pr create — 수동 PR 생성
> - (C) 더 다듬을 곳이 있어서 land하지 않음"

여기서 자동 진행하지 말고 사용자 선택을 기다린다.

## 중간 중단

사용자가 어느 단계에서든 "중단", "stop", "취소" 라고 응답하면 즉시 멈추고 현재 상태(어느 단계, 어떤 파일이 변경되었는지)를 한 줄로 보고한다.

## 시작

이 커맨드의 첫 응답은 다음과 같다:

1. 인자(주제)를 확인하고, 없으면 묻는다.
2. 파이프라인의 9단계를 한 줄씩 보여주며 "이 흐름으로 진행합니다. 1단계 brainstorming 시작합니다." 라고 알린다.
3. 1단계를 시작한다.
