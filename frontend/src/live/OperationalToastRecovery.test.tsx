import type { ComponentType } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveStatus } from '../api/liveStatus';
import DiskHeadroomToastHost from './DiskHeadroomToastHost';
import SupervisedTaskFailureToastHost from './SupervisedTaskFailureToastHost';

const query = vi.hoisted(() => ({ data: undefined as LiveStatus | undefined }));
vi.mock('../api/liveStatus', async importOriginal => ({ ...await importOriginal<typeof import('../api/liveStatus')>(), useLiveStatus: () => query }));
afterEach(cleanup);
const base: LiveStatus = { running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
  capture_healthy: true, capture_reason: 'healthy', watchlist_count: 1, live_set: [], rest_bypass_enabled: false };

function checkRecovery(Component: ComponentType, failed: LiveStatus, recovered: LiveStatus) {
  query.data = failed;
  const { rerender } = render(<Component />);
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  query.data = base; // Missing observations cannot count as recovery.
  rerender(<Component />);
  query.data = { ...failed };
  rerender(<Component />);
  expect(screen.queryByRole('status')).toBeNull();
  query.data = recovered;
  rerender(<Component />);
  query.data = failed;
  rerender(<Component />);
  expect(screen.getByRole('status')).toBeVisible();
}
it('renotifies disk exhaustion only after observed recovery and recurrence', () => {
  checkRecovery(DiskHeadroomToastHost, { ...base, disk: { low: true, free_pct: 8, free_gib: 10 } },
    { ...base, disk: { low: false, free_pct: 40, free_gib: 50 } });
});
it('renotifies task death only after observed recovery and recurrence', () => {
  checkRecovery(SupervisedTaskFailureToastHost, { ...base, supervised_tasks: [{ name: 'worker', running: false, state: 'dead' }] },
    { ...base, supervised_tasks: [{ name: 'worker', running: true, state: 'running' }] });
});
