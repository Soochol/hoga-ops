// 당일 최대벽 순위 화살표 — 세그먼트 → 화살표 좌표(순수).
//
// 앵커가 다른 표면들과 갈린다: 선·점·도킹 라벨은 전부 **벽 가격** y 에 붙지만, 화살표는
// **그 분봉 캔들의 극값**(매도=고가 / 매수=저가)에 붙는다. 그래서 "어느 봉이었나" 가
// 읽힌다.
//
// 어느 캔들인지 되찾는 법: `segment.peakTime` 은 `buildAskPeakSegments` 가
// `axis.toVirtual(캔들 ts_ms)/1000` 으로 만든 값이라, **같은 식으로 만든 키**로 정확히
// 되찾힌다. `axis.toReal` 역변환을 쓰지 않는 이유가 이것 — 세그먼트 경계에서 어느 쪽
// 세그먼트로 떨어지는지가 미묘해 1봉 밀릴 수 있다. (같은 키 규약을 `PaneLegendOverlay`
// 의 `vsecToIndex` 가 이미 쓴다.)

import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PeakWallSegment, PeakWallLabelSide } from '../chart/PeakWallSegmentsPrimitive';
import type { PeakWallRankArrow } from '../chart/PeakWallRankArrowsPrimitive';

/** 가상초 → 그 봉의 고가·저가. 캔들 배열이 수천 개라 호출부가 `useMemo` 로 붙든다
 *  (화살표 갱신은 팬·줌마다 도는데 이 맵은 캔들·축이 바뀔 때만 새로 만들면 된다). */
export function candleExtremesByVirtualSec(
  candles: readonly Candle[],
  axis: VirtualAxis,
): Map<number, { high: number; low: number }> {
  const m = new Map<number, { high: number; low: number }>();
  for (const c of candles) m.set(axis.toVirtual(c.ts_ms) / 1000, { high: c.high, low: c.low });
  return m;
}

/**
 * 그려진(필터를 모두 통과한) 세그먼트를 화살표로. 랭킹은 **여기서 하지 않는다** —
 * primitive 가 draw 시점에 보이는 범위로 고른다(팬을 별도 구독 없이 따라가고, 레전드와
 * 같은 순간의 범위를 읽게 하려고).
 *
 * peak 이 로드된 캔들 밖이면(좌측 백필 전) **건너뛴다**: 앵커로 쓸 봉 극값이 없는데
 * 벽 가격으로 대체하면 "캔들 위" 라는 이 마커의 뜻 자체가 깨진다.
 */
export function peakWallRankArrowsFromSegments(
  segments: readonly PeakWallSegment[],
  side: PeakWallLabelSide,
  extremes: ReadonlyMap<number, { high: number; low: number }>,
): PeakWallRankArrow[] {
  const out: PeakWallRankArrow[] = [];
  for (const s of segments) {
    const bar = extremes.get(Number(s.peakTime));
    if (!bar) continue;
    const anchorPrice = side === 'ask' ? bar.high : bar.low;
    if (!Number.isFinite(anchorPrice)) continue;
    out.push({
      time: s.peakTime,
      time0: s.time0,
      time1: s.time1,
      qty: s.qty,
      anchorPrice,
      side,
      color: s.color,
    });
  }
  return out;
}
