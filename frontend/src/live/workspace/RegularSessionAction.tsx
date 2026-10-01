import type { WorkspaceWindow } from '../../state/workspace';
import { useWorkspaceStore } from '../../state/workspace';

export function RegularSessionAction({ win, disabled = false }: { win: WorkspaceWindow; disabled?: boolean }) {
  return <label className="flex items-center gap-2 px-2 py-1 text-sm text-fg">
    <input type="checkbox" aria-label="정규장만 보기" checked={!disabled && (win.chart?.regularSessionOnly ?? false)}
      disabled={disabled} onChange={event => useWorkspaceStore.getState().setChartRegularSessionOnly(win.id, event.currentTarget.checked)} />
    <span title={disabled ? '분봉·초봉에서 사용할 수 있습니다' : '09:00–15:30 KST'}>정규장만 보기</span>
  </label>;
}
