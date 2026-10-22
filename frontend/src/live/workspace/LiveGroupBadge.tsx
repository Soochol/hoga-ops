import { useMemo } from 'react';
import { GroupBadge, type GroupBadgeProps } from '../../workspace/GroupBadge';
import { useWorkspaceStore } from '../../state/workspace';

export function LiveGroupBadge(props: GroupBadgeProps) {
  const symbols = useWorkspaceStore(state => state.groupSymbols);
  // Geometry changes do not rerender the palette while a window is dragged.
  const membership = useWorkspaceStore(state => state.windows.map(window => window.group).join(','));
  const descriptions = useMemo(() => {
    const counts = new Map<number, number>();
    for (const group of membership.split(',').filter(Boolean).map(Number)) counts.set(group, (counts.get(group) ?? 0) + 1);
    return Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
      const group = index + 1;
      return [group, `${symbols[group as GroupBadgeProps['group']]?.name ?? '종목 없음'} · ${counts.get(group) ?? 0}개 창`];
    }));
  }, [symbols, membership]);
  return <GroupBadge {...props} title={null} descriptions={descriptions} />;
}
