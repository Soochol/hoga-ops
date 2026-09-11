import { snapshotWorkspace, useWorkspaceStore, WORKSPACE_SCHEMA_VERSION } from '../state/workspace';
import { stageWorkspaceTransfer } from '../state/workspaceTransfer';

/** 호출한 탭의 현재 배치를 캡처한다. snapshotWorkspace가 핀 종목과 런타임을 제외한다. */
export function openWorkspaceInNewTab(path: string): void {
  const state = useWorkspaceStore.getState();
  const url = stageWorkspaceTransfer(path, {
    ...snapshotWorkspace(),
    schema_version: state.pendingNormalize ? 1 : WORKSPACE_SCHEMA_VERSION,
    groupSymbols: state.groupSymbols,
  });
  window.open(url, '_blank', 'noopener');
}
