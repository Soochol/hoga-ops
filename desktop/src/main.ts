import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appNavigation, externalLink, networkAllowed } from './navigation';
import { emptySettings, fitBounds, readSettings, saveSettings, sessionKey, validateProfile } from './profiles';
import type { Profile, Settings } from './profiles';
import { probeServer } from './connection';
import { nextZoomFactor, zoomCommand, type ZoomCommand } from './zoom';

const LAUNCHER_URL = 'app://desktop/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const override = process.env.HOGA_DESKTOP_USER_DATA;
if (override && !isAbsolute(override)) throw new Error('HOGA_DESKTOP_USER_DATA must be an absolute path');
// Preserve profiles and Chromium partitions created before the Ticklane rename.
app.setPath('userData', override || join(app.getPath('appData'), 'Hoga Ops'));
app.setName('Ticklane');
// Wayland resolves the running window's icon through this installed desktop ID.
if (process.platform === 'linux') app.setDesktopName('ticklane.desktop');
let launcher: BrowserWindow | undefined;
let settings: Settings = emptySettings();
let warning = '';
let settingsPath = '';
let active: Profile | undefined;
let connecting: AbortController | undefined;
let connectionId = 0;
let quitting = false;
const contentWindows = new Set<BrowserWindow>();
const windowProfileKeys = new Map<BrowserWindow, string>();
const configuredSessions = new Set<string>();
const build = JSON.parse(readFileSync(join(__dirname, 'build.json'), 'utf8')) as { sourceVersion: string; commit: string };

function persist(): void { saveSettings(settingsPath, settings); }
function changeZoom(win: BrowserWindow | null | undefined, command: ZoomCommand): void {
  if (!win || win.isDestroyed()) return;
  const key = windowProfileKeys.get(win);
  if (!key) return;
  const factor = nextZoomFactor(win.webContents.getZoomFactor(), command);
  for (const [other, otherKey] of windowProfileKeys) {
    if (otherKey === key && !other.isDestroyed()) {
      other.webContents.setZoomFactor(factor);
      other.webContents.send('desktop:zoom-state', factor);
    }
  }
  // Only the window where the user adjusted zoom displays the transient status.
  win.webContents.send('desktop:zoom-changed', factor);
  if (settings.zoomFactors[key] === factor) return;
  settings.zoomFactors[key] = factor;
  try { persist(); } catch { warning = '화면 배율을 저장하지 못했습니다.'; }
}
function zoomMenu(target: () => BrowserWindow | null | undefined): Electron.MenuItemConstructorOptions[] {
  return [
    { label: '확대', accelerator: 'CommandOrControl+Plus', click: () => changeZoom(target(), 'in') },
    { label: '축소', accelerator: 'CommandOrControl+-', click: () => changeZoom(target(), 'out') },
    { label: '100%로 복귀', accelerator: 'CommandOrControl+0', click: () => changeZoom(target(), 'reset') },
  ];
}
function updateMenu(serverVersion = ''): void {
  Menu.setApplicationMenu(createMenu(serverVersion));
  // Keep native edit/reload shortcuts without reserving a menu row in Linux windows.
  for (const win of BrowserWindow.getAllWindows()) win.setMenuBarVisibility(false);
}
function showLauncher(message = ''): void {
  if (message) warning = message;
  if (!launcher || launcher.isDestroyed()) {
    launcher = new BrowserWindow({ width: 620, height: 740, minWidth: 480, minHeight: 560, title: 'Ticklane 서버 연결',
      icon: join(__dirname, '../assets/icon.png'),
      webPreferences: { preload: join(__dirname, 'preload/launcher.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    launcher.setMenuBarVisibility(false);
    launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    launcher.webContents.on('will-navigate', (event, url) => { if (url !== LAUNCHER_URL) event.preventDefault(); });
    launcher.webContents.on('will-redirect', event => event.preventDefault());
    launcher.on('close', event => {
      if (!quitting && contentWindows.size > 0) { event.preventDefault(); launcher?.hide(); }
    });
    void launcher.loadURL(LAUNCHER_URL);
  } else {
    void launcher.webContents.executeJavaScript('window.refreshLauncher?.()');
  }
  launcher.show(); launcher.focus();
}

function trustedLauncher(event: IpcMainInvokeEvent): void {
  if (!launcher || event.sender !== launcher.webContents || event.senderFrame !== launcher.webContents.mainFrame
    || event.senderFrame.url !== LAUNCHER_URL) throw new Error('허용되지 않은 설정 요청입니다.');
}

/** Only the active server's top-level workspace may call these narrow controls. */
function trustedContent(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !contentWindows.has(win) || !active
    || windowProfileKeys.get(win) !== sessionKey(active)
    || event.senderFrame !== event.sender.mainFrame
    || !appNavigation(event.senderFrame.url, active)) throw new Error('허용되지 않은 데스크톱 요청입니다.');
  return win;
}

function configureSession(profile: Profile): Electron.Session {
  const key = sessionKey(profile);
  const ses = session.fromPartition(`persist:hoga-${key}`);
  if (configuredSessions.has(key)) return ses;
  configuredSessions.add(key);
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !networkAllowed(details.url, profile) }));
  // Explicitly choose the destination, and never execute a downloaded file.
  ses.on('will-download', (_event, item, contents) => {
    const win = BrowserWindow.fromWebContents(contents);
    if (!win) { item.cancel(); return; }
    const destination = dialog.showSaveDialogSync(win, { defaultPath: item.getFilename() });
    if (!destination) item.cancel(); else item.setSavePath(destination);
  });
  return ses;
}

