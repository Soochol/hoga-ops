import { useCallback, useRef, useState } from 'react';
import { useDismissablePopover } from './useDismissablePopover';

export interface UseComboboxOptions<T> {
  /** Owned by the consumer — items derive from it via a separate data hook. */
  query: string;
  setQuery: (q: string) => void;
  items: T[];
  onSelect: (item: T) => void;
  /** Enter with no items: return true if handled (suppresses default). */
  onEnterEmpty?: (query: string) => boolean;
}

export interface UseComboboxResult {
  open: boolean;
  setOpen: (o: boolean) => void;
  highlightedIndex: number;
  inputRef: React.RefObject<HTMLInputElement>;
  wrapperRef: React.RefObject<HTMLDivElement>;
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

export function useCombobox<T>({
  query, setQuery, items, onSelect, onEnterEmpty,
}: UseComboboxOptions<T>): UseComboboxResult {
  const [open, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const setOpen = useCallback((nextOpen: boolean) => {
    setIsOpen(nextOpen);
    if (nextOpen) setHighlightedIndex(0);
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const activeIndex = items.length === 0 ? -1 : Math.max(0, Math.min(highlightedIndex, items.length - 1));

  // Keep the parent layer's lifetime stable while a result's portal menu opens.
  const dismiss = useCallback(() => setOpen(false), [setOpen]);
  useDismissablePopover(open, wrapperRef, dismiss);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter may commit a Hangul syllable rather than choose a result. Safari can
    // report compositionend before that keydown, with keyCode 229 still set.
    if (e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return;
    if (e.key === 'Enter') {
      if (open && items.length > 0) {
        e.preventDefault();
        const item = items[activeIndex];
        onSelect(item);
        setOpen(false);
        return;
      }
      if (onEnterEmpty?.(query)) { e.preventDefault(); setOpen(false); }
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((h) => Math.max(0, Math.min(h + 1, items.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((h) => Math.max(Math.min(h, items.length - 1) - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, items, activeIndex, onSelect, onEnterEmpty, query, setOpen]);

  return {
    open, setOpen, highlightedIndex: activeIndex, inputRef, wrapperRef,
    inputProps: {
      value: query,
      onChange: (e) => { setQuery(e.target.value); setOpen(true); setHighlightedIndex(0); },
      onFocus: () => { if (!open) setOpen(true); },
      onKeyDown,
    },
    getOptionProps: (index) => ({
      onMouseDown: (e) => e.preventDefault(),  // keep focus; click fires before blur
      onMouseEnter: () => setHighlightedIndex(index),
      'aria-selected': index === activeIndex,
    }),
    listProps: { role: 'listbox' },
  };
}
