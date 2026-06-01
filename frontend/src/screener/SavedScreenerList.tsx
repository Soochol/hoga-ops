import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';
import { useSavedScreeners, useSaveMutations } from './useSavedScreeners';

interface Current { conditions: ConditionLeaf[]; universe: ScreenerUniverse }

export function SavedScreenerList({ current, anchorId, dirty, onLoad, onBeginSave, onAnchorChange }: {
  current: Current; anchorId: string | null; dirty: boolean;
  onLoad: (s: SavedScreener) => void; onBeginSave: () => void; onAnchorChange: (id: string | null) => void;
}) {
  const { data } = useSavedScreeners();
  const { create, update, remove } = useSaveMutations();
  const saves = data?.saves ?? [];

  // Body built from the LIVE builder — for create + intentional overwrite.
  const bodyFromBuilder = (name: string) => ({ name, conditions: current.conditions, universe: current.universe });

  // Create/overwrite re-anchor the builder to the resulting save (now an exact
  // match → clean). Rename does NOT re-anchor (conditions unchanged). Deleting
  // the anchored save drops the anchor. The child never touches `dirty` — it
  // only signals the parent via onAnchorChange, which resets dirty there.
  const onCreate = () => { const name = window.prompt('조건검색 이름'); if (name) { onBeginSave(); create.mutate(bodyFromBuilder(name), { onSuccess: (created) => onAnchorChange(created.id) }); } };
  // Rename = NAME ONLY. The PUT is a full replace, so the body must carry the
  // save's OWN conditions/universe — forwarding the live builder here is exactly
  // the ✎ data-loss bug (renaming silently overwrote the saved conditions).
  const onRename = (s: SavedScreener) => {
    const name = window.prompt('새 이름', s.name);
    if (name) update.mutate({ id: s.id, body: { name, conditions: s.conditions, universe: s.universe } });
  };
  // Overwrite = intentionally persist the current builder onto this save. The
  // confirm NAMES the target (current builder may belong to a different save —
  // the missing builder↔save binding means an unnamed confirm could clobber the
  // wrong screener).
  const onOverwrite = (s: SavedScreener) => {
    if (window.confirm(`"${s.name}"을(를) 현재 빌더 조건으로 덮어쓸까요?`)) { onBeginSave(); update.mutate({ id: s.id, body: bodyFromBuilder(s.name) }, { onSuccess: () => onAnchorChange(s.id) }); }
  };
  const onDelete = (s: SavedScreener) => { if (window.confirm(`"${s.name}" 삭제?`)) remove.mutate(s.id, { onSuccess: () => { if (s.id === anchorId) onAnchorChange(null); } }); };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">저장한 조건검색</span>
        <button type="button" aria-label="새로 저장" onClick={onCreate}
          className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
      </div>
      <div className="flex flex-col gap-1">
        {saves.map((s) => {
          // Three-way row state. anchor+clean → teal fill + bar (builder is an
          // exact match). anchor+dirty → bar only, no fill (based on this, but
          // edited) + 수정됨. Otherwise neutral. The fill is honest under normal
          // interaction; the one known false-clean is a mid-save anchor/builder
          // change (see Screener.tsx) and self-heals on the next edit.
          const isAnchor = s.id === anchorId;
          const clean = isAnchor && !dirty;
          return (
            <div key={s.id} role="button" tabIndex={0}
              onClick={() => onLoad(s)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onLoad(s); }}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer ${
                clean ? 'bg-[rgba(20,184,166,0.14)] text-fg shadow-[inset_2px_0_0_var(--accent)]'
                  : isAnchor ? 'bg-bg-input text-fg shadow-[inset_2px_0_0_var(--accent)]'
                    : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              <span className="truncate flex-1">{s.name}</span>
              {isAnchor && dirty && <span className="shrink-0 text-[10px] tracking-[0.04em] text-fg-dimmer">수정됨</span>}
              {/* Monochrome glyph (✎/× set), NOT a 💾 emoji: DESIGN.md is
                  minimal-intentional/Linear-restraint, and a floppy reads as
                  generic "save" that competes with the ＋ "새로 저장" above. ⤓
                  = "write current into this slot". */}
              <button type="button" aria-label="현재 조건으로 덮어쓰기" onClick={(e) => { e.stopPropagation(); onOverwrite(s); }}
                className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">⤓</button>
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
