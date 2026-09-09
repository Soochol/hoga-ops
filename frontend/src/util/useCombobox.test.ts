import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCombobox } from './useCombobox';

type Hit = { code: string };
const ITEMS: Hit[] = [{ code: 'a' }, { code: 'b' }, { code: 'c' }];

function key(k: string) {
  return { key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLInputElement>;
}

function setup(opts: Partial<Parameters<typeof useCombobox<Hit>>[0]> = {}) {
  const onSelect = vi.fn();
  const setQuery = vi.fn();
  const hook = renderHook(() =>
    useCombobox<Hit>({ query: 'x', setQuery, items: ITEMS, onSelect, ...opts }),
  );
  return { hook, onSelect, setQuery };
}

describe('useCombobox', () => {
  it('opens on focus and selects highlighted on Enter', () => {
    const { hook, onSelect } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    expect(hook.result.current.open).toBe(true);
    act(() => hook.result.current.inputProps.onKeyDown(key('ArrowDown')));
    expect(hook.result.current.highlightedIndex).toBe(1);
    act(() => hook.result.current.inputProps.onKeyDown(key('Enter')));
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    expect(hook.result.current.open).toBe(false);
  });

  it('clamps highlight at both ends', () => {
    const { hook } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    act(() => hook.result.current.inputProps.onKeyDown(key('ArrowUp')));
    expect(hook.result.current.highlightedIndex).toBe(0);
    act(() => {
      hook.result.current.inputProps.onKeyDown(key('ArrowDown'));
      hook.result.current.inputProps.onKeyDown(key('ArrowDown'));
      hook.result.current.inputProps.onKeyDown(key('ArrowDown'));
    });
    expect(hook.result.current.highlightedIndex).toBe(2);
  });

  it('closes on Escape', () => {
    const { hook } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    act(() => hook.result.current.inputProps.onKeyDown(key('Escape')));
    expect(hook.result.current.open).toBe(false);
  });

  it('calls onEnterEmpty when no items and suppresses default', () => {
    const onEnterEmpty = vi.fn().mockReturnValue(true);
    const onSelect = vi.fn();
    const ev = key('Enter');
    const hook = renderHook(() =>
      useCombobox<Hit>({ query: '005930', setQuery: vi.fn(), items: [], onSelect, onEnterEmpty }),
    );
    act(() => hook.result.current.inputProps.onKeyDown(ev));
    expect(onEnterEmpty).toHaveBeenCalledWith('005930');
    expect(onSelect).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('cannot produce an invalid selection when results arrive after empty arrow navigation', () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(({ items }: { items: Hit[] }) =>
      useCombobox({ query: 'x', setQuery: vi.fn(), items, onSelect }),
      { initialProps: { items: [] as Hit[] } },
    );
    act(() => result.current.inputProps.onFocus());
    act(() => result.current.inputProps.onKeyDown(key('ArrowDown')));
    rerender({ items: ITEMS });
    expect(result.current.highlightedIndex).toBe(0);
    act(() => result.current.inputProps.onKeyDown(key('Enter')));
    expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);
  });

  it('onChange forwards to setQuery and opens', () => {
    const { hook, setQuery } = setup();
    act(() =>
      hook.result.current.inputProps.onChange({
        target: { value: 'sam' },
      } as React.ChangeEvent<HTMLInputElement>),
    );
    expect(setQuery).toHaveBeenCalledWith('sam');
    expect(hook.result.current.open).toBe(true);
  });

  it('preserves the selected row on refocus, but starts at the first row on reopening', () => {
    const { hook } = setup();
    act(() => hook.result.current.setOpen(true));
    act(() => hook.result.current.inputProps.onKeyDown(key('ArrowDown')));
    act(() => hook.result.current.inputProps.onFocus());
    expect(hook.result.current.highlightedIndex).toBe(1);
    act(() => hook.result.current.setOpen(false));
    act(() => hook.result.current.setOpen(true));
    expect(hook.result.current.highlightedIndex).toBe(0);
  });

  it('getOptionProps wires hover-highlight, aria-selected, and focus-retention', () => {
    const { hook } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    act(() => hook.result.current.getOptionProps(2).onMouseEnter());
    expect(hook.result.current.highlightedIndex).toBe(2);
    expect(hook.result.current.getOptionProps(2)['aria-selected']).toBe(true);
    expect(hook.result.current.getOptionProps(0)['aria-selected']).toBe(false);
    const ev = { preventDefault: vi.fn() } as unknown as React.MouseEvent;
    hook.result.current.getOptionProps(0).onMouseDown(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('resets highlight to 0 when the query changes via onChange', () => {
    const { hook } = setup();
    act(() => hook.result.current.inputProps.onFocus());
    act(() => hook.result.current.inputProps.onKeyDown(key('ArrowDown')));
    expect(hook.result.current.highlightedIndex).toBe(1);
    act(() => hook.result.current.inputProps.onChange({ target: { value: 'sams' } } as React.ChangeEvent<HTMLInputElement>));
    expect(hook.result.current.highlightedIndex).toBe(0);
  });
});
