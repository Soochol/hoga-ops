import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaptureRowDetail } from './CaptureRowDetail';
import type { QueueItem } from '../api/types';

const base: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'capturing', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1_700_000_000_000, started_at_ms: 1_700_000_001_000,
  progress: { pages_done: 12, events_seen: 1000, frontier_ms: 1_700_000_500_000, estimate_pct: 30, elapsed_ms: 5000 },
  result: null,
  error: null,
  skip_reason: null,
};

describe('CaptureRowDetail', () => {
  it('shows started_at_ms (formatted KST clock) and frontier_ms', () => {
    render(<CaptureRowDetail item={base} />);
    expect(screen.getByText(/started_at/i)).toBeTruthy();
    expect(screen.getByText(/frontier/i)).toBeTruthy();
  });

  it('shows error message verbatim when item.error is set', () => {
    render(<CaptureRowDetail item={{ ...base, phase: 'failed', error: { code: 'cookie_expired', message: 'cookie missing on page 5', at_page: 5 } }} />);
    expect(screen.getByText(/cookie missing on page 5/)).toBeTruthy();
  });

  it('omits error section when item.error is null', () => {
    render(<CaptureRowDetail item={base} />);
    expect(screen.queryByText(/error/i)).toBeNull();
  });
});
