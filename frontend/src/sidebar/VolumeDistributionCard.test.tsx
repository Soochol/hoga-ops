import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DayVolumeDistribution } from '../api/types';
import { VolumeDistributionCard } from './VolumeDistributionCard';

const sessionOpenMs = Date.UTC(2026, 5, 25, 0, 0, 0);
const sessionCloseMs = Date.UTC(2026, 5, 25, 6, 30, 0);
const cursorMs = Date.UTC(2026, 5, 25, 1, 0, 0);

const profile: DayVolumeDistribution = {
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: sessionOpenMs,
  session_close_ms: sessionCloseMs,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 30 },
  ],
};

describe('VolumeDistributionCard', () => {
  it('renders distribution rows with an unlabeled time axis and highlights the max bin', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={cursorMs}
        closePrice={110}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    const rows = screen.getAllByTestId('volume-distribution-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveTextContent('110-120');
    expect(screen.getByTestId('volume-distribution-time-axis')).toHaveTextContent('');
    expect(screen.queryByText('09:00')).toBeNull();
    expect(screen.queryByText('15:30')).toBeNull();
    expect(screen.getByTestId('volume-distribution-max-bar')).toBeInTheDocument();
    expect(screen.getByTestId('volume-distribution-close-line')).toHaveStyle({ top: '50%' });
  });

  it('shows the cursor marker only inside the session bounds', () => {
    const { rerender } = render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getByTestId('volume-distribution-cursor-marker')).toBeInTheDocument();

    rerender(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={Date.UTC(2026, 5, 25, 8, 0, 0)}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.queryByTestId('volume-distribution-cursor-marker')).toBeNull();
  });

  it('hides the close line when the close is outside the profile price range', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={cursorMs}
        closePrice={99}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.queryByTestId('volume-distribution-close-line')).toBeNull();
  });

  it('positions the cursor marker against the latest trade time when available', () => {
    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          last_trade_ms: Date.UTC(2026, 5, 25, 2, 0, 0),
        }}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getByTestId('volume-distribution-cursor-marker')).toHaveStyle({ left: '50%' });
  });

  it('does not emit duplicate-key warnings for single-price profiles', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          price_min: 100,
          price_max: 100,
          bins: [
            { price_low: 100, price_high: 100, qty: 10 },
            { price_low: 100, price_high: 100, qty: 5 },
          ],
        }}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Encountered two children with the same key'),
      expect.anything(),
      expect.anything(),
    );
    consoleError.mockRestore();
  });
});
