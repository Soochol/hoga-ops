import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { IconToolbarButton } from '../../ui/WorkspaceShell';

export function CursorLinkAction({ win, showLabel = false }: { win: WorkspaceWindow; showLabel?: boolean }) {
  const enabled = win.chart?.hoverLinked ?? true;
  return <IconToolbarButton aria-label="호버 연동" aria-pressed={enabled}
    title={`커서 연동 ${enabled ? '끄기' : '켜기'} — 연결된 데이터 창이 분봉·초봉 커서 시점을 따라갑니다`}
    onClick={() => useWorkspaceStore.getState().setChartHoverLinked(win.id, !enabled)}
    className="aria-pressed:text-accent" icon={<span aria-hidden>↔</span>}>
    {showLabel && '커서 연동'}
  </IconToolbarButton>;
}
