import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import SettingsModal, { SourcePreferenceRadio } from './SettingsModal';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { useTabsStore } from '../state/tabs';

describe('SourcePreferenceRadio', () => {
  beforeEach(() => {
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay' });
  });

  it('reflects current store value and updates on click', () => {
    const { container } = render(
      <>
        <SourcePreferenceRadio value="hogaplay" />
        <SourcePreferenceRadio value="kis_live" />
      </>,
    );
    const hogaplay = container.querySelector('input[value="hogaplay"]') as HTMLInputElement;
    const kis = container.querySelector('input[value="kis_live"]') as HTMLInputElement;
    expect(hogaplay.checked).toBe(true);
    fireEvent.click(kis);
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_live');
  });
});

describe('SettingsModal — Source Preference section', () => {
  beforeEach(() => {
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay' });
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('shows Source Preference section with helper text in 차트 category', () => {
    render(<SettingsModal onClose={() => {}} />);
    expect(screen.getByText(/기본 데이터 소스/)).toBeInTheDocument();
    expect(screen.getByText(/모든 차트 공통/)).toBeInTheDocument();
  });

  it('switching the radio updates the store', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/kis_live 우선/));
    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_live');
  });
});
