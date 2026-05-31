---
description: full-flow v2 — 10단계 파이프라인 + 워크플로우 보강(plan-stage 선차단·워크트리 격리·flake 루프·adversarial-verify·Findings Ledger). 큰 변경에서만 워크플로우가 켜진다.
---

# Full Pipeline v2 (brainstorming → review, workflow-augmented)

이 슬래시 커맨드는 10단계 파이프라인을 끝까지 오케스트레이션한다. 각 단계는 Skill 도구로 해당 스킬을 invoke해서 실행하되, **워크플로우 게이트가 참인 단계에서는 Workflow 도구로 다중 에이전트 오케스트레이션을 추가**한다. 단계 사이에 **GATE** 표시가 있는 곳은 반드시 사용자 응답을 기다린다 — 자동으로 다음 단계로 넘어가지 말 것.

v1(`/full-flow`)과의 차이는 §"워크플로우 보강"에 정의된 6개 augmentation뿐이다. 게이트가 거짓이면 v2는 v1과 **동일하게** 동작한다(단일 에이전트/순차). 큰 변경에서만 워크플로우가 켜져 비용을 정당화한다.

## 인자

사용자가 이 커맨드와 함께 자유 텍스트로 주제를 적었으면 그것이 brainstorming의 시작 토픽이다. 비어 있으면 사용자에게 한 줄로 "이번 파이프라인의 주제는 무엇입니까?"를 물어본 뒤 시작한다.

## Auto-decision 정책

이 파이프라인은 두 곳에서 자동 결정을 적용한다:

- **grill-with-docs**: 문서(CONTEXT.md / docs/adr/) 변경은 자동 적용. 만약 grill이 코드 변경을 제안하면 그것은 plan에 반영해야 하므로 spec/plan 파일 수정으로 처리하고 코드는 건드리지 않는다.
- **improve-codebase-architecture**: 자동 적용한다. 단, §"워크플로우 보강"의 **adversarial-verify 게이트를 반드시 통과한 발견만** 적용한다. 사후 검증에서 실패가 발견되면 fix-forward(디버깅 스킬로 원인 수정)로만 대응한다. 자동 rollback / 자동 revert는 하지 않는다.

다른 단계의 결정은 모두 사용자 확인을 받는다.

### Architecture auto-apply 안전망

improve-codebase-architecture 단계의 auto-apply는 다음 절차를 따른다:

1. **체크포인트 커밋** — 단계 7 시작 직전 Bash 도구로 working tree에 변경이 있으면 `git add -A && git commit -m "checkpoint: pre-architecture refactor"` 를 실행한다(공유 워크트리라면 `git add -A` 대신 §"커밋 안전"을 따라 명시 경로만 스테이징). clean이면 `git rev-parse HEAD` 출력만 변수로 보관해둔다. 이 체크포인트는 자동 복구에는 쓰지 않고, 사용자가 나중에 수동으로 되돌리고 싶을 때 참조점이 된다.
2. **사후 검증** — 모든 제안 적용 후 단계 6의 검증 게이트를 재실행한다. 실패하면 `superpowers:systematic-debugging` 또는 `diagnose` 스킬을 invoke해서 fix-forward 한다. 검증이 통과할 때까지 fix-forward를 반복하되, **연속 3회 실패하면 멈추고** 사용자에게 현재 상태(실패 로그 + `git diff <체크포인트 SHA>..HEAD --stat`)를 보고하고 지시를 기다린다.

## 워크플로우 보강 (공유 프리미티브)

> v2의 핵심. 여러 단계가 아래를 공유한다. **새 무거운 인프라는 Findings Ledger(JSONL 1개)뿐**이고, 나머지는 "어느 단계에서 어떤 워크플로우 패턴을 쓰라"는 지시다.

### 워크플로우 게이트

각 단계의 워크플로우 augmentation은 다음 중 **하나라도 참이면 켜고**, 모두 거짓이면 기존(단일 에이전트/순차) 동작 그대로 둔다:

- plan의 `scope: both`, 또는
- 변경이 파일 **3개 이상**에 걸침, 또는
- 새 타입 / 도메인 용어를 **도입·개명**, 또는
- **async/타이밍/teardown/동시성** 코드를 건드림(WebSocket·스레드·타이머·asyncio·fixture teardown 등).

게이트가 거짓이면 워크플로우를 띄우지 말 것 — 토큰 낭비다. 단계별로 "게이트 거짓일 때의 fallback"을 명시한다.

