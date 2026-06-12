import type { QuoteRatioPoint } from '../../api/types';

export type SurgeSide = 'ask' | 'bid';
export type SurgeMarker = { t: number; prevPeak: number; value: number; pctOver: number };

export type DetectSurgesOpts = {
  /** 발사 문턱: value > prevPeak × (1 + margin). 기본 0.5. */
  margin: number;
  /** 각 Stock-Date 세션 시작(Unix ms), 오름차순. running peak를 세션마다 리셋. */
  sessionOpens: readonly number[];
  /** 마감 동시호가(15:20–15:30) 구간 술어. true면 발사·peak갱신 모두 제외. */
  isClosingAuction: (t: number) => boolean;
};

const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total'> = { ask: 'ask_total', bid: 'bid_total' };

function detectSide(points: readonly QuoteRatioPoint[], side: SurgeSide, o: DetectSurgesOpts): SurgeMarker[] {
  const out: SurgeMarker[] = [];
  let runningMax = 0;
  let segIdx = 0;
  for (const p of points) {
    while (segIdx + 1 < o.sessionOpens.length && p.t >= o.sessionOpens[segIdx + 1]) {
      segIdx += 1;
      runningMax = 0;
    }
    if (o.isClosingAuction(p.t)) continue;
    const v = p[FIELD[side]];
    if (runningMax > 0 && v > runningMax * (1 + o.margin)) {
      out.push({ t: p.t, prevPeak: runningMax, value: v, pctOver: v / runningMax - 1 });
    }
    if (v > runningMax) runningMax = v;
  }
  return out;
}

export function detectSurges(
  points: readonly QuoteRatioPoint[],
  opts: DetectSurgesOpts,
): Record<SurgeSide, SurgeMarker[]> {
  return { ask: detectSide(points, 'ask', opts), bid: detectSide(points, 'bid', opts) };
}
