import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveSettingsModal from './LiveSettingsModal';
import { useChartPrefsStore } from '../state/chartPrefs';

describe('LiveSettingsModal (2단)', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('차트 카테고리 nav 클릭 후 차트 토글이 보인다', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });

  it('toggle click mutates chartPrefs store', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
    // ToggleRow puts data-testid on the outer wrapper div; the onClick handler
    // lives on the inner role="switch" button — drill in to fire it.
    const row = screen.getByTestId('settings-toggle-auctionWindowMask');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('numeric input commits on Enter (차트 카테고리)', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    const input = screen.getByTestId('settings-numeric-ratioOutlierThreshold') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(50);
  });

  it('급증 근접 문턱 numeric commits on Enter (총잔량 급증 카테고리)', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-surge'));
    const input = screen.getByTestId('settings-numeric-surgeApproachPct') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useChartPrefsStore.getState().surgeApproachPct).toBe(90);
  });

  it('데이터소스 nav 클릭 후 source radio 두 옵션이 보인다', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));
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
