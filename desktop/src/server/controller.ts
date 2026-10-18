import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

type ServiceId = 'backend' | 'frontend';
type Phase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export interface ServerConfig { project: string; uv: string; npm: string; node: string; ports: { backend: number; frontend: number } }
interface Service { id: ServiceId; label: string; port: number; path: string; tool: string; dependency: string; cwd: string; args: string[] }
interface ServiceState { id: ServiceId; label: string; port: number; phase: Phase; owner: 'managed' | 'external' | null; message: string }
export interface ServerSnapshot {
  phase: Phase | 'checking';
  project: string; services: ServiceState[]; action: 'starting' | 'stopping' | null;
  message: string; canStart: boolean; canStop: boolean; logs: string[];
}
interface OwnedProcess { child: ChildProcess; done: Promise<void> }

export async function readServerConfig(path: string): Promise<ServerConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('서버 실행 설정이 올바르지 않습니다.');
  const value = raw as Record<string, unknown>;
  if (value.ports !== undefined && (!value.ports || typeof value.ports !== 'object' || Array.isArray(value.ports))) throw new Error('서버 포트 설정이 올바르지 않습니다.');
  const ports = value.ports as Record<string, unknown> | undefined;
  const backend = ports?.backend ?? 8000; const frontend = ports?.frontend ?? 5173;
  if (![value.project, value.uv, value.npm, value.node].every(v => typeof v === 'string' && isAbsolute(v) && !/[\r\n\0]/.test(v))
    || ![backend, frontend].every(p => typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536) || backend === frontend) {
    throw new Error('서버 실행 설정을 확인할 수 없습니다. 바로가기를 다시 등록하세요.');
  }
  return { project: value.project as string, uv: value.uv as string, npm: value.npm as string, node: value.node as string,
    ports: { backend: backend as number, frontend: frontend as number } };
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (['ECONNREFUSED', 'EAFNOSUPPORT', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(error.code ?? '')) resolve(false);
      else reject(error);
    });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('로컬 포트 확인 시간이 초과됐습니다.')); });
  });
}

export class ServerController extends EventEmitter {
  private readonly services: Service[];
  private readonly states: ServiceState[];
  private readonly owned = new Map<ServiceId, OwnedProcess>();
  private readonly expected = new Set<ServiceId>();
  private readonly errors = new Map<ServiceId, string>();
  private readonly logs: string[];
  private action: ServerSnapshot['action'] = null;
  private message = '서버 상태를 확인하고 있습니다.';
  private operation: Promise<void> | undefined;
  private startingAbort: AbortController | undefined;
  private stoppingOperation: Promise<ServerSnapshot> | undefined;
  private failure = '';
  private revision = 0;
  private refreshing = false;
  private checked = false;
  private monitor: NodeJS.Timeout | undefined;
  private notification: NodeJS.Timeout | undefined;

