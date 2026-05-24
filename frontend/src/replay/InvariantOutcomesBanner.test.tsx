import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import InvariantOutcomesBanner from './InvariantOutcomesBanner';

describe('InvariantOutcomesBanner', () => {
  it('renders nothing for healthy bundle (both lists empty)', () => {
    const { container } = render(
      <InvariantOutcomesBanner excluded={[]} warnings={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders error stripe for excluded_dates', () => {
    render(
      <InvariantOutcomesBanner
        excluded={[
          {
            date: '20260518',
            violations: [
              {
                invariant_id: 'meta.close_after_open',
                severity: 'error',
                message: 'session close must be strictly greater than open',
                ctx: { open_ms: 90_000_000, close_ms: 0 },
              },
            ],
          },
        ]}
        warnings={[]}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/데이터 결함으로 제외된 날짜/)).toBeInTheDocument();
    expect(screen.getByText('5/18')).toBeInTheDocument();
    expect(screen.getByText(/meta.close_after_open/)).toBeInTheDocument();
  });

  it('renders warn stripe for data_warnings without alert role', () => {
    render(
      <InvariantOutcomesBanner
        excluded={[]}
        warnings={[
          {
            date: '20260520',
            warnings: [
              {
                invariant_id: 'collection.unique_events_ratio',
                severity: 'warn',
                message: 'low unique-event-per-page ratio',
                ctx: { pages: 4132, events: 1553 },
              },
            ],
          },
        ]}
      />,
    );
    // warn-only render uses role="status", not "alert"
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/신뢰도 낮은 날짜/)).toBeInTheDocument();
    expect(screen.getByText(/collection.unique_events_ratio/)).toBeInTheDocument();
  });

  it('renders both stripes when both lists are populated', () => {
    render(
      <InvariantOutcomesBanner
        excluded={[
          {
            date: '20260518',
            violations: [
              { invariant_id: 'meta.close_after_open', severity: 'error',
                message: 'x', ctx: {} },
            ],
          },
        ]}
        warnings={[
          {
            date: '20260520',
            warnings: [
              { invariant_id: 'collection.finished', severity: 'warn',
                message: 'y', ctx: {} },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
