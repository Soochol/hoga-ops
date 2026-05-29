# 신규 Feature 개발 워크플로우

신규 feature를 개발할 때 따르는 표준 체인. 이 프로젝트의 `CONTEXT.md`(ubiquitous language) + `docs/adr/`(누적 결정) 자산을 최대한 활용하도록 설계됨.

## 체인

```
/superpowers:brainstorming
  → spec 파일 commit + user 승인 gate
  → /grill-with-docs                              (CONTEXT.md/ADR 동기화)
  → /superpowers:writing-plans
  → /plan-eng-review
  → (plan 변경 시) /grill-with-docs               (조건부)
  → /superpowers:using-git-worktrees              (격리된 작업공간 생성)
  → /superpowers:subagent-driven-development
  → /improve-codebase-architecture
  → (가치 있으면) ADR draft + commit
  → /checking-domain-terms                        (CONTEXT.md ubiquitous language 사후 검증)
  → /superpowers:verification-before-completion   (최종 게이트 — refactor 후 회귀 차단)
  → /superpowers:finishing-a-development-branch   (worktree 정리 + merge/PR)
```

## 각 단계 역할

| 단계 | 산출물 | 게이트 |
|------|--------|--------|
| `/superpowers:brainstorming` | spec 초안 ([SPEC_TEMPLATE.md](superpowers/specs/SPEC_TEMPLATE.md) 기반, **Invariants + Invariant impact 섹션 필수** — ADR-0045) | user가 spec 파일 검토 후 승인 |
| `/grill-with-docs` (1차) | spec 도메인 용어/ADR 정합성 + **invariant 누락 검토** | CONTEXT.md 용어 mismatch 없음, Invariants 섹션 채워짐 |
| `/superpowers:writing-plans` | 실행 가능한 plan 파일 | — |
| `/plan-eng-review` | plan에 반영된 review 코멘트 | — |
| `/grill-with-docs` (2차, 조건부) | review로 plan이 **실질 변경**됐을 때만 재실행 | plan 무변경 시 skip |
| `/superpowers:using-git-worktrees` | `.worktrees/<feature>/` 격리 환경 + `uv sync` 완료 + baseline 테스트 통과 | `.worktrees`가 `.gitignore`에 등재됨 |
| `/superpowers:subagent-driven-development` | 구현 코드 + 테스트 | — |
| `/improve-codebase-architecture` | deepening 기회 평가 + refactor | — |
| ADR draft + commit | `docs/adr/NNNN-*.md` | 결정 가치가 있을 때만 |
| `/checking-domain-terms` | Claude가 CONTEXT.md + `git diff`를 읽고 ubiquitous-language 위반을 의미 수준에서 보고 | 위반 0건 또는 false positive로 정당화됨 |
| `/superpowers:verification-before-completion` | 실제 명령 실행 증거 (refactor 후 최종) | 완료 주장 전 필수 |
| `/superpowers:finishing-a-development-branch` | merge/PR 완료 후 worktree 제거 | 작업 commit 완료 |

## 운영 원칙

1. **subagent에게 항상 컨텍스트 주입 (prevention)**: 각 subagent prompt에 **반드시** `CONTEXT.md` + 관련 ADR 경로를 포함. 예: `"Read CONTEXT.md before starting. Use the ubiquitous language defined there — never use terms listed in _Avoid_:. Follow docs/adr/0001-table-as-module.md for the table module contract."` 안 하면 비명시 규약(table-as-module, Wire Model 등)을 모르고 layer-style + 잘못된 용어가 생성됨. 사전 명시는 prevention이고, 사후의 `/checking-domain-terms`는 detection — 두 단계가 보완재.
2. **2차 grill은 조건부**: `/plan-eng-review`가 plan을 안 건드렸으면 skip. 반복 grill은 "yes/sure" 자동응답으로 품질 하락 유발.
3. **verification은 생략 금지**: subagent가 "통과했다"고 보고해도 main에서 실제 명령 재실행. 거짓 완료 방지.
4. **ADR commit은 결정에만**: architecture 개선이 단순 cleanup이면 commit으로 충분. *결정*(다른 대안을 명시적으로 기각)일 때만 ADR.
5. **worktree 경로 일관성**: 이 프로젝트는 `.worktrees/`를 사용. 첫 worktree 생성 시 skill이 `.gitignore` 등재 여부를 검증하고 없으면 자동 추가 + commit. 이후 모든 feature는 `.worktrees/<branch-name>/`에 격리.
6. **worktree의 Python 환경**: `uv sync`는 worktree마다 별도 실행되므로 `.venv`가 중복 생성됨(디스크 ~수백MB/worktree). long-lived worktree는 최대 2~3개로 제한, 끝난 작업은 즉시 `/finishing-a-development-branch`로 정리.
7. **worktree 작업은 별도 Claude 세션에서**: master 세션에서 `/using-git-worktrees`로 worktree만 생성한 뒤, 새 터미널에서 worktree 디렉터리로 진입해 신규 Claude 세션을 시작. master 세션의 cwd는 worktree로 따라가지 않으며, Claude의 "primary working directory"는 세션 시작 시점 고정이므로 worktree 작업은 worktree에서 시작한 세션이 자연스러움.

## worktree 세션 시작 패턴

```bash
# 1) master 세션에서 worktree 생성 (Claude가 /using-git-worktrees 실행)
#    → .worktrees/<feature>/ 생성됨

# 2) 새 터미널 열기
cd /home/dev/code/hoga-ops/.worktrees/<feature>
uv sync          # 첫 진입 시 1회
claude           # feature 작업 전용 세션 시작

# 3) 작업 완료 후 worktree 세션에서
#    → /finishing-a-development-branch (merge/PR + worktree 제거)
```

확인 명령:
```bash
git worktree list             # 현재 존재하는 worktree 목록
git branch --show-current     # 현재 세션이 어느 브랜치에 있는지
```

## 빠진 단계가 위험한 이유 (히스토리)

- **spec 승인 gate 없음** → spec이 휘발되어 plan과 drift.
- **verification 없음** → subagent의 self-report 신뢰 → 거짓 통과.
- **ADR commit 없음** → architecture 결정이 코드에만 남고 *왜*가 사라짐 (ADR 0001이 만들어진 이유).
- **spec에 invariant 섹션 없음** → 코드 변경이 깰 invariant가 명시되지 않아 검토자가 알아채지 못함. `2026-05-24-replay-wheel-right-wall-design.md`의 ctrl-zoom clamp이 anchor 비율 invariant를 깬 채 통과해 사용자 버그로 이어진 사례 → ADR-0045로 spec template + Invariants 필수 게이트 도입.