`Workflow` 도구는 **명시적 멀티에이전트 오케스트레이션에 사용자가 옵트인했을 때만** 호출 가능하다. 이 커맨드의 단계 지시가 곧 그 옵트인이다(사용자가 `/full-flow-v2`를 실행 = 워크플로우 사용 승인). 게이트가 참인 단계에서 Workflow를 호출하고, 거짓이면 호출하지 않는다.

### (1) 공유 리뷰 렌즈 세트

plan/리뷰 단계가 **분담해** 쓰는 렌즈(중복 비용 방지 — 같은 렌즈를 두 단계가 다시 돌리지 않는다):

- `eng` — 정확성·태스크 순서/의존성·테스트 전략·마이그레이션 안전 (기존 `/plan-eng-review`)
- `design` — UI/UX·DESIGN.md 토큰 (기존 `/plan-design-review`; **scope∈{frontend,both}일 때만**)
- `type-design` — payload/이벤트가 타입을 갖나? `Record<string,unknown>`/`Any`/dict 냄새, 약한 경계
- `naming` — CONTEXT.md 용어(ubiquitous language) 일치, **마이그레이션이 남기는 죽은 이름**(예: 전송 교체 후 잔존하는 옛 모듈/타입명)
- `dry-consistency` — 흩어진 매직넘버/상수, 파일 간 중복 로직

렌즈 분담: **stage 3** = type-design/naming/dry (plan 텍스트 대상), **stage 4** = eng/design + 잔여, **stage 9** = correctness + type-design/naming/dry + 용어. 이미 처리된 렌즈는 다음 단계가 다시 돌리지 않는다(Ledger로 dedup).

#### 렌즈를 기존 스킬 논조로 구동하는 법 (3가지 방식)

`eng`·`design`처럼 **이미 디스크에 스킬이 있는 렌즈**는 그 스킬의 논조(체크리스트·관점)를 워크플로우 에이전트의 재료로 쓴다. 세 방식 중 하나를 택한다:

- **방식 B (권장 — `agentType`)**: `agent(prompt, { agentType: 'plan-eng-review', schema: FINDINGS })`. Agent 도구와 같은 레지스트리에서 그 에이전트의 시스템 프롬프트를 통째로 적용하고, 거기에 schema 지시가 자동으로 덧붙는다. 가장 깔끔.
- **방식 A (파일 주입)**: agentType 등록이 없거나 논조만 일부 빌릴 때 — 프롬프트에 "`~/.claude/skills/plan-eng-review/SKILL.md`를 읽고 그 eng-manager 렌즈로 평가하라"고 지시한다.
- **방식 C (논조 차용 + 새 charter)**: type-design/naming/dry처럼 대응 스킬이 없는 렌즈는 새 charter를 직접 쓴다. naming 렌즈는 `checking-domain-terms` 스킬을, dry는 repo grep을 재료로 삼는다.

두 가지 **필수 변환** (스킬은 원래 워크플로우용이 아니다):

1. **무인화** — `plan-eng-review`·`plan-design-review`·`improve-codebase-architecture` 등은 frontmatter `interactive: true`로 *사용자에게 질문하며* 진행한다. 워크플로우 에이전트는 무인이므로, 스킬의 **체크리스트·논조만** 차용하고 `AskUserQuestion`/대화 루프는 **건너뛴 채** 구조화 발견만 낸다. (충돌·판단이 필요한 항목은 발견의 `needs-human` 플래그로 올려 GATE에서 사람에게.)
2. **schema 구조화** — 스킬은 산문 리뷰를 낸다. 워크플로우에서 종합하려면 `schema`로 `{lens, severity, claim, evidence{file,line}, proposed_edit}` 구조화 출력을 **강제**해야 머지된다. 논조는 스킬에서, 형식은 schema에서.

### (2) Adversarial-verify 게이트

Blocker/Critical 발견은 **적용 전에** 검증 에이전트가 거른다: "이 주장을 *반증*해보라; 인용 코드를 재확인하고, 명백한 반대 증거가 있을 때만 강등하라(기본은 발견 유지 — 보수적)." 판정 `confirmed | overstated | wrong`. `wrong`은 드롭, `overstated`는 강등. Suggestion/Nit은 검증 스킵(토큰 절약).

