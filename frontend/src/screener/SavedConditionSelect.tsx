import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

/** 페이지와 우측 패널이 공유하는 저장본 선택기. 생성·편집·조회는 호출처가 담당한다. */
export function SavedConditionSelect({ saves, selectedId, onSelect, disabled = false, placeholder = '저장된 조건검색 선택' }: {
  saves: readonly { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const { ref: layerRef, left, top } = useClampedFixedPosition<HTMLDivElement>(rect?.left ?? 0, rect ? rect.bottom + 4 : 0);
  const visible = open && !disabled;
  useDismissablePopover(visible, anchorRef, () => setOpen(false), layerRef);
  const selected = saves.find((s) => s.id === selectedId);
  const normalizedQuery = query.trim().toLocaleLowerCase().replaceAll(/\s+/g, '');
  const filtered = saves.filter((s) => s.name.toLocaleLowerCase().replaceAll(/\s+/g, '').includes(normalizedQuery));
  const activeIndex = Math.max(0, filtered.findIndex((s) => s.id === activeId));
  const active = filtered[activeIndex];
  const activeOptionId = active ? `${listId}-${active.id}` : undefined;
  useEffect(() => {
    if (visible && activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [visible, activeOptionId]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const show = () => {
    setRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setQuery('');
    setActiveId(selectedId ?? saves[0]?.id ?? null);
    setOpen(true);
  };
  const choose = (id: string) => {
    close();
    if (id !== selectedId) onSelect(id);
  };
  return (
    <div ref={anchorRef} className="relative min-w-0 flex-1">
      <button ref={buttonRef} type="button" aria-label="저장한 조건검색 선택"
        aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? listId : undefined}
        disabled={disabled} title={selected?.name ?? placeholder}
        onClick={() => visible ? close() : show()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); }
        }}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg-input px-2 py-1.5 text-sm text-fg hover:bg-bg-input-hover disabled:opacity-50">
        <span className="truncate">{selected?.name ?? placeholder}</span>
        <span aria-hidden="true" className="shrink-0 text-fg-dim">⌄</span>
      </button>
      {visible && rect && createPortal(
        <div ref={layerRef}
          style={{ position: 'fixed', left, top, width: Math.max(rect.width, 280), maxWidth: 'calc(100vw - 16px)' }}
          className="z-50 overflow-hidden rounded-md border border-border-strong bg-bg-card shadow-overlay"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget) && !anchorRef.current?.contains(e.relatedTarget)) setOpen(false);
          }}>
          <div className="border-b border-border p-2">
            <input autoFocus role="combobox" aria-label="조건검색 이름 검색" aria-expanded="true"
              aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
              placeholder="조건검색 이름 검색" value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveId(null); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
                if (e.key === 'Enter') { e.preventDefault(); if (active) choose(active.id); }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const delta = e.key === 'ArrowDown' ? 1 : -1;
                  setActiveId(filtered[(activeIndex + delta + filtered.length) % filtered.length]?.id ?? null);
                }
              }}
              className="w-full rounded-md border border-border bg-bg-input px-2 py-1.5 text-sm text-fg" />
          </div>
          <div id={listId} role="listbox" aria-label="저장한 조건검색" className="max-h-64 overflow-auto py-1">
            {filtered.map((s) => (
              <button key={s.id} id={`${listId}-${s.id}`} type="button" role="option" tabIndex={-1}
                aria-selected={s.id === selectedId} title={s.name}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActiveId(s.id)} onClick={() => choose(s.id)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${
                  s.id === active?.id ? 'bg-bg-input-hover' : ''} ${s.id === selectedId ? 'text-accent' : 'text-fg'}`}>
                <span className="min-w-0 flex-1 break-words">{s.name}</span>
                <span aria-hidden="true" className="w-4 shrink-0">{s.id === selectedId ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          {filtered.length === 0 && <p role="status" className="px-3 py-3 text-sm text-fg-dim">
            {saves.length === 0 ? '저장된 조건검색이 없습니다' : '검색 결과가 없습니다'}
          </p>}
        </div>, document.body,
      )}
    </div>
  );
}
