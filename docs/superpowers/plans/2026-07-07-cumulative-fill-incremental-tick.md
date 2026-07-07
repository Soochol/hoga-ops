# 누적 체결강도 setData 폴백 제거 (마지막 세그먼트 앵커·패치 억제) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 경매 마스크 ON에서 누적 체결강도 라인이 장중 틱마다 `setData(전체)`로 폴백하는 것을 없애고, 다른 5개 시리즈처럼 `update(tail)` 증분 경로를 타게 한다.

**Architecture:** 폴백의 원인은 **두 개**다 — 마지막 점 이후에 합성되는 미래 경매 앵커(fillStrength.ts:268-282)만이 아니라, 마지막 pre-auction 점에 소급 적용되는 투명색 패치(fillStrength.ts:254-259)도 tail-append를 깨뜨린다(다음 틱에서 직전 점의 color가 사라지므로 prefix 불일치 → setData). 둘 다 목적이 "다음 세그먼트로 넘어가는 대각선 방지"인데, **마지막 세그먼트에는 다음 세그먼트가 없어 시각적으로 무의미**하다. 따라서 `projectCumulativeSegment`에 `isLastSegment` 파라미터를 추가해 마지막 세그먼트에서 둘 다 억제한다. 억제가 투영 함수 자체의 의미론이므로 full 경로(projectCumulativeNetFill)와 캐시 경로(makeCumulativeCachedProjector)가 동일하게 적용받아 byte-parity 불변식이 유지된다.

**주의(스코프):** 이 변경은 라이브 today뿐 아니라 **모든 범위의 최종 세그먼트**(완결된 과거일 replay 포함)에서 앵커·패치를 없앤다. 앵커는 투명색(value=0, LINE_HIDDEN_COLOR)이라 렌더에는 안 보이지만, 최종 세그먼트의 데이터 배열 내용이 바뀌므로 golden 테스트는 갱신이 필요하다. 과거(비최종) 세그먼트 출력은 바이트 불변.

**Tech Stack:** TypeScript / lightweight-charts v5 / vitest (`cd frontend && npx vitest run`)

---

### Task 1: incrementalTick 기대값 뒤집기 — red 먼저

**Files:**
- Modify: `frontend/src/chart/projectors/incrementalTick.test.ts:79-90`

- [ ] **Step 1: 기존 "알려진 한계" 테스트를 목표 동작으로 교체**

`incrementalTick.test.ts:85-90`의 기존 테스트를 삭제하고 아래 2개로 교체:

```typescript
  it('누적 라인: mask ON에서도 장중 값-변경 틱에 update (마지막 세그먼트 앵커·패치 억제)', () => {
    const { axis, bundle } = build(180);
    const ctx = { cumulativeEnabled: true, auctionWindowMask: true };
    expect(tick(axis, bundle, FILL_STRENGTH_SPEC.series[2].data, ctx)).toBe('update');
  });

  it('누적 라인: mask ON에서 새 버킷 append 틱에도 update', () => {
    const { axis, bundle } = build(180);
    const ctx = { cumulativeEnabled: true, auctionWindowMask: true };
    const dataFn = FILL_STRENGTH_SPEC.series[2].data;
    const before = dataFn(bundle, axis, ctx);
    // 다음 분봉 버킷이 새로 열리는 틱: fill_strength에 점 1개 append.
    const fs2 = bundle.fill_strength.points.slice();
    const last = fs2[fs2.length - 1];
    fs2.push({ t: last.t + BUCKET, buy_qty: 700, sell_qty: 300 });
    const nextBundle = { ...bundle, fill_strength: { points: fs2 } };
    const after = dataFn(nextBundle, axis, ctx);
    expect(classifyDataChange(before, after).kind).toBe('update');
  });
```

- [ ] **Step 2: red 확인**

Run: `cd frontend && npx vitest run src/chart/projectors/incrementalTick.test.ts`
Expected: FAIL — 두 케이스 모두 `'setData'` 반환 (값-변경은 미래 앵커가 뒤에 있어 prefix 불일치, append는 투명 패치 이동까지 겹침)

---

### Task 2: `projectCumulativeSegment`에 `isLastSegment` 추가

**Files:**
- Modify: `frontend/src/chart/projectors/fillStrength.ts:186-329`

- [ ] **Step 1: 시그니처 + 억제 로직 구현**

`projectCumulativeSegment`(fillStrength.ts:186)의 시그니처에 파라미터 추가:

```typescript
export function projectCumulativeSegment(
  seg: RangeBundle['segments'][number],
  segIdx: number,
  points: readonly FillStrengthPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
  bucketMs: number,
  isLastSegment: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
```

투명 패치 블록(현재 `if (auctionWindowMask && lastPreAuctionIdx >= 0)`, :254)을 다음으로 교체:

