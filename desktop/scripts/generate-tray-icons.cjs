// Run: node_modules/.bin/electron scripts/generate-tray-icons.cjs
const { app, BrowserWindow } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const assets = join(__dirname, '../assets');
void app.whenReady().then(async () => {
  const source = await readFile(join(assets, 'server-tray.svg'), 'utf8');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<html></html>');
  for (const [state, color] of Object.entries({ running: '#6dd5a7', stopped: '#a1a7b3', busy: '#f0b429', error: '#ff8d90' })) {
    for (const scale of [1, 2]) {
      const svg = source.replace('#6dd5a7', color);
      const data = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)};
        await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${24 * scale};
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png');
      })()`);
      await writeFile(join(assets, `server-tray-${state}${scale === 2 ? '@2x' : ''}.png`), Buffer.from(data.split(',')[1], 'base64'));
    }
  }
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
