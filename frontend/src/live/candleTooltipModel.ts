import type { Candle } from '../api/types';
import { isCalendarTimeframe, type LiveTimeframe } from '../state/livePage';

export interface CandleTooltipModel {
  tsMs: number;
  dateLabel: string;        // "05/27" (분) / "2026/05/27" (D·W·M)
  timeLabel: string | null; // "09:01" (분) / null (D·W·M)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;           // vol_a + vol_b
  // 직전 봉(이전 캔들) 종가 대비 변동률 % — OHLC 각각. prev 없거나 prev.close<=0 → null.
  openPct: number | null;
  highPct: number | null;
  lowPct: number | null;
  closePct: number | null;        // = 직전대비 변동률 (종가)
  barOverBarWon: number | null;   // close − prev.close (직전대비 금액)
  volumeRatioPct: number | null;  // (volume/prevVolume) × 100, prevVolume===0 → null
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ts_ms(실 Unix ms) → KST 라벨. LiveChartRoot timeFormatter 와 동일 규칙:
 *  calendar(D/W/M)는 09:00 KST 앵커라 시각이 오해를 주므로 날짜만. */
function kstLabels(
  tsMs: number,
  timeframe: LiveTimeframe,
): { dateLabel: string; timeLabel: string | null } {
  const d = new Date(tsMs + 9 * 3600_000);
  const md = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  if (isCalendarTimeframe(timeframe)) {
    return { dateLabel: `${d.getUTCFullYear()}/${md}`, timeLabel: null };
  }
  return { dateLabel: md, timeLabel: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

/**
 * 호버된 봉과 그 직전 봉만으로 툴팁 모델을 만든다. 순수 함수 — 차트/axis API 미접근.
 * `candles` 는 컴포넌트가 넘기는 "그려진(axis.contains 필터된, 타임프레임 집계된)"
 * 배열이라 `index-1` 이 직전 그려진 봉을 가리킨다 (봉대비, ADR-0059).
 */
export function buildCandleTooltip(
  candles: Candle[],
  index: number,
  timeframe: LiveTimeframe,
): CandleTooltipModel | null {
  if (index < 0 || index >= candles.length) return null;
  const c = candles[index];
  const volume = c.vol_a + c.vol_b;
  const { dateLabel, timeLabel } = kstLabels(c.ts_ms, timeframe);
  const prev = index > 0 ? candles[index - 1] : null;
  // 기준 = 직전 봉 종가(이전 캔들), 전 타임프레임 동일 (봉대비, ADR-0059). <=0 → null 로 Infinity 방지.
  const basis = prev && prev.close > 0 ? prev.close : null;
  const pct = (v: number): number | null => (basis === null ? null : (v / basis - 1) * 100);
  const prevVol = prev ? prev.vol_a + prev.vol_b : 0;
  return {
    tsMs: c.ts_ms,
    dateLabel,
    timeLabel,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume,
    openPct: pct(c.open),
    highPct: pct(c.high),
    lowPct: pct(c.low),
    closePct: pct(c.close),
    barOverBarWon: basis === null ? null : c.close - basis,
    volumeRatioPct: prev && prevVol > 0 ? (volume / prevVol) * 100 : null,
  };
}

export interface TooltipPlacement {
  left: number;
  top: number;
}

/** 커서 기준 우하단 배치, 가장자리에서 flip, 컨테이너 안으로 clamp.
 *  px/py·containerW/H 는 chart.chartElement() 기준 좌표(= param.point 와 동일 공간). */
export function placeTooltip(
  px: number,
  py: number,
  containerW: number,
  containerH: number,
  tipW: number,
  tipH: number,
  margin = 12,
): TooltipPlacement {
  let left = px + 14;
  let top = py + 12;
  if (left + tipW + margin > containerW) left = px - 14 - tipW; // 우측 flip
  if (top + tipH + margin > containerH) top = py - 12 - tipH;   // 하단 flip
  left = Math.max(margin, Math.min(left, Math.max(margin, containerW - tipW - margin)));
  top = Math.max(margin, Math.min(top, Math.max(margin, containerH - tipH - margin)));
  return { left, top };
}
