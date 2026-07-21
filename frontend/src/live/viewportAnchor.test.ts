import { describe, it, expect } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import {
  viewportFromRanges,
  realMsToVirtualSeconds,
  computeRestoreRange,
  type TabViewport,
} from './viewportAnchor';
import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

// live-edge 복원은 rightOffset(밀도 파생)을 더한다 — 기대값을 상수에서 유도해
// 밀도 다이얼 변경 시 마법수로 깨지지 않게 한다.
const RIGHT_OFFSET = CHART_TIMESCALE_OPTIONS.rightOffset ?? 0;

// Real-anchored single-session axis (origin = session open), so within the
// session toReal/toVirtual are identity in ms — keeps the expected math obvious.
const OPEN_MS = Date.UTC(2026, 4, 27, 0, 0, 0); // 09:00 KST
const CLOSE_MS = OPEN_MS + 6.5 * 3600 * 1000;
const axis = createVirtualAxis(
  [{ date: '20260527', sessionOpenMs: OPEN_MS, sessionCloseMs: CLOSE_MS }],
  OPEN_MS,
);
const emptyAxis = createVirtualAxis([]);

describe('viewportFromRanges', () => {
  it('builds a TabViewport from logical + visible ranges (mid-session, not live edge)', () => {
    const vrToSec = (OPEN_MS + 2 * 3600_000) / 1000; // 2h past open, virtual==real
    const vp = viewportFromRanges({ from: 100, to: 400 }, { from: vrToSec, to: vrToSec }, axis, OPEN_MS + 6 * 3600_000);
    expect(vp).not.toBeNull();
    expect(vp!.rightEdgeMs).toBe(OPEN_MS + 2 * 3600_000);
    expect(vp!.barSpan).toBe(300);
    expect(vp!.atLiveEdge).toBe(false); // right edge 4h before the last candle
  });

  it('flags atLiveEdge when the right edge is at/after the last candle (within 1s)', () => {
    const lastMs = OPEN_MS + 2 * 3600_000;
    const vrToSec = lastMs / 1000;
    const vp = viewportFromRanges({ from: 0, to: 305 }, { from: vrToSec, to: vrToSec }, axis, lastMs);
    expect(vp!.atLiveEdge).toBe(true);
  });

  it('captures right-side chart padding in bars when the latest candle index is known', () => {
    const lastMs = OPEN_MS + 2 * 3600_000;
    const vp = viewportFromRanges(
      { from: 120, to: 430 },
      { from: lastMs / 1000, to: lastMs / 1000 },
      axis,
      lastMs,
      399,
    );
    expect(vp).toMatchObject({
      barSpan: 310,
      atLiveEdge: true,
      rightPaddingBars: 30,
    });
  });

  // 좌우 끝을 모두 실데이터에 앵커한다 — barSpan 은 라이브 엣지에서 마지막 캔들
  // 뒤 여백까지 세므로 좌측 끝을 역산하는 근거가 못 된다(저장뷰 시작일이 여백만큼
  // 과거로 넘치던 원인).
  it('captures the left edge from the visible range, independent of barSpan', () => {
    const leftMs = OPEN_MS + 1 * 3600_000;
    const rightMs = OPEN_MS + 2 * 3600_000;
    const vp = viewportFromRanges(
      // 논리 폭 310 중 30 은 마지막 캔들 뒤 여백 — 좌측 시각은 그와 무관해야 한다.
      { from: 120, to: 430 },
      { from: leftMs / 1000, to: rightMs / 1000 },
      axis,
      rightMs,
      399,
    );
    expect(vp!.leftEdgeMs).toBe(leftMs);
    expect(vp!.rightEdgeMs).toBe(rightMs);
  });

  // 좌측 앵커를 못 읽어도 캡처는 살아야 한다 — 탭 복원이 이 캡처에 얹혀 있고,
  // 저장만 옛 span 역산으로 폴백하면 된다.
  it('omits the left edge rather than failing when it cannot be read', () => {
    const vp = viewportFromRanges({ from: 0, to: 300 }, { from: NaN, to: OPEN_MS / 1000 }, axis, null);
    expect(vp).not.toBeNull();
    expect(vp!.leftEdgeMs).toBeUndefined();
    expect(vp!.rightEdgeMs).toBe(OPEN_MS);
  });

  it('atLiveEdge is false when lastCandleMs is null (no candles)', () => {
    const vp = viewportFromRanges({ from: 0, to: 300 }, { from: OPEN_MS / 1000, to: OPEN_MS / 1000 }, axis, null);
    expect(vp!.atLiveEdge).toBe(false);
  });

  it('returns null on a missing range read or empty axis', () => {
    expect(viewportFromRanges(null, { from: OPEN_MS / 1000, to: OPEN_MS / 1000 }, axis, null)).toBeNull();
    expect(viewportFromRanges({ from: 0, to: 300 }, null, axis, null)).toBeNull();
    expect(viewportFromRanges({ from: 0, to: 300 }, { from: OPEN_MS / 1000, to: OPEN_MS / 1000 }, emptyAxis, null)).toBeNull();
  });

  it('returns null on a non-positive bar span (degenerate / collapsed view)', () => {
    expect(viewportFromRanges({ from: 400, to: 400 }, { from: OPEN_MS / 1000, to: OPEN_MS / 1000 }, axis, null)).toBeNull();
    expect(viewportFromRanges({ from: 400, to: 100 }, { from: OPEN_MS / 1000, to: OPEN_MS / 1000 }, axis, null)).toBeNull();
  });
});

