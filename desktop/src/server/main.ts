import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerConfig, ServerController, type ServerSnapshot } from './controller';
import { ServerTray } from './tray';

const PAGE = 'app://server/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const override = process.env.HOGA_SERVER_MANAGER_USER_DATA;
if (override && !isAbsolute(override)) throw new Error('HOGA_SERVER_MANAGER_USER_DATA must be absolute');
app.setPath('userData', override || join(app.getPath('appData'), 'ticklane-server'));
app.setName('Ticklane 서버');
if (process.platform === 'linux') app.setDesktopName('ticklane-server.desktop');
let window: BrowserWindow | undefined;
let controller: ServerController | undefined;
let tray: ServerTray | undefined;
let setupMessage = '서버 실행 설정을 읽고 있습니다.';
let setupFailed = false;
let quitting = false;
let shuttingDown = false;
let quitDialog = false;
const logFolder = join(app.getPath('userData'), 'logs');
const uiDirectory = app.isPackaged ? join(__dirname, '../server-ui') : join(app.getAppPath(), 'src/server-ui');
let uiWatcher: FSWatcher | undefined;
let reloadTimer: NodeJS.Timeout | undefined;

function watchUi(): void {
  if (app.isPackaged) return;
  try {
    // Watch the directory so editors that replace files with an atomic rename work too.
    uiWatcher = watch(uiDirectory, { persistent: false }, (_event, filename) => {
      if (filename && !['index.html', 'server.css', 'server.js'].includes(filename.toString())) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (window && !window.isDestroyed() && !quitting && !shuttingDown) window.webContents.reloadIgnoringCache();
      }, 180).unref();
    });
    uiWatcher.on('error', error => console.error('서버 관리 UI 파일 감시 실패:', error));
  } catch (error) { console.error('서버 관리 UI 파일 감시를 시작하지 못했습니다:', error); }
}

