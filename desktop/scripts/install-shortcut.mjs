import { execFileSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const desktopQuote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`;
const root = fileURLToPath(new URL('../', import.meta.url));
const home = homedir();
const data = join(home, '.config/hoga-ops-local-dev');
const launcher = join(home, '.local/bin/ticklane');
const applications = join(home, '.local/share/applications');
// Versioned basename refreshes desktop-shell caches when the design changes.
const icon = join(home, '.local/share/icons/hicolor/256x256/apps/ticklane-local-v1.png');
const binary = join(root, 'node_modules/electron/dist/electron');
await access(binary);
await access(join(root, 'dist/main.js'));
for (const folder of [join(home, '.local/bin'), applications, data, join(home, '.local/share/icons/hicolor/256x256/apps')]) await mkdir(folder, { recursive: true });
await copyFile(join(root, 'assets/icon.png'), icon);
const settings = join(data, 'connections.json');
try { await access(settings); } catch {
  await writeFile(settings, JSON.stringify({ version: 1, profiles: [{ id: 'local-vite', name: '로컬 개발', mode: 'development', origin: 'http://localhost:5173', apiOrigin: 'http://localhost:8000' }], activeId: 'local-vite', bounds: {} }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
await writeFile(launcher, `#!/bin/sh
set -eu
umask 077
unset ELECTRON_RUN_AS_NODE
export HOGA_DESKTOP_USER_DATA=${quote(data)}
if [ ! -x ${quote(binary)} ] || [ ! -f ${quote(join(root, 'dist/main.js'))} ]; then
  if command -v notify-send >/dev/null 2>&1; then notify-send 'Ticklane' 'Electron 실행 파일이 없습니다. desktop에서 npm run install:shortcut을 다시 실행하세요.'; fi
  exit 1
fi
cd ${quote(root)}
exec ${quote(binary)} ${quote(root)} >> ${quote(join(data, 'launch.log'))} 2>&1
`, { mode: 0o755 });
await chmod(launcher, 0o755);
// Keep the previously documented command working after the rename.
await writeFile(join(home, '.local/bin/hoga-ops-local'), `#!/bin/sh\nexec ${quote(launcher)} "$@"\n`, { mode: 0o755 });
const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Ticklane
Comment=로컬 main 화면과 API 서버에 연결
Exec=${desktopQuote(launcher)}
Icon=${icon}
Terminal=false
Categories=Office;Finance;
Keywords=ticklane;틱레인;hoga;주식;차트;로컬;
StartupNotify=true
`;
const application = join(applications, 'ticklane-local.desktop');
await writeFile(application, entry);
execFileSync('desktop-file-validate', [application], { stdio: 'inherit' });
try { execFileSync('update-desktop-database', [applications], { stdio: 'pipe' }); } catch { /* desktops can discover the file directly */ }
let desktopDirectory = join(home, 'Desktop');
try {
  const config = await readFile(join(home, '.config/user-dirs.dirs'), 'utf8');
  const match = config.match(/^XDG_DESKTOP_DIR="([^"\n]+)"$/m);
  if (match) {
    const path = match[1].replace(/^\$HOME(?=\/|$)/, home);
    if (isAbsolute(path)) desktopDirectory = path;
  }
} catch { /* XDG fallback */ }
await mkdir(desktopDirectory, { recursive: true });
const desktopEntry = join(desktopDirectory, 'ticklane-local.desktop');
await writeFile(desktopEntry, entry, { mode: 0o755 });
await chmod(desktopEntry, 0o755);
try { execFileSync('gio', ['set', desktopEntry, 'metadata::trusted', 'true'], { stdio: 'pipe' }); } catch { /* app-menu entry still works; desktop may require Allow Launching */ }
// Remove only entries produced by the old installer, avoiding duplicate icons.
for (const folder of [applications, desktopDirectory]) {
  const legacy = join(folder, 'hoga-ops-local.desktop');
  let previous;
  try { previous = await readFile(legacy, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (previous.includes('\nName=Hoga Ops 로컬\n')
    && previous.includes(`\nExec=${desktopQuote(join(home, '.local/bin/hoga-ops-local'))}\n`)) await rm(legacy);
}
try { execFileSync('update-desktop-database', [applications], { stdio: 'pipe' }); } catch { /* optional cache refresh */ }
console.log(`앱 목록: Ticklane\n바탕화면: ${desktopEntry}\n터미널 명령: ticklane`);
