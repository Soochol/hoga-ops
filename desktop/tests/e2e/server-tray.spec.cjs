const { test, expect, _electron: electron } = require('@playwright/test');
const { cp, mkdir, readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { fixture, alive } = require('../helpers/server-fixture.cjs');
const root = resolve(__dirname, '../..');

async function launch(f, extra = {}) {
  const source = join(f.project, 'desktop');
  await mkdir(join(source, 'src'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(source, 'package.json'), JSON.stringify({ ...manifest, main: 'bootstrap.cjs' }));
  await cp(join(root, 'src/server-ui'), join(source, 'src/server-ui'), { recursive: true });
  await cp(join(root, 'assets'), join(source, 'assets'), { recursive: true });
  // Capture real native Tray/Menu objects before the app starts. No production test API.
  await writeFile(join(source, 'bootstrap.cjs'), `
    const {Tray}=require('electron');
    const setMenu=Tray.prototype.setContextMenu, setImage=Tray.prototype.setImage, destroy=Tray.prototype.destroy;
    globalThis.trayInstances=new Set();
    Tray.prototype.setContextMenu=function(menu){globalThis.trayInstances.add(this);globalThis.trayCapture={tray:this,menu};return setMenu.call(this,menu);};
    Tray.prototype.setImage=function(image){globalThis.trayImage=image.toPNG().toString('base64');return setImage.call(this,image);};
    Tray.prototype.destroy=function(){require('node:fs').writeFileSync(${JSON.stringify(join(f.project, 'tray-destroyed'))},'destroyed');return destroy.call(this);};
    require(${JSON.stringify(join(root, 'dist/bootstrap.cjs'))});
  `);
  const env = { ...process.env, ...f.env, HOGA_SERVER_MANAGER_USER_DATA: join(f.project, 'manager-data'),
    HOGA_DESKTOP_USER_DATA: join(f.project, 'client-data'), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [source, '--server-manager', `--server-config=${f.config}`];
  if (process.env.HOGA_DESKTOP_TEST_PLATFORM) args.push(`--ozone-platform=${process.env.HOGA_DESKTOP_TEST_PLATFORM}`);
  const app = await electron.launch({ args, env, cwd: root, chromiumSandbox: true });
  const page = await app.firstWindow();
  await expect(page.locator('body')).toHaveAttribute('data-phase', /starting|running|error|stopped/);
  return { app, page };
}
const item = (app, id) => app.evaluate((_, id) => {
  const item = globalThis.trayCapture.menu.getMenuItemById(id);
  return { label: item.label, enabled: item.enabled };
}, id);
const click = (app, id) => app.evaluate((_, id) => {
  const item = globalThis.trayCapture.menu.getMenuItemById(id);
  if (!item.enabled) throw new Error('Disabled tray action: ' + id);
  item.click();
}, id);
const phase = (page, value) => expect(page.locator('body')).toHaveAttribute('data-phase', value);
async function serversAlive(markers) {
  expect(await Promise.all(markers.flatMap(m => [alive(m.pid), alive(m.worker)]))).toEqual([true, true, true, true]);
}

test.beforeEach(() => {
  test.skip(Boolean(process.env.HOGA_DESKTOP_EXECUTABLE), 'Native menu capture uses an isolated source bootstrap; packaged startup is covered by the normal manager suite.');
});

test('native tray controls services, restores hidden windows and confirms stop/quit', async () => {
  const f = await fixture(); let app; let client;
  try {
    const result = await launch(f); app = result.app; const page = result.page;
    const mainPid = app.process().pid;
    await phase(page, 'running');
    await page.evaluate(() => window.serverManager.stop());
    await phase(page, 'stopped');
    await expect.poll(() => item(app, 'start')).toEqual({ label: '서버 시작', enabled: true });
    expect((await item(app, 'stop')).enabled).toBe(false);
    expect((await item(app, 'client')).enabled).toBe(false);
    const stoppedIcon = await app.evaluate(() => globalThis.trayImage);
    await click(app, 'start'); await phase(page, 'running');
    const markers = [await f.marker('backend'), await f.marker('frontend')];
    expect((await item(app, 'start')).enabled).toBe(false);
    expect((await item(app, 'client')).enabled).toBe(true);
    expect(await app.evaluate(() => globalThis.trayImage)).not.toBe(stoppedIcon);
    const env = { ...process.env, HOGA_DESKTOP_USER_DATA: join(f.project, 'client-data') };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [join(f.project, 'desktop')];
    if (process.env.HOGA_DESKTOP_TEST_PLATFORM) args.push(`--ozone-platform=${process.env.HOGA_DESKTOP_TEST_PLATFORM}`);
    client = await electron.launch({ args, env, cwd: root, chromiumSandbox: true });
    await client.firstWindow();
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await click(app, 'client');
    await expect.poll(() => client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await client.close(); client = undefined;
    for (const event of ['click', 'double-click']) {
      await page.locator('#close').click();
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
      await app.evaluate((_, event) => globalThis.trayCapture.tray.emit(event), event);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
      await serversAlive(markers);
    }
    await page.locator('#close').click(); await click(app, 'show');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await page.reload(); await phase(page, 'running');
    expect(await app.evaluate(() => globalThis.trayInstances.size)).toBe(1);
    await app.evaluate(({ dialog }) => {
      globalThis.stopDialogs = 0;
      dialog.showMessageBox = async (_window, options) => {
        globalThis.lastDialog = options; globalThis.stopDialogs++;
        return new Promise(resolve => { globalThis.resolveStop = resolve; });
      };
    });
    await page.locator('#close').click(); await click(app, 'stop');
    await expect.poll(() => app.evaluate(() => globalThis.stopDialogs)).toBe(1);
    expect((await item(app, 'stop')).enabled).toBe(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    expect(await app.evaluate(() => ({ defaultId: globalThis.lastDialog.defaultId, cancelId: globalThis.lastDialog.cancelId }))).toEqual({ defaultId: 1, cancelId: 1 });
    await app.evaluate(() => globalThis.resolveStop({ response: 1 }));
    await expect.poll(async () => (await item(app, 'stop')).enabled).toBe(true);
    await serversAlive(markers);
    await app.evaluate(({ shell }) => { shell.openPath = async path => { globalThis.openedLogPath = path; return ''; }; });
    await click(app, 'logs');
    await expect.poll(() => app.evaluate(() => globalThis.openedLogPath)).toBe(join(f.project, 'manager-data/logs'));
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await click(app, 'stop'); await phase(page, 'stopped');
    await expect.poll(() => alive(markers[0].pid)).toBe(false);
    await expect.poll(() => alive(markers[1].pid)).toBe(false);
    expect(await app.evaluate(() => globalThis.trayImage)).toBe(stoppedIcon);
    await click(app, 'start'); await phase(page, 'running');
    const restarted = [await f.marker('backend'), await f.marker('frontend')];
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator('#close').click(); await click(app, 'quit');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await phase(page, 'running'); await serversAlive(restarted);
    expect(app.process().pid).toBe(mainPid);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    const closed = app.waitForEvent('close'); await click(app, 'quit'); await closed; app = undefined;
    await expect.poll(() => alive(restarted[0].pid)).toBe(false);
    await expect.poll(() => alive(restarted[1].pid)).toBe(false);
    expect(await readFile(join(f.project, 'tray-destroyed'), 'utf8')).toBe('destroyed');
  } finally { if (client) await client.close(); if (app) await app.close(); await f.dispose(); }
});

test('tray preserves external servers and reports action errors without quitting', async () => {
  const f = await fixture(); let app;
  try {
    f.external('backend'); f.external('frontend');
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${f.ports.backend}/health`)).ok && (await fetch(`http://127.0.0.1:${f.ports.frontend}/health`)).ok; } catch { return false; } }).toBe(true);
    const markers = [await f.marker('backend'), await f.marker('frontend')];
    const result = await launch(f); app = result.app; const page = result.page;
    await phase(page, 'running');
    expect((await item(app, 'stop')).enabled).toBe(true);
    expect((await item(app, 'start')).enabled).toBe(false);
    expect(await app.evaluate(() => globalThis.trayCapture.menu.items[0].label)).toContain('외부 실행');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => { globalThis.externalStopDialog = options; return { response: 1 }; };
    });
    await click(app, 'stop');
    await expect.poll(() => app.evaluate(() => globalThis.externalStopDialog?.detail)).toContain(`PID ${markers[0].pid}`);
    expect(await app.evaluate(() => globalThis.externalStopDialog.detail)).toContain(f.project);
    await serversAlive(markers);
    await app.evaluate(({ shell, dialog }) => {
      shell.openPath = async () => 'fixture open failure';
      dialog.showMessageBox = async (_window, options) => { globalThis.errorDialog = options; return { response: 0 }; };
    });
    await page.locator('#close').click(); await click(app, 'logs');
    await expect.poll(() => app.evaluate(() => globalThis.errorDialog?.detail)).toBe('fixture open failure');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await serversAlive(markers);
    const closed = app.waitForEvent('close'); await click(app, 'quit'); await closed; app = undefined;
    await serversAlive(markers);
  } finally { if (app) await app.close(); await f.dispose(); }
});

test('tray allows startup cancellation and distinguishes busy and failure states', async () => {
  const f = await fixture(); let app;
  try {
    const result = await launch(f, { TICKLANE_FIXTURE_DELAY_MS: '5000' }); app = result.app; const page = result.page;
    await phase(page, 'starting');
    await expect.poll(async () => { try { await f.marker('backend'); await f.marker('frontend'); return true; } catch { return false; } }).toBe(true);
    const markers = [await f.marker('backend'), await f.marker('frontend')];
    expect(await item(app, 'stop')).toEqual({ label: '시작 취소', enabled: true });
    const busyIcon = await app.evaluate(() => globalThis.trayImage);
    await click(app, 'stop'); await phase(page, 'stopped');
    await expect.poll(async () => (await item(app, 'start')).enabled).toBe(true);
    const stoppedIcon = await app.evaluate(() => globalThis.trayImage);
    expect(busyIcon).not.toBe(stoppedIcon);
    await expect.poll(() => alive(markers[0].pid)).toBe(false);
    await expect.poll(() => alive(markers[1].pid)).toBe(false);
    await app.evaluate(() => { process.env.TICKLANE_FIXTURE_FAIL = 'frontend'; });
    await click(app, 'start'); await phase(page, 'error');
    const errorIcon = await app.evaluate(() => globalThis.trayImage);
    expect(errorIcon).not.toBe(stoppedIcon); expect(errorIcon).not.toBe(busyIcon);
    expect(await app.evaluate(() => globalThis.trayCapture.menu.items[0].label)).toContain('확인 필요');
    expect((await item(app, 'start')).enabled).toBe(true);
  } finally { if (app) await app.close(); await f.dispose(); }
});
