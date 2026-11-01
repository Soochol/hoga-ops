import { expect, type Page } from '@playwright/test';
import type { ScanRequest, ScreenerResponse } from '../../../src/api/screener';
import type { ScreenerRun } from '../../../src/api/screenerRuns';
import { apiPrefix } from './apiRoutes';

/** Browser flow fixture. Backend collection/preservation has separate HTTP tests. */
export async function installScreenerRunsMock(page: Page,
  response: (request: ScanRequest) => ScreenerResponse,
  preparing: () => boolean = () => false,
  onStart: (request: ScanRequest) => void = () => {}) {
  const starts: ScanRequest[] = [];
  const requests = new Map<string, ScanRequest>();
  let reads = 0;
  await page.route(apiPrefix('screener/runs'), async route => {
    const http = route.request();
    let id: string;
    let request: ScanRequest;
    if (http.method() === 'POST') {
      expect(http.headers()['content-type']).toContain('application/json');
      request = http.postDataJSON() as ScanRequest;
      starts.push(request);
      onStart(request);
      id = String(starts.length).padStart(32, '0');
      requests.set(id, request);
    } else {
      reads += 1;
      id = new URL(http.url()).pathname.split('/').at(-1)!;
      const saved = requests.get(id);
      if (!saved) { await route.fulfill({ status: 404, json: { detail: 'missing run' } }); return; }
      request = saved;
    }
    const result = response(request);
    const coverage = result.bar_coverage ?? result.history_coverage;
    const incomplete = (coverage?.total ?? 0) - (coverage?.complete ?? 0);
    const pending = preparing();
    const run: ScreenerRun = {
      id, request, status: pending ? 'preparing' : incomplete > 0 ? 'partial' : 'complete',
      total: coverage?.total ?? result.rows.length, evaluated: coverage?.complete ?? result.rows.length,
      preparing: pending ? incomplete : 0, waiting: pending ? 0 : incomplete, failed: 0, next_retry_at_ms: null, errors: {},
      revision: reads + starts.length, result_revision: reads + starts.length, result,
      started_at_ms: Date.now(), updated_at_ms: Date.now(),
    };
    await route.fulfill({ json: run });
  });
  return { starts, reads: () => reads };
}
