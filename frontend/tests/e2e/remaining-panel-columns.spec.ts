import { test, expect, type Locator } from '@playwright/test';
import type { mount, Kind } from './helpers/remainingPanelHarness';
import { apiExact } from './helpers/apiRoutes';

type HarnessWindow = Window & { panels:ReturnType<typeof mount> };
async function box(locator: Locator) {
  return locator.evaluate(node => {
    const bounds = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
    return { left:bounds.left, right:bounds.right, width:bounds.width, full:range.getBoundingClientRect().width <= bounds.width + 1,
      gap:parseFloat(getComputedStyle(node).columnGap), align:getComputedStyle(node).textAlign };
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time:new Date('2026-10-19T01:00:00Z') });
  await page.route(url => url.pathname === '/', route => route.fulfill({ contentType:'text/html', body:'<html><body><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>' }));
  await page.route(apiExact('signal-alerts/settings'), route => route.fulfill({ json:{ schema_version:1, sell_total_renewal:{ enabled:true, start_hhmm:900, threshold_pct:110, use_intra_minute_max:true } } }));
  await page.route(apiExact('signal-alerts/recent'), route => route.fulfill({ json:{ date:'20261019', scope:'inbox', cleared_through_seq:0,
    alerts:[1,2,3].map(i => ({ type:'signal_alert', id:String(i), signal:'sell_total_renewal', seq:i, code:i === 1 ? '000660' : '005930',
      name:i === 1 ? '긴이름의테스트종목' : '삼성전자', t_ms:1792368000000+i*1000, date:'20261019', source:'ws', value:i === 1 ? 123456789012 : 1234, baseline:100, ratio_pct:i === 1 ? 12345.6 : 110.1, use_intra_minute_max:true })) } }));
  await page.route(apiExact('screener/pattern-saves'), route => route.fulfill({ json:{ saves:[] } }));
  await page.route(apiExact('screener/pattern-search'), route => {
    const body = route.request().postDataJSON(), bars = Array.from({ length:7 }, (_, i) => [100+i,104+i,98+i,102+i]);
    return route.fulfill({ json:{ code:'005930', name:'삼성전자', mode:body.mode, timeframe:'D', empty_reason:null, coverage_from:'20000101', coverage_to:'20261019',
      results:Array.from({ length:26 }, (_, i) => ({ length:i+5, query:{ length:i+5, from_date:'20260901', to_date:'20260910', bars }, ma_periods:[], universe:2000,
        dist:{ p50:0.3, p95:0.6, p99:0.7, p99_99:0.8, sample:10000 }, matches:[0,1].map(j => ({ code:j ? '000660' : '004710', name:j ? '이름이아주긴테스트종목' : '한솔테크닉스',
          from_date:'20180307', to_date:'20180315', corr:j ? 0.987 : 0.998, bars, tail:[101,110,120], forward_pct:j ? -1234.5 : 1.2, ma:null, struct_match:null, struct_miss:null })),
        baseline:body.mode === 'history' ? { fwd_median_pct:1, fwd_win_rate_pct:50, sample:1000 } : null,
        partial_last_bucket_days:null, struct_total:null, struct_hist:null, struct_relations:null, elapsed_ms:1 })) } });
  });
  await page.route(apiExact('live/index-candles'), route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json:{ index_id:params.get('index_id'), timeframe:params.get('timeframe'), from:params.get('from'), to:params.get('to'),
      candles:[{ t_ms:1792368000000, open:1000, high:123456.78, low:1000, close:123456.78, volume:100 }], data_warnings:[] } });
  });
  await page.route(apiExact('live/index-quotes'), route => route.fulfill({ json:{ quotes:['KOSPI','KOSDAQ','KOSPI200'].map((id, i) => ({ id, label:id, value:i ? 1234.56 : 123456.78, change:10, change_rate:i ? -1.23 : 1234.56, t_ms:1792368400000 })) } }));
  await page.goto('/');
});

