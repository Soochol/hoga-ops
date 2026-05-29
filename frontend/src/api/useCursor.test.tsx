import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCursor } from './useCursor';
import { useTabsStore } from '../state/tabs';

/**
 * Regression: useCursor used to hard-code `date` to `selection.fromDate`,
 * which broke the spot-data fetches when the cursor lived on a different
 * Stock-Date in a multi-day range — the backend's cursor_to_native rejected
 * the (date, t) pair with HTTPException(400) and useSpot.catch swallowed
 * the error, leaving the 10호가 / 거래원 cards stuck at "커서 위치
 * 로딩 중…". The fix derives `date` from `cursorMs` itself via KST.
 */
describe('useCursor', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('returns nulls when there is no selection or cursor', () => {
    const { result } = renderHook(() => useCursor());
    expect(result.current.code).toBeNull();
    expect(result.current.date).toBeNull();
    expect(result.current.cursorMs).toBeNull();
  });

  it('derives `date` from cursorMs (NOT from selection.fromDate) on multi-day ranges', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260518',
      toDate: '20260522',
      timeframe: '1m',
    });
    // Cursor lands at 2026-05-22 12:00 KST = 2026-05-22 03:00 UTC.
    const cursorMs = Date.UTC(2026, 4, 22, 3, 0, 0);
    useTabsStore.getState().setCursor(id, cursorMs);

    const { result } = renderHook(() => useCursor());
    expect(result.current.code).toBe('005930');
    expect(result.current.cursorMs).toBe(cursorMs);
    // The regression target: date must reflect the day cursorMs falls into,
    // not the range's fromDate. Pre-fix this would have been '20260518'.
    expect(result.current.date).toBe('20260522');
  });

  it('returns null date when cursor is unset even if selection is present', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260518',
      toDate: '20260522',
      timeframe: '1m',
    });
    // No setCursor — cursorMs stays null.
    const { result } = renderHook(() => useCursor());
    expect(result.current.cursorMs).toBeNull();
    // Without a cursor we can't pick a date — caller guards on this triple.
    expect(result.current.date).toBeNull();
  });

  it('keeps reference identity stable when unrelated store fields change', () => {
    // Without useShallow the selector returns a fresh object literal on every
    // store update, so any pref toggle (settings modal, MA edits) re-renders
    // every sidebar card subscribed via useCursor. Regression guard: the
    // returned object must be ===-equal when neither cursor nor selection
    // changed, even after an unrelated mutation.
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260518',
      toDate: '20260522',
      timeframe: '1m',
    });
    useTabsStore.getState().setCursor(id, Date.UTC(2026, 4, 22, 3, 0, 0));

    const { result, rerender } = renderHook(() => useCursor());
    const before = result.current;
    // Trigger a store mutation that does NOT touch tabs/cursor (a no-op
    // setSelection with the same shape).
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260518',
      toDate: '20260522',
      timeframe: '1m',
    });
    rerender();
    expect(result.current).toBe(before);
  });

  it('respects the KST calendar boundary (UTC 15:00 of N-1 = KST 00:00 of N)', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260519',
      toDate: '20260520',
      timeframe: '1m',
    });
    // KST midnight on 2026-05-20 = UTC 15:00 on 2026-05-19. One ms earlier
    // is still 2026-05-19 in KST.
    const justBeforeKstMidnight = Date.UTC(2026, 4, 19, 15, 0, 0) - 1;
    useTabsStore.getState().setCursor(id, justBeforeKstMidnight);
    const { result } = renderHook(() => useCursor());
    expect(result.current.date).toBe('20260519');
  });
});