function openContent(profile: Profile, url: string, primary = false): BrowserWindow {
  const key = sessionKey(profile);
  const bounds = fitBounds(settings.bounds[key], screen.getAllDisplays().map(d => d.workArea));
  const win = new BrowserWindow({ ...bounds, minWidth: 480, minHeight: 360, show: false,
    icon: join(__dirname, '../assets/icon.png'),
    title: `Ticklane · ${profile.name}`,
    webPreferences: { session: configureSession(profile), preload: join(__dirname, 'preload/content.cjs'),
      additionalArguments: [`--hoga-api-origin=${profile.apiOrigin ?? profile.origin}`],
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, zoomFactor: settings.zoomFactors[key] ?? 1 },
  });
  win.setMenuBarVisibility(false);
  contentWindows.add(win);
  windowProfileKeys.set(win, key);
  win.webContents.on('before-input-event', (event, input) => {
    const command = zoomCommand(input);
    if (!command) return;
    // Prevent the renderer and the native menu accelerator from handling it twice.
    event.preventDefault();
    changeZoom(win, command);
  });
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings.zoomFactors[key] ?? 1));
  win.webContents.on('page-title-updated', event => { event.preventDefault(); win.setTitle(`Ticklane · ${profile.name}`); });
  const guard = (event: Electron.Event, target: string) => { if (!appNavigation(target, profile)) event.preventDefault(); };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (appNavigation(target, profile)) openContent(profile, target);
    return { action: 'deny' };
  });
  win.webContents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (externalLink(params.linkURL) && !appNavigation(params.linkURL, profile)) {
      items.push({ label: '링크를 외부 브라우저로 열기', click: () => {
        void shell.openExternal(params.linkURL).catch(() => showLauncher('외부 브라우저를 열 수 없습니다.'));
      } });
    }
    if (params.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) showLauncher('화면을 불러오지 못했습니다. 서버 주소·프론트 빌드·연결을 확인한 뒤 다시 연결하세요.');
  });
  win.webContents.on('render-process-gone', () => showLauncher('화면 프로세스가 종료됐습니다. 다시 연결하세요.'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (primary && settings.bounds[key]?.maximized) win.maximize();
    win.show();
    launcher?.hide();
  });
  win.on('close', () => {
    if (primary && !win.isDestroyed()) {
      settings.bounds[key] = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      try { persist(); } catch { warning = '창 위치를 저장하지 못했습니다.'; }
    }
  });
  win.on('closed', () => {
    contentWindows.delete(win);
    windowProfileKeys.delete(win);
    if (!quitting && contentWindows.size === 0) {
      // A visible connection window keeps a failed connection recoverable.
      if (!launcher?.isVisible()) app.quit();
    }
  });
  void win.loadURL(url).catch(() => { /* did-fail-load presents recovery UI */ });
  return win;
}