- stage 4·7·9 공용.
- **stage 7(롤백 없는 auto-apply)에서는 필수** — 비가역 편집의 보험.

### (3) Findings Ledger

경로: `docs/superpowers/plans/YYYY-MM-DD-<topic>-findings.jsonl`. 발견마다 한 줄:

```json
{"id":"f001","provenance":"plan-3|plan-4|arch-7|review-9","file":"...","line":0,"claim":"...","kind":"type-design|naming|dry|coupling|magic-number|dead-code|correctness|altitude","severity":"Blocker|Critical|Suggestion|Nit","status":"open|applied|deferred|refuted|escalated","evidence_ref":"..."}
```

- **오케스트레이터(이 커맨드를 실행하는 메인 루프)만 append.** 서브에이전트도, 두 단계도 동시에 쓰지 않는다 — 동시 append는 index race를 재현한다.
- **stage 4가 seed**(Blocker/Critical→open, Suggestion/Nit/deferred-memo→deferred). stage 3도 자신의 발견을 기록(provenance=plan-3).
- **stage 7·9는 시작 시 Ledger를 먼저 읽어**: 이미 `applied`면 드롭(재발견 방지), `deferred`인데 코드에 여전히 존재하면 `escalated`로 승격. 같은 부채를 plan→감사→review에서 세 번 cold-refind하는 것을 막는다.

### 커밋 안전 (공유 워크트리)

이 worktree가 다른 세션/에이전트와 공유될 수 있다. 모든 단계에서:
- **`git add -A`/`git add .`/`git add -u` 금지.** 자신이 만든/수정한 파일만 명시 경로로 스테이징.
- 서브에이전트가 커밋하기 전 `git status --porcelain`로 내 파일만 스테이징됐는지 확인.
- 인덱스 충돌 의심 시 `git commit --only <paths>`로 공유 인덱스를 우회.

## 파이프라인

### 1. Brainstorming → Spec

Skill 도구로 `superpowers:brainstorming` 을 invoke한다. spec 파일이 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 에 작성되고 git에 커밋될 때까지 진행한다.

**워크플로우(선택, green-field만)**: 설계가 신규 서브시스템/새 데이터 모델이고 접근법이 요청에 의해 이미 정해져 있지 **않을 때만**, intent가 분명해진 뒤 spec 작성 전에 Workflow로 접근법 분기 fan-out을 1회 돌린다(에이전트 2-3명이 경쟁 접근법 스켈레톤을 독립 제안 → 오케스트레이터가 divergence 축을 정리해 **사용자에게 advisory로** 제시, 자동 채택 금지). 증분 변경(흔한 경우)이면 **건너뛴다** — 단일 에이전트+대화가 더 싸다.

**GATE 1**: 스킬이 사용자에게 spec 리뷰를 요청하면 거기서 멈춘다. 사용자가 spec을 승인할 때까지 다음 단계로 가지 않는다.

### 2. Grill with docs

Skill 도구로 `grill-with-docs` 를 invoke한다. spec 파일 경로를 컨텍스트로 전달한다.

**워크플로우(선택)**: 게이트가 참이면, 대화를 시작하기 **전에** Workflow로 completeness-critic 패널(`type-design`/`naming`/`dry-consistency` 렌즈, 단발 병렬)을 spec+CONTEXT.md+ADR에 대조해 돌리고, 그 발견을 grill의 **질문 backlog**(상위 ~8개)로 넘긴다. 대화(Q&A) 자체는 단일 컨텍스트로 두고 fan-out하지 않는다 — 적응적 후속 질문이 grill의 가치이기 때문. 발견은 자동 편집이 아니라 grill 질문 씨앗이므로 오탐 비용은 질문 1개.

자동 결정 규칙:
- CONTEXT.md / ADR 문서 변경 제안 → **자동 적용 + 사용자에게 한 줄 보고**
- spec 파일 수정 제안 → **자동 적용 + diff를 사용자에게 보여주기**
- 코드 변경 제안 → **plan 단계로 이월** (지금은 적용하지 않음, 메모만 남김)

스킬 종료 후 한 줄 보고: "grill 단계 완료. 단계 3 writing-plans 로 자동 진행합니다." 사용자 응답을 기다리지 않고 곧바로 단계 3을 시작한다.

### 3. Writing plans

Skill 도구로 `superpowers:writing-plans` 를 invoke한다. spec 파일과 grill에서 누적된 메모를 입력으로 전달한다.

