import type { StudyTab } from '../state/studyTabs';
import { ChartTabBar, type ChartTabStatus } from '../tabs/ChartTabBar';

type Props = {
  tabs: StudyTab[];
  activeTabId: string | null;
  activeLoading: boolean;
  tabStatuses?: Record<string, ChartTabStatus>;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onNewTab: () => void;
};

export function StudyTabBar({ tabs, activeTabId, activeLoading, tabStatuses, onFocus, onClose, onReorder, onNewTab: _onNewTab }: Props) {
  return (
    <ChartTabBar
      tabs={tabs}
      activeTabId={activeTabId}
      activeLoading={activeLoading}
      onFocus={onFocus}
      onClose={onClose}
      onReorder={onReorder}
      renderLabel={(tab) => tab.label}
      tabStatus={(tab, active) => tabStatuses?.[tab.id] ?? (active && activeLoading ? 'loading' : active ? 'ready' : 'idle')}
      newTabButton={null}
    />
  );
}
