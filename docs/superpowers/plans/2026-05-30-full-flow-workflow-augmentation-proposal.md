# `/full-flow` 워크플로우 보강 제안서

- **Date**: 2026-05-30
- **Status**: Proposal (미적용 — `.claude/commands/full-flow.md`는 변경하지 않음)
- **근거**: 이번 세션에서 `/full-flow`를 SSE→WebSocket 마이그레이션(ADR-0053)에 end-to-end로 실제 실행하며 관측한 1차 증거 + 4개 구간 독립 설계 에이전트(Workflow)의 수렴 결과.
- **대상 파일(적용 시)**: `.claude/commands/full-flow.md`

## 요약

파이프라인 골격(단계·게이트·자동결정)은 견고하다. 이번 세션이 노출한 두 구조적 결함만 메우면 된다:

1. **리뷰 렌즈 부족** — stage 4가 `eng`+`design`만 봐서 type-design/naming/DRY를 놓침 → 사후 6커밋 burn-down(`audit batch A/B/C/D`). 다수가 plan에서 막을 수 있던 것이고, 일부는 plan의 `Deferred` 메모로 묻혀 있었다.
2. **오케스트레이션 비결정성** — stage 5 수동 병렬 디스패치 → git index race(반쪽 커밋된 rename); stage 6 단일 실행 → flake(teardown CancelledError) 출하 직전. 둘 다 추론 실패가 아니라 *순서·격리* 실패.

해결 원리: **비싼 catch를 왼쪽(plan 단계)으로 당기고**, **비가역 작업(stage 7) 앞에 반증 게이트**를 두고, **병렬은 격리가 증명될 때만**(워크트리). 워크플로우는 "더 많은 에이전트"가 아니라 **결정성·반증·조기차단**을 사는 것.

## 설계 원칙

- **하위호환**: 모든 augmentation은 **워크플로우 게이트** 뒤에 둔다. 사소한 변경엔 파일이 지금과 동일하게(단일 에이전트/순차) 동작. 큰 변경에서만 워크플로우가 켜져 비용을 정당화.
- **새 인프라 최소화**: 추가 영속 상태는 Findings Ledger(JSONL 1개)뿐. 나머지는 "어느 단계에서 어떤 패턴을 쓰라"는 지시.
- **과투자 방지**: stage 8 = 워크플로우 없음; stage 1·2 대화 = 워크플로우 없음(대화 스레드 보존).

## 워크플로우 게이트 (모든 augmentation의 on/off 조건)

다음 중 하나라도 참이면 해당 단계의 워크플로우를 켜고, 아니면 기존 동작 유지:
- plan `scope: both`, 또는
- 변경이 파일 3개 이상, 또는
- 새 타입/도메인 용어 도입·개명, 또는
- async/타이밍/teardown/동시성 코드(WebSocket·스레드·타이머 등).

게이트 거짓이면 워크플로우를 띄우지 말 것(토큰 낭비).

## 공유 프리미티브 3종 (여러 단계가 공유)

### (1) 공유 리뷰 렌즈 세트
`eng`(정확성·순서·테스트) · `design`(UI·DESIGN.md; frontend만) · `type-design`(payload/이벤트 타입 유무, `Record<string,unknown>`/`Any`/dict 냄새) · `naming`(CONTEXT.md 용어 일치, 마이그레이션이 남기는 죽은 이름) · `dry-consistency`(흩어진 매직넘버·상수, 파일 간 중복 로직).
→ stage 3·4·9가 **분담**해 재사용(중복 비용 없음). 뒤 3개가 이번 burn-down의 원인.

### (2) Adversarial-verify 게이트
critical 발견은 적용 전 검증 에이전트가 "이 주장을 *반증*해보라; 명백한 반대 증거가 있을 때만 강등"으로 1차 거른다. stage 4·7·9 공용. **stage 7(롤백 없는 auto-apply)에서는 필수.** 이번 세션의 'subscribed=dead' 오탐을 워크플로우 안에서 걸렀을 단계.

### (3) Findings Ledger
`docs/superpowers/plans/YYYY-MM-DD-<topic>-findings.jsonl`. 발견마다
`{id, provenance(plan-3|plan-4|arch-7|review-9), file, line, claim, kind, severity, status(open|applied|deferred|refuted|escalated), evidence_ref}`.
**오케스트레이터만 append**(서브에이전트·동시 단계 동시쓰기 금지 — index race 방지). stage 4가 seed, stage 7·9는 시작 시 읽어 **이미 applied면 드롭 / plan-deferred인데 코드에 남아있으면 escalate**. 같은 부채를 plan→감사→review에서 세 번 cold-refind한 게 burn-down의 진짜 메커니즘.

## 단계별 결정

