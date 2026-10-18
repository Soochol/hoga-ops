const { test, expect, _electron: electron } = require('@playwright/test');
const { createServer } = require('node:http');
const { access, readFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const { fixture, alive } = require('../helpers/server-fixture.cjs');
const root = resolve(__dirname, '../..');

function options(f, manager = true, extra = {}) {
  const env = { ...process.env, ...f.env, HOGA_SERVER_MANAGER_USER_DATA: join(f.project, 'manager-data'),
    HOGA_DESKTOP_USER_DATA: join(f.project, 'client-data'), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = process.env.HOGA_DESKTOP_EXECUTABLE ? [] : [root];
  if (manager) args.push('--server-manager', `--server-config=${f.config}`);
  if (process.env.HOGA_DESKTOP_TEST_PLATFORM) args.push(`--ozone-platform=${process.env.HOGA_DESKTOP_TEST_PLATFORM}`);
  return { executablePath: process.env.HOGA_DESKTOP_EXECUTABLE, args, cwd: root, env, chromiumSandbox: true };
}
async function manager(f, extra) {
  const app = await electron.launch(options(f, true, extra));
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: '로컬 서버', exact: true })).toBeVisible();
  return { app, page };
}
async function running(page) {
  await expect(page.locator('#service-backend')).toHaveAttribute('data-phase', 'running');
  await expect(page.locator('#service-frontend')).toHaveAttribute('data-phase', 'running');
}
async function stopped(page) {
  await expect(page.locator('#service-backend')).toHaveAttribute('data-phase', 'stopped');
  await expect(page.locator('#service-frontend')).toHaveAttribute('data-phase', 'stopped');
}
async function stop(page) {
  await page.locator('#stop').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '서버 중지', exact: true }).click();
  await stopped(page);
}
async function dead(markers) {
  await expect.poll(async () => (await Promise.all(markers.flatMap(m => [alive(m.pid), alive(m.worker)]))).some(Boolean)).toBe(false);
}
async function healthy(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
}

test('manager starts/stops services, escapes logs, and coexists with the Ticklane app', async () => {
  const f = await fixture(); let app; let client;
  try {
    const result = await manager(f); app = result.app; const page = result.page;
    await stopped(page);
    await expect(page.locator('#log-details')).toHaveJSProperty('open', false);
    await expect(page.evaluate(() => window.serverManager.openClient())).rejects.toThrow('두 서버가 준비된 뒤');
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await app.evaluate(({ BrowserWindow, app }) => ({ sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox, unsafe: app.commandLine.hasSwitch('no-sandbox') }))).toEqual({ sandbox: true, unsafe: false });
    await page.getByRole('button', { name: '서버 시작', exact: true }).click();
    await running(page);
    const first = [await f.marker('backend'), await f.marker('frontend')];
    expect(first[1].api).toBe(`http://localhost:${f.ports.backend}`);
    expect(first[1].args).toContain('--strictPort');
    await expect(page.getByRole('button', { name: 'Ticklane 열기', exact: true })).toBeEnabled();
    await page.locator('summary').click();
    await expect(page.getByLabel('실행 로그 내용')).toContainText('<img src=x onerror=alert(1)>');
    expect(await page.locator('#logs img').count()).toBe(0);
    await expect(page.locator('#logs time').first()).toHaveText(/^\d\d:\d\d:\d\d$/);
    await page.locator('summary').click();
    client = await electron.launch(options(f, false));
    await expect((await client.firstWindow()).getByRole('heading', { name: 'Ticklane', exact: true })).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Ticklane 서버');
    expect(await client.evaluate(({ app }) => app.getName())).toBe('Ticklane');
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await page.getByRole('button', { name: 'Ticklane 열기', exact: true }).click();
    await expect.poll(() => client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await client.close(); client = undefined;
    expect(await healthy(f.ports.backend)).toBe(true);
    await page.screenshot({ path: join(root, 'test-results/server-manager.png') });
    await page.locator('#stop').click();
    await page.getByRole('button', { name: '계속 실행', exact: true }).click();
    await running(page);
    await stop(page);
    await stopped(page); await dead(first);
    await page.getByRole('button', { name: '서버 시작', exact: true }).click();
    await running(page);
    const second = [await f.marker('backend'), await f.marker('frontend')];
    expect(second[0].pid).not.toBe(first[0].pid);
    // Quitting the management app must await graceful cleanup of both groups.
    await app.close(); app = undefined; await dead(second);
    expect(await readFile(join(f.project, 'manager-data/logs/server.log'), 'utf8')).toContain('서버를 중지했습니다');
  } finally { if (client) await client.close(); if (app) await app.close(); await f.dispose(); }
});

test('external services are read-only and survive management app shutdown', async () => {
  const f = await fixture(); let app;
  try {
    f.external('backend'); f.external('frontend');
    await expect.poll(() => healthy(f.ports.backend)).toBe(true);
    await expect.poll(() => healthy(f.ports.frontend)).toBe(true);
    const result = await manager(f); app = result.app; const page = result.page;
    await running(page);
    await expect(page.locator('#service-backend')).toHaveAttribute('data-owner', 'external');
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ticklane 열기', exact: true })).toBeEnabled();
    await expect(page.locator('#external-note')).toBeVisible();
    await expect(page.getByRole('button', { name: '관리 앱 종료', exact: true })).toBeInViewport();
    await page.evaluate(() => window.serverManager.stop());
    await app.close(); app = undefined;
    expect(await healthy(f.ports.backend)).toBe(true);
    expect(await healthy(f.ports.frontend)).toBe(true);
  } finally { if (app) await app.close(); await f.dispose(); }
});

