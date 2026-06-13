import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import IndicatorPrefRows from './IndicatorPrefRows';
import { useChartPrefsStore } from '../../state/chartPrefs';

describe('IndicatorPrefRows', () => {
  afterEach(cleanup);

  it('주어진 토글 키의 ToggleRow를 렌더', () => {
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });

  it('enabledBy로 묶인 numeric을 함께 렌더', () => {
    useChartPrefsStore.setState({ surgeMarkerEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    expect(screen.getByText(/급증 근접 문턱/)).toBeTruthy();
  });

  it('토글 클릭 → chartPrefs 갱신', () => {
    useChartPrefsStore.setState({ ratioOutlierFilterEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled']} />);
    // ToggleRow puts data-testid on the outer wrapper div; the onClick handler
    // lives on the inner role="switch" button — drill in to fire it.
    const row = screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().ratioOutlierFilterEnabled).toBe(false);
  });

  it('gated numeric input commits on Enter', () => {
    useChartPrefsStore.getState().resetToDefaults();
    useChartPrefsStore.setState({ surgeMarkerEnabled: true });
    render(<IndicatorPrefRows toggleKeys={['surgeMarkerEnabled']} />);
    const input = screen.getByTestId('settings-numeric-surgeApproachPct') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useChartPrefsStore.getState().surgeApproachPct).toBe(90);
  });
});
