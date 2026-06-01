import { useRef, useState } from 'react';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';

export interface SaveAnchor {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  anchorId: string | null;
  dirty: boolean;
  loadSave: (s: SavedScreener) => void;
  newDraft: () => void;
  editConditions: (c: ConditionLeaf[]) => void;
  editUniverse: (u: ScreenerUniverse) => void;
  beginSave: () => void;
  settleAnchor: (id: string | null) => void;
}

// The SavedScreener anchor lifecycle for the screener builder. Owns the live
// builder state (conditions/universe) plus the anchor/dirty state machine.
//
// anchorId = the saved screener the builder currently corresponds to (null when
// the builder is unsaved or has been edited away from it). dirty = the builder
// diverged from that anchor since the last load/save. A boolean FLAG, not a
// deep-equal: server↔builder normalization gaps (Pydantic None→null, false→
// omitted key) make naive comparison report false "dirty"/"clean". The flag is
// biased toward a false "수정됨" (e.g. after a manual revert) over a false "clean".
//
// editGen bumps on every builder edit. beginSave() snapshots it; settleAnchor()
// (the save's onSuccess) marks the row clean ONLY if no edit landed while the
// save was in flight — otherwise the builder diverged from what was actually
// saved and must stay dirty. Refs (read at call time) dodge stale closures. This
// guards the common false-clean (an edit landing during a slow save's in-flight
// window). It does NOT guard a mid-flight load of a different save — that path
// self-heals on the next edit.
//
// Load routes through the RAW setters + dirty=false. User edits route through
// editConditions/editUniverse + dirty=true. Keeping these paths separate is what
// makes "clean on load, dirty on edit" hold.
export function useSaveAnchor(): SaveAnchor {
  const [conditions, setConditions] = useState<ConditionLeaf[]>(() => []);
  const [universe, setUniverse] = useState<ScreenerUniverse>({});
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const editGen = useRef(0);
  const pendingSaveGen = useRef<number | null>(null);

  const loadSave = (s: SavedScreener) => { setConditions(s.conditions); setUniverse(s.universe); setAnchorId(s.id); setDirty(false); };
  const newDraft = () => { setConditions([]); setUniverse({}); setAnchorId(null); setDirty(false); };
  const editConditions = (c: ConditionLeaf[]) => { editGen.current += 1; setConditions(c); setDirty(true); };
  const editUniverse = (u: ScreenerUniverse) => { editGen.current += 1; setUniverse(u); setDirty(true); };
  const beginSave = () => { pendingSaveGen.current = editGen.current; };
  const settleAnchor = (id: string | null) => {
    setAnchorId(id);
    // Clean only when nothing was edited since the save was dispatched (or when
    // clearing the anchor). A mutation failure never calls this → dirty is left
    // as-is, which is correct (the save didn't change, so the builder still differs).
    if (id === null || pendingSaveGen.current === editGen.current) setDirty(false);
    pendingSaveGen.current = null;
  };

  return { conditions, universe, anchorId, dirty, loadSave, newDraft, editConditions, editUniverse, beginSave, settleAnchor };
}
