import type { StudyViewGroup } from '../api/studyViews';
import { useEffect, useMemo, useState } from 'react';
import { insertStudyViewIds } from './studyViewOrder';
import { persistJson, readJsonObject } from '../state/persist';
import {
  filterStudyViewGroups,
  groupStudyViews,
  studyViewTreeSortAction,
  type StudyViewTreeGroup,
  type StudyViewTreeManualOrder,
  type StudyViewTreeRow,
  type StudyViewTreeSortMode,
} from './studyViewTree';

const COLLAPSED_STUDY_VIEW_GROUPS_STORAGE_KEY = 'studyViews.collapsedGroups.v2';
const STUDY_VIEW_TREE_SORT_MODE_STORAGE_KEY = 'studyViews.treeSortMode.v2';
const STUDY_VIEW_TREE_MANUAL_ORDER_STORAGE_KEY = 'studyViews.treeManualOrder.v2';

function readStudyViewTreeSortMode(): StudyViewTreeSortMode {
  const saved = readJsonObject(STUDY_VIEW_TREE_SORT_MODE_STORAGE_KEY);
  if (saved.sortMode === 'name-asc' || saved.sortMode === 'name-desc') return saved.sortMode;
  return 'default';
}

function readStudyViewTreeManualOrder(): StudyViewTreeManualOrder {
  const saved = readJsonObject(STUDY_VIEW_TREE_MANUAL_ORDER_STORAGE_KEY);
  return {
    groupKeys: Array.isArray(saved.groupKeys)
      ? saved.groupKeys.filter((key): key is string => typeof key === 'string')
      : [],
    rowIdsByGroup: saved.rowIdsByGroup && typeof saved.rowIdsByGroup === 'object' && !Array.isArray(saved.rowIdsByGroup)
      ? Object.fromEntries(
        Object.entries(saved.rowIdsByGroup).flatMap(([key, value]) =>
          typeof key === 'string' && Array.isArray(value)
            ? [[key, value.filter((id): id is string => typeof id === 'string')]]
            : [],
        ),
      )
      : {},
  };
}

function pruneManualOrder<T extends StudyViewTreeRow>(
  manualOrder: StudyViewTreeManualOrder,
  sourceGroups: StudyViewTreeGroup<T>[],
): StudyViewTreeManualOrder {
  const validGroups = new Set(sourceGroups.map((group) => group.key));
  const nextRows: Record<string, string[]> = {};

  for (const group of sourceGroups) {
    const validRows = new Set(group.rows.map((row) => row.id));
    const ordered = (manualOrder.rowIdsByGroup[group.key] ?? []).filter((id) => validRows.has(id));
    if (ordered.length > 0) nextRows[group.key] = ordered;
  }

  return {
    groupKeys: manualOrder.groupKeys.filter((key) => validGroups.has(key)),
    rowIdsByGroup: nextRows,
  };
}

function sameManualOrder(left: StudyViewTreeManualOrder, right: StudyViewTreeManualOrder): boolean {
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
  if (!sameIds(left.groupKeys, right.groupKeys)) return false;
  const keys = Object.keys(left.rowIdsByGroup);
  // Persistence may enumerate Code keys differently without changing any displayed order.
  return keys.length === Object.keys(right.rowIdsByGroup).length && keys.every((key) => {
    const rightRows = right.rowIdsByGroup[key];
    return Array.isArray(rightRows) && sameIds(left.rowIdsByGroup[key], rightRows);
  });
}

function nextSortMode(current: StudyViewTreeSortMode): StudyViewTreeSortMode {
  if (current === 'default') return 'name-asc';
  if (current === 'name-asc') return 'name-desc';
  return 'default';
}

function readCollapsedStudyViewGroups(): Set<string> {
  const saved = readJsonObject(COLLAPSED_STUDY_VIEW_GROUPS_STORAGE_KEY);
  const keys = saved.keys;
  if (!Array.isArray(keys)) return new Set();
  return new Set(keys.filter((key): key is string => typeof key === 'string'));
}

function persistCollapsedStudyViewGroups<T extends StudyViewTreeRow>(
  collapsed: Set<string>,
  groups: StudyViewTreeGroup<T>[],
): void {
  const valid = new Set(groups.map((group) => group.key));
  persistJson(COLLAPSED_STUDY_VIEW_GROUPS_STORAGE_KEY, {
    keys: [...collapsed].filter((key) => valid.has(key)),
  });
}

