import { useTabsStore } from '../state/tabs';
import TabStrip from '../replay/TabStrip';
import Toolbar from '../replay/Toolbar';
import PriceStrip from '../replay/PriceStrip';
import OnboardingCard from '../replay/OnboardingCard';

export default function ReplayViewer() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  return (
    <div className="grid grid-rows-[40px_60px_52px_1fr] h-full min-h-0 min-w-0">
      <TabStrip />
      <Toolbar />
      <PriceStrip />
      <div className="bg-bg min-h-0 overflow-hidden">
        {active.status !== 'loaded' ? <OnboardingCard tab={active} /> : <Workarea />}
      </div>
    </div>
  );
}

function Workarea() {
  // Phase 6+: ChartStage + CursorSidebar
  return <div className="grid place-items-center h-full text-fg-dim">Workarea — Phase 6</div>;
}
