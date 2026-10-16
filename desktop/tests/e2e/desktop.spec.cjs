const { test, expect, _electron: electron } = require('@playwright/test');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '../..');

async function fixture() {
  let config = { api_url: '' }; let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url.startsWith('/health')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', version: 'fixture', commit: 'test' })); }
    else if (req.url === '/config.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(config)); }
    else { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"><h1>Fixture workspace</h1><button id="child">종목 새 창</button></div><script>
      sessionStorage.setItem('own', location.search || 'primary');
      document.getElementById('child').onclick = () => { localStorage.setItem('transfer', 'saved-layout'); window.open('/live?code=005930&workspaceTransfer=fixture', '_blank', 'noopener'); };
      </script></body></html>`); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)),
    config: value => { config = value; }, requests: () => requests };
}
async function launch(userData, executablePath, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (userData) env.HOGA_DESKTOP_USER_DATA = userData; else delete env.HOGA_DESKTOP_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  const platform = process.env.HOGA_DESKTOP_TEST_PLATFORM;
  const args = executablePath ? [] : [root];
  if (platform) args.push(`--ozone-platform=${platform}`);
  return electron.launch({ executablePath, args, cwd: root, env, chromiumSandbox: true });
}
async function connect(launcher, origin) {
  await launcher.locator('#origin').fill(origin);
  await launcher.locator('#name').fill('검증 서버');
  await launcher.getByRole('button', { name: '연결', exact: true }).click();
}
test('isolated server, sandbox, child state, request guard, recovery and restart', async () => {
  const server = await fixture(); const canary = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'hoga-electron-e2e-'));
  let app;
  try {
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    const launcher = await app.firstWindow();
    await expect(launcher.getByRole('heading', { name: 'Ticklane', exact: true })).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Ticklane');
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(dir);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isMenuBarVisible()))).toBe(true);
    const contentPromise = app.waitForEvent('window');
    await connect(launcher, server.origin);
    const content = await contentPromise;
    await expect(content.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.webContents.getURL().startsWith('app:')).map(w => w.getTitle()))).toEqual(['Ticklane · 검증 서버']);
    expect(await content.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(false);
    expect(await content.evaluate(() => window.hogaDesktop)).toEqual({ strictConfig: true, apiOrigin: server.origin });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.webContents.getURL().startsWith('app:')).every(w => w.webContents.getLastWebPreferences().sandbox))).toBe(true);
    const childPromise = app.waitForEvent('window');
    await content.getByRole('button', { name: '종목 새 창' }).click();
    const child = await childPromise;
    await expect(child.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isMenuBarVisible()))).toBe(true);
    expect(child.url()).toContain('workspaceTransfer=fixture');
    expect(await child.evaluate(() => localStorage.getItem('transfer'))).toBe('saved-layout');
    expect(await content.evaluate(() => sessionStorage.getItem('own'))).toBe('primary');
    expect(await child.evaluate(() => sessionStorage.getItem('own'))).toContain('code=005930');
    const before = canary.requests();
    expect(await content.evaluate(async origin => { try { await fetch(origin + '/api/order', { method: 'POST' }); return false; } catch { return true; } }, canary.origin)).toBe(true);
    expect(canary.requests()).toBe(before);
    await app.close(); app = undefined;
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    await expect.poll(() => app.windows().some(page => page.url().startsWith(server.origin))).toBe(true);
    const restored = app.windows().find(page => page.url().startsWith(server.origin));
    await expect(restored.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    expect(await restored.evaluate(() => localStorage.getItem('transfer'))).toBe('saved-layout');
    await app.close(); app = undefined;
    // Server lifetime is independent of both app processes.
    expect((await fetch(server.origin + '/health')).ok).toBe(true);
  } finally { if (app) await app.close(); await server.close(); await canary.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Ticklane reuses the pre-rename default profile directory', async () => {
  const server = await fixture();
  const configHome = await mkdtemp(join(tmpdir(), 'ticklane-legacy-profile-'));
  const legacyData = join(configHome, 'Hoga Ops');
  let app;
  try {
    await mkdir(legacyData);
    await writeFile(join(legacyData, 'connections.json'), JSON.stringify({ version: 1,
      profiles: [{ id: 'legacy', name: '이전 연결', mode: 'server', origin: server.origin }],
      activeId: 'legacy', bounds: {} }));
    app = await launch(undefined, process.env.HOGA_DESKTOP_EXECUTABLE, { XDG_CONFIG_HOME: configHome });
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Ticklane');
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(legacyData);
    await expect.poll(() => app.windows().some(page => page.url().startsWith(server.origin))).toBe(true);
    const content = app.windows().find(page => page.url().startsWith(server.origin));
    await expect(content.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
  } finally { if (app) await app.close(); await server.close(); await rm(configHome, { recursive: true, force: true }); }
});
test('invalid remote config stays on recovery screen', async () => {
  const server = await fixture(); server.config({ api_url: 'http://localhost:8000' });
  const dir = await mkdtemp(join(tmpdir(), 'hoga-electron-failure-')); let app;
  try {
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    const launcher = await app.firstWindow(); await connect(launcher, server.origin);
    await expect(launcher.getByRole('status')).toContainText('API 주소');
    expect(app.windows()).toHaveLength(1);
    server.config({ api_url: '' });
    const next = app.waitForEvent('window'); await launcher.getByRole('button', { name: '연결', exact: true }).click();
    await expect((await next).getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
  } finally { if (app) await app.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
