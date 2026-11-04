import { writeFileSync } from 'node:fs';
import { test as base, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import type { SavedScreener } from '../../src/api/savedScreeners';
import type { ScanRequest, ScreenerResponse } from '../../src/api/screener';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

const missing = '감시가 만료되었거나 종료되었습니다. 다시 시작해 주세요.';
const empty: ScreenerResponse = { status: 'ok', rows: [], warnings: [] };
const populated: ScreenerResponse = { status: 'ok', rows: [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, trade_value_won: 1e11, change_pct: 2 },
], warnings: [] };
function save(id: string, name: string, period = 10): SavedScreener {
  return { id, name, calculation_policy: 'legacy_v1', universe: { scopes: ['watchlist'] },
    conditions: [{ id: 'v', type: 'new_high_vol', params: { timeframe: '1m', period, lookback: 3, include_open_bar: true } }],
    created_at_ms: 1, updated_at_ms: 1 };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
type MonitorState = {
  saves: SavedScreener[]; savesReads: number;
  sessions: Map<string, { request: ScanRequest; deleted: boolean }>;
  reads: { id: string; route: Route }[]; deletes: string[]; heartbeats: string[];
  pendingPosts: { id: string; route: Route }[]; holdPost: boolean; deleteGate: Promise<void>;
  reply: { status: number; body: unknown } | null; events: { method: string; path: string }[];
};
async function setup(page: Page) {
  await page.clock.install({ time: new Date('2026-11-04T10:00:00+09:00') });
  await installLiveMocks(page);
  await page.route(apiPrefix('live/quotes'), route => route.fulfill({ json: { phase: 'open', quotes: [] } }));
  await page.route(apiExact('heatmap'), route => route.fulfill({ json: { folders: [], entries: [], capture_markers: {}, next_run_at_ms: 0 } }));
  await page.route(apiPrefix('screener/exclusions'), route => route.fulfill({ json: { schema_version: 1, exclusions: [] } }));
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/ws', ws => { socket = ws; });
  const state: MonitorState = {
    saves: [save('alpha', '첫 감시'), save('beta', '다음 감시', 20)],
    savesReads: 0,
    sessions: new Map<string, { request: ScanRequest; deleted: boolean }>(),
    reads: [],
    deletes: [],
    heartbeats: [],
    pendingPosts: [],
    holdPost: false,
    deleteGate: Promise.resolve(),
    reply: null,
    events: [],
  };
  await page.route(apiExact('screener/saves'), route => {
    state.savesReads += 1;
    return route.fulfill({ json: { schema_version: 1, saves: state.saves } });
  });
  await page.route(apiPrefix('screener/monitors'), async route => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    state.events.push({ method, path });
    if (path.endsWith('/monitors')) {
      expect(method).toBe('POST');
      const id = `owner-${state.sessions.size + 1}`;
      state.sessions.set(id, { request: route.request().postDataJSON().request, deleted: false });
      if (state.holdPost) state.pendingPosts.push({ id, route });
      else await route.fulfill({ json: { id } });
      return;
    }
    const parts = path.split('/');
    const id = parts[4];
    const session = state.sessions.get(id);
    if (method === 'DELETE') {
      expect(session).toBeDefined();
      session!.deleted = true;
      state.deletes.push(id);
      await state.deleteGate;
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/heartbeat')) {
      expect(session?.deleted).toBe(false);
      state.heartbeats.push(id);
      await route.fulfill({ json: { id } });
    } else {
      expect(session?.deleted).toBe(false);
      state.reads.push({ id, route });
      if (state.reply) await route.fulfill({ status: state.reply.status, json: state.reply.body });
    }
  });
  return {
    ...state,
    state,
    async refresh() {
      await expect.poll(() => !!socket).toBe(true);
      const before = state.savesReads;
      socket!.send(JSON.stringify({ ch: 'event', data: { type: 'screener_saves_changed' } }));
      await page.clock.runFor(300);
      await expect.poll(() => state.savesReads).toBeGreaterThan(before);
    },
    async event(type = 'screener_volume_changed') {
      await expect.poll(() => !!socket).toBe(true);
      socket!.send(JSON.stringify({ ch: 'event', data: type === 'connected' || type === 'disconnected' ? { type } : {
        type, monitor_id: state.reads.at(-1)?.id, condition_ids: ['v'],
      } }));
      await page.clock.runFor(500);
    },
    async finish(index: number, body: unknown = empty, status = 200) {
      const read = state.reads[index];
      expect(read).toBeDefined();
      await read.route.fulfill({ status, json: body });
    },
  };
}
const test = base.extend<{ server: Awaited<ReturnType<typeof setup>> }>({
  server: async ({ page }, use, info) => {
    const server = await setup(page);
    await use(server);
    const path = info.outputPath('ownership-events.json');
    writeFileSync(path, JSON.stringify({ events: server.state.events, sessions: [...server.state.sessions],
      deletes: server.state.deletes, heartbeats: server.state.heartbeats }, null, 2));
    await info.attach('ownership-events', { path, contentType: 'application/json' });
  },
});
async function start(page: Page) {
  await page.goto('/screener');
  await page.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
}
async function panelScan(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('screenerPanel.v1') ?? '{}').lastScan);
}

