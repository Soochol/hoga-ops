import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ viewport: { width: 1600, height: 1000 } });

for (const source of ['watchlist', 'heatmap'] as const) {
  test(`${source}: 200종목·400행 배치 조회와 시세 갱신 시 그래프 재사용`, async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date('2026-10-21T01:00:00Z') });
    await installLiveMocks(page);
    const folders = Array.from({ length: 10 }, (_, i) => ({ id: `f_${i.toString(16).padStart(8, '0')}`, name: `그룹 ${i}`, order: i }));
    const codes = Array.from({ length: 200 }, (_, i) => String(100000 + i));
    const entries = [0, 1].flatMap(shift => codes.map((code, i) => ({ code, name: `종목 ${code}`,
      folder_id: folders[(Math.floor(i / 20) + shift) % 10].id, order: i % 20 + shift * 20,
      registered_at_kst_date: '20261021', last_success_date: null })));
    await page.route(apiExact(source), route => route.fulfill({ json: { folders, entries, memos: [], capture_markers: {}, next_run_at_ms: 0 } }));
    let quote = 1;
    await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open', quotes: codes.map(code => ({ code, price: 10000, change_pct: quote, change_won: 100 })) } }));
    const pct = Array.from({ length: 132 }, (_, i) => i < 60 ? Math.round((Math.sin(i / 7) + i / 40) * 100) / 100 : null);
    const payload = { date: '2026-10-21', venue: 'KRX', bucket_ms: 300000, t_base_ms: 1792540800000, as_of_ms: 1792544400000,
      stocks: codes.map(code => ({ code, venue: 'KRX', pct, last_observed_ms: 1792544400000, missing_reason: null })),
      groups: folders.map(folder => ({ folder_id: folder.id, pct, total: 40, counts: pct.map(value => value == null ? 0 : 40) })) };
    let batches = 0;
    await page.route(apiExact('panel-flow'), route => { batches++; return route.fulfill({ json: payload }); });
    await page.goto('/live?code=098460');
    const started = performance.now();
    const panel = page.getByTestId(`${source}-panel`);
    if (!(await panel.isVisible())) await page.getByRole('button', { name: new RegExp(`${source === 'watchlist' ? '관심종목' : '히트맵'} 패널 토글`) }).click();
    await expect(panel.locator('.quote-row-flow svg')).toHaveCount(400);
    const firstPaintMs = Math.round(performance.now() - started);
    expect(batches).toBe(1);
    await expect(panel).toHaveCSS('width', '320px');
    const heading = panel.getByTestId('quote-columns-header');
    const top = (await heading.boundingBox())!.y;
    await panel.locator('[data-quote-nav]').evaluate(node => { node.scrollTop = 250; });
    await expect.poll(async () => (await heading.boundingBox())!.y).toBeCloseTo(top, 1);
    await expect(panel.locator('[data-quote-row] .quote-row-price')).toHaveCount(400);
    await page.evaluate(() => {
      let writes = 0;
      const observer = new MutationObserver(records => { writes += records.length; });
      observer.observe(document.querySelector('.ui-rail-drawer')!, { subtree: true, attributes: true, attributeFilter: ['d', 'points'] });
      Object.assign(window, { finishFlowObservation: () => { observer.disconnect(); return writes; } });
    });
    quote = 2;
    await page.clock.fastForward(11_000);
    await expect(panel.locator('[data-quote-row] .quote-row-percent').first()).toHaveText('+2.00%');
    const writes = await page.evaluate(() => (window as unknown as { finishFlowObservation: () => number }).finishFlowObservation());
    expect(writes).toBe(0);
    expect(batches).toBe(1);
    const measurements = { source, uniqueStocks: 200, rows: 400, graphs: 400, firstPaintMs, flowBatches: batches, pathWritesDuringQuoteRefresh: writes, payloadBytes: Buffer.byteLength(JSON.stringify(payload)) };
    console.log(JSON.stringify(measurements));
    await testInfo.attach('panel-flow-performance', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  });
}
