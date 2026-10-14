import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../util/useAnchoredPopover';
import type { StudyViewGroup } from '../api/studyViews';
import { type StudyGroupChoice } from './StudyGroupPickerHelpers';

export function StudyGroupPicker({ groups, value, onChange, allowCreate = true }: {
  groups: StudyViewGroup[]; value: StudyGroupChoice; onChange: (value: StudyGroupChoice) => void; allowCreate?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { ref, style } = useAnchoredPopover(open, anchor, close, 320);
  const creating = value.new_group_name !== undefined;
  const selected = groups.find(group => group.id === value.group_id);
  const matches = groups.filter(group => group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const pick = (id: string) => { onChange({ group_id: id }); close(); input.current?.focus(); };
  return <div className="space-y-2">
    {creating ? <label className="block text-xs">새 그룹 이름
      <input aria-label="새 그룹 이름" data-modal-autofocus maxLength={60} value={value.new_group_name} autoFocus
        onChange={(e) => onChange({ new_group_name: e.target.value })} className="ui-field mt-1 w-full" />
    </label> : <>
      <div ref={anchor}>
        <label className="block text-xs">저장 그룹
          <input ref={input} data-modal-autofocus role="combobox" aria-label="저장 그룹" aria-expanded={open} aria-controls={listId}
            aria-autocomplete="list" aria-activedescendant={open && matches.length ? `${listId}-${activeIndex}` : undefined}
            onFocus={event => event.currentTarget.select()} value={open ? query : selected?.name ?? ''} placeholder="그룹 검색 또는 선택"
            onClick={() => { if (!open) { setQuery(''); setActive(0); setOpen(true); } }}
            onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); if (value.group_id) onChange({}); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!open) { setQuery(''); setActive(0); setOpen(true); }
                else setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length));
              }
              if (event.key === 'Enter' && open) { event.preventDefault(); if (matches[activeIndex]) pick(matches[activeIndex].id); }
              if (event.key === 'Tab') close();
            }} className="ui-field mt-1 w-full" />
        </label>
      </div>
      {open && createPortal(<div ref={ref} style={style} id={listId} role="listbox" aria-label="저장 그룹 목록"
        className="ui-popover max-h-48 overflow-y-auto p-1" onMouseDown={event => event.preventDefault()}>
        {matches.length === 0 && <p role="status" className="px-2 py-2 text-xs text-fg-dim">일치하는 그룹이 없습니다</p>}
        {matches.map((group, index) => <div key={group.id} id={`${listId}-${index}`} role="option"
          aria-selected={value.group_id === group.id} onMouseEnter={() => setActive(index)} onClick={() => pick(group.id)}
          className={`ui-menu-item cursor-pointer ${index === activeIndex ? 'bg-tint-selection' : ''}`}>
          <span>{group.name}</span>{value.group_id === group.id && <span aria-hidden>✓</span>}
        </div>)}
      </div>, document.body)}
    </>}
    {allowCreate && <button type="button" className="text-xs text-accent" onClick={() => onChange(creating ? {} : { new_group_name: query })}>
      {creating ? '기존 그룹 선택' : '+ 새 그룹'}
    </button>}
  </div>;
}
