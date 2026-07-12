// Flag legend value helpers — 커서 시각(가상초)을 거래일로 해석하고, 거래일별
// 지표 데이터(최대벽·POC)를 레전드 값 셀 문자열로 변환하는 순수 계층.
// `flagLegendValueRegistry`의 provider 구현체들이 공유한다.

import type { VirtualAxis } from '../util/virtualAxis';
import { formatQtyCompact } from '../util/formatQtyCompact';
import type { FlagLegendValueCell } from './indicators/flagLegendValueRegistry';

/** 커서 가상초 → 그 시각이 속한 거래일(YYYYMMDD). 커서 없음(null) → 마지막
 *  세그먼트 날짜(latest-fallback, MA row 규칙 미러). 축이 비면 null. */
export function legendCursorDate(axis: VirtualAxis, cursorTimeSec: number | null): string | null {
  const segs = axis.segments;
  if (segs.length === 0) return null;
  if (cursorTimeSec === null) return segs[segs.length - 1].date;
  const idx = axis.findByVirtual(cursorTimeSec * 1000);
  // 첫 세그먼트 이전(-1)은 데이터 없는 과거 — 값 없음이 정직하다.
  return idx >= 0 ? segs[idx].date : null;
}

/** "가격, 수량압축" — 최대벽 도킹 라벨과 동일한 포맷(peakWall label 미러). */
export function formatPriceQty(price: number, qty: number): string {
  return `${Math.round(price).toLocaleString('ko-KR')}, ${formatQtyCompact(qty)}`;
}

type DayPeakLike = {
  date: string;
  price: number | null;
  qty: number | null;
  max_price: number | null;
  max_qty: number | null;
};

/** 거래일별 최대벽(ask/bid 공용) provider 본체: 커서 거래일의 벽 가격·잔량을
 *  단일 셀로. 해당 날 데이터 없음 → 빈 배열(레전드는 이름만 표시). */
export function peakLegendCells(
  peaks: readonly DayPeakLike[],
  axis: VirtualAxis,
  intraMax: boolean,
  cursorTimeSec: number | null,
  key: string,
): FlagLegendValueCell[] {
  const date = legendCursorDate(axis, cursorTimeSec);
  if (date === null) return [];
  const peak = peaks.find((p) => p.date === date);
  if (!peak) return [];
  const price = intraMax ? peak.max_price : peak.price;
  const qty = intraMax ? peak.max_qty : peak.qty;
  if (price === null || qty === null || !Number.isFinite(price) || !Number.isFinite(qty)) return [];
  return [{ key, value: formatPriceQty(price, qty) }];
}
