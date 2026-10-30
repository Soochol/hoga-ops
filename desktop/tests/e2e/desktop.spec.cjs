const { test, expect, _electron: electron } = require('@playwright/test');
const { createServer } = require('node:http');
const { execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, rm, writeFile, readFile } = require('node:fs/promises');
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
  return electron.launch({ executablePath: executablePath ?? process.env.HOGA_DESKTOP_ELECTRON_BINARY, args, cwd: root, env, chromiumSandbox: true });
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
    expect(await content.evaluate(() => ({ strictConfig: window.hogaDesktop.strictConfig, apiOrigin: window.hogaDesktop.apiOrigin }))).toEqual({ strictConfig: true, apiOrigin: server.origin });
    expect(await content.evaluate(() => window.hogaDesktop.controls.getState())).toEqual({ serverName: '검증 서버', origin: server.origin, apiOrigin: server.origin, zoomFactor: 1 });
    expect(await content.evaluate(async () => { try { await window.hogaDesktop.controls.zoom('invalid'); return false; } catch { return true; } })).toBe(true);
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

test('page zoom keys, menus, same-server children and restart share the saved factor', async () => {
  const server = await fixture(); const otherServer = await fixture();
  const dir = await mkdtemp(join(tmpdir(), 'ticklane-zoom-'));
  let app;
  try {
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    const next = app.waitForEvent('window');
    await connect(await app.firstWindow(), server.origin);
    const content = await next;
    await expect(content.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    const overlay = content.locator('#ticklane-desktop-zoom');
    const status = overlay.getByRole('status');
    await expect(overlay).toHaveCount(0);
    await content.addStyleTag({ content: ':root { --bg-card: #121811; --fg: #e7eddf; --fg-dim: #a7b39b; }' });
    const zoom = async page => (await app.browserWindow(page)).evaluate(win => win.webContents.getZoomFactor());
    // CDP page.keyboard bypasses Electron's before-input-event. Send native
    // WebContents input so the real app shortcut handler is exercised.
    const pressZoomKey = async (page, key, modifiers = ['control']) => (await app.browserWindow(page)).evaluate((win, input) => {
      win.focus(); win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers: input.modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: input.key, modifiers: input.modifiers });
    }, { key, modifiers });
    await content.bringToFront();
    await content.locator('#child').focus();
    expect(await zoom(content)).toBeCloseTo(1);
    await pressZoomKey(content, '=');
    await expect.poll(() => zoom(content)).toBeCloseTo(1.1);
    await expect(status).toHaveText('화면 배율110%');
    await expect(content.locator('#child')).toBeFocused();
    const appearance = await status.evaluate(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { dx: Math.abs(rect.x + rect.width / 2 - document.documentElement.clientWidth / 2), dy: Math.abs(rect.y + rect.height / 2 - document.documentElement.clientHeight / 2),
        color: style.color, background: style.backgroundColor, blur: style.backdropFilter, pointerEvents: style.pointerEvents };
    });
    expect(appearance.dx).toBeLessThan(1);
    expect(appearance.dy).toBeLessThan(1);
    expect(appearance.color).toBe('rgb(231, 237, 223)');
    expect(appearance.background).toContain('0.35');
    expect(appearance.blur).toBe('blur(8px)');
    expect(appearance.pointerEvents).toBe('none');
    // Real elapsed time is intentional: preload timers live in Electron's
    // isolated world, and must restart after the most recent native key input.
    await content.waitForTimeout(1100);
    await pressZoomKey(content, '+', ['control', 'shift']);
    await expect.poll(() => zoom(content)).toBeCloseTo(1.25);
    await expect(status).toHaveText('화면 배율125%');
    await content.waitForTimeout(900);
    await expect(status).toBeVisible();
    await expect(overlay).toHaveCount(1);
    await content.evaluate(() => {
      const button = document.createElement('button'); button.id = 'zoom-underlay'; button.textContent = '아래 화면 조작';
      button.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:200px;height:60px';
      button.onclick = () => { button.dataset.clicked = 'true'; }; document.body.append(button);
    });
    await content.locator('#zoom-underlay').click();
    await expect(content.locator('#zoom-underlay')).toHaveAttribute('data-clicked', 'true');
    await content.locator('#zoom-underlay').evaluate(el => el.remove());
    await pressZoomKey(content, '-');
    await expect.poll(() => zoom(content)).toBeCloseTo(1.1);
    await expect(status).toHaveText('화면 배율110%');
    await expect(status).toBeHidden({ timeout: 3000 });
    const childPromise = app.waitForEvent('window');
    await content.getByRole('button', { name: '종목 새 창' }).click();
    const child = await childPromise;
    await expect(child.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    await expect.poll(() => zoom(child)).toBeCloseTo(1.1);
    await expect(child.locator('#ticklane-desktop-zoom')).toHaveCount(0);
    await child.bringToFront();
    await pressZoomKey(child, '0');
    await expect.poll(() => zoom(child)).toBeCloseTo(1);
    await expect.poll(() => zoom(content)).toBeCloseTo(1);
    await expect(child.locator('#ticklane-desktop-zoom').getByRole('status')).toHaveText('화면 배율100%');
    await expect(status).toBeHidden();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '보기').submenu.items.find(item => item.label === '확대').click());
    await expect.poll(() => zoom(child)).toBeCloseTo(1.1);
    await expect(child.locator('#ticklane-desktop-zoom').getByRole('status')).toHaveText('화면 배율110%');
    const contextMenus = await app.evaluate(({ BrowserWindow, Menu }, url) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url);
      const original = Menu.buildFromTemplate;
      const menus = [];
      try {
        Menu.buildFromTemplate = template => { menus.push(template.map(item => item.label || item.role)); return { popup() {} }; };
        win.webContents.emit('context-menu', {}, { linkURL: '', isEditable: false });
        win.webContents.emit('context-menu', {}, { linkURL: '', isEditable: true });
      } finally { Menu.buildFromTemplate = original; }
      return menus;
    }, child.url());
    expect(contextMenus).toEqual([['cut', 'copy', 'paste', 'selectAll']]);
    await child.evaluate(() => window.hogaDesktop.controls.zoom('out'));
    await expect.poll(() => zoom(child)).toBeCloseTo(1);
    await expect(child.locator('#ticklane-desktop-zoom').getByRole('status')).toHaveText('화면 배율100%');
    await pressZoomKey(child, '=');
    await expect.poll(() => zoom(child)).toBeCloseTo(1.1);
    const saved = JSON.parse(await readFile(join(dir, 'connections.json'), 'utf8'));
    expect(Object.values(saved.zoomFactors)).toEqual([1.1]);
    expect(saved.profiles[0].origin).toBe(server.origin);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isMenuBarVisible()))).toBe(true);
    await app.close(); app = undefined;
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    await expect.poll(() => app.windows().some(page => page.url().startsWith(server.origin))).toBe(true);
    const restored = app.windows().find(page => page.url().startsWith(server.origin));
    await expect(restored.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    await expect.poll(() => zoom(restored)).toBeCloseTo(1.1);
    await restored.reload();
    await expect.poll(() => zoom(restored)).toBeCloseTo(1.1);
    await expect(restored.locator('#ticklane-desktop-zoom')).toHaveCount(0);
    await restored.evaluate(() => window.hogaDesktop.controls.selectServer());
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '서버 선택').accelerator)).toBe('CommandOrControl+Alt+S');
    const launcher = app.windows().find(page => page.url().startsWith('app:'));
    // Keep the recovery launcher visible while closing the old workspace, then
    // connect the next server after Electron has finished closing its window.
    await restored.close();
    await expect.poll(() => app.windows().some(page => page.url().startsWith(server.origin))).toBe(false);
    const switchedPromise = app.waitForEvent('window');
    await connect(launcher, otherServer.origin);
    const switched = await switchedPromise;
    await expect(switched.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    await expect.poll(() => zoom(switched)).toBeCloseTo(1);
    await expect(switched.locator('#ticklane-desktop-zoom')).toHaveCount(0);
    await (await app.browserWindow(switched)).evaluate(win => win.setSize(480, 360));
    await switched.emulateMedia({ reducedMotion: 'reduce' });
    for (let i = 0; i < 13; i++) await pressZoomKey(switched, '=');
    const extremeStatus = switched.locator('#ticklane-desktop-zoom').getByRole('status');
    await expect(extremeStatus).toHaveText('화면 배율300%');
    for (const percent of [300, 50]) {
      if (percent === 50) for (let i = 0; i < 13; i++) await pressZoomKey(switched, '-');
      await expect(extremeStatus).toHaveText(`화면 배율${percent}%`);
      const bounds = await extremeStatus.evaluate(el => {
        const rect = el.getBoundingClientRect(), width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
        return { left: rect.left, right: rect.right, width, dx: Math.abs(rect.x + rect.width / 2 - width / 2),
          dy: Math.abs(rect.y + rect.height / 2 - height / 2), transition: getComputedStyle(el).transitionDuration,
          textFits: [...el.children].every(child => { const box = child.getBoundingClientRect(); return box.left >= 0 && box.right <= width; }) };
      });
      expect(bounds.left, `${percent}% ${JSON.stringify(bounds)}`).toBeGreaterThanOrEqual(0);
      expect(bounds.right, `${percent}% ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(bounds.width);
      expect(bounds.dx).toBeLessThan(1);
      expect(bounds.dy).toBeLessThan(1);
      expect(bounds.transition).toBe('0s');
      expect(bounds.textFits).toBe(true);
    }
    const factors = Object.values(JSON.parse(await readFile(join(dir, 'connections.json'), 'utf8')).zoomFactors);
    expect(factors).toContain(1.1);
    expect((await fetch(server.origin + '/health')).ok).toBe(true);
  } finally { if (app) await app.close(); await server.close(); await otherServer.close(); await rm(dir, { recursive: true, force: true }); }
});

test('floating controls retain sandboxing, control the OS window and notify the owner on close', async () => {
  const server = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'ticklane-floating-'));
  let app;
  try {
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    const launcher = await app.firstWindow();
    const contentPromise = app.waitForEvent('window');
    await connect(launcher, server.origin);
    const content = await contentPromise;
    await expect(content.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    // CDP/OS destruction can bypass the launcher's ordinary close-to-hide path.
    // A newly ready content window must not dereference that destroyed object.
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.floatingMainErrors = [];
      process.on('uncaughtExceptionMonitor', error => globalThis.floatingMainErrors.push(error.message));
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('app:')).destroy();
    });
    const token = '12345678-1234-1234-1234-123456789012';
    await content.evaluate(() => { window.closedFloating = []; window.hogaDesktop.controls.onFloatingClosed(token => window.closedFloating.push(token)); });
    const floatingPromise = app.waitForEvent('window');
    await content.evaluate(({ origin, token }) => window.hogaDesktop.controls.openFloating(`${origin}/live?floating=${token}&window=w1`, 320, 260), { origin: server.origin, token });
    const floating = await floatingPromise;
    await expect(floating.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    const prefs = await app.evaluate(({ BrowserWindow }, token) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(token));
      return { sandbox: win.webContents.getLastWebPreferences().sandbox, node: win.webContents.getLastWebPreferences().nodeIntegration,
        minimum: win.getMinimumSize(), parentUrl: win.getParentWindow()?.webContents.getURL(),
        frameInsets: { w: win.getBounds().width - win.getContentBounds().width, h: win.getBounds().height - win.getContentBounds().height } };
    }, token);
    expect(prefs).toEqual({ sandbox: true, node: false, minimum: [160, 120], parentUrl: server.origin + '/live', frameInsets: { w: 0, h: 0 } });
    expect(await floating.evaluate(() => window.hogaDesktop.floatingToolWindow)).toBe(true);
    if (process.platform === 'linux' && process.env.HOGA_DESKTOP_TEST_PLATFORM === 'x11') {
      const nativeId = await app.evaluate(({ BrowserWindow }, token) => BrowserWindow.getAllWindows()
        .find(win => win.webContents.getURL().includes(token)).getNativeWindowHandle().readUInt32LE(0).toString(16), token);
      const hints = () => execFileSync('xprop', ['-id', '0x' + nativeId, '_NET_WM_WINDOW_TYPE', '_NET_WM_STATE', 'WM_TRANSIENT_FOR', '_MOTIF_WM_HINTS'], { encoding: 'utf8' });
      await expect.poll(hints).toMatch(/_NET_WM_WINDOW_TYPE_(UTILITY|DIALOG)/);
      await expect.poll(hints).toContain('_NET_WM_STATE_SKIP_TASKBAR');
      expect(hints()).toMatch(/WM_TRANSIENT_FOR.*window id # 0x/);
    }
    await floating.evaluate(() => window.hogaDesktop.controls.setFloatingAlwaysOnTop(true));
    expect((await floating.evaluate(() => window.hogaDesktop.controls.floatingState())).alwaysOnTop).toBe(true);
    await floating.evaluate(() => window.hogaDesktop.controls.setFloatingAlwaysOnTop(false));
    expect((await floating.evaluate(() => window.hogaDesktop.controls.floatingState())).alwaysOnTop).toBe(false);
    await floating.evaluate(() => window.hogaDesktop.controls.toggleFloatingMaximize());
    await expect.poll(() => floating.evaluate(() => window.hogaDesktop.controls.floatingState())).toMatchObject({ maximized: true });
    await floating.evaluate(() => window.hogaDesktop.controls.toggleFloatingMaximize());
    await expect.poll(() => floating.evaluate(() => window.hogaDesktop.controls.floatingState())).toMatchObject({ maximized: false });
    expect(await content.evaluate(async origin => {
      try { await window.hogaDesktop.controls.openFloating(origin + '/api/trading', 320, 260); return false; } catch { return true; }
    }, server.origin)).toBe(true);
    await floating.close();
    await expect.poll(() => content.evaluate(() => window.closedFloating)).toEqual([token]);
    const anotherEvent = app.waitForEvent('window');
    await content.evaluate(({ origin, token }) => window.hogaDesktop.controls.openFloating(`${origin}/live?floating=${token}&window=w1`, 320, 260), { origin: server.origin, token });
    const another = await anotherEvent;
    await expect(another.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    const closed = another.waitForEvent('close');
    await content.evaluate(token => window.hogaDesktop.controls.closeFloating(token), token);
    await closed;
    await expect.poll(() => content.evaluate(() => window.closedFloating)).toEqual([token, token]);
    expect(await app.evaluate(() => globalThis.floatingMainErrors)).toEqual([]);
  } finally { if (app) await app.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});


test('tool windows hide and restore with their owner, including tools loaded while hidden', async () => {
  const server = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'ticklane-tools-owner-'));
  let app;
  try {
    app = await launch(dir, process.env.HOGA_DESKTOP_EXECUTABLE);
    const launcher = await app.firstWindow();
    const contentEvent = app.waitForEvent('window');
    await connect(launcher, server.origin);
    const content = await contentEvent;
    await expect(content.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    const ownerId = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).id, content.url());
    const openTool = async (page, index) => {
      const token = `12345678-1234-1234-1234-${String(index).padStart(12, '0')}`;
      const event = app.waitForEvent('window');
      await page.evaluate(({ origin, token }) => window.hogaDesktop.controls.openFloating(`${origin}/live?floating=${token}&window=w${token.slice(-1)}`, 320, 260), { origin: server.origin, token });
      const tool = await event;
      await expect(tool.getByRole('heading', { name: 'Fixture workspace' })).toBeAttached();
      return { page: tool, token };
    };
    const one = await openTool(content, 1);
    const two = await openTool(content, 2);
    const otherEvent = app.waitForEvent('window');
    await content.evaluate(() => window.hogaDesktop.controls.newWindow());
    const other = await otherEvent;
    await expect(other.getByRole('heading', { name: 'Fixture workspace' })).toBeVisible();
    const unrelated = await openTool(other, 3);
    const visible = async token => app.evaluate(({ BrowserWindow }, token) => BrowserWindow.getAllWindows()
      .find(win => win.webContents.getURL().includes(token))?.isVisible() ?? false, token);
    await expect.poll(() => visible(one.token)).toBe(true);
    await expect.poll(() => visible(two.token)).toBe(true);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), ownerId);
    await expect.poll(() => visible(one.token)).toBe(false);
    await expect.poll(() => visible(two.token)).toBe(false);
    expect(await visible(unrelated.token)).toBe(true);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).restore(), ownerId);
    await expect.poll(() => visible(one.token)).toBe(true);
    await expect.poll(() => visible(two.token)).toBe(true);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).hide(), ownerId);
    await expect.poll(() => visible(one.token)).toBe(false);
    const late = await openTool(content, 4);
    expect(await visible(late.token)).toBe(false);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).show(), ownerId);
    await expect.poll(() => visible(one.token)).toBe(true);
    await expect.poll(() => visible(two.token)).toBe(true);
    await expect.poll(() => visible(late.token)).toBe(true);
    // Test the renderer visibility route as well: Wayland compositor minimization
    // does not consistently deliver BrowserWindow's native minimize/restore events.
    await content.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => visible(one.token)).toBe(true);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), ownerId);
    await expect.poll(() => app.evaluate(({ BrowserWindow }, tokens) => BrowserWindow.getAllWindows()
      .filter(win => tokens.some(token => win.webContents.getURL().includes(token))).length, [one.token, two.token, late.token])).toBe(0);
    expect(await visible(unrelated.token)).toBe(true);
  } finally { if (app) await app.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
