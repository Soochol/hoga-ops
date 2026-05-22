import type { Tab as TabModel } from '../state/tabs';

export default function Tab({
  tab,
  isActive,
  isLast,
  onActivate,
  onClose,
}: {
  tab: TabModel;
  isActive: boolean;
  isLast: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onActivate}
      className={`tab ${isActive ? 'active' : ''} relative flex items-center gap-2 h-8 px-3.5 -mb-px rounded-t cursor-pointer border ${
        isActive ? 'bg-bg-card z-10 border-b-transparent' : 'bg-bg-input text-fg-dim'
      }`}
    >
      {isActive && <span className="absolute top-0 inset-x-0 h-0.5 bg-accent rounded-t" />}
      <TabStatusDot status={tab.status} />
      <span className="tab-code font-mono text-sm text-accent">{tab.selection?.code ?? '—'}</span>
      <span className="text-sm">{tab.selection ? '...' : '새 탭'}</span>
      {!isLast && (
        <button
          className="w-4 h-4 opacity-0 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function TabStatusDot({ status }: { status: TabModel['status'] }) {
  const cls =
    status === 'loaded'
      ? 'bg-up'
      : status === 'loading'
      ? 'bg-accent animate-pulse'
      : 'border border-fg-dimmer';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />;
}
