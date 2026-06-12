import type { QuoteRatioPoint } from '../../api/types';

export type SurgeSide = 'ask' | 'bid';
/** prevPeak = 발사 시점의 running peak(직전 고가). value = 그 순간 총잔량. pctOfPeak = value/prevPeak
 *  (근접 발사면 0.95~1.0, 신고가 갱신 중이면 ≥1.0). */
export type SurgeMarker = { t: number; prevPeak: number; value: number; pctOfPeak: number };

export type DetectSurgesOpts = {
  /** 근접 발사 문턱(비율): value ≥ approachRatio × runningPeak 이면 발사. 기본 0.95. */
  approachRatio: number;
  /** 재무장 문턱(비율): value < rearmRatio × runningPeak 로 빠지면 다시 발사 가능. 기본 0.85.
   *  (히스테리시스 — 고점 근처 출렁임에 도배되지 않게 approachRatio보다 낮게.) */
  rearmRatio: number;
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

/**
 * 한 side(ask|bid)의 급증 마커 — **근접(re-approach) + 히스테리시스** 방식.
 * 벽이 당일 running peak의 `approachRatio`(기본 95%)까지 차오르면 1회 발사하고, `rearmRatio`(기본 85%)
 * 아래로 빠져야 다시 발사 가능. 즉 "벽이 자기 직전 고가에 다시 도전하는 순간"을 한 번씩 잡는다.
 * 거래일마다 running peak·무장 리셋, 마감 동시호가 제외. quiet-start: 무장은 false로 시작(첫 고가가
 * 세워지고 한 번 빠진 뒤부터 발사 — 비교할 직전 고가가 생긴 뒤).
 */
export function detectSurgeSide(
  points: readonly QuoteRatioPoint[],
  side: SurgeSide,
  o: DetectSurgesOpts,
): SurgeMarker[] {
  const out: SurgeMarker[] = [];
  let runningMax = 0;
  let armed = false;
  let curDay = Number.NaN;
  for (const p of points) {
    const day = tradingDayOf(p.t);
    if (day !== curDay) {
      curDay = day;
      runningMax = 0; // 거래일 경계 리셋
      armed = false;
    }
    if (o.isClosingAuction(p.t)) continue; // 마감 동시호가 누적 제외
    const v = p[FIELD[side]];
    if (runningMax > 0) {
      if (v < o.rearmRatio * runningMax) armed = true; // 빠짐 → 재무장
      if (armed && v >= o.approachRatio * runningMax) {
        out.push({ t: p.t, prevPeak: runningMax, value: v, pctOfPeak: v / runningMax });
        armed = false; // 한 번 발사 후 disarm (재무장 전까지 도배 방지)
      }
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
