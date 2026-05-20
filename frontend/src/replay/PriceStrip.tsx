import { useTabsStore } from '../state/tabs';

export default function PriceStrip() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  if (active.status !== 'loaded') {
    return <div className="h-[52px] bg-bg-subtle border-b" />;
  }
  // Viewport-tracked current price wired in Task 6.5 once ChartStage exposes
  // the right-edge timestamp via timeScale().subscribeVisibleTimeRangeChange.
  return (
    <div className="flex items-center gap-4 px-4 bg-bg-subtle border-b h-[52px]">
      <span className="font-mono text-sm">{active.selection?.code}</span>
      <span className="text-lg font-semibold text-fg-dim">—</span>
    </div>
  );
}
