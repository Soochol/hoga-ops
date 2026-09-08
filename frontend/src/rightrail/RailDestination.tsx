import { activationTarget, useWorkspaceStore } from '../state/workspace';

/** The click destination is derived from the same pinned-window rule as navigation. */
export function RailDestination() {
  const description = useWorkspaceStore((state) => {
    const target = activationTarget(state);
    if (target.kind === 'blocked') return '연결 대상 없음 · 창 고정을 해제하세요';
    if (target.kind === 'empty') return '연결 대상: 그룹 1 · 창 추가 후 표시';
    const group = target.window.group;
    const count = state.windows.filter((win) => win.group === group && !win.pinned).length;
    return `연결 대상: 그룹 ${group} · 창 ${count}개`;
  });
  return <p className="px-md py-1 text-xs text-fg-dim" role="status"
    title="종목 클릭 시 변경할 차트 연결 그룹 · 고정 창 제외 · 직접 드래그하면 놓은 창에 적용">
    {description}
  </p>;
}