test('Page selection retires a pending read to idle and ignores its late domain404', async ({ page, server }, info) => {
  await start(page);
  await expect.poll(() => server.reads.length).toBe(1);
  await page.getByRole('button', { name: '저장한 조건검색 선택', exact: true }).click();
  await page.getByRole('option', { name: '다음 감시', exact: true }).click();
  await expect.poll(() => server.deletes).toEqual(['owner-1']);
  await server.finish(0, { detail: missing }, 404);
  await expect(page.getByText('아직 조회하지 않았습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('조회할 수 없습니다', { exact: true })).toHaveCount(0);
  await expect(page.getByText(missing, { exact: true })).toHaveCount(0);
  expect(server.sessions.size).toBe(1);
  await page.screenshot({ path: info.outputPath('selection-idle.png') });
});

test('Drawer metadata, equal saves and unrelated refresh preserve pending and settled ownership', async ({ page, server }, info) => {
  await page.goto('/screener');
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  const drawer = page.getByTestId('screener-panel');
  await drawer.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
  await expect.poll(() => server.reads.length).toBe(1);
  server.state.saves[0] = { ...server.state.saves[0], name: '이름 변경', updated_at_ms: 2 };
  await server.refresh();
  await expect(drawer.getByRole('button', { name: '저장한 조건검색 선택' })).toHaveText('이름 변경⌄');
  await server.refresh();
  server.state.saves[1] = { ...server.state.saves[1], name: '다른 저장본 이름', updated_at_ms: 3 };
  await server.refresh();
  expect(server.deletes).toEqual([]);
  expect(server.sessions.size).toBe(1);
  expect(server.reads).toHaveLength(1);
  await server.finish(0, populated);
  await expect.poll(() => panelScan(page)).toMatchObject({ savedName: '이름 변경', savedUpdatedAtMs: 2 });
  server.state.saves[0] = { ...server.state.saves[0], name: '결과 후 이름', updated_at_ms: 4 };
  await server.refresh();
  await expect(drawer.getByRole('button', { name: '저장한 조건검색 선택' })).toContainText('결과 후 이름');
  await server.event();
  await expect.poll(() => server.reads.length).toBe(2);
  await server.finish(1, populated);
  await expect.poll(() => panelScan(page)).toMatchObject({ savedName: '결과 후 이름', savedUpdatedAtMs: 4 });
  expect(server.sessions.size).toBe(1);
  expect(server.deletes).toEqual([]);
  await expect(drawer.getByText('조회 실패', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('metadata-preserved.png') });
});

for (const pending of ['result', 'post'] as const) {
  test(`initial Page ${pending} unmount releases exact ownership and stops heartbeat`, async ({ page, server }, info) => {
    server.state.holdPost = pending === 'post';
    await start(page);
    await expect.poll(() => pending === 'post' ? server.pendingPosts.length : server.reads.length).toBe(1);
    if (pending === 'result') {
      await page.clock.runFor(30_000);
      await expect.poll(() => server.heartbeats).toEqual(['owner-1']);
    }
    await page.getByRole('link', { name: '히트맵', exact: true }).click();
    await expect(page).toHaveURL(/\/heatmap$/);
    if (pending === 'post') await server.pendingPosts[0].route.fulfill({ json: { id: 'owner-1' } });
    await expect.poll(() => server.deletes).toEqual(['owner-1']);
    const count = server.heartbeats.length;
    await page.clock.runFor(31_000);
    expect(server.heartbeats).toHaveLength(count);
    if (pending === 'result') await server.finish(0, { detail: missing }, 404);
    await expect(page.getByText(missing, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`unmount-${pending}.png`) });
  });
}

test('Page keeps request identity across identical-request saves and publishes current metadata', async ({ page, server }) => {
  server.state.saves[1] = save('beta', '동일 요청');
  await start(page);
  await expect.poll(() => server.reads.length).toBe(1);
  await page.getByRole('button', { name: '저장한 조건검색 선택', exact: true }).click();
  await page.getByRole('option', { name: '동일 요청', exact: true }).click();
  server.state.saves[1] = { ...server.state.saves[1], name: '최신 Page 이름', updated_at_ms: 9 };
  await server.refresh();
  await server.finish(0, populated);
  await expect.poll(() => panelScan(page)).toMatchObject({ savedId: 'beta', savedName: '최신 Page 이름', savedUpdatedAtMs: 9 });
  await expect(page.getByRole('button', { name: '실시간 감시 종료', exact: true })).toBeEnabled();
  expect(server.deletes).toEqual([]);
  expect(server.sessions.size).toBe(1);
});

for (const detail of [missing, 'Not Found']) {
  test(`current404 remains visible after automatic stop: ${detail}`, async ({ page, server }, info) => {
    server.state.reply = { status: 404, body: { detail } };
    await page.goto('/screener');
    await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
    const drawer = page.getByTestId('screener-panel');
    await drawer.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
    await expect(drawer.getByText(detail, { exact: true })).toBeVisible();
    for (const delay of [30_000, 60_000, 120_000, 240_000]) {
      const before = server.reads.length;
      await page.clock.runFor(delay);
      await expect.poll(() => server.reads.length).toBe(before + 1);
    }
    await expect(drawer.getByRole('button', { name: '실시간 감시 시작', exact: true })).toBeEnabled();
    await expect(drawer.getByText(detail, { exact: true })).toBeVisible();
    await expect(drawer.getByText('조회 실패', { exact: true })).toBeVisible();
    expect(server.reads).toHaveLength(5);
    await page.screenshot({ path: info.outputPath(detail === missing ? 'current-domain404.png' : 'current-route404.png') });
  });
}

test('Stop during pending Drawer read ignores late failure; Stop after current failure retains it', async ({ page, server }) => {
  await page.goto('/screener');
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  const drawer = page.getByTestId('screener-panel');
  await drawer.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
  await expect.poll(() => server.reads.length).toBe(1);
  await drawer.getByTestId('screener-monitor-toggle').click();
  await expect.poll(() => server.deletes).toEqual(['owner-1']);
  await server.finish(0, { detail: missing }, 404);
  await expect(drawer.getByText('조회 실패', { exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
  await expect.poll(() => server.reads.length).toBe(2);
  await server.finish(1, { detail: '현재 서버 실패' }, 500);
  await expect(drawer.getByText('현재 서버 실패', { exact: true })).toBeVisible();
  await drawer.getByTestId('screener-monitor-toggle').click();
  await expect(drawer.getByText('현재 서버 실패', { exact: true })).toBeVisible();
});

test('same-ID Drawer definition edits reanchor immediately and selected removal stops ownership', async ({ page, server }) => {
  await page.goto('/screener');
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  const drawer = page.getByTestId('screener-panel');
  await drawer.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
  await expect.poll(() => server.reads.length).toBe(1);
  server.state.saves[0] = { ...save('alpha', '첫 감시', 30), updated_at_ms: 2 };
  await server.refresh();
  await expect.poll(() => server.deletes).toEqual(['owner-1']);
  await expect.poll(() => server.reads.length).toBe(2);
  expect(server.sessions.get('owner-2')?.request.conditions[0].params).toMatchObject({ period: 30 });
  await server.finish(0, { detail: missing }, 404);
  await server.finish(1, populated);
  await expect(drawer.getByText('삼성전자', { exact: true })).toBeVisible();
  server.state.saves = [];
  await server.refresh();
  await expect.poll(() => server.deletes).toEqual(['owner-1', 'owner-2']);
  await expect(drawer.getByRole('button', { name: '실시간 감시 시작', exact: true })).toBeDisabled();
  await expect(drawer.getByText('조회 실패', { exact: true })).toHaveCount(0);
});

for (const outcome of ['success', 'error'] as const) {
  test(`manual ${outcome} survives delayed DELETE, intent falling edge and retired monitor404`, async ({ page, server }) => {
    server.state.reply = { status: 200, body: populated };
    await start(page);
    await expect(page.getByRole('button', { name: '실시간 감시 종료', exact: true })).toBeEnabled();
    server.state.reply = null;
    await server.event();
    await expect.poll(() => server.reads.length).toBe(2);
    await page.getByRole('button', { name: '실시간 감시 종료', exact: true }).click();
    await expect(page.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
    server.state.reply = { status: 200, body: populated };
    await page.getByRole('button', { name: '실시간 감시 시작', exact: true }).click();
    await expect(page.getByRole('button', { name: '실시간 감시 종료', exact: true })).toBeEnabled();
    const deletion = deferred();
    server.state.deleteGate = deletion.promise;
    let manual: Route | undefined;
    await page.route(apiPrefix('screener/runs'), route => { manual = route; });
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await expect.poll(() => server.deletes).toContain('owner-2');
    expect(manual).toBeUndefined();
    await expect(page.getByRole('button', { name: '조회 중…', exact: true })).toBeDisabled();
    deletion.resolve();
    await expect.poll(() => !!manual).toBe(true);
    if (outcome === 'error') await manual!.fulfill({ status: 500, json: { detail: '현재 수동 실패' } });
    else await manual!.fulfill({ json: { id: 'manual', request: manual!.request().postDataJSON(), status: 'partial',
      total: 1, evaluated: 1, preparing: 0, waiting: 0, failed: 0, next_retry_at_ms: null,
      errors: {}, revision: 1, result_revision: 1, result: populated, started_at_ms: 1, updated_at_ms: 1 } });
    await expect(page.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
    await server.finish(1, { detail: missing }, 404);
    if (outcome === 'error') await expect(page.getByText('현재 수동 실패', { exact: true })).toBeVisible();
    else await expect.poll(() => panelScan(page)).toMatchObject({ scanStatus: 'ok', rows: populated.rows });
    await expect(page.getByText(missing, { exact: true })).toHaveCount(0);
  });
}

test('current empty and preparing200 stay distinct and retain their monitor on reconnect', async ({ page, server }) => {
  await start(page);
  await expect.poll(() => server.reads.length).toBe(1);
  await server.finish(0, empty);
  await expect(page.getByText('조건에 맞는 종목이 없습니다', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '실시간 감시 종료', exact: true })).toBeEnabled();
  await server.event('disconnected');
  await server.event('connected');
  await expect.poll(() => server.reads.length).toBe(2);
  await server.finish(1, { ...empty, bar_coverage: { total: 1, complete: 0, incomplete: [],
    realtime: { prepared: 0, receiving: 0, preparing: 1, insufficient: 0, continuous: true } } });
  await expect(page.getByText('분봉 자료를 준비하고 있습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('조회할 수 없습니다', { exact: true })).toHaveCount(0);
  expect(server.sessions.size).toBe(1);
  expect(server.deletes).toEqual([]);
});

for (const detail of [missing, 'Not Found']) {
  test(`Page current404 keeps the original visible failure: ${detail}`, async ({ page, server }, info) => {
    server.state.reply = { status: 404, body: { detail } };
    await start(page);
    await expect(page.getByText('조회할 수 없습니다', { exact: true })).toBeVisible();
    await expect(page.getByText(detail, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '실시간 감시 시작', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(detail === missing ? 'page-domain404.png' : 'page-route404.png') });
  });
}
