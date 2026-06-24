import type { StudyTab } from '../state/studyTabs';
import { ChartTabBar } from '../tabs/ChartTabBar';

type Props = {
  tabs: StudyTab[];
  activeTabId: string | null;
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onNewTab: () => void;
};

export function StudyTabBar({ tabs, activeTabId, activeLoading, onFocus, onClose, onReorder, onNewTab: _onNewTab }: Props) {
  return (
    <ChartTabBar
      tabs={tabs}
      activeTabId={activeTabId}
      activeLoading={activeLoading}
      onFocus={onFocus}
      onClose={onClose}
      onReorder={onReorder}
      renderLabel={(tab) => tab.label}
      newTabButton={null}
    />
  );
}
