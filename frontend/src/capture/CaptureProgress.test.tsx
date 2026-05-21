import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureProgress } from './CaptureProgress';
import type { CaptureJob } from '../api/types';

function makeJob(overrides: Partial<CaptureJob> = {}): CaptureJob {
  return {
    job_id: 'j1', code: '005930', date: '20260520', phase: 'capturing',
    options: { allow_partial: false, resume: false, capture_only: false },
    started_at_ms: 0, result: null, error: null,
    progress: {
      pages_done: 47, events_seen: 12401,
      frontier_ms: Date.UTC(2026, 4, 20, 4, 24, 0),
      estimate_pct: 62, elapsed_ms: 134_000,
    },
    ...overrides,
  };
}

describe('CaptureProgress', () => {
  it('renders three big numbers from progress', () => {
    render(<CaptureProgress job={makeJob()} onCancel={vi.fn()} />);
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('12,401')).toBeInTheDocument();
    expect(screen.getByText('13:24:00')).toBeInTheDocument();
  });

  it('shows PARSING label when phase=parsing', () => {
    render(<CaptureProgress job={makeJob({ phase: 'parsing' })} onCancel={vi.fn()} />);
    expect(screen.getByTestId('capture-phase')).toHaveTextContent('PARSING');
  });

  it('cancel button shows confirm popover', () => {
    const onCancel = vi.fn();
    render(<CaptureProgress job={makeJob()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText(/Cancel capture/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Cancel capture/));
    expect(onCancel).toHaveBeenCalled();
  });
});
