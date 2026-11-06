import { expect, test, type Page } from '@playwright/test';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
type Frame = {
    holdingValues: number;
    holdingSame: boolean;
    holdingKnownUnchanged: boolean;
    foreignValues: number;
    foreignFirst: number | null;
    foreignLast: number | null;
    institutionValues: number;
    institutionLast: number | null;
    institutionFirst: number | null;
    institutionNotice: string;
    foreignNotice: string;
    candleCount: number;
    range: unknown;
};
type ProbeWindow = Window & {
    __liveCharts: Map<string, IChartApi>;
    __flowProbe: {
        chartId: string;
        holding: ISeriesApi<SeriesType>;
        frames: Frame[];
        active: boolean;
        read: () => Frame;
    };
};
const output = resolve(process.cwd(), '../.audit/preview');
const all = Array.from({ length: 2340 }, (_, i) => Date.UTC(2020, 0, 1 + i)).filter(t => t <= Date.UTC(2026, 4, 28) && ![0, 6].includes(new Date(t).getUTCDay())).map((t_ms, i) => ({ t_ms, open: 35000 + i * 5, high: 35300 + i * 5, low: 34700 + i * 5, close: 35000 + i * 5 + Math.sin(i * .15) * 150, volume: 100000 + i * 100 }));
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
const rows = (p: URLSearchParams) => all.filter(c => ymd(c.t_ms) >= p.get('from')! && ymd(c.t_ms) <= p.get('to')!);
async function add(page: Page, label: string) {
    await page.getByTestId('live-indicators-button').first().click();
    const panel = page.getByTestId('indicator-panel-shell');
    await panel.getByRole('button', { name: '지표 추가', exact: true }).click();
    await panel.getByRole('button', { name: label, exact: true }).click();
    if (label === '기관 누적 순매수') {
        await panel.getByRole('button', { name: '기관 누적 순매수 선택' }).click();
        await page.getByRole('button', { name: '기관 누적 순매수 #F97316', exact: true }).click();
    }
    await panel.getByRole('button', { name: '설정대로 추가', exact: true }).click();
    await panel.getByRole('button', { name: '닫기', exact: true }).click();
}
async function drag(page: Page, dx: number) {
    const box = await page.evaluate(() => { const p = (window as unknown as ProbeWindow).__flowProbe; const c = (window as unknown as ProbeWindow).__liveCharts.get(p.chartId)!; const b = c.chartElement().getBoundingClientRect(); return { x: b.x, y: b.y, width: c.timeScale().width(), height: c.panes()[0].getHeight() }; });
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .45);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .5 + dx, box.y + box.height * .45, { steps: 20 });
    await page.mouse.up();
}
async function probe(page: Page) {
    await expect.poll(() => page.evaluate(() => {
        const chart = [...(window as unknown as ProbeWindow).__liveCharts.values()][0];
        return ['#EC4899', '#F97316', '#22D3EE'].every(color => chart.panes().flatMap(p => p.getSeries()).some(s => {
            const options = s.options();
            return s.seriesType() === 'Line' && 'color' in options && options.color === color && s.data().filter(point => 'value' in point).length > 200;
        }));
    })).toBe(true);
    await page.evaluate(() => {
        const w = window as unknown as ProbeWindow;
        const [chartId, chart] = [...w.__liveCharts.entries()][0];
        const holding = chart.panes().flatMap(p => p.getSeries()).find(s => { const options = s.options(); return s.seriesType() === 'Line' && 'color' in options && options.color === '#EC4899'; })!;
        const knownValues = holding.data().flatMap(point => 'value' in point ? [point.value] : []);
        const read = (): Frame => {
            const live = chart.panes().flatMap(p => p.getSeries());
            const institution = live.find(s => { const options = s.options(); return s.seriesType() === 'Line' && 'color' in options && options.color === '#F97316'; });
            const foreign = live.find(s => { const options = s.options(); return s.seriesType() === 'Line' && 'color' in options && options.color === '#22D3EE'; });
            const foreignValues = foreign?.data().flatMap(point => 'value' in point ? [point.value] : []) ?? [];
            const heldValues = new Set(holding.data().flatMap(point => 'value' in point ? [point.value] : []));
            const values = institution?.data().flatMap(p => 'value' in p ? [p.value] : []) ?? [];
            return { foreignValues: foreignValues.length, foreignFirst: foreignValues[0] ?? null, foreignLast: foreignValues.at(-1) ?? null, holdingKnownUnchanged: knownValues.every(value => heldValues.has(value)), holdingValues: holding.data().filter(p => 'value' in p).length, holdingSame: live.includes(holding), institutionValues: values.length, institutionFirst: values[0] ?? null, institutionLast: values.at(-1) ?? null,
                institutionNotice: document.querySelector('[data-testid="pane-legend-rows-institution-cumulative"] [role="status"]')?.textContent ?? '', foreignNotice: document.querySelector('[data-testid="pane-legend-rows-foreign-cumulative"] [role="status"]')?.textContent ?? '',
                candleCount: live.find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0, range: chart.timeScale().getVisibleRange() };
        };
        w.__flowProbe = { chartId, holding, read, frames: [], active: true };
        const tick = () => { if (!w.__flowProbe.active)
            return; w.__flowProbe.frames.push(read()); requestAnimationFrame(tick); };
        tick();
    });
}
for (const failure of [false, true])
    test(`actual older prepend ${failure ? 'failure and retry' : 'success'} preserves holdings and rebases two cumulative curves`, async ({ page }) => {
        test.setTimeout(90000);
        await page.setViewportSize({ width: 1600, height: 1100 });
        await page.clock.setFixedTime(new Date('2026-05-28T17:00:00+09:00'));
        await installLiveMocks(page);
        await page.routeWebSocket(/\/api\/ws/, () => { });
        const requests: {
            kind: string;
            from: string | null;
        }[] = [];
        let firstFrom = '';
        let release: () => void = () => { };
        const gate = new Promise<void>(resolve => release = resolve);
        let hold = true;
        let fail = failure;
        await page.route(apiExact('live/past-daily-candles'), route => { const p = new URL(route.request().url()).searchParams; requests.push({ kind: 'candle', from: p.get('from') }); return route.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), candles: rows(p), cached_batches: [], fresh_batches: [], data_warnings: [] } }); });
        await page.route(apiExact('live/investor-holdings'), async (route) => {
            const p = new URL(route.request().url()).searchParams;
            firstFrom ||= p.get('from')!;
            const older = p.get('from')! < firstFrom;
            requests.push({ kind: 'holdings', from: p.get('from') });
            if (older && hold)
                await gate;
            if (older && fail) {
                await route.fulfill({ status: 503, json: { detail: 'synthetic failure' } });
                return;
            }
            const observations = rows(p).map(c => ({ date: ymd(c.t_ms), t_ms: c.t_ms, quantity_shares: 6000000 + all.indexOf(c) * 1000, ratio_pct: 26 + all.indexOf(c) / 1000 }));
            await route.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), source: 'kiwoom_ka10008', provider_scope: 'KRX', institution_supported: false, observations, oldest_observed_date: observations[0]?.date ?? null, latest_observed_date: observations.at(-1)?.date ?? null, pages_observed: 2, pagination_complete: true, exhausted: true, partial: false, data_warnings: [] } });
        });
        await page.route(apiExact('live/investor-daily-flow'), async (route) => {
            const p = new URL(route.request().url()).searchParams;
            const older = firstFrom && p.get('from')! < firstFrom;
            requests.push({ kind: 'flow', from: p.get('from') });
            if (older && hold)
                await gate;
            await route.fulfill({ json: { code: p.get('code'), from: p.get('from'), to: p.get('to'), source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net', observations: rows(p).map(c => ({ date: ymd(c.t_ms), t_ms: c.t_ms, institution_net_shares: 100, foreign_net_shares: -50 })), pagination: 'covered', unlocated_defect: false, pages_observed: 8, can_continue: false, data_warnings: [] } });
        });
        try {
            await page.goto('/live?code=098460');
            await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
            await page.getByRole('button', { name: '일', exact: true }).first().click();
            const max = page.getByRole('button', { name: '창 최대화', exact: true });
            if (await max.count())
                await max.first().click();
            await add(page, '외국인 보유');
            await add(page, '기관 누적 순매수');
            await add(page, '외국인 누적 순매수');
            await probe(page);
            const before = await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read());
            expect(before.holdingValues).toBeGreaterThan(200);
            expect(before.institutionValues).toBeGreaterThan(200);
            const chartId = await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.chartId);
            await page.evaluate(({ chartId, count }) => (window as unknown as ProbeWindow).__liveCharts.get(chartId)!.timeScale().setVisibleLogicalRange({ from: count - 200, to: count - 80 }), { chartId, count: before.candleCount });
            await drag(page, 80);
            const ordinary = await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read());
            expect(ordinary.holdingValues).toBe(before.holdingValues);
            expect(ordinary.institutionNotice).toBe(before.institutionNotice);
            const requestCount = requests.length;
            await page.evaluate(chartId => (window as unknown as ProbeWindow).__liveCharts.get(chartId)!.timeScale().setVisibleLogicalRange({ from: 5, to: 125 }), chartId);
            await drag(page, 260);
            await expect.poll(() => requests.filter(r => r.kind === 'holdings' && r.from! < firstFrom).length).toBeGreaterThan(0);
            await expect.poll(async () => await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read().candleCount)).toBeGreaterThan(before.candleCount);
            await page.waitForTimeout(350);
            const pending = await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read());
            expect(pending.holdingSame).toBe(true);
            expect(pending.holdingValues).toBe(before.holdingValues);
            expect(pending.institutionValues).toBe(before.institutionValues);
            expect(pending.foreignValues).toBe(before.foreignValues);
            mkdirSync(output, { recursive: true });
            await page.screenshot({ path: resolve(output, `history-${failure ? 'failure' : 'success'}-pending.png`) });
            hold = false;
            release();
            if (failure) {
                await expect(page.getByTestId('pane-legend-rows-investor-holdings')).toContainText('조회 실패', { timeout: 15000 });
                expect(await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read().holdingValues)).toBe(before.holdingValues);
                fail = false;
                await page.getByRole('button', { name: '보유 자료 다시 조회' }).click();
            }
            await expect.poll(async () => await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read().holdingValues)).toBeGreaterThan(before.holdingValues);
            await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read().institutionValues)).toBeGreaterThan(before.institutionValues);
            const after = await page.evaluate(() => (window as unknown as ProbeWindow).__flowProbe.read());
            expect(after.holdingSame).toBe(true);
            expect(after.institutionFirst).toBe(0);
            expect(after.institutionLast).toBe((after.institutionValues - 1) * 100);
            expect(after.institutionValues).toBeGreaterThan(before.institutionValues);
            expect(after.institutionNotice).toBe('');
            expect(after.foreignNotice).toBe('');
            const frames = await page.evaluate(() => { const p = (window as unknown as ProbeWindow).__flowProbe; p.active = false; return p.frames; });
            expect(frames.every(frame => frame.holdingSame && frame.holdingValues >= before.holdingValues)).toBe(true);
            for (const frame of frames) {
                expect(frame.holdingKnownUnchanged).toBe(true);
                if (frame.institutionValues > 0) {
                    expect(frame.institutionFirst).toBe(0);
                    expect(frame.institutionLast).toBe((frame.institutionValues - 1) * 100);
                    expect(frame.institutionNotice).toBe('');
                }
                else
                    expect(frame.institutionNotice).not.toContain('누적 기준');
                if (frame.foreignValues > 0) {
                    expect(frame.foreignFirst).toBe(0);
                    expect(frame.foreignLast).toBe((frame.foreignValues - 1) * -50);
                    expect(frame.foreignNotice).toBe('');
                }
                else
                    expect(frame.foreignNotice).not.toContain('누적 기준');
            }
            await page.screenshot({ path: resolve(output, `history-${failure ? 'failure' : 'success'}-resolved.png`) });
            writeFileSync(resolve(output, `history-${failure ? 'failure' : 'success'}.json`), JSON.stringify({ syntheticBoundary: 'external market-data APIs; real product range loading, cumulative math and series', before, ordinary, pending, after, requestCount, requests, frames }, null, 2));
        }
        finally {
            hold = false;
            release();
        }
    });