describe('realMsToVirtualSeconds', () => {
  it('rounds axis.toVirtual(realMs)/1000 to an integer second', () => {
    const realMs = OPEN_MS + 1234_567; // identity axis → virtual == real
    expect(realMsToVirtualSeconds(axis, realMs)).toBe(Math.round((OPEN_MS + 1234_567) / 1000));
  });
});

describe('computeRestoreRange', () => {
  const scrolledBack: TabViewport = { rightEdgeMs: OPEN_MS, leftEdgeMs: OPEN_MS, barSpan: 120, atLiveEdge: false };
  const liveEdge: TabViewport = { rightEdgeMs: OPEN_MS, leftEdgeMs: OPEN_MS, barSpan: 50, atLiveEdge: true };

  it('non-live-edge: pins the anchor index as the right edge, span as width', () => {
    expect(computeRestoreRange(scrolledBack, 5000, 1000)).toEqual({ from: 880, to: 1000, scrollToRight: false });
  });

  it('non-live-edge: clamps from to >= 0 so the lazy-fetch trigger cannot misfire', () => {
    const r = computeRestoreRange(scrolledBack, 5000, 50); // 50 - 120 < 0
    expect(r).toEqual({ from: 0, to: 50, scrollToRight: false });
    expect(r!.from).toBeGreaterThanOrEqual(0);
  });

  it('non-live-edge: null when the anchor index could not be resolved (anchor off-axis)', () => {
    expect(computeRestoreRange(scrolledBack, 5000, null)).toBeNull();
  });

  it('live-edge: preserves the saved zoom with right-offset whitespace, ignoring the index', () => {
    expect(computeRestoreRange(liveEdge, 200, null)).toEqual({ from: 150, to: 200 + RIGHT_OFFSET, scrollToRight: false });
  });

  it('live-edge: preserves the saved right-side padding exactly when captured', () => {
    const padded: TabViewport = { ...liveEdge, barSpan: 80, rightPaddingBars: 30 };
    expect(computeRestoreRange(padded, 200, null)).toEqual({ from: 150, to: 230, scrollToRight: false });
  });

  it('live-edge: restores saved padding from the latest candle logical index when the shared scale has extra points', () => {
    const padded: TabViewport = { ...liveEdge, barSpan: 80, rightPaddingBars: 30 };
    expect(computeRestoreRange(padded, 200, null, undefined, 249)).toEqual({ from: 200, to: 280, scrollToRight: false });
  });

  it('user-adjusted live-edge: captured padding takes precedence over the time anchor', () => {
    const padded: TabViewport = { ...liveEdge, barSpan: 80, rightPaddingBars: 30, userAdjusted: true };
    expect(computeRestoreRange(padded, 200, 120)).toEqual({ from: 150, to: 230, scrollToRight: false });
  });

  it('user-adjusted live-edge: pins the explicit time anchor instead of the latest bar', () => {
    const adjustedLiveEdge: TabViewport = { ...liveEdge, userAdjusted: true };
    expect(computeRestoreRange(adjustedLiveEdge, 200, 120)).toEqual({ from: 70, to: 120, scrollToRight: false });
  });

  it('live-edge: clamps from to >= 0 when fewer bars than the saved span', () => {
    expect(computeRestoreRange(liveEdge, 30, null)).toEqual({ from: 0, to: 30 + RIGHT_OFFSET, scrollToRight: false });
  });

  it('rounds a fractional saved span', () => {
    const frac: TabViewport = { rightEdgeMs: OPEN_MS, leftEdgeMs: OPEN_MS, barSpan: 119.6, atLiveEdge: false };
    expect(computeRestoreRange(frac, 5000, 1000)).toEqual({ from: 880, to: 1000, scrollToRight: false });
  });
});
