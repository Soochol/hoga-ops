import type { QuoteRatioPoint } from '../../api/types';

export type SurgeSide = 'ask' | 'bid';
export type SurgeMarker = { t: number; prevPeak: number; value: number; pctOver: number };

export type DetectSurgesOpts = {
  /** 발사 문턱: value > prevPeak × (1 + margin). 기본 0.5. */
  margin: number;
  /** 마감 동시호가(15:20–15:30) 구간 술어. true면 발사·peak갱신 모두 제외. */
  isClosingAuction: (t: number) => boolean;
};

const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total'> = { ask: 'ask_total', bid: 'bid_total' };

// 거래일(세션) 경계 = KST 자정. running peak를 거래일마다 0으로 리셋한다. 세션은 09:00–15:30라
// 한 거래일이 한 KST 날짜에 들어가므로 "KST 날짜 변화 = 세션 경계". sessionOpens를 따로 받지 않고
// 점의 t에서 직접 도출 → 한 청크(과거/당일 어느 쪽이든) 안에서 자기-완결적으로 리셋된다. 이 self-reset
// 덕분에 각 거래일 마커는 그 거래일 점에만 의존 → makePastCachedProjector의 `cachedPast ++ today === all`
// 불변식이 그대로 성립(과거 동결 + 당일만 재계산).
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const tradingDayOf = (t: number): number => Math.floor((t + KST_OFFSET_MS) / 86_400_000);

/** 한 side(ask|bid)의 급증 마커. 거래일마다 running peak 리셋, 마감 동시호가 제외, 마진 초과 시 발사. */
export function detectSurgeSide(
  points: readonly QuoteRatioPoint[],
  side: SurgeSide,
  o: DetectSurgesOpts,
): SurgeMarker[] {
  const out: SurgeMarker[] = [];
  let runningMax = 0;
  let curDay = Number.NaN;
  for (const p of points) {
    const day = tradingDayOf(p.t);
    if (day !== curDay) {
      curDay = day;
      runningMax = 0; // 거래일 경계 리셋
    }
    if (o.isClosingAuction(p.t)) continue; // 마감 동시호가 누적 제외
    const v = p[FIELD[side]];
    if (runningMax > 0 && v > runningMax * (1 + o.margin)) {
      out.push({ t: p.t, prevPeak: runningMax, value: v, pctOver: v / runningMax - 1 });
    }
    if (v > runningMax) runningMax = v; // 래칫
  }
  return out;
}

/** 양 side를 함께 산출(직접 호출·테스트용). 캐시 경로는 side별 detectSurgeSide를 따로 쓴다(중복 계산 회피). */
export function detectSurges(
  points: readonly QuoteRatioPoint[],
  opts: DetectSurgesOpts,
): Record<SurgeSide, SurgeMarker[]> {
  return { ask: detectSurgeSide(points, 'ask', opts), bid: detectSurgeSide(points, 'bid', opts) };
}
