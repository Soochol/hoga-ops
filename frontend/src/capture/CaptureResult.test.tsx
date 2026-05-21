import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { CaptureResult } from './CaptureResult';
import type { CaptureJob } from '../api/types';

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

const base: CaptureJob = {
  job_id: 'j1', code: '005930', date: '20260520', phase: 'done',
  options: { allow_partial: false, resume: false, capture_only: false },
  started_at_ms: 0, error: null,
  progress: { pages_done: 76, events_seen: 19873, frontier_ms: 0, estimate_pct: 98, elapsed_ms: 222_000 },
  result: { pages_written: 76, unique_events: 19873, raw_dir: '/tmp', parsed: true },
};

describe('CaptureResult', () => {
  it('done phase shows Open in Replay CTA', () => {
    render(wrap(<CaptureResult job={base} onDismiss={vi.fn()} onResume={vi.fn()} />));
    expect(screen.getByText(/Open in Replay/)).toBeInTheDocument();
    expect(screen.getByText(/View in Inventory/)).toBeInTheDocument();
  });

  it('Open in Replay navigates with the Replay page tabs= schema', () => {
    // Locks the URL contract: ReplayViewer's useUrlSync hydrates tabs from
    // `?tabs=CODE:fromDate:toDate&active=N`. The bare `?code=...&date=...`
    // form was silently dropped, leaving the user on an empty Replay page.
    render(
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route path="/start" element={<CaptureResult job={base} onDismiss={vi.fn()} onResume={vi.fn()} />} />
          <Route path="/replay" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText(/Open in Replay/));
    expect(screen.getByTestId('loc').textContent).toBe('/replay?tabs=005930:20260520:20260520&active=0');
  });

  it('failed phase shows error message and Retry with Resume', () => {
    const job: CaptureJob = {
      ...base, phase: 'failed', result: null,
      error: { code: 'cookie_expired', message: 'Refresh your .cookie...', at_page: 34 },
    };
    render(wrap(<CaptureResult job={job} onDismiss={vi.fn()} onResume={vi.fn()} />));
    expect(screen.getByText('cookie_expired')).toBeInTheDocument();
    expect(screen.getByText(/Refresh your \.cookie/)).toBeInTheDocument();
    expect(screen.getByText(/Retry with Resume/)).toBeInTheDocument();
  });

  it('cancelled phase shows Resume from page N', () => {
    const job: CaptureJob = { ...base, phase: 'cancelled', result: null };
    render(wrap(<CaptureResult job={job} onDismiss={vi.fn()} onResume={vi.fn()} />));
    expect(screen.getByText(/Resume from page 76/)).toBeInTheDocument();
  });
});