function state(): ServerSnapshot {
  return controller?.snapshot() ?? { phase: setupFailed ? 'error' : 'checking', project: '', services: [], action: null, message: setupMessage, canStart: false, canStop: false, logs: [] };
}
function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== PAGE) throw new Error('허용되지 않은 서버 관리 요청입니다.');
}
function publish(): void {
  const snapshot = state();
  try { tray?.update(snapshot); }
  catch (error) { console.error('서버 트레이 상태 갱신 실패:', error); }
  if (window && !window.isDestroyed() && window.webContents.getURL() === PAGE) window.webContents.send('server:state', snapshot);
}
function windowState(): { maximized: boolean } { return { maximized: window?.isMaximized() ?? false }; }
function publishWindowState(): void {
  if (window && !window.isDestroyed() && window.webContents.getURL() === PAGE) window.webContents.send('server:window-state', windowState());
}
async function shutdown(): Promise<void> {
  if (quitting || shuttingDown) return;
  shuttingDown = true;
  await controller?.stop();
  quitting = true;
  app.quit();
}
async function quitManager(): Promise<void> {
  if (quitDialog || !window) return;
  if (!controller?.hasOwnedServers) { void shutdown(); return; }
  quitDialog = true;
  try {
    showWindow();
    const result = await dialog.showMessageBox(window, {
      type: 'question', title: 'Ticklane 서버', message: '서버를 중지하고 관리 앱을 종료할까요?',
      detail: '이 관리 창에서 시작한 서버만 중지합니다. 창만 숨기려면 취소한 뒤 오른쪽 위 ×를 누르세요.',
      buttons: ['서버 중지 후 종료', '취소'], defaultId: 1, cancelId: 1,
    });
    if (result.response === 0) await shutdown();
  } finally { quitDialog = false; }
}
function openClient(): Promise<void> {
  if (state().phase !== 'running') throw new Error('두 서버가 준비된 뒤 Ticklane을 열 수 있습니다.');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HOGA_SERVER_MANAGER_USER_DATA;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const platform = app.commandLine.getSwitchValue('ozone-platform');
  if (platform) args.push(`--ozone-platform=${platform}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
function showWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (!quitting) { event.preventDefault(); void shutdown(); }
  });
  app.on('will-quit', () => { tray?.destroy(); uiWatcher?.close(); clearTimeout(reloadTimer); controller?.dispose(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    protocol.handle('app', request => {
      const url = new URL(request.url);
      const files: Record<string, string> = { '/index.html': 'index.html', '/server.css': 'server.css', '/server.js': 'server.js', '/icon.png': '../../assets/server-icon.png' };
      if (url.host !== 'server' || !files[url.pathname] || url.search) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(join(uiDirectory, files[url.pathname])).toString());
    });
    window = new BrowserWindow({ width: 680, height: 700, minWidth: 420, minHeight: 580, frame: false, backgroundColor: '#131418', show: false,
      title: 'Ticklane 서버', icon: join(__dirname, '../../assets/server-icon.png'),
      webPreferences: { preload: join(__dirname, '../preload/server.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== PAGE) event.preventDefault(); });
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    window.on('maximize', publishWindowState);
    window.on('unmaximize', publishWindowState);
    window.once('ready-to-show', showWindow);
    try {
      tray = new ServerTray(window, {
        showWindow, start: async () => controller?.start(), stop: async () => controller?.stop(), openClient,
        prepareStop: async () => { if (!controller) throw new Error('서버 설정을 확인해 주세요.'); return controller.prepareStop(); },
        confirmStop: async token => controller?.confirmStop(token),
        openLogs: async () => { const error = await shell.openPath(logFolder); if (error) throw new Error(error); },
        quit: quitManager,
      }, state());
    } catch (error) { console.error('서버 트레이를 시작하지 못했습니다. 실행 아이콘으로 관리 창을 열 수 있습니다:', error); }
    ipcMain.handle('server:read', event => { trusted(event); return state(); });
    ipcMain.handle('server:refresh', async event => { trusted(event); return await controller?.refresh() ?? state(); });
    ipcMain.handle('server:start', async event => { trusted(event); return await controller?.start() ?? state(); });
    ipcMain.handle('server:stop', async event => { trusted(event); return await controller?.stop() ?? state(); });
    ipcMain.handle('server:prepare-stop', async (event, ids, force) => {
      trusted(event);
      if (!controller) throw new Error('서버 실행 설정을 먼저 확인해 주세요.');
      return controller.prepareStop(ids, force);
    });
    ipcMain.handle('server:confirm-stop', async (event, token) => {
      trusted(event);
      if (!controller) throw new Error('서버 실행 설정을 먼저 확인해 주세요.');
      return controller.confirmStop(token);
    });
    ipcMain.handle('server:logs', async event => { trusted(event); return shell.openPath(logFolder); });
    ipcMain.handle('server:open-client', event => { trusted(event); return openClient(); });
    ipcMain.handle('server:window-state', event => { trusted(event); return windowState(); });
    ipcMain.handle('server:minimize', event => { trusted(event); window?.minimize(); });
    ipcMain.handle('server:toggle-maximize', event => {
      trusted(event);
      if (window?.isMaximized()) window.unmaximize(); else window?.maximize();
    });
    ipcMain.handle('server:close', event => { trusted(event); window?.hide(); });
    ipcMain.handle('server:quit', event => { trusted(event); void quitManager(); });
    await window.loadURL(PAGE);
    try {
      const argument = process.argv.find(value => value.startsWith('--server-config='));
      const path = argument?.slice('--server-config='.length) || join(homedir(), '.local/lib/ticklane/servers.json');
      if (!isAbsolute(path)) throw new Error('서버 설정 경로는 절대 경로여야 합니다.');
      const config = await readServerConfig(path);
      if (quitting || shuttingDown) return;
      controller = new ServerController(config, join(logFolder, 'server.log'));
      controller.on('change', publish);
      controller.startMonitoring();
    } catch (error) {
      setupFailed = true;
      setupMessage = `서버 실행 설정을 읽지 못했습니다. 실행기를 다시 등록하세요.\n${error instanceof Error ? error.message : ''}`;
    }
    publish();
    watchUi();
    // Run once for the primary app process, never on renderer reload or activation.
    // start() probes both ports and reuses healthy services before spawning anything.
    if (controller && !quitting && !shuttingDown) {
      const currentController = controller;
      void currentController.start().then(() => currentController.refresh())
        .catch(error => console.error('서버 자동 시작 실패:', error));
    }
  }).catch(error => { dialog.showErrorBox('Ticklane 서버 시작 실패', String(error)); quitting = true; app.quit(); });
}
