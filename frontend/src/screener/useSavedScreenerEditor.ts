import { useEffect, useRef } from 'react';
import { readPersistedAnchorId, useSaveAnchor } from './useSaveAnchor';
import { useSavedScreeners, useSaveMutations } from './useSavedScreeners';
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
  anchorName: string | null;
  dirty: boolean;
  isSaving: boolean;
  saveError: Error | null;
  editConditions: (c: ConditionLeaf[]) => void;
  editUniverse: (u: ScreenerUniverse) => void;
  load: (s: SavedScreener) => void;
  newDraft: () => void;
  saveAsNew: (name: string) => void;
  saveCurrent: (name?: string) => void;
  overwrite: (s: SavedScreener) => void;
  duplicate: (s: SavedScreener) => void;
  rename: (s: SavedScreener, name: string) => void;
  remove: (s: SavedScreener) => void;
}

export function useSavedScreenerEditor(): SavedScreenerEditor {
  const anchor = useSaveAnchor();
  const { create, update, remove } = useSaveMutations();
  const { data: savesData, isSuccess: savesLoaded } = useSavedScreeners();

  // 첫 진입 자동 로드(1회): 저장 목록이 도착하면 마지막으로 앵커됐던 저장본
  // (persist된 id)을, 없어졌으면 목록 첫 항목을 빌더에 로드한다 — 드로어의
  // restore/repair 패턴(ScreenerDrawer)의 페이지판. 목록이 도착하기 전에 사용자가
  // 이미 편집/로드를 시작했다면(dirty 또는 anchor 존재) 절대 덮어쓰지 않는다.
  // 목적: 빈 빌더로 조회해 "전종목 1000행"이 나오는 초기 상태를 없앤다.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !savesLoaded) return;
    hydratedRef.current = true;
    if (anchor.anchorId !== null || anchor.dirty) return;
    const saves = savesData?.saves ?? [];
    if (saves.length === 0) return;
    const persistedId = readPersistedAnchorId();
    anchor.loadSave(saves.find((s) => s.id === persistedId) ?? saves[0]);
    // anchor 는 렌더마다 새 객체지만 hydratedRef 가드로 1회만 실행된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savesLoaded, savesData]);

  // create re-anchors to the new save (race-guarded: settle only if no edit
  // landed mid-flight — beginSave snapshots, settleAnchor checks).
  const saveAsNew = (name: string) => {
    anchor.beginSave();
    create.mutate(
      { name, conditions: anchor.conditions, universe: anchor.universe },
      { onSuccess: (created) => anchor.settleAnchor(created.id, created.name) },
    );
  };
  const saveCurrent = (name?: string) => {
    if (anchor.anchorId && anchor.anchorName) {
      anchor.beginSave();
      update.mutate(
        { id: anchor.anchorId, body: { name: anchor.anchorName, conditions: anchor.conditions, universe: anchor.universe } },
        { onSuccess: () => anchor.settleAnchor(anchor.anchorId, anchor.anchorName) },
      );
      return;
    }
    if (name?.trim()) saveAsNew(name.trim());
  };
  // overwrite an existing save with the live builder, keep its name, re-anchor.
  const overwrite = (s: SavedScreener) => {
    anchor.beginSave();
    update.mutate(
      { id: s.id, body: { name: s.name, conditions: anchor.conditions, universe: anchor.universe } },
      { onSuccess: () => anchor.settleAnchor(s.id, s.name) },
    );
  };
  const duplicate = (s: SavedScreener) => {
    create.mutate({ name: `${s.name} 복사`, conditions: s.conditions, universe: s.universe });
  };
  // rename carries the SAVE's own conditions/universe (NOT the live builder) and
  // does NOT re-anchor — mirrors the prior commitRename.
  const rename = (s: SavedScreener, name: string) => {
    update.mutate(
      { id: s.id, body: { name, conditions: s.conditions, universe: s.universe } },
      { onSuccess: () => { if (s.id === anchor.anchorId) anchor.settleAnchor(s.id, name); } },
    );
  };
  // delete clears the anchor only when the deleted save WAS the anchor.
  const removeSave = (s: SavedScreener) => {
    remove.mutate(s.id, { onSuccess: () => { if (s.id === anchor.anchorId) anchor.settleAnchor(null); } });
  };

  return {
    conditions: anchor.conditions, universe: anchor.universe,
    anchorId: anchor.anchorId, anchorName: anchor.anchorName, dirty: anchor.dirty,
    isSaving: create.isPending || update.isPending,
    saveError: (create.error ?? update.error) instanceof Error ? (create.error ?? update.error) as Error : null,
    editConditions: anchor.editConditions, editUniverse: anchor.editUniverse,
    load: anchor.loadSave, newDraft: anchor.newDraft,
    saveAsNew, saveCurrent, overwrite, duplicate, rename, remove: removeSave,
  };
}
