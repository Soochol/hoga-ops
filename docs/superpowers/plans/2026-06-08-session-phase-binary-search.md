# sessionPhaseAt 이진 탐색화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sessionPhaseAt` 선형 워크를 lower-bound 이진 탐색으로 — projector 핫패스(캔들당 2회 호출) 세그먼트 비교 ~20배 절감, 시그니처·시맨틱 불변.

**Architecture:** `frontend/src/util/sessionTime.ts` 단일 함수 교체. 가드 2종: Proxy 접근 횟수 상한(진짜 RED — 선형 ~200 vs 이진 ≤24) + 교체 전 선형 구현을 테스트 로컬 reference로 보존한 동치 스윕. Spec: `docs/superpowers/specs/2026-06-08-session-phase-binary-search-design.md`.

**Tech Stack:** TypeScript, vitest, Proxy 기반 접근 카운팅.

---

### Task 1: 이진 탐색 교체 (TDD)

**Files:**
- Modify: `frontend/src/util/sessionTime.ts` (sessionPhaseAt 본문만)
- Test: `frontend/src/util/sessionTime.test.ts`

- [ ] **Step 1: 가드 테스트 2종 작성** — sessionTime.test.ts 끝에 추가 (기존 픽스처 상수 DAY1_OPEN/DAY1_CLOSE/DAY_MS/FULL_SESSION_MS 재사용):

```typescript
describe('sessionPhaseAt — O(log n) 접근 횟수 (스펙 2026-06-08)', () => {
  it('200세그먼트에서 콜당 배열 인덱스 접근 ≤ 24 (선형이면 ~200)', () => {
    const segs = Array.from({ length: 200 }, (_, i) => ({
      sessionOpenMs: DAY1_OPEN + i * DAY_MS,
      sessionCloseMs: DAY1_OPEN + i * DAY_MS + FULL_SESSION_MS,
    }));
    let reads = 0;
    const counted = new Proxy(segs, {
      get(target, prop, recv) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, recv);
      },
    });
    // 마지막 세그먼트 한가운데 — 선형 워크는 전 구간을 훑는다.
    const t = segs[199].sessionOpenMs + 60 * 60 * 1000;
    reads = 0;
    expect(sessionPhaseAt(counted, t)).toBe('regular');
    expect(reads).toBeLessThanOrEqual(24);
  });
});

describe('sessionPhaseAt — 선형 reference 동치 (스펙 2026-06-08)', () => {
  // 교체 전 선형 구현의 보존 사본 — 이진 구현의 의미론 가드. 세그먼트
  // 정렬·비중첩(buildSegments 불변식) 하에서 두 구현은 동치다.
  function linearReference(
    segments: readonly SessionSegment[],
    realMs: number,
  ): SessionPhase {
    if (segments.length === 0) return 'pre-axis';
    const first = segments[0];
    if (realMs < first.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'pre-axis';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (realMs < seg.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'gap';
      if (realMs <= seg.sessionCloseMs) return classifyWithinSegment(seg, realMs);
    }
    return 'post-axis';
  }

  it('다중 세그먼트(반장 포함) 축에서 경계 ±1ms·1분 스윕 전수 일치', () => {
    const segs = [
      { sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_CLOSE },
      { sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_OPEN + 3.5 * 60 * 60 * 1000 },
      {
        sessionOpenMs: DAY1_OPEN + 2 * DAY_MS,
        sessionCloseMs: DAY1_OPEN + 2 * DAY_MS + FULL_SESSION_MS,
      },
    ];
    const probes: number[] = [];
    for (const s of segs) {
      for (const b of [
        s.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS,
        s.sessionOpenMs,
        s.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS,
        s.sessionCloseMs,
      ]) {
        probes.push(b - 1, b, b + 1);
      }
    }
    for (let t = DAY1_OPEN - DAY_MS; t <= DAY1_OPEN + 3 * DAY_MS; t += 60_000) {
      probes.push(t);
    }
    for (const t of probes) {
      expect(sessionPhaseAt(segs, t), `t=${t}`).toBe(linearReference(segs, t));
    }
  });
});
```

**Step 1에서 반드시** 기존 import 블록에 타입을 추가한다 —
`import { ..., type SessionPhase, type SessionSegment } from './sessionTime';`
(vitest/esbuild는 타입을 체크 없이 제거하므로 빠뜨려도 Step 2/4는 통과하고
Task 2의 `tsc --noEmit`에서야 깨진다 — advisor 검증 지적.)

- [ ] **Step 2: RED 확인** — Run: `cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-ws-design/frontend && npx vitest run src/util/sessionTime.test.ts 2>&1 | tail -5`
Expected: 접근 횟수 테스트 **FAIL** (`reads` ≈ 200 > 24); 동치 스윕은 PASS(현 구현 == reference — 리팩터 가드).

- [ ] **Step 3: 구현 — sessionPhaseAt 교체** (sessionTime.ts:81-101의 함수 본문):

```typescript
export function sessionPhaseAt(segments: readonly SessionSegment[], realMs: number): SessionPhase {
  if (segments.length === 0) return 'pre-axis';

  const first = segments[0];
  if (realMs < first.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'pre-axis';

  // preOpenStart(= open − 30min) ≤ realMs 인 마지막 세그먼트를 이진 탐색 —
  // findByReal(virtualAxis.ts)과 같은 lower-bound 패턴, 키만 preOpenStart.
  // 전제: 세그먼트 정렬·비중첩(buildSegments 불변식). projector 핫패스가
  // 캔들마다 contains/inClosingAuctionWindow로 2회 부르므로 선형 워크는
  // 250일 스크롤에서 projection당 수천만 비교가 된다(스펙 2026-06-08).
  let lo = 0;
  let hi = segments.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS <= realMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const seg = segments[idx];
  if (realMs <= seg.sessionCloseMs) return classifyWithinSegment(seg, realMs);
  // seg 마감 뒤 ~ 다음 세그먼트 pre-open 시작 전 구간. idx가 마지막이면 post-axis.
  return idx === segments.length - 1 ? 'post-axis' : 'gap';
}
```

기존 docstring(반환값 표)은 그대로 유지.

- [ ] **Step 4: GREEN + util 회귀** — Run: `npx vitest run src/util/ 2>&1 | tail -4`
Expected: sessionTime(16)·virtualAxis(46) 포함 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/util/sessionTime.ts frontend/src/util/sessionTime.test.ts
git commit -m "perf(frontend): sessionPhaseAt 이진 탐색화 — projector 핫패스 ~20배 절감 (스펙 2026-06-08)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 전체 회귀 + spec 상태

- [ ] **Step 1**: `npx vitest run 2>&1 | grep -E "Test Files|Tests "` → 전부 PASS (기준선 1510 + 신규 2).
- [ ] **Step 2**: `npx tsc --noEmit` → 에러 0.
- [ ] **Step 3**: spec Status → `Implemented (2026-06-08)` 교체 후 커밋:

```bash
git add docs/superpowers/specs/2026-06-08-session-phase-binary-search-design.md
git commit -m "docs(spec): sessionPhaseAt 이진 탐색화 Status → Implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
