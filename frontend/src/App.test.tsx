import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import App from './App';

vi.mock('./api/eventStream', () => ({
  useEventStream: () => {},
  lastHeartbeat: () => 0,
}));

vi.mock('./capture/useCaptureQueue', () => ({
  useCaptureQueueSync: () => {},
}));

vi.mock('./inventory/useInventoryRecaptureOrigins', () => ({
  useInventoryRecaptureOriginsCleanup: () => {},
}));

vi.mock('./nav/CaptureStatusPill', () => ({
  CaptureStatusPill: () => null,
}));

vi.mock('./rightrail/RightRail', () => ({
  default: () => <aside data-testid="right-rail" />,
}));

function wrap(ui: ReactNode, initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<App />}>
            <Route path="/live" element={<div>live page</div>} />
            <Route path="/study" element={<div>study page</div>} />
            <Route path="/heatmap" element={ui} />
            <Route path="/inventory" element={ui} />
            <Route path="/screener" element={ui} />
            <Route path="/capture" element={ui} />
            <Route path="/settings" element={ui} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  document.title = 'before-test';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App document title', () => {
  it.each([
    ['/heatmap', 'Heatmap'],
    ['/screener', 'Screener'],
    ['/inventory', 'Inventory'],
    ['/capture', 'Capture'],
    ['/settings', 'Settings'],
  ])('sets %s to the matching left nav label', (path, expected) => {
    wrap(<div>{expected}</div>, path);
    expect(document.title).toBe(expected);
  });

  it('leaves /live to the LivePage title writer', () => {
    wrap(<div>unused</div>, '/live?code=005930');
    expect(document.title).toBe('before-test');
  });

  it('sets /study to the matching left nav label', () => {
    wrap(<div>unused</div>, '/study');
    expect(document.title).toBe('Study');
  });
});
