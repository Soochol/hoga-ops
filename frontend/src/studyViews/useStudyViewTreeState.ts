import { useEffect, useMemo, useState } from 'react';
import { persistJson, readJsonObject } from '../state/persist';
import {
  filterStudyViewGroups,
  groupStudyViewsByCode,
  type StudyViewTreeGroup,
  type StudyViewTreeRow,
} from './studyViewTree';

const COLLAPSED_STUDY_VIEW_GROUPS_STORAGE_KEY = 'studyViews.collapsedGroups.v1';

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
  const allGroups = useMemo(() => groupStudyViewsByCode(rows), [rows]);
  const visibleGroups = useMemo(() => filterStudyViewGroups(allGroups, query), [allGroups, query]);

  useEffect(() => {
    persistCollapsedStudyViewGroups(collapsedGroups, allGroups);
  }, [collapsedGroups, allGroups]);

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

  return {
    query,
    setQuery,
    visibleGroups,
    isCollapsed: (key: string) => collapsedGroups.has(key),
    toggleGroup,
    collapseVisibleGroups,
    expandVisibleGroups,
  };
}
