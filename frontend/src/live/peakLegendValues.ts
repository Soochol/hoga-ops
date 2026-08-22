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

/** "가격, 수량압축" — 최대벽 도킹 라벨과 **같은 함수**다(레전드·라벨 공용).
 *
 *  종전엔 「미러」였는데 #839 가 라벨에서만 가격을 빼면서 그 주장이 거짓이 됐다
 *  (라벨 "1.8k" vs 레전드 "934,000, 1.8k"). 미러는 어긋나도 타입이 안 잡으므로
 *  이제 라벨이 이 함수를 **직접 부른다** — 갈릴 여지를 없앤다. */
export function formatPriceQty(price: number, qty: number): string {
  return `${Math.round(price).toLocaleString('ko-KR')}, ${formatQtyCompact(qty)}`;
}

/** "가격, +유입/-유출" — 단별 잔량 증감 레전드. net 이 아니라 gross 두 값을 함께 보인다:
 *  들어온 만큼 빠진 가격(net 0)이 "아무 일도 없었음"으로 읽히지 않게 하기 위함. */
export function formatPriceDelta(price: number, inQty: number, outQty: number): string {
  const parts: string[] = [];
  if (inQty > 0) parts.push(`+${formatQtyCompact(inQty)}`);
  if (outQty > 0) parts.push(`-${formatQtyCompact(outQty)}`);
  const flow = parts.length > 0 ? parts.join(' ') : '0';
  return `${Math.round(price).toLocaleString('ko-KR')}, ${flow}`;
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
