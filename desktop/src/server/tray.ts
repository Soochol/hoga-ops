import { dialog, Menu, nativeImage, Tray } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions, NativeImage } from 'electron';
import { join } from 'node:path';
import type { ServerSnapshot, StopPlan } from './controller';

interface TrayActions {
  showWindow: () => void;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  prepareStop: () => Promise<StopPlan>;
  confirmStop: (token: string) => Promise<unknown>;
  openClient: () => Promise<unknown>;
  openLogs: () => Promise<unknown>;
  quit: () => Promise<unknown>;
}
const labels: Record<ServerSnapshot['phase'], string> = {
  checking: '상태 확인 중', stopped: '중지됨', starting: '시작 중', stopping: '중지 중', running: '실행 중', error: '확인 필요',
};
type IconState = 'running' | 'stopped' | 'busy' | 'error';

export class ServerTray {
  private readonly tray: Tray;
  private readonly icons = new Map<IconState, NativeImage>();
  private current: ServerSnapshot;
  private signature = '';
  private confirmingStop = false;
  private destroyed = false;

  constructor(private readonly window: BrowserWindow, private readonly actions: TrayActions, initial: ServerSnapshot) {
    this.current = initial;
    for (const state of ['running', 'stopped', 'busy', 'error'] as const) {
      const path = join(__dirname, `../../assets/server-tray-${state}`);
      const icon = nativeImage.createFromPath(`${path}.png`);
      if (icon.isEmpty()) throw new Error(`트레이 아이콘을 읽지 못했습니다: ${state}`);
      const retina = nativeImage.createFromPath(`${path}@2x.png`);
      if (!retina.isEmpty()) icon.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG() });
      this.icons.set(state, icon);
    }
    this.tray = new Tray(this.icons.get('busy')!);
    this.tray.on('click', actions.showWindow);
    this.tray.on('double-click', actions.showWindow);
    try { this.update(initial); }
    catch (error) { this.tray.destroy(); throw error; }
  }

  update(snapshot: ServerSnapshot): void {
    if (this.destroyed) return;
    this.current = snapshot;
    // Log/status polling must not rebuild an open native menu on every message.
    const signature = JSON.stringify([snapshot.phase, snapshot.canStart, snapshot.canStop, snapshot.action,
      snapshot.services.map(service => [service.id, service.phase, service.owner]), this.confirmingStop]);
    if (this.signature === signature) return;
    const external = snapshot.services.some(service => service.owner === 'external');
    const suffix = external ? ' · 외부 실행 포함' : '';
    const title = `Ticklane 서버 · ${labels[snapshot.phase]}${suffix}`;
    const iconState: IconState = snapshot.phase === 'running' || snapshot.phase === 'stopped' || snapshot.phase === 'error' ? snapshot.phase : 'busy';
    this.tray.setImage(this.icons.get(iconState)!);
    this.tray.setToolTip(title);
    const items: MenuItemConstructorOptions[] = [
      { label: title, enabled: false },
      { type: 'separator' },
      { id: 'show', label: '관리 창 열기', click: this.actions.showWindow },
      { id: 'client', label: 'Ticklane 열기', enabled: snapshot.phase === 'running', click: () => {
        if (this.current.phase === 'running') this.run(this.actions.openClient);
      } },
      { type: 'separator' },
      { id: 'start', label: '서버 시작', enabled: snapshot.canStart, click: () => {
        if (this.current.canStart) this.run(this.actions.start);
      } },
      { id: 'stop', label: snapshot.action === 'starting' ? '시작 취소' : '서버 중지', enabled: snapshot.canStop && !this.confirmingStop,
        click: () => { this.run(() => this.stop()); } },
    ];
    if (external) items.push({ label: '외부 서버는 실행 정보 확인 후 중지합니다', enabled: false });
    items.push(
      { id: 'logs', label: '로그 폴더 열기', click: () => { this.run(this.actions.openLogs); } },
      { type: 'separator' },
      { id: 'quit', label: '관리 앱 종료…', click: () => { this.run(this.actions.quit); } },
    );
    // Linux requires assigning the context menu again after its items change.
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.signature = signature;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tray.removeAllListeners();
    this.tray.destroy();
  }

  private run(action: () => Promise<unknown>): void {
    if (this.destroyed) return;
    void Promise.resolve().then(action).catch(async error => {
      if (this.destroyed || this.window.isDestroyed()) return;
      this.actions.showWindow();
      await dialog.showMessageBox(this.window, { type: 'error', title: 'Ticklane 서버', message: '작업을 완료하지 못했습니다.',
        detail: error instanceof Error ? error.message : String(error), buttons: ['확인'] });
    }).catch(error => console.error('트레이 작업 오류:', error));
  }

  private async stop(): Promise<void> {
    if (!this.current.canStop || this.confirmingStop) return;
    if (this.current.action === 'starting') { await this.actions.stop(); return; }
    this.confirmingStop = true;
    this.update(this.current);
    this.actions.showWindow();
    try {
      const plan = await this.actions.prepareStop();
      const targets = plan.targets.map(t => `${t.label} · localhost:${t.port} · ${t.owner === 'external' ? '외부 실행' : '앱에서 실행'}\nPID ${t.pid} · ${t.user}\n${t.cwd}\n${t.command}`).join('\n\n');
      const blocked = plan.blocked.map(t => `${t.label}: ${t.reason}`).join('\n');
      const result = await dialog.showMessageBox(this.window, { type: 'question', title: 'Ticklane 서버',
        message: plan.targets.length ? '확인한 로컬 서버를 중지할까요?' : '중지할 서버를 확인하지 못했습니다.',
        detail: `${targets}\n\n${blocked ? `중지할 수 없는 서버\n${blocked}\n\n` : ''}연결된 Ticklane의 조회·수집·주문 처리가 중단됩니다.`,
        buttons: plan.targets.length ? ['서버 중지', '계속 실행'] : ['확인'], defaultId: plan.targets.length ? 1 : 0, cancelId: plan.targets.length ? 1 : 0 });
      if (plan.targets.length && result.response === 0 && this.current.canStop) await this.actions.confirmStop(plan.token);
    } finally { this.confirmingStop = false; this.update(this.current); }
  }
}