plan 파일이 `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md` 에 작성될 때까지 진행한다. plan 파일 첫머리에 다음 필드를 강제로 포함시킨다:

```yaml
scope: frontend | backend | both
```

**워크플로우(plan critic 패널 — 게이트 참이면 YES)**: plan 작성 직후 Workflow로:
- **Phase A(병렬)**: `type-design`/`naming`/`dry-consistency` 렌즈가 *plan 텍스트*를 CONTEXT.md·ADR·대상 소스에 대조해 발견을 낸다. 각 발견 `{lens, severity, claim, plan_section_ref, proposed_plan_edit}`. **plan의 `## Deferred` 메모도 스캔해, 코드로 예방 가능한 것은 Blocker/Critical로 승격**(deferred-memo가 묻혀 사후 부채가 되는 함정 차단).
- **Phase B(검증)**: 각 Blocker/Critical을 adversarial-verify로 거른다.
- **머지**: 검증 통과 Blocker/Critical은 plan에 반영(stage 4와 동일 머지 규칙), Suggestion/Nit은 `## Deferred review notes`. 모두 Findings Ledger에 기록(provenance=plan-3).
- eng/design 렌즈는 stage 4가 담당하므로 여기서는 **돌리지 않는다**(중복 방지).

게이트 거짓이면 이 패널을 건너뛴다(plan 그대로 stage 4로).

### 4. Plan reviews

**게이트 거짓(사소한 변경)** → v1 동작: plan의 `scope`에 따라 `/plan-eng-review`(backend) / `/plan-design-review`(frontend) / 둘 병렬(both)을 Agent로 실행.

**게이트 참** → Workflow로 3-Phase 리뷰:
- **Phase A(병렬 fan-out, read-only)**: 모든 에이전트에 **동일 입력**(plan 파일 + plan이 작성된 git SHA + CONTEXT.md + docs/adr/ + 대상 소스 트리)을 by-value로 준다. 렌즈 = `eng` + (frontend면 `design`) + stage 3이 안 본 잔여 렌즈. 각 반환 `{lens, severity, claim, evidence{file,line}, proposed_edit}`. 스킬-기반 렌즈는 §"렌즈를 기존 스킬 논조로 구동하는 법"의 **방식 B**를 기본으로 — 예:
  ```js
  await parallel([
    () => agent(planReviewPrompt, { agentType: 'plan-eng-review',    schema: FINDINGS, phase: 'Review' }),
    () => agent(planReviewPrompt, { agentType: 'plan-design-review', schema: FINDINGS, phase: 'Review' }), // scope∈{frontend,both}만
    () => agent(typeDesignCharter,  { schema: FINDINGS, phase: 'Review' }), // 방식 C: 새 charter
    () => agent(namingCharter,      { schema: FINDINGS, phase: 'Review' }),
    () => agent(dryCharter,         { schema: FINDINGS, phase: 'Review' }),
  ])
  ```
  `agentType`이 해당 환경에 등록돼 있지 않으면 방식 A(스킬 파일 경로를 프롬프트에 주입)로 폴백한다. 모든 스킬-기반 렌즈는 §의 두 변환(무인화 + schema 구조화)을 적용한다 — `AskUserQuestion`/대화 루프는 돌리지 말고 구조화 발견만 낸다.
- **Phase B(병렬, Blocker/Critical마다 검증자 1명)**: adversarial-verify(`confirmed|overstated|wrong`). Nit은 스킵. 보수적 강등.
- **Phase C(단일 에이전트, 결정론적 머지)**: 확정분만 규칙대로 산출 — `plan_patches`(정확한 old_text 매칭; 불일치 시 fuzzy 적용 금지하고 사용자에게 보고), `deferred_appends`, `conflicts`, `convergence`(다중 렌즈 합의 = 고신뢰 신호).

머지 규칙:
- **Blocker / Critical**(검증 통과) → plan 파일에 자동 반영
- **Suggestion / Nit** → plan 끝 `## Deferred review notes` 섹션에 누적
- **렌즈 간 충돌** → 양쪽 의견을 정리해 GATE 2에서 사용자에게 묻기
- 모든 발견은 Findings Ledger에 기록(provenance=plan-4). **stage 3이 이미 처리한 발견은 드롭.**

