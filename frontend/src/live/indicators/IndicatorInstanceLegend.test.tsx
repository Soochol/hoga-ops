import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndicatorInstanceLegend } from './IndicatorInstanceLegend';
import { usePaneLegendRegistry } from './paneLegendRegistry';
import { useLivePageStore } from '../../state/livePage';
import { DEFAULT_PREFS } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { indicatorInstanceSummary, makeIndicatorInstance } from '../../state/indicatorInstances';
import type { SeriesLegendMeta } from '../../chart/RangeSeriesPane';
import type { CategoryId } from './IndicatorPanelHelpers';
import { VOLUME_SPEC } from '../../chart/projectors/volume';
import { TRADE_VALUE_SPEC } from '../../chart/projectors/tradeValue';
import { RATIO_SPEC } from '../../chart/projectors/ratio';
import { PROGRAM_TRADE_SPEC } from '../../chart/projectors/programTrade';
import { DAILY_PROGRAM_TRADE_SPEC } from '../../chart/projectors/dailyProgramTrade';
import { INVESTOR_FOREIGN_SPEC, INVESTOR_INSTITUTION_SPEC } from '../../chart/projectors/investorNet';
import { INVESTOR_HOLDINGS_SPEC } from '../../chart/projectors/investorHoldings';
import { CUMULATIVE_SPECS } from '../../chart/projectors/investorCumulative';
import { QUOTE_TOTALS_SPEC } from '../../chart/projectors/quoteTotals';

const data = [{ time: 1, value: 1250 }, { time: 3, value: -2500 }];
const series = (visible = true) => ({ data: () => data, options: () => ({ visible }),
  priceFormatter: () => ({ format: (value: number) => `${value}` }) }) as never;
beforeEach(() => {
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {} });
  usePaneLegendRegistry.setState({ byScope: new Map() });
});
afterEach(cleanup);

function fixture(category: CategoryId, meta: SeriesLegendMeta) {
  const row = makeIndicatorInstance(category, FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS);
  useLivePageStore.setState({ indicatorInstances: [row] });
  usePaneLegendRegistry.getState().register(null, `indicator:${row.id}:volume`, [{ series: series(), meta }]);
  return row;
}

const cases: { category: CategoryId; meta: SeriesLegendMeta }[] = [
  { category: 'volume', meta: VOLUME_SPEC.series[0].legend },
  { category: 'trade-value', meta: TRADE_VALUE_SPEC.series[0].legend },
  { category: 'ratio', meta: RATIO_SPEC.series[0].legend },
  { category: 'program-trade', meta: PROGRAM_TRADE_SPEC.series[0].legend },
  { category: 'program-daily', meta: DAILY_PROGRAM_TRADE_SPEC.series[0].legend },
  { category: 'foreign-net', meta: INVESTOR_FOREIGN_SPEC.series[0].legend },
  { category: 'institution-net', meta: INVESTOR_INSTITUTION_SPEC.series[0].legend },
  { category: 'foreign-cumulative', meta: CUMULATIVE_SPECS.foreign.series[0].legend! },
  { category: 'institution-cumulative', meta: CUMULATIVE_SPECS.institution.series[0].legend! },
  { category: 'investor-holdings', meta: INVESTOR_HOLDINGS_SPEC.series[0].legend! },
];

describe('repeated Pane Legend names', () => {
  it.each(cases)('$category keeps its formatter and omits the pane name before its value', ({ category, meta }) => {
    const row = fixture(category, meta);
    const { container } = render(<IndicatorInstanceLegend id={row.id} cursorTimeSec={1} latestTimeSec={3} />);
    expect(container.querySelector('.font-data')).toHaveTextContent(meta.format?.(1250) ?? '1250');
    expect(container.querySelector('.font-data')).not.toHaveTextContent(meta.label);
    expect(screen.getByRole('button', { name: /숨기기$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /삭제$/ })).toBeInTheDocument();
  });

  it.each(['foreign-net', 'institution-net'] as const)('%s does not borrow a nearby value or native snapshot for a missing date', category => {
    const meta = category === 'foreign-net' ? INVESTOR_FOREIGN_SPEC.series[0].legend : INVESTOR_INSTITUTION_SPEC.series[0].legend;
    const row = fixture(category, meta);
    const { container, rerender } = render(<IndicatorInstanceLegend id={row.id} cursorTimeSec={1} latestTimeSec={3} />);
    const value = () => container.querySelector('.font-data')?.textContent;
    expect(value()).toBe(meta.format(1250));
    rerender(<IndicatorInstanceLegend id={row.id} cursorTimeSec={2} latestTimeSec={3} />);
    expect(value()).toBe('—');
    rerender(<IndicatorInstanceLegend id={row.id} latestTimeSec={3} />);
    expect(value()).toBe(meta.format(-2500));
  });

  it('preserves a series identifier when the other line is absent', () => {
    const meta = QUOTE_TOTALS_SPEC.series[0].legend;
    const row = fixture('quote-totals', meta);
    const { container } = render(<IndicatorInstanceLegend id={row.id} cursorTimeSec={1} />);
    expect(container.querySelector('.font-data')).toHaveTextContent('매수 1250');
  });

  it('omits the cumulative calculation summary only from the legend and keeps hide/delete scoped', () => {
    const row = fixture('foreign-cumulative', CUMULATIVE_SPECS.foreign.series[0].legend!);
    expect(indicatorInstanceSummary(row.category, FACTORY_INDICATOR_SETTINGS)).toBe('조회자료 첫날 0 · 주');
    const { container } = render(<IndicatorInstanceLegend id={row.id} cursorTimeSec={1} />);
    expect(container).not.toHaveTextContent('조회자료 첫날');
    fireEvent.click(screen.getByRole('button', { name: '외국인 누적 순매수 숨기기' }));
    expect(useLivePageStore.getState().indicatorInstances?.[0]).toMatchObject({ id: row.id, hidden: true });
    expect(container.querySelector('.font-data')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '외국인 누적 순매수 표시' }));
    fireEvent.click(screen.getByRole('button', { name: '외국인 누적 순매수 삭제' }));
    expect(useLivePageStore.getState().indicatorInstances).toEqual([]);
    expect(useLivePageStore.getState().indicatorUndoToast?.removedInstance?.row.id).toBe(row.id);
  });

  it('keeps percentage units and metric in the holdings title without repeating the subject', () => {
    const row = fixture('investor-holdings', { ...INVESTOR_HOLDINGS_SPEC.series[0].legend!, label: '외국인(%)', format: value => `${value.toFixed(2)}%` });
    act(() => useLivePageStore.setState({ indicatorInstances: [{ ...row, settings: { ...row.settings, investorHoldingsMetric: 'ratio' } }] }));
    const { container } = render(<IndicatorInstanceLegend id={row.id} cursorTimeSec={1} />);
    expect(container).toHaveTextContent('외국인 보유 · 비중 · %');
    expect(container.querySelector('.font-data')).toHaveTextContent('1250.00%');
    expect(container).not.toHaveTextContent('외국인(%)');
  });
});
