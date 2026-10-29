import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { WhiteboardDocument } from '../../src/api/whiteboards';
import { emptyReview } from '../../src/whiteboard/review';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import { API_URL, BASE_URL } from './worktreeEnv';

test('당일 종목 분봉 한 장만 첨부하고 시장·순매수 자동 조회를 하지 않는다', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.clock.setFixedTime(new Date('2026-05-28T06:40:00Z'));
  await installLiveMocks(page);
  await page.route(apiExact('live/settings'), route => route.fulfill({ json: {
    schema_version: 1, rest_bypass_enabled: false, krx_prefer_hogaplay: false, screener_depth_autocollect: false,
  } }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', venue: 'KRX', from: '20260528', to: '20260528', cached_dates: [], fresh_dates: ['20260528'], data_warnings: [],
    candles: Array.from({ length: 79 }, (_, i) => ({ t_ms: Date.UTC(2026, 4, 28) + i * 300000,
      open: 35000 + i * 10, high: 35120 + i * 10, low: 34950 + i * 10, close: 35050 + i * 10, volume: 100 + i })),
  } }));
  const id = randomUUID().replaceAll('-', '');
  const created = await request.post(`${API_URL}/api/whiteboards`, { headers: { Origin: BASE_URL }, data: {
    id, mutation_id: id, name: '당일 분봉 복기', review: emptyReview('2026-05-28'),
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const read = async (): Promise<WhiteboardDocument> => (await request.get(`${API_URL}/api/whiteboards/${id}`)).json();
  try {
    await page.goto('/live?code=098460');
    await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      const chart = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
      store.setState({ windows: [{ ...chart, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '5m' } }],
        zOrder: [chart.id], maximizedId: null });
      store.getState().setWindowSymbol(chart.id, { code: '098460', name: '고영', kind: 'stock' });
    });
    await expect(page.getByTestId('live-chart-root').locator('.legend-ohlc-open')).toBeVisible();
    const extraRequests: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      // Existing minute indicators may read daily history independently of capture.
      if (['/api/live/index-candles', '/api/market/investor-flow'].includes(path)) extraRequests.push(path);
    });
    await page.getByTestId('chart-window-header').getByRole('button', { name: '복기 노트에 추가', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '복기 노트에 차트 추가' })).toBeVisible();
    await page.getByLabel('추가할 노트', { exact: true }).selectOption(id);
    await page.getByRole('button', { name: '차트 첨부하고 작성하기', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/whiteboard\\?board=${id}`));
    await expect(page.getByTestId('review-canvas')).toBeVisible();
    const images = (doc: WhiteboardDocument) => doc.scene.elements.filter(el => el.type === 'image' && !el.isDeleted);
    await expect.poll(async () => images(await read()).length).toBe(1);
    const doc = await read();
    expect(images(doc)[0].customData).toMatchObject({ chartSource: { code: '098460', timeframe: '5m' } });
    expect(Object.keys(doc.scene.files)).toHaveLength(1);
    expect(extraRequests).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('review-canvas')).toBeVisible();
    expect(images(await read()).map(el => el.id)).toEqual(images(doc).map(el => el.id));
  } finally {
    const doc = await read();
    await request.put(`${API_URL}/api/whiteboards/${id}`, { headers: { Origin: BASE_URL }, data: {
      mutation_id: randomUUID().replaceAll('-', ''), expected_revision: doc.revision, name: doc.name, scene: doc.scene, review: doc.review, deleted: true,
    } });
  }
});
