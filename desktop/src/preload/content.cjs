const { contextBridge, ipcRenderer } = require('electron');
const argument = process.argv.find(value => value.startsWith('--hoga-api-origin='));
contextBridge.exposeInMainWorld('hogaDesktop', Object.freeze({
  controls: Object.freeze({
    getState: () => ipcRenderer.invoke('desktop:read'),
    selectServer: () => ipcRenderer.invoke('desktop:select-server'),
    newWindow: () => ipcRenderer.invoke('desktop:new-window'),
    openFloating: (url, width, height) => ipcRenderer.invoke('desktop:open-floating', url, width, height),
    closeFloating: token => ipcRenderer.invoke('desktop:close-floating', token),
    floatingState: () => ipcRenderer.invoke('desktop:floating-state'),
    toggleFloatingMaximize: () => ipcRenderer.invoke('desktop:floating-maximize'),
    setFloatingAlwaysOnTop: enabled => ipcRenderer.invoke('desktop:floating-on-top', enabled),
    focusFloating: () => ipcRenderer.invoke('desktop:floating-focus'),
    onFloatingClosed: callback => {
      const listener = (_event, token) => { if (typeof token === 'string') callback(token); };
      ipcRenderer.on('desktop:floating-closed', listener);
      return () => ipcRenderer.removeListener('desktop:floating-closed', listener);
    },
    zoom: command => ipcRenderer.invoke('desktop:zoom', command),
    onZoomChange: callback => {
      const listener = (_event, factor) => {
        if (typeof factor === 'number' && Number.isFinite(factor) && factor >= .5 && factor <= 3) callback(factor);
      };
      ipcRenderer.on('desktop:zoom-state', listener);
      return () => ipcRenderer.removeListener('desktop:zoom-state', listener);
    },
  }),
  strictConfig: true,
  apiOrigin: argument ? argument.slice('--hoga-api-origin='.length) : '',
}));

// The transient zoom overlay stays inside the isolated preload. Shadow DOM keeps page selectors and this small overlay separate.
let zoomHost, zoomPanel, zoomValue, hideZoomTimer, pendingZoom;
function showZoom(factor) {
  if (!document.body) { pendingZoom = factor; return; }
  if (!zoomHost) {
    zoomHost = document.createElement('div');
    zoomHost.id = 'ticklane-desktop-zoom';
    const shadow = zoomHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial; position: fixed; inset: 0; z-index: 2147483647;
        display: grid; place-items: center; pointer-events: none !important;
      }
      .status {
        box-sizing: border-box; display: flex; align-items: center; gap: .625rem;
        max-width: calc(100% - 24px); padding: var(--space-md, .75rem) var(--space-lg, 1rem);
        border: 1px solid color-mix(in srgb, var(--fg, CanvasText) 12%, transparent);
        border-radius: 8px; color: var(--fg, CanvasText);
        background: color-mix(in srgb, var(--bg-card, Canvas) 35%, transparent);
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        font-family: var(--font-ui, system-ui, sans-serif); line-height: 1.6;
        pointer-events: none; user-select: none; opacity: 0; visibility: hidden;
        transition: opacity 150ms ease-out, visibility 0s 150ms;
      }
      .status[data-visible] { opacity: 1; visibility: visible; transition: opacity 150ms ease-out; }
      .label { font-size: var(--text-sm, .71875rem); color: var(--fg-dim, CanvasText); white-space: nowrap; }
      .value { font-size: var(--text-lg, 1rem); font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
      @media (prefers-reduced-motion: reduce) { .status, .status[data-visible] { transition: none; } }
    `;
    zoomPanel = document.createElement('div');
    zoomPanel.className = 'status';
    zoomPanel.setAttribute('role', 'status');
    zoomPanel.setAttribute('aria-live', 'polite');
    zoomPanel.setAttribute('aria-atomic', 'true');
    const label = document.createElement('span');
    label.className = 'label'; label.textContent = '화면 배율';
    zoomValue = document.createElement('span'); zoomValue.className = 'value';
    zoomPanel.append(label, zoomValue);
    shadow.append(style, zoomPanel);
    document.documentElement.append(zoomHost);
  }
  clearTimeout(hideZoomTimer);
  zoomValue.textContent = `${Math.round(factor * 100)}%`;
  zoomPanel.setAttribute('data-visible', '');
  hideZoomTimer = setTimeout(() => zoomPanel.removeAttribute('data-visible'), 1800);
}
ipcRenderer.on('desktop:zoom-changed', (_event, factor) => {
  if (typeof factor === 'number' && Number.isFinite(factor) && factor >= .5 && factor <= 3) showZoom(factor);
});
window.addEventListener('DOMContentLoaded', () => {
  if (pendingZoom !== undefined) { showZoom(pendingZoom); pendingZoom = undefined; }
}, { once: true });
