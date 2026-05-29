import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveSettingsModal from './LiveSettingsModal';
import { useChartPrefsStore } from '../state/chartPrefs';

describe('LiveSettingsModal', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('renders chart toggles (chart category only)', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });

  it('toggle click mutates chartPrefs store', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
    // ToggleRow puts data-testid on the outer wrapper div; the onClick
    // handler lives on the inner role="switch" button. Drill in to fire
    // the actual handler (matches the pattern in
    // replay/settings/IndicatorsSection.test.tsx).
    const row = screen.getByTestId('settings-toggle-auctionWindowMask');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('numeric input commits on Enter', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    const input = screen.getByTestId('settings-numeric-ratioOutlierThreshold') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(50);
  });

  it('source preference radio renders both options', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(screen.getByLabelText(/hogaplay 우선/)).toBeTruthy();
    expect(screen.getByLabelText(/kis_live 우선/)).toBeTruthy();
  });

  it('Escape calls onClose', () => {
    let closed = false;
    render(<LiveSettingsModal onClose={() => { closed = true; }} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  it('backdrop click calls onClose', () => {
    let closed = false;
    render(<LiveSettingsModal onClose={() => { closed = true; }} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(closed).toBe(true);
  });
});
