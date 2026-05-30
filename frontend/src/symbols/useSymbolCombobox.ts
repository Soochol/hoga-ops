import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseSymbolComboboxOptions<T> {
  /** Owned by the consumer — items derive from it via a separate data hook. */
  query: string;
  setQuery: (q: string) => void;
  items: T[];
  onSelect: (item: T) => void;
  /** Enter with no items: return true if handled (suppresses default). */
  onEnterEmpty?: (query: string) => boolean;
}

export interface UseSymbolComboboxResult<T> {
  open: boolean;
  setOpen: (o: boolean) => void;
  highlightedIndex: number;
  inputRef: React.RefObject<HTMLInputElement>;
  inputProps: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onFocus: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  };
  getOptionProps: (index: number) => {
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseEnter: () => void;
    'aria-selected': boolean;
  };
  listProps: { role: 'listbox' };
}

export function useSymbolCombobox<T>({
  query, setQuery, items, onSelect, onEnterEmpty,
}: UseSymbolComboboxOptions<T>): UseSymbolComboboxResult<T> {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset highlight whenever the query changes (mirrors capture SymbolSearch).
  useEffect(() => { setHighlightedIndex(0); }, [query]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (open && items.length > 0) {
        e.preventDefault();
        const item = items[Math.min(highlightedIndex, items.length - 1)];
        onSelect(item);
        setOpen(false);
        return;
      }
      if (onEnterEmpty?.(query)) { e.preventDefault(); }
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, items, highlightedIndex, onSelect, onEnterEmpty, query]);

  return {
    open, setOpen, highlightedIndex, inputRef,
    inputProps: {
      value: query,
      onChange: (e) => { setQuery(e.target.value); setOpen(true); },
      onFocus: () => setOpen(true),
      onKeyDown,
    },
    getOptionProps: (index) => ({
      onMouseDown: (e) => e.preventDefault(),  // keep focus; click fires before blur
      onMouseEnter: () => setHighlightedIndex(index),
      'aria-selected': index === highlightedIndex,
    }),
    listProps: { role: 'listbox' },
  };
}
