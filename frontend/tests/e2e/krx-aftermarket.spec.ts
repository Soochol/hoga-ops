import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { installLiveWs } from './helpers/liveWs';
import { apiPrefix } from './helpers/apiRoutes';

const CODE = '098460';
const at = (hour: number, minute = 0) => Date.UTC(2026, 8, 14, hour - 9, minute);

async function chartCloses(page: Page, id: string): Promise<number[]> {
  return page.evaluate((windowId) => {
    const charts = (window as unknown as {__liveCharts?: Map<string, import('lightweight-charts').IChartApi>}).__liveCharts;
    return charts?.get(windowId)?.panes().flatMap(pane => pane.getSeries().flatMap(series =>
      series.data().flatMap(point => 'close' in point ? [point.close] : []))) ?? [];
  }, id);
}

test('KRX 15:30 → 16:00 → 20:00 keeps the live ladder and evening candle', async ({ page }) => {
  await page.clock.install({time:at(15,29)});
  const ws = await installLiveWs(page);
  await installLiveMocks(page);
  await page.addInitScript(() => localStorage.setItem('live.venue.v1', JSON.stringify({venue:'KRX'})));
  await page.route(apiPrefix('live/past-candles'), route => route.fulfill({json:{
    code:CODE,from:'20260914',to:'20260914',candles:[{t_ms:at(15),open:30000,high:30000,low:30000,close:30000,volume:10}],cached_dates:[],fresh_dates:[],data_warnings:[],
    effective_sessions:[{date:'20260914',open_ms:at(9),close_ms:at(20)}],
  }}));
  let retiredRequests = 0;
  await page.route(apiPrefix('live/after-hours-book'), route => {
    retiredRequests += 1;
    return route.fulfill({json:{code:CODE,active:false}});
  });
  await page.goto(`/live?code=${CODE}`);
  await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
  // Set up the actual workspace, then drive market data through its WebSocket.
  const chartId = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const {useWorkspaceStore} = await import(path);
    const state = useWorkspaceStore.getState();
    const chart = state.windows.find((win: {kind:string}) => win.kind === 'chart');
    state.setChartTimeframe(chart.id, '120m');
    if (!state.windows.some((win: {kind:string}) => win.kind === 'book')) state.addWindow('book');
    return chart.id as string;
  });
  await ws.waitForSubscribe(CODE);
  const push = (t: number, price: number) => {
    ws.pushLive(CODE,{kind:'ob',venue:'KRX',t_ms:t,total_ask_qty:1000,total_bid_qty:1000,
      asks:Array.from({length:10},(_,i)=>({price:price+i+1,qty:100})),
      bids:Array.from({length:10},(_,i)=>({price:price-i-1,qty:100}))});
    ws.pushLive(CODE,{kind:'trade',venue:'KRX',t_ms:t,prev_close:30000,
      trades:[{t_ms:t,price,qty:100,side:1}]});
  };
  push(at(15,29),31000);
  await expect.poll(() => chartCloses(page,chartId)).toContain(31000);
  await page.clock.fastForward(60_000);
  await expect(page.getByText('정규장 · 마지막',{exact:true})).toBeVisible();
  await page.clock.fastForward(30*60_000);
  await expect(page.getByText('애프터마켓 · 수신 대기',{exact:true})).toBeVisible();
  push(at(16),32000);
  await expect(page.getByText('애프터마켓',{exact:true})).toBeVisible();
  await expect.poll(() => chartCloses(page,chartId)).toContain(32000);
  const connections = ws.connectionCount();
  await page.clock.fastForward(239*60_000);
  // Hours without heartbeat correctly close the socket. Wait for the renewed
  // subscription before sending the next frame; never send into the old socket.
  await expect.poll(ws.connectionCount).toBeGreaterThan(connections);
  await ws.waitForSubscribe(CODE);
  push(at(19,59),33000);
  await expect.poll(() => chartCloses(page,chartId)).toContain(33000);
  await page.clock.fastForward(60_000);
  await expect(page.getByText('애프터마켓 · 마지막',{exact:true})).toBeVisible();
  expect(await chartCloses(page,chartId)).toContain(33000);
  expect(retiredRequests).toBe(0);
});