async function connect(raw: unknown): Promise<{ ok: boolean; error?: string }> {
  const attempt = ++connectionId;
  connecting?.abort();
  const controller = new AbortController(); connecting = controller;
  try {
    const profile = validateProfile(raw, !app.isPackaged);
    if (settings.profiles.length >= 50 && !settings.profiles.some(p => p.id === profile.id)) throw new Error('저장된 서버는 최대 50개입니다. 사용하지 않는 프로필을 삭제하세요.');
    const info = await probeServer(profile, controller.signal);
    if (controller.signal.aborted || attempt !== connectionId) return { ok: false, error: '연결 시도를 취소했습니다.' };
    settings.profiles = settings.profiles.filter(p => p.id !== profile.id);
    settings.profiles.push(profile); settings.activeId = profile.id;
    persist();
    // Keep a launcher alive during transition so closing old windows cannot quit the app.
    showLauncher();
    for (const old of [...contentWindows]) old.close();
    if (contentWindows.size) throw new Error('기존 창을 닫은 뒤 다시 연결하세요.');
    active = profile; warning = '';
    openContent(profile, `${profile.origin}/live`, true);
    // Deep health is informational; a 503 must not prevent recovery via the app.
    void fetch(`${profile.apiOrigin ?? profile.origin}/health?deep=1`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
      .then(response => { if (attempt === connectionId && !response.ok) warning = `서버 진단 HTTP ${response.status}. 앱의 서비스 상태를 확인하세요.`; })
      .catch(() => { /* runtime reconnect belongs to the web app */ });
    updateMenu(`${info.version}${info.commit ? ` (${info.commit})` : ''}`);
    return { ok: true };
  } catch (error) {
    controller.abort();
    return { ok: false, error: error instanceof Error ? error.message : '연결할 수 없습니다.' };
  } finally { if (attempt === connectionId) connecting = undefined; }
}

function createMenu(serverVersion = ''): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '앱', submenu: [
      { label: '서버 선택', accelerator: 'CommandOrControl+Alt+S', click: () => showLauncher() },
      { label: '새 작업 창', click: () => { if (active) openContent(active, `${active.origin}/live`); } },
      { label: '앱 정보', click: () => { void dialog.showMessageBox({ message: `Ticklane ${build.sourceVersion}`,
        detail: `Desktop commit: ${build.commit}\n서버: ${active?.name ?? '연결 안 됨'}\n서버 버전: ${serverVersion || '—'}` }); } },
      { type: 'separator' }, { role: 'quit', label: '종료' },
    ] },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ role: 'reload', label: '화면 새로고침' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
      { type: 'separator' }, ...zoomMenu(() => BrowserWindow.getFocusedWindow()),
      { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }] },
  ]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const win = [...contentWindows][0];
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else showLauncher();
  });
  app.on('before-quit', () => { quitting = true; connecting?.abort(); });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(() => {
    settingsPath = join(app.getPath('userData'), 'connections.json');
    const loaded = readSettings(settingsPath); settings = loaded.settings; warning = loaded.warning ?? '';
    protocol.handle('app', request => {
      const url = new URL(request.url);
      const files: Record<string, string> = { '/index.html': 'index.html', '/launcher.js': 'launcher.js', '/launcher.css': 'launcher.css' };
      if (url.host !== 'desktop' || !files[url.pathname] || url.search) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(join(__dirname, 'launcher', files[url.pathname])).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('desktop:read', event => {
      const win = trustedContent(event);
      return { serverName: active!.name, origin: active!.origin,
        apiOrigin: active!.apiOrigin ?? active!.origin, zoomFactor: win.webContents.getZoomFactor() };
    });
    ipcMain.handle('desktop:select-server', event => { trustedContent(event); showLauncher(); });
    ipcMain.handle('desktop:new-window', event => { trustedContent(event); openContent(active!, `${active!.origin}/live`); });
    ipcMain.handle('desktop:zoom', (event, command: unknown) => {
      const win = trustedContent(event);
      if (command !== 'in' && command !== 'out' && command !== 'reset') throw new Error('잘못된 배율 명령입니다.');
      changeZoom(win, command);
      return win.webContents.getZoomFactor();
    });
    ipcMain.handle('launcher:read', event => {
      trustedLauncher(event);
      return { profiles: settings.profiles, activeId: settings.activeId, warning, build, developmentAllowed: !app.isPackaged, hasWindows: contentWindows.size > 0 };
    });
    ipcMain.handle('launcher:connect', (event, value: unknown) => { trustedLauncher(event); return connect(value); });
    ipcMain.handle('launcher:cancel', event => { trustedLauncher(event); connecting?.abort(); connectionId++; });
    ipcMain.handle('launcher:remove', (event, id: unknown) => {
      trustedLauncher(event);
      if (typeof id !== 'string') throw new Error('잘못된 프로필');
      settings.profiles = settings.profiles.filter(p => p.id !== id);
      if (settings.activeId === id) settings.activeId = undefined;
      persist();
    });
    updateMenu();
    showLauncher();
    const last = settings.profiles.find(p => p.id === settings.activeId);
    if (last) void connect(last).then(result => { if (!result.ok) showLauncher(result.error); });
  }).catch(error => { dialog.showErrorBox('Ticklane 시작 실패', error instanceof Error ? error.message : '앱을 시작할 수 없습니다.'); app.quit(); });
}
