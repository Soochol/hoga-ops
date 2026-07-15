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
  onTogglePin?: (id: string) => void;
  /** 탭 바 거터 배경. 기본은 ChartTabBar 기본값(--bg-subtle). 부유 카드 모델에선 --bg 전달. */
  background?: string;
};

export function StudyTabBar({ tabs, activeTabId, activeLoading, tabStatuses, onFocus, onClose, onReorder, onNewTab: _onNewTab, onTogglePin, background }: Props) {
  return (
    <ChartTabBar
      tabs={tabs}
      activeTabId={activeTabId}
      activeLoading={activeLoading}
      onFocus={onFocus}
      onClose={onClose}
      onReorder={onReorder}
      onTogglePin={onTogglePin}
      renderLabel={(tab) => tab.label}
      tabStatus={(tab, active) => tabStatuses?.[tab.id] ?? (active && activeLoading ? 'loading' : active ? 'ready' : 'idle')}
      newTabButton={null}
      background={background}
    />
  );
}
