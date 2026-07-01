import type { LiveTab } from '../state/liveTabs';
import { ChartTabBar } from '../tabs/ChartTabBar';
import { LiveTabOverflowMenu } from './LiveTabOverflowMenu';
import { formatLiveViewLabel } from './liveViewLabel';

interface Props {
  tabs: LiveTab[];
  activeTabId: string | null;
  /** 활성 탭의 차트 데이터 로딩 중 여부 (상태점). */
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void; // Task 8 드래그 핸들러가 사용
  onNewTab: () => void;
  onTogglePin?: (id: string) => void;
}

export function LiveTabBar({ tabs, activeTabId, activeLoading, onFocus, onClose, onReorder, onNewTab, onTogglePin }: Props) {
  return (
    <ChartTabBar
      tabs={tabs}
      activeTabId={activeTabId}
      activeLoading={activeLoading}
      onFocus={onFocus}
      onClose={onClose}
      onReorder={onReorder}
      onTogglePin={onTogglePin}
      renderLabel={(tab) => formatLiveViewLabel(tab.label, tab.timeframe)}
      newTabButton={{ ariaLabel: '새 탭', onClick: onNewTab }}
      trailingActions={<LiveTabOverflowMenu tabs={tabs} activeTabId={activeTabId} onFocus={onFocus} onClose={onClose} />}
    />
  );
}
