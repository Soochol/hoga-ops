import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import KisRestUnavailableToastHost from './KisRestUnavailableToastHost';
import { useKisRestModeStore } from '../state/kisRestMode';

describe('KisRestUnavailableToastHost', () => {
  beforeEach(() => {
    localStorage.clear();
    useKisRestModeStore.setState({
      kisRestBypassEnabled: false,
      lastFailureAtMs: null,
      lastToastAtMs: null,
    });
  });

  it('shows a KIS connection toast and toggles bypass mode', () => {
    render(<KisRestUnavailableToastHost />);

    act(() => {
      useKisRestModeStore.getState().notifyFailure(1_000);
    });

    expect(screen.getByRole('status')).toHaveTextContent('KIS 연결 불가');
    const toggle = screen.getByRole('switch', { name: 'KIS API 우회' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(useKisRestModeStore.getState().kisRestBypassEnabled).toBe(true);
    expect(screen.getByRole('switch', { name: 'KIS API 우회' })).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('chart.kisRestMode.v1')).toContain('true');
  });

  it('does not render before a failure notification', () => {
    render(<KisRestUnavailableToastHost />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
