import { memo } from 'react';

export interface SparklineProps {
  /** since-open 시계열(상대 등락률 또는 가격; 모양 동일). undefined/<2점이면 미렌더. */
  series: number[] | undefined;
  width?: number;
  height?: number;
}

/** 평탄 임계(단위 %p — series가 change_pct이므로 slope = Δ일간등락 %p).
 *  |Δ| < EPS_PP 면 중립색. 0.05%p ≈ 롤링 창의 '추세 없음' 바닥선(1틱 ≈0.1~0.3%p
 *  미만의 미동을 방향신호로 오독 방지). closed 시 series 평탄 → slope 0 < EPS_PP → 중립 정지(의도). */
const EPS_PP = 0.05;

/** since-open 시계열 → 1px SVG 스파크라인. 색 = 기울기(last−first) 부호:
 *  상승 --price-up(적) · 하락 --price-down(청) · 평탄 --fg-dim.
 *  DESIGN.md: heat.ts가 가격방향을 배경으로 확장하듯, 이 컴포넌트는 1px stroke로 확장한다.
 *  색은 일간 등락칩과 다를 수 있다(다른 시간창 = 모멘텀 정보; spec invariant impact). */
export const Sparkline = memo(function Sparkline({ series, width = 56, height = 16 }: SparklineProps) {
  if (!series || series.length < 2) return null;
  const slope = series[series.length - 1] - series[0];
  const stroke = Math.abs(slope) < EPS_PP
    ? 'var(--fg-dim)'
    : slope > 0 ? 'var(--price-up)' : 'var(--price-down)';
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;       // 평탄이면 1로 나눠 중앙선
  const pad = 1.5;
  const h = height - pad * 2;
  const n = series.length;
  const d = series
    .map((v, i) => {
      const x = (i / (n - 1)) * width;
      const y = pad + (1 - (v - min) / span) * h; // SVG y 반전: 큰 값=위(작은 y)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const lastY = pad + (1 - (series[n - 1] - min) / span) * h;
  return (
    <svg className="srow-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
      preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeOpacity={0.9} strokeWidth={1}
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={Number(lastY.toFixed(1))} r={1.2} fill={stroke} />
    </svg>
  );
});
