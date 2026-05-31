import { useState } from 'react';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';
import { useSavedScreeners, useSaveMutations } from './useSavedScreeners';

interface Current { conditions: ConditionLeaf[]; universe: ScreenerUniverse }

export function SavedScreenerList({ current, onLoad }: { current: Current; onLoad: (s: SavedScreener) => void }) {
  const { data } = useSavedScreeners();
  const { create, update, remove } = useSaveMutations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const saves = data?.saves ?? [];

  const body = (name: string) => ({ name, conditions: current.conditions, universe: current.universe });

  const onCreate = () => { const name = window.prompt('조건검색 이름'); if (name) create.mutate(body(name)); };
  const onRename = (s: SavedScreener) => { const name = window.prompt('새 이름', s.name); if (name) update.mutate({ id: s.id, body: body(name) }); };
  const onDelete = (s: SavedScreener) => { if (window.confirm(`"${s.name}" 삭제?`)) remove.mutate(s.id); };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">저장한 조건검색</span>
        <button type="button" aria-label="새로 저장" onClick={onCreate}
          className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
      </div>
      <div className="flex flex-col gap-1">
        {saves.map((s) => {
          const active = s.id === selectedId;
          return (
            <div key={s.id} role="button" tabIndex={0}
              onClick={() => { setSelectedId(s.id); onLoad(s); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSelectedId(s.id); onLoad(s); } }}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer ${active ? 'bg-[rgba(20,184,166,0.14)] text-fg shadow-[inset_2px_0_0_var(--accent)]' : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              <span className="truncate flex-1">{s.name}</span>
              <button type="button" aria-label="이름변경" onClick={(e) => { e.stopPropagation(); onRename(s); }}
                className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">✎</button>
              <button type="button" aria-label="삭제" onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">🗑</button>
            </div>
          );
        })}
        {saves.length === 0 && <div className="text-fg-dimmer text-xs px-1 py-2">저장된 조건검색이 없습니다. ＋ 로 현재 조건을 저장하세요.</div>}
      </div>
    </div>
  );
}