| 단계 | 추가 | 패턴 |
|---|---|---|
| 1 브레인스토밍 | 선택(green-field만) | 접근법 분기 fan-out 1회(advisory) |
| 2 grill | 선택 | 대화 앞에 completeness-critic 패널 → 질문 backlog (대화 자체는 그대로) |
| 3 plan 작성 | **YES** | type/naming/dry critic + adversarial-verify → plan 머지 (Deferred 메모 승격) |
| 4 plan review | **YES** | 렌즈 fan-out + adversarial-verify + 결정론적 merge-synthesizer |
| 5 구현 | **YES** | per-task 파이프라인 + 워크트리 격리 + 단일 커밋 배리어 |
| 6 검증 | **YES** | flake 루프 N회 + "진짜 green?" adversarial-verify |
| 7 아키텍처(auto-apply) | **YES** | **필수** adversarial-verify + 순차 단일라이터 적용 |
| 8 simplify | **NO** | 단일 에이전트 유지; 별도 auto-apply 패스 금지(stage 7과 이중편집 thrash) |
| 9 review | **YES** | 경량 judge-panel + Ledger 대조 + adversarial-verify(critical만) |

## 적용 시 diff (요지)

> 전체 diff는 세션 로그 참조. 아래는 단계별 핵심 삽입점.

- **Auto-decision 정책 뒤**: "워크플로우 보강(공유 프리미티브)" 섹션 신설 — 게이트 + 렌즈 세트 + verify 게이트 + Ledger.
- **Stage 3**: plan 작성 직후 게이트 참이면 critic 패널(type/naming/dry) + verify; Deferred 메모 코드-예방가능분 승격; Ledger seed(plan-3). eng/design은 stage 4가 담당(중복 방지).
- **Stage 4**: 게이트 거짓=기존 2렌즈; 참이면 3-Phase(fan-out → 검증자/critical → 결정론적 머지, 정확 old_text 매칭). 충돌은 GATE 2에서 사용자. Ledger 기록 + stage 3 처리분 드롭.
- **Stage 5**: 구현 서브에이전트 **순차 기본**. 병렬은 게이트 참 + 태스크 독립(글롭 비중첩)일 때만 EnterWorktree 인덱스 격리 + 커밋 배리어(오케스트레이터가 하나씩 merge, 매번 `git status --porcelain` 검사). `git add -A` 금지·명시 경로만. quality리뷰에 공유 렌즈.
- **Stage 6**: flake 게이트(async/타이밍 변경 시 5회, 재발 시 10회 반복; 미봉책 금지·근본수정) + masked-green 검증(0수집/전부skip/xfail/삼켜진 teardown/경고억제 빌드 차단).
- **Stage 7**: Ledger 선독(applied 드롭·deferred-present escalate); **adversarial-verify 필수**(refuted/needs-human 미적용); 순차 단일라이터 적용; 무인 auto-apply이므로 스킬의 대화 단계는 건너뛰고 탐색·용어만 사용.
- **Stage 8**: 단일 에이전트 유지; 발견은 Ledger, 적용은 stage 7 경로 재사용(이중편집 금지).
- **Stage 9**: 게이트 거짓=기존 단일 review; 참이면 judge-panel(correctness+type/naming/dry+용어) + Ledger 대조 + critical별 adversarial-verify.
- **frontmatter/도입부**: "9단계" → "10단계"(Landing 포함; 기존 표기 불일치 교정).

## 도입 우선순위 (ROI 순)

1. 공유 렌즈 세트 + Findings Ledger (전제. 거의 0 비용)
2. Stage 3/4 워크플로우化 (burn-down 근본 차단 — 세션이 증명한 1순위)
3. Stage 5 워크트리 격리 파이프라인 (index race 박멸)
4. Stage 6 flake 루프 + green 검증 (flake 출하 방지, 쌈)
5. Stage 7 adversarial-verify 게이트 (비가역 안전망)
6. Stage 9 judge-panel (Ledger로 중복 제거하니 실제 비용 작음)

## 세션 증거 매핑 (제안 ↔ 실제로 일어난 일)

- type-design/naming/dry 렌즈 누락 → `audit batch A/B/C/D`(죽은 sse.ts 참조·dangling heartbeat, 임계값 4파일 분산+중복 폴링, sse.py→events.py/SSEEvent→PushEvent, payload 타입화). → Stage 3/4 렌즈 추가.
- 'subscribed=dead' 오탐 → adversarial-verify가 걸렀을 것. → verify 게이트.
- 같은 부채 3회 cold-refind → Findings Ledger.
- 공유 워크트리 병렬 디스패치 → git index race(반쪽 rename). → Stage 5 워크트리 격리 + 커밋 배리어.
- 단일 pytest 실행 → flake 출하 직전(teardown CancelledError). → Stage 6 반복 루프 + 근본수정.
- stage 7 무인 auto-apply의 대화형 스킬 충돌 → 탐색·용어만 쓰고 verify→apply 기계로 적용.

## 관련

- [[2026-05-30-live-websocket-transport-plan]] — 이 제안의 증거를 생산한 실행
- ADR-0053 — 그 마이그레이션의 결정
- 메모리: "No concurrent agents in same worktree"(index race), "/browse js = single expression only"
