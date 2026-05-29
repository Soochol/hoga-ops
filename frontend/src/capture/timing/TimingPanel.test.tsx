import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimingPanel } from './TimingPanel';
import { useCaptureTimings } from './useCaptureTimings';
import type { TimingSummary } from '../../api/types';

function summary(overrides: Partial<TimingSummary> = {}): TimingSummary {
  return {
    code: '005930',
    date: '20250520',
    started_at_kst: '2026-05-27T14:32:18+09:00',
    ended_at_kst: '2026-05-27T14:33:02+09:00',
    total_ms: 43821.4,
    phase_totals_ms: {
      http_fetch_ms: 31204.8, parse_ms: 4102.1, disk_write_ms: 1843.7,
      rate_limit_ms: 5021.0, backoff_ms: 0, cookie_pause_ms: 0, other_ms: 0,
    },
    phase_percentages: {
      http_fetch: 71.2, parse: 9.4, disk_write: 4.2, rate_limit: 11.5,
      backoff: 0, cookie_pause: 0, other: 0,
    },
    unaccounted_ms: 1649.8,
    page_count: 387,
    event_count: 184231,
    error_counts: { '429': 0 },
    env: {
      rate_limit_s: 0.05, max_concurrent: 3, page_step_ms_initial: 60000,
      hoga_version: '0.1.0', git_sha: '9aef504',
    },
    ...overrides,
  };
}

describe('TimingPanel', () => {
  beforeEach(() => {
    useCaptureTimings.setState({ timings: {} });
  });

  it('renders nothing when no timing exists for the id', () => {
    const { container } = render(<TimingPanel id="005930:20250520" />);
    expect(container.textContent).toBe('');
  });

  it('renders collapsed by default when timing exists', () => {
    useCaptureTimings.getState().upsert('005930:20250520', summary());
    render(<TimingPanel id="005930:20250520" />);
    expect(screen.getByText(/43\.8 s/)).toBeInTheDocument();
    // expanded-only content should be absent
    expect(screen.queryByText(/pages: 387/)).not.toBeInTheDocument();
  });

  it('expands to show phase table on toggle click', () => {
    useCaptureTimings.getState().upsert('005930:20250520', summary());
    render(<TimingPanel id="005930:20250520" />);
    const toggle = screen.getByRole('button', { name: /타이밍 상세/i });
    fireEvent.click(toggle);
    expect(screen.getByText(/pages: 387/)).toBeInTheDocument();
    expect(screen.getByText(/events: 184,231/)).toBeInTheDocument();
  });

  it('warns when unaccounted_ms exceeds 5% of total', () => {
    useCaptureTimings.getState().upsert(
      '005930:20250520',
      summary({ unaccounted_ms: 5000, total_ms: 10000 }),
    );
    render(<TimingPanel id="005930:20250520" />);
    fireEvent.click(screen.getByRole('button', { name: /타이밍 상세/i }));
    expect(screen.getByText(/unaccounted/i)).toHaveAttribute('data-warning', 'true');
  });
});