export function useStudyViewTreeState<T extends StudyViewTreeRow>(rows: T[], groups: StudyViewGroup[], loaded = true) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    try {
      for (const key of ['studyViews.collapsedGroups.v1', 'studyViews.treeSortMode.v1', 'studyViews.treeManualOrder.v1']) localStorage.removeItem(key);
    } catch { /* Storage may be unavailable; the new keys never read the legacy state. */ }
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedStudyViewGroups());
  const [sortMode, setSortMode] = useState<StudyViewTreeSortMode>(() => readStudyViewTreeSortMode());
  const [manualOrder, setManualOrder] = useState<StudyViewTreeManualOrder>(() => readStudyViewTreeManualOrder());
  const [orderMessage, setOrderMessage] = useState('');
  const [undoOrder, setUndoOrder] = useState<{ before: StudyViewTreeManualOrder; after: StudyViewTreeManualOrder } | null>(null);
  const sourceGroups = useMemo(() => groupStudyViews(rows, groups), [rows, groups]);
  const allGroups = useMemo(() => groupStudyViews(rows, groups, sortMode, manualOrder), [manualOrder, rows, groups, sortMode]);
  const visibleGroups = useMemo(() => filterStudyViewGroups(allGroups, query), [allGroups, query]);
  const searching = query.trim() !== '';
  const visibleGroupsCollapsed = !searching && visibleGroups.length > 0 && visibleGroups.every((group) => collapsedGroups.has(group.key));

  useEffect(() => {
    if (loaded) persistCollapsedStudyViewGroups(collapsedGroups, allGroups);
  }, [collapsedGroups, allGroups, loaded]);

  useEffect(() => {
    persistJson(STUDY_VIEW_TREE_SORT_MODE_STORAGE_KEY, { sortMode });
  }, [sortMode]);

  useEffect(() => {
    if (!loaded) return;
    const pruned = pruneManualOrder(manualOrder, sourceGroups);
    persistJson(STUDY_VIEW_TREE_MANUAL_ORDER_STORAGE_KEY, pruned);
  }, [manualOrder, sourceGroups, loaded]);

  const toggleGroup = (key: string) => {
    if (searching) return;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const collapseVisibleGroups = () => {
    if (searching) return;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const group of visibleGroups) next.add(group.key);
      return next;
    });
  };

  const expandVisibleGroups = () => {
    if (searching) return;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const group of visibleGroups) next.delete(group.key);
      return next;
    });
  };

  const toggleVisibleGroups = () => {
    if (searching) return;
    if (visibleGroupsCollapsed) {
      expandVisibleGroups();
      return;
    }
    collapseVisibleGroups();
  };

  const snapshot = (): StudyViewTreeManualOrder => {
    const orderedGroups = groupStudyViews(rows, groups, 'default', manualOrder);
    return { groupKeys: orderedGroups.map((g) => g.key), rowIdsByGroup: Object.fromEntries(orderedGroups.map((g) => [g.key, g.rows.map((r) => r.id)])) };
  };
  const writeOrder = (next: StudyViewTreeManualOrder) => {
    try { localStorage.setItem(STUDY_VIEW_TREE_MANUAL_ORDER_STORAGE_KEY, JSON.stringify(next)); }
    catch { setOrderMessage('순서를 저장하지 못했습니다. 브라우저 저장 공간을 확인하세요.'); return false; }
    setManualOrder(next);
    return true;
  };
  const commitOrder = (next: StudyViewTreeManualOrder) => {
    const before = snapshot();
    if (sameManualOrder(before, next)) return;
    if (!writeOrder(next)) return;
    setUndoOrder({ before, after: next });
    setOrderMessage('순서를 변경했습니다 · 이 브라우저에 저장');
  };
  const placeGroup = (activeKey: string, overKey: string, side: 'before' | 'after') => {
    const next = snapshot();
    const at = next.groupKeys.indexOf(overKey);
    if (at < 0 || !next.groupKeys.includes(activeKey)) return;
    next.groupKeys = insertStudyViewIds(next.groupKeys, [activeKey], at + (side === 'after' ? 1 : 0));
    commitOrder(next);
  };
  const placeRows = (groupKey: string, ids: string[], overId: string, side: 'before' | 'after') => {
    const next = snapshot();
    const current = next.rowIdsByGroup[groupKey];
    if (!current) return;
    const at = overId ? current.indexOf(overId) : current.length;
    if (at < 0) return;
    for (const key of Object.keys(next.rowIdsByGroup)) {
      if (key !== groupKey) next.rowIdsByGroup[key] = next.rowIdsByGroup[key].filter((id) => !ids.includes(id));
    }
    next.rowIdsByGroup[groupKey] = insertStudyViewIds([...current, ...ids.filter((id) => !current.includes(id))], ids, at + (side === 'after' ? 1 : 0));
    commitOrder(next);
  };
  const undoReorder = () => {
    if (!undoOrder) return;
    if (!sameManualOrder(readStudyViewTreeManualOrder(), undoOrder.after)) {
      setOrderMessage('순서가 변경되어 되돌릴 수 없습니다. 최신 목록을 확인하세요.');
      setUndoOrder(null);
      return;
    }
    if (writeOrder(undoOrder.before)) { setUndoOrder(null); setOrderMessage('순서를 되돌렸습니다'); }
  };
  const reorderGroup = (activeKey: string, overKey: string) => {
    const keys = snapshot().groupKeys;
    placeGroup(activeKey, overKey, keys.indexOf(activeKey) < keys.indexOf(overKey) ? 'after' : 'before');
  };
  const reorderRow = (groupKey: string, activeId: string, overId: string) => {
    const ids = snapshot().rowIdsByGroup[groupKey] ?? [];
    placeRows(groupKey, [activeId], overId, ids.indexOf(activeId) < ids.indexOf(overId) ? 'after' : 'before');
  };

  return {
    revealGroup: (key: string) => { setQuery(''); setCollapsedGroups((old) => { const next = new Set(old); next.delete(key); return next; }); },
    query,
    setQuery,
    sortMode,
    sortAction: studyViewTreeSortAction(sortMode),
    cycleSortMode: () => setSortMode(nextSortMode),
    dragEnabled: sortMode === 'default' && query.trim() === '',
    visibleGroups,
    visibleGroupsCollapsed,
    isCollapsed: (key: string) => !searching && collapsedGroups.has(key),
    searching,
    orderMessage, placeGroup, placeRows, undoReorder, canUndoOrder: !!undoOrder,
    useManualSort: () => setSortMode('default'),
    toggleGroup,
    collapseVisibleGroups,
    expandVisibleGroups,
    toggleVisibleGroups,
    reorderGroup,
    reorderRow,
  };
}
