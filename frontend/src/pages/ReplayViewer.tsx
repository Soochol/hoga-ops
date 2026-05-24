import { useEffect, useRef } from 'react';
import { useTabsStore } from '../state/tabs';
import { parseReplayUrl, emitReplayUrl } from '../state/url';
import TabStrip from '../replay/TabStrip';
import Toolbar from '../replay/Toolbar';
import PriceStrip from '../replay/PriceStrip';
import OnboardingCard from '../replay/OnboardingCard';
import Workarea from '../replay/Workarea';

function useUrlSync() {
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const parsed = parseReplayUrl(window.location.search);
    if (parsed.tabs.length === 0) {
      // No URL params → keep the store as-is. The store was already seeded
      // at module-load time from localStorage (see state/tabs.ts), or with a
      // single fresh tab if no snapshot existed. The debounced persist
      // subscriber will keep localStorage in sync from here.
      return;
    }
    // URL hydration wins over localStorage. After reset() + setSelection(),
    // the persist subscriber will overwrite localStorage with the URL state
    // (intentional one-way URL → localStorage sync — see spec §"Hydration 방향").
    const store = useTabsStore.getState();
    store.reset();
    const firstId = useTabsStore.getState().tabs[0].id;
    store.setSelection(firstId, parsed.tabs[0]);
    for (let i = 1; i < parsed.tabs.length; i++) {
      const id = store.newTab();
      useTabsStore.getState().setSelection(id, parsed.tabs[i]);
    }
    const ids = useTabsStore.getState().tabs.map((t) => t.id);
    useTabsStore.getState().setActive(ids[parsed.active] ?? ids[0]);
  }, []);

  // Push tabs → URL whenever selection / active changes.
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeTabId);
  useEffect(() => {
    if (!hydrated.current) return;
    const activeIdx = tabs.findIndex((t) => t.id === activeId);
    const sel = tabs.map((t) => t.selection);
    const search = emitReplayUrl(sel, activeIdx);
    const target = `${window.location.pathname}${search}`;
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', target);
    }
  }, [tabs, activeId]);
}

export default function ReplayViewer() {
  useUrlSync();
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  return (
    <div className="grid grid-rows-[40px_60px_52px_1fr] h-full min-h-0 min-w-0">
      <TabStrip />
      <Toolbar />
      <PriceStrip />
      <div className="bg-bg min-h-0 overflow-hidden">
        {!active.selection ? <OnboardingCard tab={active} /> : <Workarea tab={active} />}
      </div>
    </div>
  );
}
