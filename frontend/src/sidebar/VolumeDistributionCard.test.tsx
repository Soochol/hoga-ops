import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DayVolumeDistribution } from '../api/types';
import { VolumeDistributionCard } from './VolumeDistributionCard';

const profile: DayVolumeDistribution = {
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 30 },
  ],
};

describe('VolumeDistributionCard', () => {
  it('renders high price rows first and highlights the max bin', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={100_000_000}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    const rows = screen.getAllByTestId('volume-distribution-row');
    expect(rows[0]).toHaveTextContent('110');
    expect(rows[0]).toHaveTextContent('120');
    expect(screen.getByTestId('volume-distribution-max-bar')).toBeInTheDocument();
  });

  it('shows the cursor marker only inside the session bounds', () => {
    const { rerender } = render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={100_000_000}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getByTestId('volume-distribution-cursor-marker')).toBeInTheDocument();

    rerender(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={200_000_000}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.queryByTestId('volume-distribution-cursor-marker')).toBeNull();
  });
});
