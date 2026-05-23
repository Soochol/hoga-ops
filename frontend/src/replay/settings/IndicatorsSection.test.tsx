import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import IndicatorsSection from './IndicatorsSection';
import { useTabsStore } from '../../state/tabs';

describe('IndicatorsSection', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('renders 5 MA rows with default labels and checkboxes', () => {
    render(<IndicatorsSection />);
    expect(screen.getByText('MA 5')).toBeTruthy();
    expect(screen.getByText('MA 10')).toBeTruthy();
    expect(screen.getByText('MA 20')).toBeTruthy();
    expect(screen.getByText('MA 60')).toBeTruthy();
    expect(screen.getByText('MA 120')).toBeTruthy();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(5);
    checkboxes.forEach((cb) => {
      expect((cb as HTMLInputElement).checked).toBe(true);
    });
  });

  it('clicking checkbox at index 1 disables that slot in the store', () => {
    render(<IndicatorsSection />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    const activeId = useTabsStore.getState().activeTabId;
    const updated = useTabsStore.getState().getPrefs(activeId);
    expect(updated.movingAverages[1].enabled).toBe(false);
    // Other slots remain unchanged.
    expect(updated.movingAverages[0].enabled).toBe(true);
    expect(updated.movingAverages[2].enabled).toBe(true);
    // Re-query — the checkbox should now reflect unchecked state.
    const checkboxesAfter = screen.getAllByRole('checkbox');
    expect((checkboxesAfter[1] as HTMLInputElement).checked).toBe(false);
  });

  it('changing period input on row 2 to 30 and blurring commits to store', () => {
    render(<IndicatorsSection />);
    const input = screen.getByLabelText('MA 20 기간') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '30' } });
    // No store write until commit.
    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).movingAverages[2].period).toBe(20);
    fireEvent.blur(input);
    expect(useTabsStore.getState().getPrefs(activeId).movingAverages[2].period).toBe(30);
  });

  it('Enter key on period input commits the value', () => {
    render(<IndicatorsSection />);
    const input = screen.getByLabelText('MA 5 기간') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).movingAverages[0].period).toBe(7);
  });

  it('invalid period values revert without touching the store', () => {
    render(<IndicatorsSection />);
    const activeId = useTabsStore.getState().activeTabId;
    const originalPeriod = useTabsStore.getState().getPrefs(activeId).movingAverages[2].period;
    expect(originalPeriod).toBe(20);

    const cases = ['abc', '1', '401', '', '20.5'];
    for (const value of cases) {
      const input = screen.getByLabelText('MA 20 기간') as HTMLInputElement;
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      // Store untouched.
      expect(useTabsStore.getState().getPrefs(activeId).movingAverages[2].period).toBe(20);
      // Input reverts to the prior canonical value.
      const inputAfter = screen.getByLabelText('MA 20 기간') as HTMLInputElement;
      expect(inputAfter.value).toBe('20');
    }
  });

  it('color dot inline style uses --ma-{n} for each row', () => {
    render(<IndicatorsSection />);
    for (let i = 0; i < 5; i += 1) {
      const dot = screen.getByTestId(`ma-color-dot-${i}`);
      expect(dot.getAttribute('style')).toContain(`--ma-${i + 1}`);
    }
  });
});
