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

export function normalizeStudyViewQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

export function groupStudyViewsByCode<T extends StudyViewTreeRow>(rows: T[]): StudyViewTreeGroup<T>[] {
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

  return groups;
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
