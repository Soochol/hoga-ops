import TabStrip from '../replay/TabStrip';

export default function ReplayViewer() {
  return (
    <div className="grid grid-rows-[40px_60px_52px_1fr] h-full min-h-0 min-w-0">
      <TabStrip />
      <div className="bg-bg-card border-b" /> {/* Toolbar slot (Task 5.1) */}
      <div className="bg-bg-subtle border-b" /> {/* PriceStrip slot (Task 5.3) */}
      <div className="bg-bg" /> {/* Workarea slot (Phase 6+) */}
    </div>
  );
}