**GATE 2**: 머지된 plan + (있으면) convergence/conflicts를 사용자에게 보여주고 "이대로 실행할까요?" 승인 대기. 워크플로우는 GATE 2 패킷 생산까지만 — 승인 게이트를 건너뛰지 않는다.

### 5. Subagent-driven development

Skill 도구로 `superpowers:subagent-driven-development` 를 invoke한다. 승인된 plan 파일 경로를 전달한다.

**동시성/격리 규칙(필수 — git index race 재발 방지):**
- 구현 서브에이전트는 **순차가 기본**. 공유 워크트리에 절대 병렬 디스패치하지 말 것.
- **병렬은 게이트 참 + 태스크 독립(파일 글롭 비중첩)일 때만**: Workflow로
  - Phase 0(오케스트레이터): plan 태스크의 depends_on/파일 글롭으로 DAG를 만들어 wave로 분할(글롭 겹치면 같은 wave 금지 = 순차).
  - Phase 1(wave별 fan-out, 동시 ≤3): 태스크마다 `EnterWorktree`로 **인덱스 격리** 후 per-task PIPELINE — 1a 구현(글롭 밖 파일 금지·커밋 금지) → 1b spec-review(스펙 일치, scope creep) → 1c quality-review(**공유 렌즈: naming/type-design/dry** — diff가 작을 때 잡는 게 가장 쌈) → 1d fix 루프(최대 2회, 실패 시 BLOCKED로 사용자 보고, merge 안 함).
  - Phase 2(**커밋 배리어, 직렬 단일 라이터 = 오케스트레이터만**): wave 내 태스크 id 순서로 PASS 브랜치를 **하나씩** 통합 브랜치에 merge, 매 merge 후 `git status --porcelain` 검사(반쪽 커밋 즉시 포착), `ExitWorktree`. 예기치 않은 dirty면 halt+보고.
- 게이트 거짓이거나 단일 태스크면 워크트리 fan-out 없이 순차 구현→리뷰. per-task 리뷰 게이트(spec→quality)는 항상 적용.
- 커밋은 §"커밋 안전"(명시 경로만).

스킬/워크플로우가 종료될 때까지 진행한다.

### 6. Verification gate

검증 게이트를 실행한다:

1. Bash 도구로 `uv run pytest` 실행 (백엔드 테스트)
2. plan의 scope가 frontend 또는 both 인 경우, Bash 도구로 `cd frontend && npm run build` 실행
3. 두 명령이 모두 성공할 때까지 실패를 수정한다 (`superpowers:systematic-debugging` 또는 `diagnose` 스킬을 필요 시 invoke)
4. **Flake 게이트**: 변경이 async/타이밍/teardown/동시성 코드를 건드렸으면(또는 이번 세션에 flake를 한 번이라도 봤으면) 스위트를 **여러 번 반복** 실행한다(기본 1회 → 해당 시 5회 → 재발 시 10회; 에이전트 없이 Bash 반복, 첫 실행은 고정 seed 후 seed/order 변주). 단 1회라도 실패하면 flaky로 보고하고 트레이스를 캡처해 디버깅 스킬로 **근본 원인 수정**(sleep/retry 같은 미봉책 금지). 첫 실패 발견 시 루프 중단(한 번만 실패해도 flaky 증명).
5. **green 검증(adversarial)**: "정말 green인가"를 검증 에이전트가 확인 — 0개 수집 / 전부 skip / xfail-as-pass / 삼켜진 teardown 에러(CancelledError·ResourceWarning) / 경고억제 빌드가 아닌지(masked-green 차단). skip/xfail 수는 절대값이 아니라 baseline 대비로 판정.

검증 통과 후 한 줄 보고: "테스트 N개 통과(× M회 안정), frontend 빌드 통과. 단계 7로 자동 진행합니다." 사용자 응답을 기다리지 않고 곧바로 단계 7을 시작한다.

### 7. Improve codebase architecture (auto-apply)

먼저 "Architecture auto-apply 안전망" 절차 1번(체크포인트 커밋)을 실행한다.

발견을 모은다: `improve-codebase-architecture` 스킬의 자체 탐색 + 세션 변경 파일(`git diff --name-only main...HEAD`)을 읽는 강한 리뷰어 1명. diff가 타입/프로토콜 경계를 넘으면 `type-design` 렌즈 1개를 추가(convergence 확보). 각 발견을 Ledger 스키마로.

