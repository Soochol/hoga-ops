import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock ChartStage to throw — proves the boundary catches it.
vi.mock('../../src/chart/ChartStage', () => ({
  default: () => {
    throw new Error('boundary-test boom');
  },
}));
// Mock CursorSidebarConnected so it doesn't pull in network code.
vi.mock('../../src/sidebar/CursorSidebar', () => ({
  CursorSidebarConnected: () => <div data-testid="sidebar" />,
}));
// Stub API hooks the Workarea consumes.
vi.mock('../../src/api/session', () => ({
  useSession: () => ({ data: { fake: true }, isLoading: false, isError: false, error: null }),
}));
vi.mock('../../src/api/stock-dates', () => ({
  useStockDates: () => ({ data: [] }),
}));

import Workarea from '../../src/replay/Workarea';

describe('Workarea + ChartErrorBoundary integration', () => {
  const origErr = console.error;
  afterEach(() => {
    console.error = origErr;
  });

  it('isolates chart throws so sidebar remains rendered', () => {
    console.error = vi.fn();
    const tab: any = {
      id: 't1',
      selection: { code: '003490', fromDate: '20260511', toDate: '20260511' },
      cursorMs: null,
      status: 'loaded',
      bundles: new Map(),
    };
    render(<Workarea tab={tab} />);
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/boundary-test boom/)).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});
