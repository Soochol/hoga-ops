export type StudyViewTreeRow = {
  id: string;
  label: string;
  code: string;
  name: string;
  memo: string;
};

export type StudyViewTreeGroup<T extends StudyViewTreeRow> = {
  key: string;
  label: string;
  code: string;
  rows: T[];
};
export type StudyViewTreeSortMode = 'default' | 'name-asc' | 'name-desc';
export type StudyViewTreeSortDirection = 'default' | 'asc' | 'desc';
export type StudyViewTreeManualOrder = {
  groupKeys: string[];
  rowIdsByGroup: Record<string, string[]>;
};
export type StudyViewTreeSortAction = {
  label: string;
  direction: StudyViewTreeSortDirection;
  pressed: boolean;
};

export function normalizeStudyViewQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function compareTreeText(a: string, b: string): number {
  return a.localeCompare(b, 'ko-KR', { numeric: true, sensitivity: 'base' });
}

function sortStudyViewGroupsByName<T extends StudyViewTreeRow>(
  groups: StudyViewTreeGroup<T>[],
  direction: 'asc' | 'desc',
): StudyViewTreeGroup<T>[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...groups]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) =>
        factor * (compareTreeText(a.name, b.name) || compareTreeText(a.code, b.code) || compareTreeText(a.id, b.id)),
      ),
    }))
    .sort((a, b) => factor * (compareTreeText(a.label, b.label) || compareTreeText(a.code, b.code)));
}

function orderByKeys<T>(items: T[], keys: string[], keyOf: (item: T) => string): T[] {
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const ordered: T[] = [];
  const used = new Set<string>();

  for (const key of keys) {
    const item = byKey.get(key);
    if (!item || used.has(key)) continue;
    ordered.push(item);
    used.add(key);
  }

  for (const item of items) {
    const key = keyOf(item);
    if (!used.has(key)) ordered.push(item);
  }

  return ordered;
}

function applyManualStudyViewOrder<T extends StudyViewTreeRow>(
  groups: StudyViewTreeGroup<T>[],
  manualOrder?: StudyViewTreeManualOrder,
): StudyViewTreeGroup<T>[] {
  if (!manualOrder) return groups;

  return orderByKeys(groups, manualOrder.groupKeys, (group) => group.key).map((group) => ({
    ...group,
    rows: orderByKeys(group.rows, manualOrder.rowIdsByGroup[group.key] ?? [], (row) => row.id),
  }));
}

export function groupStudyViewsByCode<T extends StudyViewTreeRow>(
  rows: T[],
  sortMode: StudyViewTreeSortMode = 'default',
  manualOrder?: StudyViewTreeManualOrder,
): StudyViewTreeGroup<T>[] {
  const groups: StudyViewTreeGroup<T>[] = [];
  const byCode = new Map<string, StudyViewTreeGroup<T>>();

  for (const row of rows) {
    const existing = byCode.get(row.code);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group = { key: row.code, label: row.label || row.code, code: row.code, rows: [row] };
    byCode.set(row.code, group);
    groups.push(group);
  }

  if (sortMode === 'name-asc') return sortStudyViewGroupsByName(groups, 'asc');
  if (sortMode === 'name-desc') return sortStudyViewGroupsByName(groups, 'desc');
  return applyManualStudyViewOrder(groups, manualOrder);
}

export function studyViewTreeSortAction(sortMode: StudyViewTreeSortMode): StudyViewTreeSortAction {
  if (sortMode === 'name-asc') {
    return { label: '이름 내림차순 정렬', direction: 'asc', pressed: true };
  }
  if (sortMode === 'name-desc') {
    return { label: '기본 정렬', direction: 'desc', pressed: true };
  }
  return { label: '이름 오름차순 정렬', direction: 'default', pressed: false };
}

export function filterStudyViewGroups<T extends StudyViewTreeRow>(
  groups: StudyViewTreeGroup<T>[],
  query: string,
): StudyViewTreeGroup<T>[] {
  const q = normalizeStudyViewQuery(query);
  if (!q) return groups;

  return groups.flatMap((group) => {
    const stockMatches = [group.label, group.code].some((value) => normalizeStudyViewQuery(value).includes(q));
    if (stockMatches) return [group];

    const rows = group.rows.filter((row) =>
      [row.name, row.memo].some((value) => normalizeStudyViewQuery(value).includes(q)),
    );
    return rows.length > 0 ? [{ ...group, rows }] : [];
  });
}
