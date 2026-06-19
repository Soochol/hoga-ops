import { useEffect, useMemo, useState } from 'react';
import { persistJson, readJsonObject } from '../state/persist';
import {
  filterStudyViewGroups,
  groupStudyViewsByCode,
  studyViewTreeSortAction,
  type StudyViewTreeGroup,
  type StudyViewTreeManualOrder,
  type StudyViewTreeRow,
  type StudyViewTreeSortMode,
} from './studyViewTree';

const COLLAPSED_STUDY_VIEW_GROUPS_STORAGE_KEY = 'studyViews.collapsedGroups.v1';
const STUDY_VIEW_TREE_SORT_MODE_STORAGE_KEY = 'studyViews.treeSortMode.v1';
const STUDY_VIEW_TREE_MANUAL_ORDER_STORAGE_KEY = 'studyViews.treeManualOrder.v1';

function arrayMoveLocal<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

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

export function useStudyViewTreeState<T extends StudyViewTreeRow>(rows: T[]) {
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedStudyViewGroups());
  const [sortMode, setSortMode] = useState<StudyViewTreeSortMode>(() => readStudyViewTreeSortMode());
  const [manualOrder, setManualOrder] = useState<StudyViewTreeManualOrder>(() => readStudyViewTreeManualOrder());
  const sourceGroups = useMemo(() => groupStudyViewsByCode(rows), [rows]);
  const allGroups = useMemo(() => groupStudyViewsByCode(rows, sortMode, manualOrder), [manualOrder, rows, sortMode]);
  const visibleGroups = useMemo(() => filterStudyViewGroups(allGroups, query), [allGroups, query]);

  useEffect(() => {
    persistCollapsedStudyViewGroups(collapsedGroups, allGroups);
  }, [collapsedGroups, allGroups]);

  useEffect(() => {
    persistJson(STUDY_VIEW_TREE_SORT_MODE_STORAGE_KEY, { sortMode });
  }, [sortMode]);

  useEffect(() => {
    const pruned = pruneManualOrder(manualOrder, sourceGroups);
    persistJson(STUDY_VIEW_TREE_MANUAL_ORDER_STORAGE_KEY, pruned);
  }, [manualOrder, sourceGroups]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const collapseVisibleGroups = () => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const group of visibleGroups) next.add(group.key);
      return next;
    });
  };

  const expandVisibleGroups = () => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const group of visibleGroups) next.delete(group.key);
      return next;
    });
  };

  const reorderGroup = (activeKey: string, overKey: string) => {
    if (activeKey === overKey) return;
    setManualOrder((current) => {
      const currentKeys = groupStudyViewsByCode(rows, 'default', current).map((group) => group.key);
      const from = currentKeys.indexOf(activeKey);
      const to = currentKeys.indexOf(overKey);
      if (from < 0 || to < 0) return current;
      return { ...current, groupKeys: arrayMoveLocal(currentKeys, from, to) };
    });
  };

  const reorderRow = (groupKey: string, activeId: string, overId: string) => {
    if (activeId === overId) return;
    setManualOrder((current) => {
      const group = groupStudyViewsByCode(rows, 'default', current).find((candidate) => candidate.key === groupKey);
      if (!group) return current;
      const currentIds = group.rows.map((row) => row.id);
      const from = currentIds.indexOf(activeId);
      const to = currentIds.indexOf(overId);
      if (from < 0 || to < 0) return current;
      return {
        ...current,
        rowIdsByGroup: {
          ...current.rowIdsByGroup,
          [groupKey]: arrayMoveLocal(currentIds, from, to),
        },
      };
    });
  };

  return {
    query,
    setQuery,
    sortMode,
    sortAction: studyViewTreeSortAction(sortMode),
    cycleSortMode: () => setSortMode(nextSortMode),
    dragEnabled: sortMode === 'default' && query.trim() === '',
    visibleGroups,
    isCollapsed: (key: string) => collapsedGroups.has(key),
    toggleGroup,
    collapseVisibleGroups,
    expandVisibleGroups,
    reorderGroup,
    reorderRow,
  };
}
