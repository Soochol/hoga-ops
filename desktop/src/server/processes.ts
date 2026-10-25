import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { userInfo } from 'node:os';

export interface ProcessIdentity {
  pid: number; parent: number; start: string; uid: number; cwd: string; exe: string; args: string[];
}
export interface ExternalProcess {
  root: ProcessIdentity; members: ProcessIdentity[]; user: string;
}
export interface ProcessService { id: 'backend' | 'frontend'; port: number; cwd: string }

// PID alone is unsafe after a confirmation dialog: Linux may reuse it.
export async function readProcess(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const dir = `/proc/${pid}`;
    const [stat, status, cwd, exe, cmdline] = await Promise.all([
      readFile(`${dir}/stat`, 'utf8'), readFile(`${dir}/status`, 'utf8'),
      realpath(`${dir}/cwd`), realpath(`${dir}/exe`), readFile(`${dir}/cmdline`, 'utf8'),
    ]);
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!ids || ids.slice(1).some(id => Number(id) !== process.getuid?.()) || ['Z', 'X'].includes(fields[0])) return;
    return { pid, parent: Number(fields[1]), start: fields[19], uid: Number(ids[1]), cwd, exe,
      args: cmdline.split('\0').filter(Boolean) };
  } catch { return; } // Exited, another user, or /proc access is restricted.
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity | undefined): boolean {
  return Boolean(b && a.pid === b.pid && a.start === b.start && a.uid === b.uid && a.cwd === b.cwd
    && a.exe === b.exe && JSON.stringify(a.args) === JSON.stringify(b.args));
}
async function processes(): Promise<ProcessIdentity[]> {
  const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number);
  const found: ProcessIdentity[] = [];
  // Bound the number of concurrently open /proc files.
  for (let i = 0; i < pids.length; i += 24) {
    found.push(...(await Promise.all(pids.slice(i, i + 24).map(readProcess))).filter((p): p is ProcessIdentity => Boolean(p)));
  }
  return found;
}