  constructor(readonly config: ServerConfig, readonly logPath: string) {
    super();
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    this.rotateLog();
    this.logs = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-300) : [];
    const { project, ports } = config;
    this.services = [
      { id: 'backend', label: '백엔드', port: ports.backend, path: '/health', tool: config.uv,
        cwd: project, dependency: join(project, '.venv/bin/python'),
        args: ['run', '--frozen', 'uvicorn', 'hoga.api.app:default_app', '--factory', '--host', '127.0.0.1', '--port', String(ports.backend), '--reload', '--reload-dir', 'hoga'] },
      { id: 'frontend', label: '프론트엔드', port: ports.frontend, path: '/@vite/client', tool: config.npm,
        cwd: join(project, 'frontend'), dependency: join(project, 'frontend/node_modules/vite/bin/vite.js'),
        args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(ports.frontend), '--strictPort'] },
    ];
    this.states = this.services.map(s => ({ id: s.id, label: s.label, port: s.port, phase: 'stopped', owner: null, message: '확인 중' }));
    this.log('관리', 'Ticklane 서버 관리 창을 열었습니다.');
  }

  get hasOwnedServers(): boolean { return this.owned.size > 0 || this.action === 'starting'; }
  snapshot(): ServerSnapshot {
    const running = this.states.every(s => s.phase === 'running');
    const phase = this.action ?? (running ? 'running' : this.failure || this.errors.size || this.states.some(s => s.phase === 'error') ? 'error' : this.checked ? 'stopped' : 'checking');
    return { phase, project: this.config.project, services: this.states.map(s => ({ ...s })), action: this.action,
      message: this.failure || this.errors.values().next().value || this.message,
      canStart: !this.action && this.checked && !running,
      canStop: this.hasOwnedServers && this.action !== 'stopping', logs: [...this.logs] };
  }
  startMonitoring(): void {
    void this.refresh();
    this.monitor ??= setInterval(() => { void this.refresh(); }, 3000).unref();
  }
  dispose(): void { clearInterval(this.monitor); clearTimeout(this.notification); this.removeAllListeners(); }
  private changed(): void {
    this.notification ??= setTimeout(() => { this.notification = undefined; this.emit('change', this.snapshot()); }, 80).unref();
  }
  private rotateLog(): void {
    if (existsSync(this.logPath) && statSync(this.logPath).size > 5 * 1024 * 1024) renameSync(this.logPath, `${this.logPath}.1`);
  }
  private log(label: string, text: string): void {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const entry = `${new Date().toISOString()} [${label}] ${line.slice(0, 4000)}`;
      this.logs.push(entry);
      if (this.logs.length > 300) this.logs.shift();
      try { this.rotateLog(); appendFileSync(this.logPath, `${entry}\n`, { mode: 0o600 }); }
      catch { this.message = '로그 파일을 저장하지 못했습니다. 저장 공간을 확인하세요.'; }
    }
    this.changed();
  }
  private state(id: ServiceId): ServiceState { return this.states.find(s => s.id === id)!; }
  private async healthy(service: Service): Promise<boolean> {
    const results = await Promise.all(['127.0.0.1', '[::1]'].map(async host => {
      try {
        const response = await fetch(`http://${host}:${service.port}${service.path}`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (!response.ok) return false;
        if (service.id === 'backend') {
          const value = await response.json() as { status?: unknown; version?: unknown };
          return value.status === 'ok' && typeof value.version === 'string';
        }
        return Boolean(response.headers.get('content-type')?.includes('javascript')) && (await response.text()).includes('createHotContext');
      } catch { return false; }
    }));
    return results.some(Boolean);
  }
  private async probe(service: Service): Promise<{ busy: boolean; healthy: boolean }> {
    const busy = (await Promise.all(['127.0.0.1', '::1'].map(host => listening(host, service.port)))).some(Boolean);
    return { busy, healthy: busy && await this.healthy(service) };
  }
  async refresh(): Promise<ServerSnapshot> {
    if (this.action || this.refreshing) return this.snapshot();
    this.refreshing = true;
    const revision = this.revision;
    try {
      const results = await Promise.all(this.services.map(s => this.probe(s)));
      if (this.action || revision !== this.revision) return this.snapshot();
      this.checked = true;
      for (const [i, result] of results.entries()) {
        const state = this.states[i];
        state.owner = this.owned.has(state.id) ? 'managed' : result.busy ? 'external' : null;
        state.phase = result.healthy ? 'running' : result.busy || this.errors.has(state.id) ? 'error' : 'stopped';
        state.message = result.healthy ? state.owner === 'managed' ? '이 관리 창에서 실행' : '다른 곳에서 실행 중' :
          result.busy ? '포트 사용 중 · 응답 확인 필요' : this.errors.get(state.id) ?? '시작할 수 있습니다.';
      }
      if (!this.errors.size && !this.failure) this.message = results.every(r => r.healthy) ? '서버가 준비됐습니다. Ticklane 앱을 열어 사용하세요.' : '서버 시작 버튼으로 프론트엔드와 백엔드를 함께 켜세요.';
    } catch (error) { this.message = error instanceof Error ? error.message : '서버 상태를 확인하지 못했습니다.'; }
    finally { this.refreshing = false; this.changed(); }
    return this.snapshot();
  }

  private spawnService(service: Service): void {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(this.config.node)}:${process.env.PATH ?? ''}` };
    if (service.id === 'frontend') env.E2E_API_URL = `http://localhost:${this.config.ports.backend}`;
    const child = spawn(service.tool, service.args, { cwd: service.cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    this.owned.set(service.id, { child, done });
    Object.assign(this.state(service.id), { phase: 'starting', owner: 'managed', message: '서버를 시작하고 있습니다.' });
    this.log(service.label, '시작 요청');
    for (const output of [child.stdout, child.stderr]) {
      if (output) createInterface({ input: output }).on('line', line => this.log(service.label, line));
    }
    child.once('error', error => { this.errors.set(service.id, error.message); this.log(service.label, `실행 실패: ${error.message}`); });
    child.once('close', (code, signal) => {
      this.owned.delete(service.id);
      const expected = this.expected.delete(service.id);
      const message = expected ? '서버를 중지했습니다.' : `서버가 종료됐습니다 (${signal ?? code}). 로그를 확인하세요.`;
      if (!expected) this.errors.set(service.id, message);
      Object.assign(this.state(service.id), { phase: expected ? 'stopped' : 'error', owner: null, message });
      this.log(service.label, message);
      finished();
    });
  }
  private async terminate(ids = [...this.owned.keys()]): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const id of ids) {
      const owned = this.owned.get(id);
      if (!owned) continue;
      this.expected.add(id);
      Object.assign(this.state(id), { phase: 'stopping', message: '서버의 작업 정리를 기다리고 있습니다.' });
      pending.push(owned.done);
      if (owned.child.pid) {
        try {
          if (process.platform === 'win32') owned.child.kill('SIGTERM');
          else process.kill(-owned.child.pid, 'SIGTERM');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.log('관리', String(error)); }
      }
    }
    this.changed();
    await Promise.all(pending);
  }
  async start(): Promise<ServerSnapshot> {
    if (this.stoppingOperation) return this.stoppingOperation;
    if (this.operation) { await this.operation; return this.snapshot(); }
    this.action = 'starting'; this.revision++; this.startingAbort = new AbortController();
    this.message = '서버를 준비하고 있습니다.'; this.failure = ''; this.errors.clear(); this.changed();
    this.operation = this.performStart().finally(() => { this.operation = undefined; this.action = null; this.changed(); });
    await this.operation;
    return this.snapshot();
  }
  private async performStart(): Promise<void> {
    const staged: ServiceId[] = [];
    try {
      const probes = await Promise.all(this.services.map(s => this.probe(s)));
      for (const [i, result] of probes.entries()) {
        const service = this.services[i];
        if (result.busy && !result.healthy) throw new Error(`${service.label} ${service.port} 포트가 사용 중입니다. 기존 프로그램을 확인하세요.`);
        if (result.healthy) {
          Object.assign(this.state(service.id), { phase: 'running', owner: this.owned.has(service.id) ? 'managed' : 'external', message: this.owned.has(service.id) ? '이 관리 창에서 실행' : '다른 곳에서 실행 중' });
        } else {
          try { await access(service.dependency); await access(service.tool); }
          catch (error) { this.log(service.label, String(error)); throw new Error(`${service.label} 실행 환경을 찾지 못했습니다. 프로젝트의 의존성과 실행기 등록을 확인하세요.`, { cause: error }); }
        }
      }
      if (this.startingAbort?.signal.aborted) throw new Error('시작을 취소했습니다.');
      for (const [i, result] of probes.entries()) if (!result.healthy) { staged.push(this.services[i].id); this.spawnService(this.services[i]); }
      const deadline = Date.now() + 60_000;
      while (true) {
        if (this.startingAbort?.signal.aborted) throw new Error('시작을 취소했습니다.');
        if (staged.some(id => !this.owned.has(id) || this.errors.has(id))) throw new Error('서버를 시작하지 못했습니다. 아래 로그를 확인하세요.');
        const results = await Promise.all(this.services.map(s => this.healthy(s)));
        if (results.every(Boolean)) break;
        if (Date.now() > deadline) throw new Error('서버 준비 시간이 초과됐습니다. 아래 로그를 확인하세요.');
        await delay(300, undefined, { signal: this.startingAbort?.signal });
      }
      for (const state of this.states) Object.assign(state, { phase: 'running', owner: this.owned.has(state.id) ? 'managed' : 'external', message: this.owned.has(state.id) ? '이 관리 창에서 실행' : '다른 곳에서 실행 중' });
      this.message = '서버가 준비됐습니다. Ticklane 앱을 열어 사용하세요.';
      this.log('관리', '프론트엔드와 백엔드 준비 완료');
    } catch (error) {
      const cancelled = this.startingAbort?.signal.aborted;
      this.message = cancelled ? '서버 시작을 취소했습니다.' : error instanceof Error ? error.message : '서버를 시작하지 못했습니다.';
      if (!cancelled) this.failure = this.message;
      this.log('관리', this.message);
      await this.terminate(staged);
    }
  }
  stop(): Promise<ServerSnapshot> {
    if (this.stoppingOperation) return this.stoppingOperation;
    this.startingAbort?.abort();
    this.stoppingOperation = this.performStop().finally(() => { this.stoppingOperation = undefined; });
    return this.stoppingOperation;
  }
  private async performStop(): Promise<ServerSnapshot> {
    await this.operation;
    this.action = 'stopping'; this.revision++;
    this.message = '이 관리 창에서 시작한 서버를 중지하고 있습니다.'; this.changed();
    this.operation = this.terminate().finally(() => {
      this.operation = undefined; this.action = null;
      this.failure = '';
      this.errors.clear();
      this.message = '관리 중인 서버를 중지했습니다. 다른 곳에서 실행한 서버는 유지됩니다.'; this.changed();
    });
    await this.operation;
    return this.refresh();
  }
}
