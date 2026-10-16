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
  for (const suffix of ['', '_2', '_3', '_4']) { env[`KIWOOM_APP_KEY${suffix}`] = ''; env[`KIWOOM_APP_SECRET${suffix}`] = ''; }
  const server = spawn(join(repo, '.venv/bin/python'), ['-m', 'uvicorn', 'hoga.api.app:default_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], { cwd: repo, env, stdio: 'ignore' });
  let app;
  try {
    await expect.poll(async () => { try { return (await fetch(origin + '/health')).ok; } catch { return false; } }, { timeout: 30000 }).toBe(true);
    const identity = await (await fetch(origin + '/api/test/whoami')).json();
    expect(identity.repo_root).toBe(repo); expect(identity.data_dir).toBe(join(temp, 'data'));
    const desktopEnv = { ...process.env, HOGA_DESKTOP_USER_DATA: join(temp, 'desktop') }; delete desktopEnv.ELECTRON_RUN_AS_NODE;
    const args = process.env.HOGA_DESKTOP_EXECUTABLE ? [] : [desktop];
    if (process.env.HOGA_DESKTOP_TEST_PLATFORM) args.push(`--ozone-platform=${process.env.HOGA_DESKTOP_TEST_PLATFORM}`);
    app = await electron.launch({ executablePath: process.env.HOGA_DESKTOP_EXECUTABLE,
      args, cwd: desktop, env: desktopEnv, chromiumSandbox: true });
    const launcher = await app.firstWindow();
    await launcher.locator('#origin').fill(origin); await launcher.locator('#name').fill('로컬 통합 검증');
    const contentPromise = app.waitForEvent('window'); await launcher.getByRole('button', { name: '연결', exact: true }).click();
    const page = await contentPromise;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '관심종목 패널 토글', exact: true })).toBeVisible();
    await page.screenshot({ path: join(desktop, 'test-results/real-app.png') });
    await page.getByRole('button', { name: '설정', exact: true }).click();
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
    const nextWindow = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '새 작업 창').click());
    const child = await nextWindow;
    await expect(child.getByRole('button', { name: '관심종목 패널 토글', exact: true })).toBeVisible();
    await installLiveMocks(page);
    await page.reload();
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByTestId('watchlist-row-098460').click();
    await expect(page.getByTestId('live-chart-root').first()).toBeVisible();
    await page.screenshot({ path: join(desktop, 'test-results/real-chart.png') });
    expect(errors).toEqual([]);
    await app.close(); app = undefined;
    expect((await fetch(origin + '/health')).ok).toBe(true);
  } finally {
    if (app) await app.close();
    server.kill('SIGTERM'); await new Promise(done => { if (server.exitCode !== null) done(); else server.once('exit', done); });
    await rm(temp, { recursive: true, force: true });
  }
});
