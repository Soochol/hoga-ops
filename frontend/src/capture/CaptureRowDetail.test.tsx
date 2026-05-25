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
  attempt: 1,
};

describe('CaptureRowDetail', () => {
  it('shows started_at_ms (formatted KST clock) and frontier_ms', () => {
    render(<CaptureRowDetail item={base} />);
    expect(screen.getByText(/started_at/i)).toBeTruthy();
    expect(screen.getByText(/frontier/i)).toBeTruthy();
  });

  it('shows error message verbatim when item.error is set', () => {
    render(<CaptureRowDetail item={{ ...base, phase: 'failed', error: { code: 'internal_error', message: 'unexpected internal failure', at_page: null } }} />);
    expect(screen.getByText(/internal_error: unexpected internal failure/)).toBeTruthy();
  });

  it('omits error section when item.error is null', () => {
    render(<CaptureRowDetail item={base} />);
    expect(screen.queryByText(/error/i)).toBeNull();
  });
});

describe('CaptureRowDetail abort_reason', () => {
  const finishedBase: QueueItem = {
    ...base,
    phase: 'done',
    result: {
      pages_written: 42,
      unique_events: 100,
      raw_dir: '/data/raw/20260518/005930',
      parsed: true,
      abort_reason: null,
    },
  };

  it('omits the abort_reason row when result.abort_reason is null', () => {
    render(<CaptureRowDetail item={finishedBase} />);
    expect(screen.queryByText(/abort_reason/i)).toBeNull();
  });

  it('shows a Korean hint when result.abort_reason is stagnation_abort', () => {
    render(
      <CaptureRowDetail
        item={{
          ...finishedBase,
          result: { ...finishedBase.result!, abort_reason: 'stagnation_abort' },
        }}
      />,
    );
    expect(screen.getByText(/abort_reason/i)).toBeTruthy();
    expect(screen.getByText(/hogaplay 응답 동결로 캡처가 중단/)).toBeTruthy();
  });

  it('falls back to the raw reason for unknown abort_reason strings', () => {
    render(
      <CaptureRowDetail
        item={{
          ...finishedBase,
          result: { ...finishedBase.result!, abort_reason: 'unknown_future_reason' },
        }}
      />,
    );
    expect(screen.getByText('unknown_future_reason')).toBeTruthy();
  });
});

describe('CaptureRowDetail UpstreamCode map-driven copy', () => {
  it('shows captureFinishedHints copy when error.code is an UpstreamCode (cookie_expired)', () => {
    render(
      <CaptureRowDetail
        item={{
          ...base,
          phase: 'failed',
          error: {
            code: 'cookie_expired',
            message: 'cookie missing on page 5',
            at_page: 5,
          },
        }}
      />,
    );
    expect(screen.getByText(/캡처 실패 — hogaplay 쿠키 만료/)).toBeTruthy();
    // The raw message should still be visible (preserved as a debug-context line).
    expect(screen.getByText(/cookie missing on page 5/)).toBeTruthy();
  });
});
