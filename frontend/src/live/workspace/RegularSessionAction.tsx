import type { WorkspaceWindow } from '../../state/workspace';
import { useWorkspaceStore } from '../../state/workspace';
import { IconToolbarButton } from '../../ui/WorkspaceShell';

export function RegularSessionAction({ win, disabled = false, showLabel = true }: {
  win: WorkspaceWindow; disabled?: boolean; showLabel?: boolean;
}) {
  const active = !disabled && (win.chart?.regularSessionOnly ?? false);
  return <IconToolbarButton aria-label="정규장만 보기" aria-pressed={active} disabled={disabled}
    title={disabled ? '정규장만 보기 — 분봉·초봉에서 사용할 수 있습니다' : '정규장만 보기 — 09:00–15:30 KST'}
    className="aria-pressed:text-accent"
    onClick={() => useWorkspaceStore.getState().setChartRegularSessionOnly(win.id, !active)}
    icon={<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" />
    </svg>}>
    {showLabel && '정규장'}
  </IconToolbarButton>;
}
