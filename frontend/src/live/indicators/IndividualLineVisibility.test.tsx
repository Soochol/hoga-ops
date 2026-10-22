import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import MovingAverageConfig from './MovingAverageConfig';
import DailyMovingAverageConfig from './DailyMovingAverageConfig';
import BollingerConfig from './BollingerConfig';
import EnvelopeConfig from './EnvelopeConfig';
import SupertrendConfig from './SupertrendConfig';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import FillStrengthConfig from './FillStrengthConfig';
import IndicatorStylePreview from './IndicatorStylePreview';
import { useWindowIndicators } from '../workspace/windowView';
import type { CategoryId } from './IndicatorPanelHelpers';

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m',
    dailyMovingAverages: FACTORY_INDICATOR_SETTINGS.dailyMovingAverages.map(m => ({ ...m, enabled: true })),
    envelopeEnabled: true, bollingerEnabled: true, supertrendEnabled: true, quoteTotalsEnabled: true, fillStrengthEnabled: true,
    quoteTotalsLevelLineEnabled: true, quoteTotalsDayMaxLineEnabled: true });
  useChartPrefsStore.getState().resetToDefaults();
});
function Preview({ category }: { category: CategoryId }) {
  return <IndicatorStylePreview category={category} settings={useWindowIndicators()} />;
}

describe('individual display switches and preview', () => {
  it.each([
    [MovingAverageConfig, 'moving-average', '기간1 표시', '5봉'],
    [DailyMovingAverageConfig, 'daily-moving-average', '기간1 표시', '20일'],
    [EnvelopeConfig, 'envelope', '엔벨로프 상단선 표시', '상단선'],
    [BollingerConfig, 'bollinger', '볼린저 상단선 표시', '상단선'],
    [SupertrendConfig, 'supertrend', '슈퍼트렌드 상승 추세 표시', '상승 추세'],
    [QuoteTotalsConfig, 'quote-totals', '매수 총잔량 표시', '매수 총잔량'],
    [FillStrengthConfig, 'fill-strength', '매수 체결 표시', '매수 체결'],
  ] as const)('%s hides only its selected line and preserves configuration', (Config, category, toggleLabel, lineLabel) => {
    const { container } = render(<><Config /><Preview category={category} /></>);
    const target = () => container.querySelector(`[data-preview-line="${lineLabel}"]`);
    const before = target()?.outerHTML;
    expect(before).toBeTruthy();
    const count = container.querySelectorAll('[data-preview-line]').length;
    const toggle = screen.getByRole('switch', { name: toggleLabel });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(target()).toBeNull();
    expect(container.querySelectorAll('[data-preview-line]')).toHaveLength(count - 1);
    fireEvent.click(toggle);
    expect(target()?.outerHTML).toEqual(before);
    if (category === 'quote-totals') expect(container.querySelector('[data-preview-line="매수 수평선"]')).toHaveAttribute('stroke-dasharray', '6 4');
  });

  it('quote guides are independent from their main traces and remain editable when hidden', () => {
    render(<QuoteTotalsConfig />);
    for (const label of ['매수 총잔량', '매수 수평선', '매수 최고선']) fireEvent.click(screen.getByRole('switch', { name: `${label} 표시` }));
    expect(screen.getByRole('switch', { name: '매도 총잔량 표시' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: '매수 수평선 스타일 선택' })).toBeEnabled();
    expect(useLivePageStore.getState().indicatorLineVisibility).toEqual({ quoteTotalsBid: false, quoteTotalsBidLevel: false, quoteTotalsDayMaxBid: false });
  });

  it('the existing cumulative preference uses the same row and clears the preview', () => {
    const { container } = render(<><FillStrengthConfig /><Preview category="fill-strength" /></>);
    for (const label of ['매수 체결 표시', '매도 체결 표시', '당일 누적선 표시']) fireEvent.click(screen.getByRole('switch', { name: label }));
    expect(container.querySelectorAll('[data-preview-line]')).toHaveLength(0);
    expect(screen.getByText('표시 중인 선이 없습니다.')).toBeInTheDocument();
    expect(useLivePageStore.getState().fillStrengthEnabled).toBe(true);
  });
});
