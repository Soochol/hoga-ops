import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import '@testing-library/jest-dom/vitest';
import CaptureStatusPill from './CaptureStatusPill';

const mockUseCaptureJob = vi.fn();
vi.mock('../capture/useCaptureJob', () => ({
  useCaptureJob: () => mockUseCaptureJob(),
}));

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe('CaptureStatusPill', () => {
  it('renders null when no job', () => {
    mockUseCaptureJob.mockReturnValue({ job: null });
    const { container } = render(wrap(<CaptureStatusPill />));
    expect(container.firstChild).toBeNull();
  });

  it('renders null when terminal', () => {
    mockUseCaptureJob.mockReturnValue({
      job: { phase: 'done', code: '005930', date: '20260520', progress: null }
    });
    const { container } = render(wrap(<CaptureStatusPill />));
    expect(container.firstChild).toBeNull();
  });

  it('renders pill when capturing', () => {
    mockUseCaptureJob.mockReturnValue({
      job: {
        job_id: 'j1', code: '005930', date: '20260520', phase: 'capturing',
        progress: { pages_done: 47, events_seen: 12401, frontier_ms: 0, estimate_pct: 62, elapsed_ms: 0 },
      },
    });
    render(wrap(<CaptureStatusPill />));
    expect(screen.getByTestId('capture-pill')).toBeInTheDocument();
    expect(screen.getByText(/005930/)).toBeInTheDocument();
    expect(screen.getByText(/47 pg/)).toBeInTheDocument();
  });
});
