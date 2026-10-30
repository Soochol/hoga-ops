import { computeEnvelope } from '../../chart/projectors/envelope';
import type { LineStyle } from '../../chart/drawing/types';
import { resolveMaColor } from '../../util/maColor';
import { useThemePrefsStore } from '../../state/themePrefs';
import { lineVisible } from '../../state/indicatorLineVisibility';
import { useScopedChartPrefs } from '../../state/chartPrefs';
import { computeSupertrend } from '../../chart/projectors/supertrend';
import { useId } from 'react';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import { computeSMA, selectSource } from '../../chart/projectors/movingAverage';
import type { CategoryId } from './IndicatorPanelHelpers';
import { dotColorsFor } from './indicatorDotColors';
import './IndicatorStylePreview.css';

type PreviewLine = { label: string; color: string; width: number; values: (number | null)[]; histogram?: boolean; lineStyle?: LineStyle };
const SAMPLE = Array.from({ length: 4096 }, (_, i) => {
  const close = 100 + Math.sin(i * .15) * 7 + Math.sin(i * .027) * 9;
  const open = close + Math.cos(i * .5) * 2;
  return { open, close, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2 };
});
const DISPLAY = SAMPLE.slice(-40);

function previewLines(category: CategoryId, s: IndicatorSettings, cumulative: boolean, theme: string): PreviewLine[] {
  if (category === 'moving-average' || category === 'daily-moving-average') {
    return (category === 'moving-average' ? s.movingAverages : s.dailyMovingAverages).filter(m => m.enabled && !m.hidden).map(m => ({
      label: `${m.period}${category === 'daily-moving-average' ? '일' : '봉'}`,
      color: resolveMaColor(m, theme), width: m.lineWidth,
      values: computeSMA(SAMPLE.map(c => selectSource(c, m.source)), m.period).slice(-40).map(value => value ?? 100),
    }));
  }
  if (category === 'envelope') {
    const points = computeEnvelope(SAMPLE.map(c => selectSource(c, s.envelopeSource)), s.envelopePeriod, s.envelopePercent).slice(-40);
    return [s.envelopeUpperColor, s.envelopeMiddleColor, s.envelopeLowerColor].map((color, line) => ({
      label: ['상단선', '중심선', '하단선'][line], color, width: s.envelopeLineWidth,
      values: points.map(point => point?.[(['upper', 'middle', 'lower'] as const)[line]] ?? 100),
    })).filter((_, i) => lineVisible(s.indicatorLineVisibility, (['envelopeUpper', 'envelopeMiddle', 'envelopeLower'] as const)[i]));
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
    })).filter((_, i) => lineVisible(s.indicatorLineVisibility, (['bollingerUpper', 'bollingerMiddle', 'bollingerLower'] as const)[i]));
  }
  if (category === 'new-high-bearish') return Array.from({ length: s.newHighBearishMaxCount }, (_, n) => ({
    label: `시가선 ${n + 1}`, color: s.newHighBearishColor, width: s.newHighBearishLineWidth,
    values: DISPLAY.map((_, i) => i < 12 + n * 8 ? null : 108 - n * 8),
  }));
  if (category === 'supertrend') {
    const points = computeSupertrend(SAMPLE, s.supertrendPeriod, s.supertrendMultiplier).slice(-40);
    return (['up', 'down'] as const).map((direction, i) => ({
      label: i ? '하락 추세' : '상승 추세', color: i ? s.supertrendDownColor : s.supertrendUpColor,
      width: s.supertrendLineWidth, values: points.map(p => p?.direction === direction ? p.value : null),
    })).filter((_, i) => lineVisible(s.indicatorLineVisibility, i ? 'supertrendDown' : 'supertrendUp'));
  }
  if (category === 'quote-totals') return [
    { key: 'quoteTotalsBid', label: '매수 총잔량', color: 'var(--price-up)', width: 3, values: DISPLAY.map((_, i) => 92 + Math.sin(i * .2) * 5) },
    { key: 'quoteTotalsAsk', label: '매도 총잔량', color: 'var(--price-down)', width: 3, values: DISPLAY.map((_, i) => 107 + Math.cos(i * .2) * 5) },
    ...(s.quoteTotalsLevelLineEnabled ? [
      { key: 'quoteTotalsBidLevel', label: '매수 수평선', color: s.quoteTotalsBidLevelColor, width: s.quoteTotalsBidLevelWidth, lineStyle: s.quoteTotalsBidLevelStyle, values: DISPLAY.map(() => 97) },
      { key: 'quoteTotalsAskLevel', label: '매도 수평선', color: s.quoteTotalsAskLevelColor, width: s.quoteTotalsAskLevelWidth, lineStyle: s.quoteTotalsAskLevelStyle, values: DISPLAY.map(() => 107) },
    ] as const : []),
    ...(s.quoteTotalsDayMaxLineEnabled ? [
      { key: 'quoteTotalsDayMaxBid', label: '매수 최고선', color: s.quoteTotalsDayMaxBidColor, width: s.quoteTotalsDayMaxBidWidth, lineStyle: s.quoteTotalsDayMaxBidStyle, values: DISPLAY.map(() => 101) },
      { key: 'quoteTotalsDayMaxAsk', label: '매도 최고선', color: s.quoteTotalsDayMaxAskColor, width: s.quoteTotalsDayMaxAskWidth, lineStyle: s.quoteTotalsDayMaxAskStyle, values: DISPLAY.map(() => 115) },
    ] as const : []),
  ].filter(line => lineVisible(s.indicatorLineVisibility, line.key as import('../../state/indicatorLineVisibility').IndicatorLineKey));
  if (category === 'fill-strength') return [
    ...(lineVisible(s.indicatorLineVisibility, 'fillStrengthBuy') ? [{ label: '매수 체결', color: 'var(--price-up)', width: 2, histogram: true, values: DISPLAY.map((_, i) => 100 + 4 + Math.abs(Math.sin(i * .4)) * 12) }] : []),
    ...(lineVisible(s.indicatorLineVisibility, 'fillStrengthSell') ? [{ label: '매도 체결', color: 'var(--price-down)', width: 2, histogram: true, values: DISPLAY.map((_, i) => 100 - 4 - Math.abs(Math.cos(i * .4)) * 12) }] : []),
    ...(cumulative ? [{ label: '당일 누적선', color: 'var(--fg-dim)', width: 2, values: DISPLAY.map((_, i) => 100 + Math.sin(i * .15) * 8) }] : []),
  ];
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
  const theme = useThemePrefsStore(s => s.themePreference);
  const cumulative = useScopedChartPrefs().fillStrengthCumulative;
  const lines = previewLines(category, settings, cumulative, theme);
  const controlled = ['moving-average', 'daily-moving-average', 'bollinger', 'envelope', 'supertrend', 'quote-totals', 'fill-strength'].includes(category);
  const hoga = category === 'quote-totals' || category === 'fill-strength';
  const colors = dotColorsFor(category, settings, theme);
  if (!controlled && !lines.length && !colors.length) return null;
  const allValues = [...DISPLAY.flatMap(c => [c.low, c.high]), ...lines.flatMap(line => line.values.filter((v): v is number => v !== null))];
  const low = Math.min(...allValues) - 3, high = Math.max(...allValues) + 3;
  const y = (value: number) => 106 - (value - low) / (high - low) * 96;
  const x = (index: number) => 8 + index / 39 * 464;
  return <figure className="indicator-style-preview" aria-label="지표 스타일 미리보기" data-testid="indicator-style-preview">
    <figcaption><span>미리보기</span><span>예시</span></figcaption>
    {(controlled || lines.length > 0) ? <svg viewBox="0 0 480 116" role="img" aria-label="설정한 색상과 두께를 반영한 지표 예시">
      <defs><clipPath id={clipId}><rect width="480" height="116" /></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        {[28, 62, 96].map(value => <line key={value} x1="0" x2="480" y1={value} y2={value} className="indicator-style-grid" />)}
        {!hoga && DISPLAY.map((candle, index) => <g key={index} className="indicator-style-candle">
          <line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} />
          <rect x={x(index) - 2} y={Math.min(y(candle.open), y(candle.close))} width="4" height={Math.max(1, Math.abs(y(candle.open) - y(candle.close)))} rx="1" />
        </g>)}
        {lines.map((line, index) => line.histogram
          ? <g key={index} fill={line.color} data-preview-line={line.label}>{line.values.map((value, i) => value === null ? null :
            <rect key={i} x={x(i) - 3} y={Math.min(y(100), y(value))} width="6" height={Math.max(1, Math.abs(y(value) - y(100)))} />)}</g>
          : <path key={index} d={line.values.map((value, i) => value === null ? '' : `${i && line.values[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(2)},${y(value).toFixed(2)}`).join(' ')}
            fill="none" stroke={line.color} strokeWidth={line.width} strokeDasharray={line.lineStyle === 'dashed' ? '6 4' : line.lineStyle === 'dotted' ? '2 3' : undefined} vectorEffect="non-scaling-stroke" data-preview-line={line.label} />)}
      </g>
    </svg> : <div className="indicator-style-swatches">{colors.map((color, index) => <span key={index} style={{ background: color }} aria-label={`선택 색상 ${index + 1}: ${color}`} />)}</div>}
    {controlled && lines.length === 0 && <p className="text-xs text-fg-dim">표시 중인 선이 없습니다.</p>}
    {lines.length > 0 && category !== 'moving-average' && category !== 'daily-moving-average' && <div className="indicator-style-legend">{lines.map((line, index) => <span key={index}><i style={{ background: line.color, height: line.width }} />{line.label}</span>)}</div>}
  </figure>;
}
