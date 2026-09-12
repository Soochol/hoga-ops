import { useState } from 'react';
import type { StudyViewGroup } from '../api/studyViews';

export type StudyGroupChoice = { group_id?: string; new_group_name?: string };
export function StudyGroupPicker({ groups, value, onChange, allowCreate = true }: {
  groups: StudyViewGroup[]; value: StudyGroupChoice; onChange: (value: StudyGroupChoice) => void; allowCreate?: boolean;
}) {
  const [query, setQuery] = useState('');
  const creating = value.new_group_name !== undefined;
  const matches = groups.filter((g) => g.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || g.id === value.group_id);
  return <div className="space-y-2">
    {creating ? <label className="block text-xs">새 그룹 이름
      <input aria-label="새 그룹 이름" maxLength={60} value={value.new_group_name} autoFocus
        onChange={(e) => onChange({ new_group_name: e.target.value })} className="mt-1 w-full rounded border bg-bg-input px-2 py-1 text-sm" />
    </label> : <>
      <label className="block text-xs">그룹 검색
        <input aria-label="그룹 검색" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="그룹 이름 검색"
          className="mt-1 w-full rounded border bg-bg-input px-2 py-1 text-sm" />
      </label>
      <label className="block text-xs">저장 그룹
        <select aria-label="저장 그룹" value={value.group_id ?? ''} onChange={(e) => onChange({ group_id: e.target.value })}
          className="mt-1 w-full rounded border bg-bg-input px-2 py-1 text-sm">
          <option value="">그룹 선택</option>
          {matches.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>
      {matches.length === 0 && <p className="text-xs text-fg-dim">일치하는 그룹이 없습니다</p>}
    </>}
    {allowCreate && <button type="button" className="text-xs text-accent" onClick={() => onChange(creating ? {} : { new_group_name: query })}>
      {creating ? '기존 그룹 선택' : '+ 새 그룹'}
    </button>}
  </div>;
}

export function validStudyGroupChoice(groups: StudyViewGroup[], value: StudyGroupChoice): boolean {
  if (value.new_group_name !== undefined) return !!value.new_group_name.trim() && !groups.some((g) => g.name.toLocaleLowerCase() === value.new_group_name!.trim().toLocaleLowerCase());
  return groups.some((g) => g.id === value.group_id);
}
