import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const desktopQuote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--project-root')) throw new Error('사용법: npm run install:server -- [--project-root /absolute/project/path]');
if (args.length && !isAbsolute(args[1])) throw new Error('프로젝트 경로는 절대 경로여야 합니다.');
const project = args.length ? resolve(args[1]) : fileURLToPath(new URL('../../', import.meta.url));
const desktop = fileURLToPath(new URL('../', import.meta.url));
const binary = join(desktop, 'node_modules/electron/dist/electron');
await access(join(project, 'pyproject.toml'));
await access(join(project, 'frontend/package.json'));
await access(binary, constants.X_OK);
await access(join(desktop, 'dist/bootstrap.cjs'));

async function executable(name) {
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = resolve(folder, name);
    try { await access(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  throw new Error(`${name} 실행 파일을 찾지 못했습니다. 설치 후 다시 등록하세요.`);
}
const npm = await executable('npm');
const uv = await executable('uv');
const home = homedir();
const bin = join(home, '.local/bin');
const library = join(home, '.local/lib/ticklane');
const state = join(home, '.local/state/ticklane');
const applications = join(home, '.local/share/applications');
const icons = join(home, '.local/share/icons/hicolor/256x256/apps');
let desktopDirectory = join(home, 'Desktop');
try {
  const config = await readFile(join(home, '.config/user-dirs.dirs'), 'utf8');
  const match = config.match(/^XDG_DESKTOP_DIR="([^"\n]+)"$/m);
  if (match) {
    const path = match[1].replace(/^\$HOME(?=\/|$)/, home);
    if (isAbsolute(path)) desktopDirectory = path;
  }
} catch { /* XDG fallback */ }
for (const folder of [bin, library, state, applications, desktopDirectory, icons]) await mkdir(folder, { recursive: true });
const icon = join(icons, 'ticklane-server-v3.png');
await copyFile(join(desktop, 'assets/server-icon.png'), icon);
const config = join(library, 'servers.json');
await writeFile(config, JSON.stringify({ project, uv, npm, node: process.execPath }, null, 2) + '\n', { mode: 0o600 });
const launcher = join(bin, 'ticklane-server');
const command = [binary, desktop, '--server-manager', `--server-config=${config}`].map(quote).join(' ');
await writeFile(launcher, `#!/bin/sh
set -eu
umask 077
unset ELECTRON_RUN_AS_NODE
export HOGA_SERVER_MANAGER_USER_DATA=${quote(join(home, '.config/ticklane-server'))}
export HOGA_DESKTOP_USER_DATA=${quote(join(home, '.config/hoga-ops-local-dev'))}
export PATH=${quote(dirname(process.execPath))}:"$PATH"
if { [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; } && command -v setsid >/dev/null 2>&1; then
  setsid -f ${command} < /dev/null >> ${quote(join(state, 'server-manager-launch.log'))} 2>&1
  exit 0
fi
exec ${command} >> ${quote(join(state, 'server-manager-launch.log'))} 2>&1
`, { mode: 0o755 });
await chmod(launcher, 0o755);
const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Ticklane 서버
Comment=로컬 프론트엔드·백엔드 시작 및 중지·상태·로그 관리
Exec=${desktopQuote(launcher)}
Icon=${icon}
Terminal=false
Categories=Development;
Keywords=ticklane;틱레인;서버;관리;frontend;backend;server;
StartupNotify=true
StartupWMClass=ticklane-server
`;
const application = join(applications, 'ticklane-server.desktop');
const shortcut = join(desktopDirectory, 'ticklane-server.desktop');
await writeFile(application, entry);
execFileSync('desktop-file-validate', [application], { stdio: 'inherit' });
await writeFile(shortcut, entry, { mode: 0o755 });
await chmod(shortcut, 0o755);
try { execFileSync('gio', ['set', shortcut, 'metadata::trusted', 'true'], { stdio: 'pipe' }); } catch { /* app menu remains available */ }

// Remove only the separate server shortcuts created by the earlier installer.
for (const [component, label] of [['frontend', '프론트엔드'], ['backend', '백엔드']]) {
  const oldLauncher = join(bin, `ticklane-${component}`);
  for (const folder of [applications, desktopDirectory]) {
    const oldEntry = join(folder, `ticklane-${component}.desktop`);
    try {
      const previous = await readFile(oldEntry, 'utf8');
      if (previous.includes(`\nName=Ticklane ${label}\n`) && previous.includes(`\nExec=${desktopQuote(oldLauncher)}\n`)) await rm(oldEntry);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    if ((await readFile(oldLauncher, 'utf8')).includes(join(library, 'run-local-server.sh'))) await rm(oldLauncher);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
try { execFileSync('update-desktop-database', [applications], { stdio: 'pipe' }); } catch { /* optional cache refresh */ }
console.log(`등록: Ticklane 서버\n명령: ticklane-server\n바탕화면: ${shortcut}\n소스 경로: ${project}\nElectron 앱은 기존 Ticklane 아이콘으로 별도 실행합니다.`);