> 주의: `improve-codebase-architecture` 스킬의 본래 절차는 "후보를 제시하고 사용자에게 무엇을 탐색할지 묻는" **대화형**이다. v2의 무인 auto-apply에서는 §"렌즈를 기존 스킬 논조로 구동하는 법"의 **무인화 변환**을 적용 — 스킬의 **탐색·용어(glossary) 단계만** 사용하고, 적용은 아래 워크플로우의 verify→apply 기계로 한다(스킬의 "사용자에게 질문" 단계는 건너뛴다).

- **Ledger 선독**: 이미 `applied`면 드롭, plan에서 `deferred`인데 코드에 남아있으면 `escalated`.
- **adversarial-verify(필수)**: auto-apply 후보마다 검증자가 인용 코드를 재확인(`confirmed|refuted|needs-human`, 보수적). refuted/needs-human은 Ledger에 deferred로 남기고 **적용하지 않는다**.
- **적용(직렬 단일 라이터 = 오케스트레이터)**: confirmed 발견을 (severity, file) 순으로 하나씩 적용, 발견마다 체크포인트.

적용이 끝나면 "Architecture auto-apply 안전망" 절차 2번(사후 검증 = 단계 6 게이트 재실행)을 실행한다. 통과하면 단계 8로, 실패하면 안전망 절차에 따라 fix-forward.

### 8. Simplify (current session only)

Skill 도구로 `simplify` 를 **단일 에이전트로** invoke한다(워크플로우 아님 — 단일 축 품질 패스라 fan-out 불필요). 컨텍스트:

- 대상 파일: `git diff --name-only main...HEAD` 의 출력 (단계 7에서 추가된 파일까지 포함)
- 제약: 기능 변경 금지, 가독성/중복 제거/효율성만 다룰 것
- **별도 auto-apply 패스로 같은 파일을 또 편집하지 말 것**(stage 7과 이중 편집 → thrash). 발견은 Ledger에 적고, 적용은 stage 7의 verify→apply 경로를 재사용하거나 단순(behavior-preserving) 변경만 직접 한다.

스킬 종료 후 변경사항을 사용자에게 요약 보고한다.

### 9. Review (current session only)

**게이트 거짓** → v1 동작: `review` 스킬 단일 실행. critical 즉시 수정, nit은 보고만.

**게이트 참** → Workflow로 경량 judge-panel:
- **Phase A(병렬)**: `correctness`(`review` 스킬 본업 — §의 방식 B `agentType: 'review'` 또는 방식 A) + `type-design`/`naming`/`dry-consistency` + 용어(CONTEXT.md, `checking-domain-terms` 재사용) 렌즈. 스킬-기반 렌즈는 §의 두 변환(무인화 + schema 구조화)을 적용. 각 발견 Ledger 스키마(provenance=review-9).
- **Phase B(Ledger 대조)**: `applied`면 드롭, plan-deferred인데 diff에 여전히 있으면 `escalated{leaked_from_plan:true}`, 신규만 남김.
- **Phase C(검증)**: critical마다 adversarial-verify → confirmed만 수정 루프(직렬 단일 라이터, 수정 후 단계 6 게이트 재실행).

critical은 즉시 수정, nit은 사용자에게 보고만. 모든 발견 Ledger 기록.

### 10. Landing 안내

파이프라인 종료. 사용자에게 다음 옵션을 안내한다:

> "전체 파이프라인 완료. 다음 중 어떻게 마무리할까요?
> - (A) /ship — 자동 PR 생성
> - (B) gh pr create — 수동 PR 생성
> - (C) 더 다듬을 곳이 있어서 land하지 않음"

여기서 자동 진행하지 말고 사용자 선택을 기다린다.

## 중간 중단

사용자가 어느 단계에서든 "중단", "stop", "취소" 라고 응답하면 즉시 멈추고 현재 상태(어느 단계, 어떤 파일이 변경되었는지, Findings Ledger 경로)를 한 줄로 보고한다.

## 시작

이 커맨드의 첫 응답은 다음과 같다:

1. 인자(주제)를 확인하고, 없으면 묻는다.
2. 파이프라인의 10단계를 한 줄씩 보여주고, **워크플로우 게이트 평가 결과**(이번 작업에서 워크플로우가 켜질지/꺼질지 + 이유)를 한 줄로 알린 뒤 "이 흐름으로 진행합니다. 1단계 brainstorming 시작합니다." 라고 알린다.
3. 1단계를 시작한다.
