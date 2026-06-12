import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

export type Extreme = {
  /** 극값 가격 — 고가는 봉의 high, 저가는 봉의 low. */
  price: number;
  /** 극값 대비율(Extreme Gap) = (현재가 − price) / price × 100. CONTEXT.md `극값 대비율`. */
  pct: number;
  /** 극값 봉의 실 Unix ms — KST 시각 라벨용(formatExtremeLabel). */
  tsMs: number;
  /** 극값 봉의 가상초(chart Time = axis.toVirtual(tsMs)/1000) — x좌표 투영용. */
  virtualSec: number;
};

export type VisibleExtremes = { high: Extreme; low: Extreme } | null;

function gap(currentPrice: number, extreme: number): number {
  return ((currentPrice - extreme) / extreme) * 100;
}

/**
 * 현재 보이는 뷰포트 범위 안에서 그려진 캔들의 최고가 봉/최저가 봉을 찾아 극값 대비율을 계산한다.
 * (CONTEXT.md: `극값 대비율` / `High/Low Extreme Labels`.) lightweight-charts 비의존 —
 * 좌표→픽셀 변환은 호출부(HighLowAnnotationOverlay)가 담당한다.
 *
 *  - visibleRange / currentPrice 가 null 이거나 candles 가 비면 null (no-op).
 *  - `axis.contains(ts_ms)` 가 false인 봉(축에 안 그려짐) 제외. 마감 동시호가 봉은 그려지므로
 *    포함한다(그릴링 Q2 — 캔들 pane과 동일 기준; 캔들은 Auction Mask 비참여, ADR-0018/0029).
 *  - `visibleRange`(가상초) 밖의 봉 제외. 동률 극값은 첫 발생을 유지(스크롤 중 흔들림 방지).
 *  - 거래일별 리셋 없음 — 멀티데이 concat이어도 "보이는 범위의 전역 극값"(surge와 상반).
 */
export function computeVisibleExtremes(
  candles: readonly Candle[],
  axis: VirtualAxis,
  visibleRange: { from: number; to: number } | null,
  currentPrice: number | null,
): VisibleExtremes {
  if (visibleRange === null || currentPrice === null || candles.length === 0) return null;
  const { from, to } = visibleRange;

  let high: Extreme | null = null;
  let low: Extreme | null = null;
  for (const c of candles) {
    if (!axis.contains(c.ts_ms)) continue;
    const virtualSec = axis.toVirtual(c.ts_ms) / 1000;
    if (virtualSec < from || virtualSec > to) continue;
    if (high === null || c.high > high.price) {
      high = { price: c.high, pct: gap(currentPrice, c.high), tsMs: c.ts_ms, virtualSec };
    }
    if (low === null || c.low < low.price) {
      low = { price: c.low, pct: gap(currentPrice, c.low), tsMs: c.ts_ms, virtualSec };
    }
  }
  if (high === null || low === null) return null;
  return { high, low };
}