async function listenerInodes(port: number): Promise<Set<string>> {
  const tables = await Promise.all(['tcp', 'tcp6'].map(async table => {
    try { return await readFile(`/proc/net/${table}`, 'utf8'); }
    catch (error) { if (table === 'tcp6' && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }));
  const sockets = new Set<string>();
  for (const table of tables) for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || Number.parseInt(fields[1]?.split(':')[1], 16) !== port) continue;
    const address = fields[1].split(':')[0];
    // A public/LAN/Tailscale binding is outside this local manager's authority.
    if (!['0100007F', '00000000000000000000000001000000'].includes(address)) {
      throw new Error('루프백 전용 서버가 아닙니다. 원래 실행기에서 중지해 주세요.');
    }
    sockets.add(fields[9]);
  }
  if (!sockets.size) throw new Error('포트를 사용하는 서버가 바뀌었거나 이미 종료됐습니다. 상태를 새로고침해 주세요.');
  return sockets;
}
async function socketOwners(inodes: Set<string>, all: ProcessIdentity[]): Promise<ProcessIdentity[]> {
  const seen = new Set<string>();
  const owners: ProcessIdentity[] = [];
  for (let i = 0; i < all.length; i += 24) await Promise.all(all.slice(i, i + 24).map(async p => {
    try {
      const dir = `/proc/${p.pid}/fd`;
      const links = await Promise.all((await readdir(dir)).map(fd => readlink(`${dir}/${fd}`).catch(() => '')));
      const matches = links.map(link => /^socket:\[(\d+)\]$/.exec(link)?.[1]).filter((s): s is string => Boolean(s && inodes.has(s)));
      if (matches.length) { owners.push(p); matches.forEach(s => seen.add(s)); }
    } catch { /* Processes may exit while scanning. Missing sockets fail closed below. */ }
  }));
  if (seen.size !== inodes.size) throw new Error('실행 사용자나 포트 점유 프로세스를 확인하지 못했습니다. 원래 실행기에서 중지해 주세요.');
  return owners;
}
function isLauncher(p: ProcessIdentity, service: ProcessService): boolean {
  const args = p.args;
  const names = args.slice(0, 3).map(arg => basename(arg));
  if (service.id === 'backend') {
    const uvicorn = names.includes('uvicorn') || (args[1] === '-m' && args[2] === 'uvicorn');
    const hoga = names.includes('hoga') || (args[1] === '-m' && args[2] === 'hoga');
    const uv = names.includes('uv') && args.includes('run');
    return (uvicorn || uv) && args.includes('hoga.api.app:default_app')
      || (hoga || uv) && args.includes('serve') && args.some(arg => basename(arg) === 'hoga');
  }
  return args.some(arg => resolve(p.cwd, arg) === join(service.cwd, 'node_modules/vite/bin/vite.js')
    || resolve(p.cwd, arg) === join(service.cwd, 'node_modules/.bin/vite'))
    || (names.some(name => ['npm', 'npm-cli.js'].includes(name)) && args.includes('run') && args.includes('dev'))
    || args[0]?.startsWith('npm run dev') === true
    || (['sh', 'dash', 'bash'].includes(names[0]) && args[1] === '-c' && /^vite(?:\s+--[\w-]+(?:[=\s]+[\w.:/-]+)?)*$/.test(args[2] ?? ''));
}
function descendsFrom(p: ProcessIdentity, root: ProcessIdentity, all: ProcessIdentity[]): boolean {
  const seen = new Set<number>();
  let current: ProcessIdentity | undefined = p;
  while (current && !seen.has(current.pid)) {
    if (current.pid === root.pid) return true;
    seen.add(current.pid); current = all.find(candidate => candidate.pid === current!.parent);
  }
  return false;
}
export async function inspectExternal(service: ProcessService): Promise<ExternalProcess> {
  if (process.platform !== 'linux') throw new Error('외부 서버 중지는 Linux에서 지원합니다. 원래 실행기에서 중지해 주세요.');
  const cwd = await realpath(service.cwd);
  const spec = { ...service, cwd };
  const inodes = await listenerInodes(service.port);
  const all = await processes();
  const owners = await socketOwners(inodes, all);
  const candidates: ProcessIdentity[] = [];
  for (const owner of owners) {
    let current: ProcessIdentity | undefined = owner;
    let root: ProcessIdentity | undefined;
    for (let depth = 0; current && current.cwd === cwd && depth < 12; depth++) {
      if (isLauncher(current, spec)) root = current;
      else if (root) break; // Never climb into a terminal, supervisor or arbitrary shell.
      current = all.find(p => p.pid === current!.parent);
    }
    if (!root) throw new Error('같은 프로젝트의 Vite 또는 hoga 서버로 확인되지 않았습니다. 원래 실행기에서 중지해 주세요.');
    candidates.push(root);
  }
  const root = candidates[0];
  if (!root || candidates.some(p => p.pid !== root.pid)) throw new Error('여러 실행기가 포트를 공유하고 있습니다. 원래 실행기에서 중지해 주세요.');
  const cgroup = await readFile(`/proc/${root.pid}/cgroup`, 'utf8');
  if (cgroup.trim().split('\n').some(line => /\.service$/.test(line) && !/\/user@\d+\.service$/.test(line))) {
    throw new Error('서비스 관리자가 실행한 서버입니다. 해당 서비스 관리자에서 중지해 주세요.');
  }
  const members = [root, ...all.filter(p => p.pid !== root.pid && descendsFrom(p, root, all))];
  if (members.length > 256 || members.some(p => p.pid === process.pid)) throw new Error('종료할 프로세스 범위를 안전하게 확인하지 못했습니다.');
  if (!sameProcess(root, await readProcess(root.pid))) throw new Error('확인 중 실행 정보가 바뀌었습니다. 다시 시도해 주세요.');
  return { root, members, user: `${userInfo().username} (${root.uid})` };
}

export async function survivingProcesses(members: ProcessIdentity[]): Promise<ProcessIdentity[]> {
  return (await Promise.all(members.map(async p => sameProcess(p, await readProcess(p.pid)) ? p : undefined)))
    .filter((p): p is ProcessIdentity => Boolean(p));
}
export async function signalProcesses(members: ProcessIdentity[], signal: NodeJS.Signals): Promise<void> {
  // Signal the launcher first so uvicorn --reload/npm cannot respawn its listener.
  for (const p of members) {
    if (!sameProcess(p, await readProcess(p.pid))) continue;
    try { process.kill(p.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