```typescript
  // 패치와 경매 앵커(아래)는 둘 다 "다음 세그먼트로 넘어가는 대각선 방지"가
  // 목적이다. 마지막 세그먼트엔 다음 세그먼트가 없어 시각적으로 무의미하고,
  // 남겨두면 라이브 틱마다 (a) 직전 점의 소급 color 재작성, (b) 마지막 점 뒤
  // 미래 앵커 삽입으로 tail-append가 깨져 setData(전체) 폴백을 강제한다
  // (seriesDataDiff.ts). 그래서 마지막 세그먼트에서는 둘 다 억제한다.
  if (auctionWindowMask && !isLastSegment && lastPreAuctionIdx >= 0) {
```

앵커 합성 블록(현재 `if (auctionWindowMask)`, :268)을 다음으로 교체:

```typescript
  if (auctionWindowMask && !isLastSegment) {
```

- [ ] **Step 2: 호출부 2곳 갱신**

`projectCumulativeNetFill`(:163-173)의 세그먼트 루프:

```typescript
  bundle.segments.forEach((seg, segIdx) => {
    const segOut = projectCumulativeSegment(
      seg,
      segIdx,
      bundle.fill_strength.points,
      axis,
      auctionWindowMask,
      bundle.bucket_ms,
      segIdx === bundle.segments.length - 1,
    );
    for (const e of segOut) out.push(e);
  });
```

`makeCumulativeCachedProjector`(:316-327) — 과거 루프는 전부 비최종(false), today는 최종(true):

```typescript
      for (let i = 0; i < todayIdx; i++) {
        const segOut = projectCumulativeSegment(segs[i], i, pastPoints, axis, mask, bucketMs, false);
        for (const e of segOut) pastData.push(e);
      }
      ...
    return entry.pastData.concat(
      projectCumulativeSegment(todaySeg, todayIdx, todayPoints, axis, mask, bucketMs, true),
    );
```

- [ ] **Step 3: green 확인 (Task 1의 red 테스트)**

Run: `cd frontend && npx vitest run src/chart/projectors/incrementalTick.test.ts`
Expected: PASS — 6/6 (기존 mask OFF 케이스 포함)

---

### Task 3: 기존 테스트 회귀 정리

**Files:**
- Modify: `frontend/src/chart/projectors/fillStrength.test.ts`, `frontend/src/chart/projectors/pastCachedProjector.test.ts` (컴파일 에러·golden 불일치 나는 곳만)

- [ ] **Step 1: 관련 스위트 실행으로 깨지는 지점 식별**

Run: `cd frontend && npx vitest run src/chart/projectors/`
Expected: `projectCumulativeSegment` 직접 호출부는 TS 인자 누락, 최종 세그먼트의 앵커/패치를 단언하는 golden은 값 불일치로 FAIL.

- [ ] **Step 2: 케이스별 갱신 원칙**

- **직접 호출 컴파일 에러**: 테스트가 "비최종 세그먼트" 시나리오면 `false`, "단일/최종 세그먼트" 시나리오면 `true`를 전달.
- **byte-parity 테스트**(pastCachedProjector.test.ts의 "flat-map == full 재계산"): 로직 수정 없이 통과해야 한다 — 두 경로 모두 같은 `isLastSegment` 규칙을 쓰므로. 여기가 깨지면 Task 2의 호출부 배선이 틀린 것이니 테스트가 아니라 구현을 고칠 것.
- **최종 세그먼트 앵커·패치 golden**: 기대값에서 최종 세그먼트의 (a) 15:20~15:29 투명 앵커 항목들, (b) 마지막 pre-auction 점의 `color` 필드를 제거. 비최종 세그먼트 기대값은 절대 손대지 않는다 — 비최종이 바뀌면 구현 버그다.

- [ ] **Step 3: 프론트 전체 게이트**

Run: `cd frontend && npx vitest run && npx tsc -b`
Expected: PASS / 에러 0 (eslint 전역은 게이트 아님 — 변경 파일만 0 에러 확인: `npx eslint src/chart/projectors/fillStrength.ts`)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/projectors/fillStrength.ts frontend/src/chart/projectors/incrementalTick.test.ts frontend/src/chart/projectors/fillStrength.test.ts frontend/src/chart/projectors/pastCachedProjector.test.ts
git commit -m "perf(live): 누적 체결강도 mask ON setData 폴백 제거 — 최종 세그먼트 앵커·패치 억제"
```

---

### Task 4: 브라우저 도그푸딩 검증

- [ ] **Step 1: /browse로 실차트 확인**

dev 서버 기동 후(CLAUDE.md의 백엔드 uvicorn + `cd frontend && npm run dev`):

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B console --errors        # JS 에러 0 확인
$B screenshot /tmp/cumulative-mask-on.png
```

확인 포인트: (1) 누적 라인이 경매 마스크 ON에서 기존과 동일하게 보이는가 — 과거일 경매 밴드에 라인 없음, 일경계 리셋 유지. (2) 최종(오늘) 세그먼트 라인 꼬리가 정상 렌더. (3) 콘솔에 "data must be asc ordered by time" 에러 없음.

- [ ] **Step 2: 빌드 게이트**

Run: `cd frontend && npm run build`
Expected: 성공