test('stop cancels startup and leaves no child processes', async () => {
  const f = await fixture(); let app;
  try {
    const result = await manager(f, { TICKLANE_FIXTURE_DELAY_MS: '5000' }); app = result.app; const page = result.page;
    await expect(page.getByRole('button', { name: '서버 시작', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '서버 시작', exact: true }).click();
    await expect.poll(async () => { try { await f.marker('backend'); await f.marker('frontend'); return true; } catch { return false; } }).toBe(true);
    const markers = [await f.marker('backend'), await f.marker('frontend')];
    await page.getByRole('button', { name: '시작 취소', exact: true }).click();
    await stopped(page); await dead(markers);
    await expect(page.getByRole('button', { name: '서버 시작', exact: true })).toBeEnabled();
  } finally { if (app) await app.close(); await f.dispose(); }
});

test('port conflicts do not start the other service and can be retried', async () => {
  const f = await fixture(); let app;
  const foreign = createServer((_req, res) => res.end('unrelated application'));
  await new Promise(done => foreign.listen(f.ports.backend, '127.0.0.1', done));
  try {
    const result = await manager(f); app = result.app; const page = result.page;
    await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('포트가 사용 중');
    await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeEnabled();
    await expect(page.locator('#log-details')).toHaveJSProperty('open', true);
    await page.locator('summary').click();
    await page.getByRole('button', { name: '상태 새로고침' }).click();
    await expect(page.locator('#log-details')).toHaveJSProperty('open', false);
    await expect(access(join(f.project, 'frontend.json'))).rejects.toThrow();
    expect(foreign.listening).toBe(true);
    await new Promise(done => foreign.close(done));
    await page.getByRole('button', { name: '상태 새로고침' }).click();
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await running(page);
  } finally { if (app) await app.close(); if (foreign.listening) await new Promise(done => foreign.close(done)); await f.dispose(); }
});

test('failed startup cleans owned processes and supports retry', async () => {
  const f = await fixture(); let app;
  try {
    const result = await manager(f, { TICKLANE_FIXTURE_FAIL: 'frontend' }); app = result.app; const page = result.page;
    await expect(page.getByRole('button', { name: '서버 시작', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '서버 시작', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('시작하지 못했습니다');
    await expect(page.locator('#log-details')).toHaveJSProperty('open', true);
    await dead([await f.marker('backend')]);
    await app.evaluate(() => { delete process.env.TICKLANE_FIXTURE_FAIL; });
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await running(page);
    await expect(page.locator('#log-details')).toHaveJSProperty('open', false);
  } finally { if (app) await app.close(); await f.dispose(); }
});

test('close always hides the manager and relaunch focuses the same app without stopping servers', async () => {
  const f = await fixture(); let app;
  try {
    const result = await manager(f); app = result.app; const page = result.page;
    await expect(page.getByRole('button', { name: '서버 시작', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '서버 시작', exact: true }).click(); await running(page);
    const markers = [await f.marker('backend'), await f.marker('frontend')];
    for (const native of [false, true]) {
      if (native) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      else await page.getByRole('button', { name: '관리 창 숨기기' }).click();
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
      const opts = options(f);
      const duplicate = spawn(opts.executablePath || require('electron'), opts.args, { cwd: opts.cwd, env: opts.env, stdio: 'ignore' });
      expect(await new Promise(done => duplicate.once('exit', done))).toBe(0);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
      await running(page);
      expect(await alive(markers[0].pid)).toBe(true);
    }
  } finally { if (app) await app.close(); await f.dispose(); }
});

test('explicit manager quit can be cancelled and confirmed quit gracefully stops owned services', async () => {
  const f = await fixture(); let app;
  try {
    const result = await manager(f); app = result.app; const page = result.page;
    await page.getByRole('button', { name: '서버 시작', exact: true }).click(); await running(page);
    const markers = [await f.marker('backend'), await f.marker('frontend')];
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.getByRole('button', { name: '관리 앱 종료', exact: true }).click();
    await running(page); expect(await alive(markers[0].pid)).toBe(true);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    const closed = app.waitForEvent('close');
    await page.getByRole('button', { name: '관리 앱 종료', exact: true }).click();
    await closed; app = undefined; await dead(markers);
  } finally { if (app) await app.close(); await f.dispose(); }
});

test('status view fits the compact window and live service failure reveals logs', async () => {
  const f = await fixture(); let app;
  try {
    const result = await manager(f); app = result.app; const page = result.page;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '서버 시작', exact: true }).click(); await running(page);
    for (const width of [420, 680]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('button', { name: '관리 앱 종료', exact: true })).toBeInViewport();
      await page.locator('summary').click();
      await expect(page.getByRole('button', { name: '관리 창 숨기기' })).toBeInViewport();
      await expect(page.getByRole('button', { name: '관리 앱 종료', exact: true })).toBeInViewport();
      await page.locator('summary').click();
    }
    const frontend = await f.marker('frontend'); process.kill(-frontend.pid, 'SIGTERM');
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'error');
    await expect(page.locator('#log-details')).toHaveJSProperty('open', true);
    await expect(page.getByRole('status')).toContainText('서버가 종료됐습니다');
    await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '다시 시도', exact: true }).click(); await running(page);
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await f.dispose(); }
});
