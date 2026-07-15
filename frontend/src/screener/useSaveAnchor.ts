import { useEffect, useRef, useState } from 'react';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';
import { persistScreenerDraft, readScreenerDraft } from './screenerDraft';

export interface SaveAnchor {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  anchorId: string | null;
  anchorName: string | null;
  dirty: boolean;
  loadSave: (s: SavedScreener) => void;
  newDraft: () => void;
  editConditions: (c: ConditionLeaf[]) => void;
  editUniverse: (u: ScreenerUniverse) => void;
  beginSave: () => void;
  settleAnchor: (id: string | null, name?: string | null) => void;
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
  // 마운트 시 1회 localStorage 하이드레이션 — 라우트 왕복/새로고침 후 조건 입력값 복원.
  const [seed] = useState(readScreenerDraft);
  const [conditions, setConditions] = useState<ConditionLeaf[]>(seed.conditions);
  const [universe, setUniverse] = useState<ScreenerUniverse>(seed.universe);
  const [anchorId, setAnchorId] = useState<string | null>(seed.anchorId);
  const [anchorName, setAnchorName] = useState<string | null>(seed.anchorName);
  const [dirty, setDirty] = useState(seed.dirty);
  const editGen = useRef(0);
  const pendingSaveGen = useRef<number | null>(null);

  // 빌더 상태가 바뀔 때마다 영속(조건 편집은 keystroke 가 아닌 discrete op 라 write 빈도 낮음).
  useEffect(() => {
    persistScreenerDraft({ conditions, universe, anchorId, anchorName, dirty });
  }, [conditions, universe, anchorId, anchorName, dirty]);

  const loadSave = (s: SavedScreener) => {
    setConditions(s.conditions);
    setUniverse(s.universe);
    setAnchorId(s.id);
    setAnchorName(s.name);
    setDirty(false);
  };
  const newDraft = () => { setConditions([]); setUniverse({}); setAnchorId(null); setAnchorName(null); setDirty(false); };
  const editConditions = (c: ConditionLeaf[]) => { editGen.current += 1; setConditions(c); setDirty(true); };
  const editUniverse = (u: ScreenerUniverse) => { editGen.current += 1; setUniverse(u); setDirty(true); };
  const beginSave = () => { pendingSaveGen.current = editGen.current; };
  const settleAnchor = (id: string | null, name?: string | null) => {
    setAnchorId(id);
    if (id === null) setAnchorName(null);
    else if (name !== undefined) setAnchorName(name);
    // Clean only when nothing was edited since the save was dispatched (or when
    // clearing the anchor). A mutation failure never calls this → dirty is left
    // as-is, which is correct (the save didn't change, so the builder still differs).
    if (id === null || pendingSaveGen.current === editGen.current) setDirty(false);
    pendingSaveGen.current = null;
  };

  return { conditions, universe, anchorId, anchorName, dirty, loadSave, newDraft, editConditions, editUniverse, beginSave, settleAnchor };
}
