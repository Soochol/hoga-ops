import { memo } from 'react';

export interface CandleGlyphProps {
  /** 당일 OHLC + 현재가(close). 하나라도 결측/모순이면 미렌더(빈 셀). */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  width?: number;
  height?: number;
}

const W = 10, H = 16, PAD = 1, BODY_W = 8, CX = 5;

/** 두 y좌표 사이 최소 1px·중점정렬 세그먼트(심지·몸통 공용 — limit-lock 비대칭 방지). */
function place(a: number, b: number): { y: number; height: number } {
  const raw = Math.abs(a - b);
  const height = Math.max(raw, 1);
  return { y: Math.min(a, b) - (height - raw) / 2, height };
}

/** 당일 1봉 캔들 글리프(고-저 심지 + 시-종 몸통). 색 = strict 종가 vs 시가:
 *  종가>시가 양봉 --price-up(적) · 종가<시가 음봉 --price-down(청) · 도지 --fg-dim.
 *  결측/모순(null·high<=0·high<low) → null. DESIGN.md: 가격방향 카테고리의 캔들 확장. */
export const CandleGlyph = memo(function CandleGlyph({
  open, high, low, close, width = W, height = H,
}: CandleGlyphProps) {
  if (open == null || high == null || low == null || close == null
      || high <= 0 || high < low) return null;
  const stroke = close > open ? 'var(--price-up)'
    : close < open ? 'var(--price-down)' : 'var(--fg-dim)';
  const span = (high - low) || 1;                  // 도지/limit-lock: 0 나눗셈 방지
  const y = (v: number) => PAD + (1 - (v - low) / span) * (height - PAD * 2);
  const c = Math.min(Math.max(close, low), high);  // [low,high]로 clamp(off-canvas 방어)
  const wick = place(y(low), y(high));
  const body = place(y(open), y(c));
  return (
    <svg className="candle-glyph" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
      preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
      <rect x={CX - 0.5} y={wick.y} width={1} height={wick.height} fill={stroke} />
      <rect x={CX - BODY_W / 2} y={body.y} width={BODY_W} height={body.height} fill={stroke} />
    </svg>
  );
});
