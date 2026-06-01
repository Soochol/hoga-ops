import { useSaveAnchor } from './useSaveAnchor';
import { useSaveMutations } from './useSavedScreeners';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';

// The SavedScreener editing session: the builder's live state PLUS the full
// save lifecycle. Composes the anchor/dirty state machine (useSaveAnchor) with
// the CRUD mutations (useSaveMutations); each lifecycle op runs the
// beginSave→mutate→settleAnchor race guard internally, so consumers (the page,
// the saved-list view) never orchestrate it. See ADR-0052 / CONTEXT.md SavedScreener.
export interface SavedScreenerEditor {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  anchorId: string | null;
  dirty: boolean;
  editConditions: (c: ConditionLeaf[]) => void;
  editUniverse: (u: ScreenerUniverse) => void;
  load: (s: SavedScreener) => void;
  newDraft: () => void;
  saveAsNew: (name: string) => void;
  overwrite: (s: SavedScreener) => void;
  rename: (s: SavedScreener, name: string) => void;
  remove: (s: SavedScreener) => void;
}

export function useSavedScreenerEditor(): SavedScreenerEditor {
  const anchor = useSaveAnchor();
  const { create, update, remove } = useSaveMutations();

  // create re-anchors to the new save (race-guarded: settle only if no edit
  // landed mid-flight — beginSave snapshots, settleAnchor checks).
  const saveAsNew = (name: string) => {
    anchor.beginSave();
    create.mutate(
      { name, conditions: anchor.conditions, universe: anchor.universe },
      { onSuccess: (created) => anchor.settleAnchor(created.id) },
    );
  };
  // overwrite an existing save with the live builder, keep its name, re-anchor.
  const overwrite = (s: SavedScreener) => {
    anchor.beginSave();
    update.mutate(
      { id: s.id, body: { name: s.name, conditions: anchor.conditions, universe: anchor.universe } },
      { onSuccess: () => anchor.settleAnchor(s.id) },
    );
  };
  // rename carries the SAVE's own conditions/universe (NOT the live builder) and
  // does NOT re-anchor — mirrors the prior commitRename.
  const rename = (s: SavedScreener, name: string) => {
    update.mutate({ id: s.id, body: { name, conditions: s.conditions, universe: s.universe } });
  };
  // delete clears the anchor only when the deleted save WAS the anchor.
  const removeSave = (s: SavedScreener) => {
    remove.mutate(s.id, { onSuccess: () => { if (s.id === anchor.anchorId) anchor.settleAnchor(null); } });
  };

  return {
    conditions: anchor.conditions, universe: anchor.universe,
    anchorId: anchor.anchorId, dirty: anchor.dirty,
    editConditions: anchor.editConditions, editUniverse: anchor.editUniverse,
    load: anchor.loadSave, newDraft: anchor.newDraft,
    saveAsNew, overwrite, rename, remove: removeSave,
  };
}
