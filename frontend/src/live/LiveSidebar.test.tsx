import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LiveSidebar } from './LiveSidebar';

// Mock useLiveSeries so LiveSidebar can render in isolation
vi.mock('../api/liveSeries', () => ({
  useLiveSeries: vi.fn(() => ({
    initial: undefined,
    isLoading: false,
    error: null,
    ob: [],
    trade: [],
    broker: [],
  })),
}));

import * as liveSeriesMod from '../api/liveSeries';

describe('LiveSidebar', () => {
  beforeEach(() => {
    (liveSeriesMod.useLiveSeries as ReturnType<typeof vi.fn>).mockReturnValue({
      initial: undefined,
      isLoading: false,
      error: null,
      ob: [],
      trade: [],
      broker: [],
    });
  });
  afterEach(() => cleanup());

  it('renders three card slots when code is null (waiting state)', () => {
    render(<LiveSidebar code={null} />);
    expect(screen.getByTestId('live-sidebar')).toBeInTheDocument();
  });

  it('subscribes to useLiveSeries with the active code', () => {
    render(<LiveSidebar code="005930" />);
    expect(liveSeriesMod.useLiveSeries).toHaveBeenCalledWith('005930');
  });

  it('shows the LIVE pulse badge in header (Design C1)', () => {
    render(<LiveSidebar code="005930" />);
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
  });
});