for (const fontSize of [16,20]) for (const kind of ['sector','indices','volume','pattern','alerts'] as Kind[]) {
  test(`${kind}: responsive columns and complete figures (${fontSize}px)`, async ({ page }, info) => {
    const errors:string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(async ({ kind,fontSize }) => {
      const path = '/tests/e2e/helpers/remainingPanelHarness.tsx';
      const { mount } = await import(path);
      (window as unknown as HarnessWindow).panels = mount(kind,900,fontSize); await document.fonts.ready;
    }, { kind,fontSize });
    const host = page.getByTestId('panel-host');
    if (kind === 'pattern') {
      await expect(page.locator('.pattern-match-row')).toHaveCount(2);
      await page.getByRole('button', { name:'과거에 이 모양', exact:true }).click();
      await expect(page.locator('.pattern-match-figures').last()).toContainText('-1234.5%');
    }
    if (kind === 'alerts') await expect(page.locator('.signal-alert-row')).toHaveCount(2);
    if (kind === 'indices') await expect(page.locator('.major-indices-value').first()).toHaveText('123,456.78');
    for (const width of [900,360,280,240]) {
      await page.evaluate(width => (window as unknown as HarnessWindow).panels.resize(width), width * fontSize / 16);
      const selectors:Record<Kind,string> = { sector:'.sector-ranking-sectors .sector-ranking-row > :last-child', indices:'.major-indices-value, .major-indices-percent',
        volume:'[data-testid="volume-distribution-price-axis"] > span:not(.volume-distribution-axis-budget)', pattern:'.pattern-match-figures > span', alerts:'.signal-alert-row > :nth-child(2), .signal-alert-quantity > :last-child' };
      const figures = host.locator(selectors[kind]);
      await expect(figures.first()).toBeVisible();
      for (const figure of await figures.all()) expect((await box(figure)).full).toBe(true);
      expect(await host.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      if (kind === 'sector' || kind === 'pattern' || kind === 'alerts') {
        const rows = host.locator(kind === 'sector' ? '.sector-ranking-sectors .sector-ranking-row' : kind === 'pattern' ? '.pattern-match-row' : '.signal-alert-row');
        const column = kind === 'alerts' ? ':scope > :nth-child(2)' : ':scope > :last-child';
        expect((await box(rows.first().locator(column))).right).toBeCloseTo((await box(rows.last().locator(column))).right, 2);
        const gap = width > 320 ? 8 : width > 260 ? 4 : 2;
        await expect.poll(() => box(rows.first()).then(value => value.gap)).toBe(gap * fontSize / 16);
      }
      if (kind === 'volume') {
        const axis = host.getByTestId('volume-distribution-price-axis'), time = host.getByTestId('volume-distribution-time-axis');
        expect((await box(axis)).left - (await box(time)).right).toBeCloseTo(4 * fontSize / 16, 2);
        const before = await box(axis);
        await page.evaluate(() => (window as unknown as HarnessWindow).panels.cursor(1792368600000));
        expect((await box(axis)).width).toBe(before.width);
      }
      if (kind === 'indices' && width <= 360) {
        const rows = host.locator('.major-indices-quote');
        expect((await box(rows.first().locator('.major-indices-value'))).right).toBeCloseTo((await box(rows.last().locator('.major-indices-value'))).right, 2);
      }
      if (kind === 'indices') {
        await expect.poll(() => host.getByTestId('major-indices-axis-labels').evaluate(group => {
          const svg = group.closest('svg')!.getBoundingClientRect();
          return [...group.querySelectorAll('text')].every(node => {
            const bounds = node.getBoundingClientRect(); return bounds.right <= svg.right && bounds.left >= svg.left;
          });
        })).toBe(true);
      }
    }
    if (kind === 'sector') {
      await host.locator('.sector-ranking-sectors .sector-ranking-row').first().click();
      await expect(host.getByRole('button', { name:'← 섹터 목록', exact:true })).toBeFocused();
      const stock = host.locator('.sector-ranking-stocks .sector-ranking-row').last();
      expect((await box(stock.locator(':scope > :last-child'))).full).toBe(true);
      await stock.click(); await expect(host).toHaveAttribute('data-opened','000660');
      await host.getByRole('button', { name:'← 섹터 목록', exact:true }).click();
      await expect(host.locator('.sector-ranking-sectors [aria-pressed="true"]')).toBeFocused();
    }
    if (kind === 'pattern') {
      await host.locator('.pattern-match-row').first().focus(); await page.keyboard.press('Delete');
      await expect(host.locator('.pattern-match-row')).toHaveCount(1);
      await expect(host.locator('.pattern-match-row')).toBeFocused();
    }
    await host.screenshot({ path:info.outputPath(`${kind}-${fontSize}.png`) });
    expect(errors).toEqual([]);
  });
}
