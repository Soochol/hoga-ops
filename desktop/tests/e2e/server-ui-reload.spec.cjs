const { test, expect, _electron: electron } = require('@playwright/test');
const { cp, mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { fixture, alive } = require('../helpers/server-fixture.cjs');
const root = resolve(__dirname, '../..');

test('editing manager HTML, CSS and JS reloads only the renderer and preserves managed servers', async () => {
  test.skip(Boolean(process.env.HOGA_DESKTOP_EXECUTABLE), 'Source UI watching is disabled in packaged apps.');
  const f = await fixture(); let app;
  try {
    // Edit an isolated app copy, never the user's live manager source files.
    const sourceApp = join(f.project, 'desktop');
    const ui = join(sourceApp, 'src/server-ui');
    await mkdir(join(sourceApp, 'src'), { recursive: true });
    await cp(join(root, 'package.json'), join(sourceApp, 'package.json'));
    await cp(join(root, 'dist'), join(sourceApp, 'dist'), { recursive: true });
    await cp(join(root, 'assets'), join(sourceApp, 'assets'), { recursive: true });
    await cp(join(root, 'src/server-ui'), ui, { recursive: true });
    const env = { ...process.env, ...f.env, HOGA_SERVER_MANAGER_USER_DATA: join(f.project, 'manager-data') };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [sourceApp, '--server-manager', `--server-config=${f.config}`];
    if (process.env.HOGA_DESKTOP_TEST_PLATFORM) args.push(`--ozone-platform=${process.env.HOGA_DESKTOP_TEST_PLATFORM}`);
    app = await electron.launch({ args, cwd: root, env, chromiumSandbox: true });
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '서버 시작', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'running');
    const mainPid = app.process().pid;
    const markers = { backend: await f.marker('backend'), frontend: await f.marker('frontend') };
    async function serversUnchanged() {
      expect(app.process().pid).toBe(mainPid);
      for (const id of ['backend', 'frontend']) {
        expect((await f.marker(id)).pid).toBe(markers[id].pid);
        expect(await alive(markers[id].pid)).toBe(true);
        expect(await alive(markers[id].worker)).toBe(true);
        expect((await fetch(`http://127.0.0.1:${f.ports[id]}/health`)).ok).toBe(true);
        await expect(page.locator(`#service-${id}`)).toHaveAttribute('data-owner', 'managed');
        await expect(page.locator(`#service-${id}`)).toHaveAttribute('data-phase', 'running');
      }
      expect(app.windows()).toHaveLength(1);
    }
    async function save(name, transform) {
      const path = join(ui, name);
      await writeFile(`${path}.saving`, transform(await readFile(path, 'utf8')));
      await rename(`${path}.saving`, path); // Typical editor atomic-save behavior.
    }

    await page.locator('summary').click();
    await page.getByLabel('자동 스크롤').uncheck();
    await save('server.css', css => css.replace('--accent: #f0b429', '--accent: #f5c542'));
    await expect(page.locator('#primary')).toHaveCSS('background-color', 'rgb(245, 197, 66)');
    await expect(page.locator('#log-details')).toHaveJSProperty('open', true);
    await expect(page.getByLabel('자동 스크롤')).not.toBeChecked();
    await serversUnchanged();

    await save('index.html', html => html.replace('<h1>로컬 서버</h1>', '<h1>변경된 서버 관리 화면</h1>'));
    await expect(page.getByRole('heading', { name: '변경된 서버 관리 화면', exact: true })).toBeVisible();
    await serversUnchanged();

    await page.locator('#stop').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await save('server.js', js => `${js}\ndocument.documentElement.dataset.reloadProbe = 'updated';\n`);
    await expect(page.locator('html')).toHaveAttribute('data-reload-probe', 'updated');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await serversUnchanged();

    await page.getByRole('button', { name: '관리 창 숨기기' }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    await save('server.js', js => js.replace("reloadProbe = 'updated'", "reloadProbe = 'hidden-update'"));
    await expect(page.locator('html')).toHaveAttribute('data-reload-probe', 'hidden-update');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    await serversUnchanged();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.locator('#stop').click();
    await page.getByRole('dialog').getByRole('button', { name: '서버 중지', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'stopped');
    for (const marker of Object.values(markers)) {
      await expect.poll(() => alive(marker.pid)).toBe(false);
      await expect.poll(() => alive(marker.worker)).toBe(false);
    }
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await f.dispose(); }
});
