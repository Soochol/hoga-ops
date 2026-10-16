import { useId } from 'react';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import { computeSMA, selectSource } from '../../chart/projectors/movingAverage';
import type { CategoryId } from './IndicatorPanelHelpers';
import { dotColorsFor } from './indicatorDotColors';
import './IndicatorStylePreview.css';

type PreviewLine = { label: string; color: string; width: number; values: number[] };
const SAMPLE = Array.from({ length: 4096 }, (_, i) => {
  const close = 100 + Math.sin(i * .15) * 7 + Math.sin(i * .027) * 9;
  const open = close + Math.cos(i * .5) * 2;
  return { open, close, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2 };
});
const DISPLAY = SAMPLE.slice(-40);

function previewLines(category: CategoryId, s: IndicatorSettings): PreviewLine[] {
  if (category === 'moving-average' || category === 'daily-moving-average') {
    return (category === 'moving-average' ? s.movingAverages : s.dailyMovingAverages).filter(m => m.enabled).map(m => ({
      label: `${m.period}${category === 'daily-moving-average' ? '일' : '봉'}`,
      color: m.color, width: m.lineWidth,
      values: computeSMA(SAMPLE.map(c => selectSource(c, m.source)), m.period).slice(-40).map(value => value ?? 100),
    }));
  }
  if (category === 'bollinger') {
    const values = SAMPLE.map(c => selectSource(c, s.bollingerSource));
    const middle = computeSMA(values, s.bollingerPeriod);
    const spread = values.slice(-40).map((_, i) => {
      const end = values.length - 40 + i;
      const window = values.slice(Math.max(0, end - s.bollingerPeriod + 1), end + 1);
      const mean = middle[end] ?? 100;
      return Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length) * s.bollingerMultiplier;
    });
    return [s.bollingerUpperColor, s.bollingerMiddleColor, s.bollingerLowerColor].map((color, line) => ({
      label: ['상단선', '중심선', '하단선'][line], color, width: s.bollingerLineWidth,
      values: middle.slice(-40).map((value, i) => (value ?? 100) + (1 - line) * spread[i]),
    }));
  }
  if (category === 'supertrend') return [s.supertrendUpColor, s.supertrendDownColor].map((color, line) => ({
    label: line ? '하락 추세' : '상승 추세', color, width: s.supertrendLineWidth,
    values: DISPLAY.map(c => c.close + (line ? 1 : -1) * s.supertrendMultiplier * 2),
  }));
  if (category === 'peak-walls') return [
    ...(s.askPeakEnabled ? [
      ...(s.askPeakTradedLineEnabled ? [{ label: '매도 체결', color: s.askPeakColor, width: s.askPeakLineWidth }] : []),
      ...(s.askPeakUnreachedLineEnabled ? [{ label: '매도 미도달', color: s.askPeakUnreachedColor, width: s.askPeakUnreachedLineWidth }] : []),
      ...(s.askPeakAllWallLineEnabled ? [{ label: '매도 전체', color: s.askPeakAllWallColor, width: s.askPeakAllWallLineWidth }] : []),
    ] : []),
    ...(s.bidPeakEnabled ? [
      ...(s.bidPeakTradedLineEnabled ? [{ label: '매수 체결', color: s.bidPeakColor, width: s.bidPeakLineWidth }] : []),
      ...(s.bidPeakUnreachedLineEnabled ? [{ label: '매수 미도달', color: s.bidPeakUnreachedColor, width: s.bidPeakUnreachedLineWidth }] : []),
      ...(s.bidPeakAllWallLineEnabled ? [{ label: '매수 전체', color: s.bidPeakAllWallColor, width: s.bidPeakAllWallLineWidth }] : []),
    ] : []),
  ].map((line, index) => ({ ...line, values: DISPLAY.map(() => 88 + index * 5) }));
  return [];
}

/** Synthetic prices demonstrate the actual chosen style; no market requests,
 * chart instances, or subscriptions are created for this small SVG. */
export default function IndicatorStylePreview({ category, settings }: { category: CategoryId; settings: IndicatorSettings }) {
  const clipId = useId();
  const lines = previewLines(category, settings);
  const colors = dotColorsFor(category, settings);
  if (!lines.length && !colors.length) return null;
  const allValues = [...DISPLAY.flatMap(c => [c.low, c.high]), ...lines.flatMap(line => line.values)];
  const low = Math.min(...allValues) - 3, high = Math.max(...allValues) + 3;
  const y = (value: number) => 106 - (value - low) / (high - low) * 96;
  const x = (index: number) => 8 + index / 39 * 464;
  return <figure className="indicator-style-preview" aria-label="지표 스타일 미리보기" data-testid="indicator-style-preview">
    <figcaption><span>스타일 미리보기</span><span>예시 데이터 · 스타일 확인용</span></figcaption>
    {lines.length > 0 ? <svg viewBox="0 0 480 116" role="img" aria-label="설정한 색상과 두께를 반영한 지표 예시">
      <defs><clipPath id={clipId}><rect width="480" height="116" /></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        {[28, 62, 96].map(value => <line key={value} x1="0" x2="480" y1={value} y2={value} className="indicator-style-grid" />)}
        {DISPLAY.map((candle, index) => <g key={index} className="indicator-style-candle">
          <line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} />
          <rect x={x(index) - 2} y={Math.min(y(candle.open), y(candle.close))} width="4" height={Math.max(1, Math.abs(y(candle.open) - y(candle.close)))} rx="1" />
        </g>)}
        {lines.map((line, index) => <path key={index} d={line.values.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(value).toFixed(2)}`).join(' ')}
          fill="none" stroke={line.color} strokeWidth={line.width} vectorEffect="non-scaling-stroke" data-preview-line={line.label} />)}
      </g>
    </svg> : <div className="indicator-style-swatches">{colors.map((color, index) => <span key={index} style={{ background: color }} aria-label={`선택 색상 ${index + 1}: ${color}`} />)}</div>}
    {lines.length > 0 && <div className="indicator-style-legend">{lines.map((line, index) => <span key={index}><i style={{ background: line.color, height: line.width }} />{line.label}</span>)}</div>}
  </figure>;
}
