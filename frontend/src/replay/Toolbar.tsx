import { useEffect, useState } from 'react';
import { useTabsStore } from '../state/tabs';
import StockCombobox from './StockCombobox';
import DateRangePicker from './DateRangePicker';

export default function Toolbar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  const [draft, setDraft] = useState<{ code: string | null; from: string | null; to: string | null }>({
    code: active.selection?.code ?? null,
    from: active.selection?.fromDate ?? null,
    to: active.selection?.toDate ?? null,
  });

  // Sync draft from the store when the user switches tabs (active.id changes).
  // URL hydration also goes through this path because the hydrator calls
  // tabsStore.reset() which produces a fresh tab id — so a deep-link like
  // /replay?tabs=005930:20260520:20260520 correctly populates the toolbar.
  // We intentionally don't sync on selection-within-the-same-tab changes:
  // that would clobber the user's in-progress draft if any other code path
  // mutated selection while they were editing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDraft({
      code: active.selection?.code ?? null,
      from: active.selection?.fromDate ?? null,
      to: active.selection?.toDate ?? null,
    });
  }, [active.id]);

  // Stock change → clear dates (Task 4.5)
  const setCode = (code: string) => setDraft({ code, from: null, to: null });
  const setDates = (from: string, to: string) => setDraft((d) => ({ ...d, from, to }));

  const ready = !!(draft.code && draft.from && draft.to);
  const loaded = active.status === 'loaded';

  const onLoad = () => {
    if (!ready) return;
    useTabsStore
      .getState()
      .setSelection(active.id, { code: draft.code!, fromDate: draft.from!, toDate: draft.to! });
  };

  return (
    <div className="flex items-center gap-2.5 px-4 bg-bg-card border-b h-[60px]">
      <StockCombobox value={draft.code} onChange={setCode} />
      <DateRangePicker code={draft.code} from={draft.from} to={draft.to} onChange={setDates} />
      <span className="flex-1" />
      <button
        disabled={!ready}
        onClick={onLoad}
        className="px-4 py-2 bg-accent text-accent-fg rounded font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loaded ? 'Reload' : '데이터 불러오기'}
      </button>
    </div>
  );
}
