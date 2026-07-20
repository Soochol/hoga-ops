import { describe, it, expect } from 'vitest';
import { mergeDepthDeltaSession } from './depthDeltaSession';
import type { DepthDeltaPoint } from './depthDelta';

const pt = (tMs: number, inQty: number): DepthDeltaPoint => ({
  tMs,
  askDelta: [{ price: 1000, inQty, outQty: 0 }],
  bidDelta: [],
  askTick: 1,
  bidTick: 1,
});

describe('mergeDepthDeltaSession', () => {
  it('keeps buckets the 15-minute buffer has already evicted', () => {
    // 이 테스트가 지키는 것: 지표 커버리지가 "최근 15분"이 아니라 "세션 전체"라는 것.
    const t0 = 0;
    const t1 = 60_000;
    const t2 = 120_000;
    let session = mergeDepthDeltaSession([], [pt(t0, 100), pt(t1, 200)]);
    // 버퍼가 앞을 잘라내 버킷터가 t0 를 더는 만들지 못한다.
    session = mergeDepthDeltaSession(session, [pt(t1, 200), pt(t2, 300)]);
    expect(session.map((p) => p.tMs)).toEqual([t0, t1, t2]);
    expect(session[0].askDelta[0].inQty).toBe(100);
  });

  it('does not let a shrunken recomputation overwrite a settled bucket', () => {
    // 잘려나간 버킷은 남은 스냅샷만으로 재계산돼 값이 작아진다 — 완전값을 덮으면
    // 과거 구간 증감이 시간이 갈수록 야금야금 줄어든다.
    const settled = mergeDepthDeltaSession([], [pt(0, 500), pt(60_000, 10)]);
    const next = mergeDepthDeltaSession(settled, [pt(0, 120), pt(60_000, 20)]);
    expect(next.find((p) => p.tMs === 0)!.askDelta[0].inQty).toBe(500); // 유지
    expect(next.find((p) => p.tMs === 60_000)!.askDelta[0].inQty).toBe(20); // 활성 → 갱신
  });

  it('updates the active (latest) bucket as it keeps growing', () => {
    const a = mergeDepthDeltaSession([], [pt(0, 100)]);
    const b = mergeDepthDeltaSession(a, [pt(0, 250)]);
    expect(b[0].askDelta[0].inQty).toBe(250);
  });

  it('returns the same reference when nothing changed (하류 memo 유지)', () => {
    const active = pt(0, 100);
    const a = mergeDepthDeltaSession([], [active]);
    expect(mergeDepthDeltaSession(a, [active])).toBe(a);
  });

  it('keeps the accumulation when fresh is empty (콜드 홀드·비분봉)', () => {
    const a = mergeDepthDeltaSession([], [pt(0, 100)]);
    expect(mergeDepthDeltaSession(a, [])).toBe(a);
  });

  it('is idempotent — merging the same fresh twice changes nothing', () => {
    const fresh = [pt(0, 100), pt(60_000, 200)];
    const once = mergeDepthDeltaSession([], fresh);
    expect(mergeDepthDeltaSession(once, fresh)).toBe(once);
  });

  it('emits buckets in ascending tMs even when they arrive out of order', () => {
    const a = mergeDepthDeltaSession([], [pt(120_000, 1)]);
    const b = mergeDepthDeltaSession(a, [pt(0, 2), pt(60_000, 3)]);
    expect(b.map((p) => p.tMs)).toEqual([0, 60_000, 120_000]);
  });
});
