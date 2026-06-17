import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VolumeConfig from './VolumeConfig';
import { useChartPrefsStore } from '../../state/chartPrefs';

describe('VolumeConfig', () => {
  afterEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('체결강도 누적 토글 행이 렌더링된다', () => {
    render(<VolumeConfig />);
    expect(screen.getByTestId('settings-toggle-volumeFillStrengthCumulative')).toBeTruthy();
    expect(screen.getByText('거래량 — 체결강도 누적')).toBeTruthy();
  });

  it('토글 클릭 시 chartPrefs에 반영된다', () => {
    render(<VolumeConfig />);
    const checkbox = screen.getByRole('switch', { name: '거래량 — 체결강도 누적' }) as HTMLButtonElement;

    expect(useChartPrefsStore.getState().volumeFillStrengthCumulative).toBe(false);
    fireEvent.click(checkbox);
    expect(useChartPrefsStore.getState().volumeFillStrengthCumulative).toBe(true);
    fireEvent.click(checkbox);
    expect(useChartPrefsStore.getState().volumeFillStrengthCumulative).toBe(false);
  });
});
