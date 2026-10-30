const { test, expect, _electron: electron } = require('@playwright/test');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const desktop = resolve(__dirname, '../..');
const repo = resolve(desktop, '..');
const { installLiveMocks } = require('../../../frontend/tests/e2e/helpers/liveMocks.ts');

test('production React and FastAPI in Electron: settings export/import and native new window', async () => {
  test.setTimeout(90000);
  const temp = await mkdtemp(join(tmpdir(), 'hoga-desktop-real-'));
  const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port; await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOGA_DATA_DIR: join(temp, 'data'), XDG_DATA_HOME: join(temp, 'xdg'),
    HOGA_LOG_DIR: join(temp, 'logs'), HOGA_ALLOWED_ORIGINS: origin, HOGA_FRONTEND_DIST: join(repo, 'frontend/dist'),
    HOGA_ENABLE_TEST_ENDPOINTS: '1', HOGA_LIVE_STARTUP_ENABLED: 'false', HOGAPLAY_COOKIE: '',
    TOSSINVEST_CLIENT_ID: '', TOSSINVEST_CLIENT_SECRET: '', KIS_APP_KEY: '', KIS_APP_SECRET: '' };
  for (const suffix of ['', '_2', '_3', '_4', '_5', '_6']) { env[`KIWOOM_APP_KEY${suffix}`] = ''; env[`KIWOOM_APP_SECRET${suffix}`] = ''; }
  env.KIWOOM_MOCK_APP_KEY = ''; env.KIWOOM_MOCK_APP_SECRET = ''; env.KOFIA_API_KEY = '';
  const server = spawn(join(repo, '.venv/bin/python'), ['-m', 'uvicorn', 'hoga.api.app:default_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], { cwd: repo, env, stdio: 'ignore' });
  let app;
  try {
    await expect.poll(async () => { try { return (await fetch(origin + '/health')).ok; } catch { return false; } }, { timeout: 30000 }).toBe(true);
    const identity = await (await fetch(origin + '/api/test/whoami')).json();
    expect(identity.repo_root).toBe(repo); expect(identity.data_dir).toBe(join(temp, 'data'));
    const desktopEnv = { ...process.env, HOGA_DESKTOP_USER_DATA: join(temp, 'desktop') }; delete desktopEnv.ELECTRON_RUN_AS_NODE;
    const args = process.env.HOGA_DESKTOP_EXECUTABLE ? [] : [desktop];
    if (process.env.HOGA_DESKTOP_TEST_PLATFORM) args.push(`--ozone-platform=${process.env.HOGA_DESKTOP_TEST_PLATFORM}`);
    app = await electron.launch({ executablePath: process.env.HOGA_DESKTOP_EXECUTABLE ?? process.env.HOGA_DESKTOP_ELECTRON_BINARY,
      args, cwd: desktop, env: desktopEnv, chromiumSandbox: true });
    const launcher = await app.firstWindow();
    await launcher.locator('#origin').fill(origin); await launcher.locator('#name').fill('로컬 통합 검증');
    const contentPromise = app.waitForEvent('window'); await launcher.getByRole('button', { name: '연결', exact: true }).click();
    const page = await contentPromise;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '관심종목 패널 토글', exact: true })).toBeVisible();
    await page.screenshot({ path: join(desktop, 'test-results/real-app.png') });
    await expect(page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '설정', exact: true })).toHaveCount(0);
    const rail = page.getByRole('navigation', { name: '우측 레일' });
    await expect(rail.getByRole('button').last()).toHaveAccessibleName('설정');
    await rail.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByTestId('settings-nav-desktop').click();
    const desktopSettings = page.getByRole('region', { name: '데스크톱', exact: true });
    await expect(desktopSettings.getByText('로컬 통합 검증', { exact: true })).toBeVisible();
    await expect(desktopSettings.getByText(origin, { exact: true })).toBeVisible();
    await desktopSettings.getByRole('button', { name: '화면 배율 확대', exact: true }).click();
    await expect(desktopSettings.getByLabel('현재 화면 배율')).toHaveText('110%');
    await desktopSettings.getByRole('button', { name: '100% 복원', exact: true }).click();
    await expect(desktopSettings.getByLabel('현재 화면 배율')).toHaveText('100%');
    await expect(page.locator('#ticklane-desktop-zoom').getByRole('status')).toBeHidden({ timeout: 3000 });
    await desktopSettings.screenshot({ path: join(desktop, 'test-results/desktop-settings.png') });
    await desktopSettings.getByRole('button', { name: '서버 선택', exact: true }).click();
    await expect(launcher.locator('#origin')).toBeVisible();
    await launcher.close(); // Hides the recovery window while workspaces remain open.
    await page.bringToFront();
    await expect(page.getByRole('button', { name: '화면 설정 내보내기' })).toBeAttached();
    await page.getByRole('button', { name: '앱 정보', exact: true }).click();
    // Native save destination is stubbed in the main process, not the renderer.
    const destination = join(temp, 'settings.json');
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialogSync = () => path; }, destination);
    await page.getByRole('button', { name: '화면 설정 내보내기' }).click();
    await expect.poll(async () => { try { return JSON.parse(await readFile(destination, 'utf8')).format; } catch { return ''; } }).toBe('hoga-user-settings');
    await page.locator('input[type="file"][aria-label="화면 설정 파일"]').setInputFiles(destination);
    await expect(page.getByText(/원본: http/)).toBeVisible();
    await page.getByLabel('이 서버의 다른 작업 창과 탭을 모두 닫았습니다.').check();
    await page.getByRole('button', { name: '현재 설정 백업', exact: true }).click();
    await page.getByLabel('백업 파일을 저장했습니다.').check();
    await page.getByRole('button', { name: '설정 적용 후 새로고침' }).click();
    await expect(page.getByRole('button', { name: '관심종목 패널 토글', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByTestId('settings-nav-desktop').click();
    const nextWindow = app.waitForEvent('window');
    await page.getByRole('button', { name: '새 작업 창', exact: true }).click();
    const child = await nextWindow;
    await expect(child.getByRole('button', { name: '관심종목 패널 토글', exact: true })).toBeVisible({ timeout: 15000 });
    await installLiveMocks(page);
    await page.reload();
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByTestId('watchlist-row-098460').click();
    await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
    await page.screenshot({ path: join(desktop, 'test-results/real-chart.png') });
    await installLiveMocks(page.context());
    const frame = page.locator('[data-win]').filter({ has: page.getByTestId('live-chart-root') }).first();
    const bounds = await frame.boundingBox();
    const detachedEvent = app.waitForEvent('window');
    await frame.getByRole('button', { name: '창 분리', exact: true }).click();
    const detached = await detachedEvent;
    await expect(detached.getByTestId('floating-workspace')).toBeVisible();
    await expect(frame).toHaveCount(0);
    await expect(detached.getByRole('navigation')).toHaveCount(0);
    await expect(detached.getByTestId('app-content-grid')).toHaveAttribute('data-floating-tool', '');
    const header = detached.locator('.live-window-titlebar');
    expect(await header.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag');
    expect(await header.getByRole('button', { name: '항상 위', exact: true }).evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
    const toolId = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).id, detached.url());
    const parentId = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getParentWindow().id, toolId);
    await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), toolId)).toBe(true);
    for (let cycle = 0; cycle < 3; cycle++) {
      await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), parentId);
      // OS minimize/restore requests are asynchronous. Await the owner's actual
      // hidden state before restoring, rather than cancelling an in-flight minimize.
      if (process.env.HOGA_DESKTOP_TEST_PLATFORM === 'x11')
        await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isMinimized(), parentId)).toBe(true);
      await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), toolId)).toBe(false);
      await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).restore(), parentId);
      if (process.env.HOGA_DESKTOP_TEST_PLATFORM === 'x11')
        await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isMinimized(), parentId)).toBe(false);
      await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), toolId)).toBe(true);
    }
    await detached.getByRole('button', { name: '항상 위', exact: true }).click();
    await expect.poll(() => detached.evaluate(() => window.hogaDesktop.controls.floatingState())).toMatchObject({ alwaysOnTop: true });
    const floatingSize = await detached.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await detached.getByRole('button', { name: '창 최대화', exact: true }).click();
    await expect.poll(() => detached.evaluate(() => innerWidth)).toBeGreaterThan(floatingSize.w);
    await expect(detached.getByRole('button', { name: '원래 크기로 복원', exact: true })).toBeVisible();
    await detached.getByRole('button', { name: '원래 크기로 복원', exact: true }).click();
    await expect.poll(() => detached.evaluate(() => ({ w: innerWidth, h: innerHeight }))).toEqual(floatingSize);
    await expect.poll(() => detached.locator('[data-win]').evaluate(element => {
      const box = element.getBoundingClientRect();
      return Math.max(Math.abs(box.width - innerWidth), Math.abs(box.height - innerHeight));
    })).toBeLessThan(1);
    await detached.screenshot({ path: join(desktop, 'test-results/real-floating-chart.png') });
    await detached.getByRole('button', { name: '원래 화면에 합치기', exact: true }).click();
    await expect(frame).toBeVisible();
    const restored = await frame.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) expect(restored[key]).toBeCloseTo(bounds[key], 0);
    expect(errors).toEqual([]);
    await app.close(); app = undefined;
    expect((await fetch(origin + '/health')).ok).toBe(true);
  } finally {
    if (app) await app.close();
    server.kill('SIGTERM'); await new Promise(done => { if (server.exitCode !== null) done(); else server.once('exit', done); });
    await rm(temp, { recursive: true, force: true });
  }
});
