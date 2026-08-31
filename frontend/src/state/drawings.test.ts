// frontend/src/state/drawings.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from '../chart/drawing/types';
import { INITIAL_DEFAULTS } from '../chart/drawing/types';
import { DEFAULTS_KEY, drawingScope } from '../chart/drawing/persistence';
import { useDrawingsStore, drawingBarMsFor, drawingScopeFor, slotForTimeframe } from './drawings';
import { MINUTE_TIMEFRAMES } from './livePage';

// 스토어 키는 (종목, 봉 슬롯) scope. A/B 는 서로 다른 종목의 분봉 슬롯이고,
// A_DAILY 는 A 와 같은 종목의 일봉 슬롯 — 슬롯 격리 검증용.
const CODE_A = '005930';
const CODE_B = '003490';
const A = drawingScope(CODE_A, 'minute');
const B = drawingScope(CODE_B, 'minute');
const A_DAILY = drawingScope(CODE_A, 'D');

function mkHline(id: string, price: number): Drawing {
  return { id, kind: 'hline', price, color: '#FFD60A', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
}

beforeEach(() => {
  localStorage.clear();
  useDrawingsStore.getState().__resetForTests();
});

describe('useDrawingsStore — Code partitioning', () => {
  it('starts empty with no activeScope', () => {
    const s = useDrawingsStore.getState();
    expect(s.activeScope).toBeNull();
    expect(s.activeTool).toBe('select');
    expect(s.selectedFor(A)).toBeNull();
    expect(s.drawingsFor(A)).toEqual([]);
  });

  it('add appends to the active Code only', () => {
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
  });

  it('switching activeScope does not move drawings', () => {
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    useDrawingsStore.getState().add(B, mkHline('h2', 200));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(1);
  });

  it('selection is per-code — switching activeScope does not touch a code\'s selection', () => {
    useDrawingsStore.getState().setActiveScope(A);
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    useDrawingsStore.getState().setSelected(A, 'h1');
    expect(useDrawingsStore.getState().selectedFor(A)).toBe('h1');
    // 종목별이라 다른 종목으로 전환해도 A 의 선택은 유지된다(창별 독립 선택).
    useDrawingsStore.getState().setActiveScope(B);
    expect(useDrawingsStore.getState().selectedFor(A)).toBe('h1');
    expect(useDrawingsStore.getState().selectedFor(B)).toBeNull();
  });
});

describe('slotForTimeframe / drawingScopeFor', () => {
  it('collapses every minute frame onto one slot and keeps D/W/M separate', () => {
    for (const tf of MINUTE_TIMEFRAMES) {
      expect(slotForTimeframe(tf)).toBe('minute');
    }
    expect(slotForTimeframe('D')).toBe('D');
    expect(slotForTimeframe('W')).toBe('W');
    expect(slotForTimeframe('M')).toBe('M');
  });

  it('builds a scope per (code, slot) and yields null without a code', () => {
    expect(drawingScopeFor(CODE_A, '5m')).toBe(drawingScopeFor(CODE_A, '30m'));
    expect(drawingScopeFor(CODE_A, '5m')).not.toBe(drawingScopeFor(CODE_A, 'D'));
    expect(drawingScopeFor(CODE_A, 'D')).not.toBe(drawingScopeFor(CODE_B, 'D'));
    expect(drawingScopeFor(null, '1m')).toBeNull();
  });
});

describe('drawingBarMsFor', () => {
  it('passes the bundle bucket through on minute frames', () => {
    expect(drawingBarMsFor('1m', 60_000)).toBe(60_000);
    expect(drawingBarMsFor('5m', 300_000)).toBe(300_000);
    expect(drawingBarMsFor('30m', undefined)).toBeUndefined();
  });

  it('ignores the bundle bucket on D/W/M — it is the hoga range bucket (60s), not the bar pitch', () => {
    // Regression: feeding the bundle's 60 000 to the FutureBand made a
    // whole-band drag on the daily chart span minutes of real time, so every
    // drawing anchored right of the last candle collapsed onto its X.
    expect(drawingBarMsFor('D', 60_000)).toBe(86_400_000);
    expect(drawingBarMsFor('W', 60_000)).toBe(7 * 86_400_000);
    expect(drawingBarMsFor('M', 60_000)).toBe(30 * 86_400_000);
  });
});

describe('useDrawingsStore — timeframe slot partitioning', () => {
  it('drawings on the minute slot do not appear on the same symbol\'s daily slot', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('m1', 100));
    s().add(A_DAILY, mkHline('d1', 200));
    expect(s().drawingsFor(A).map((d) => d.id)).toEqual(['m1']);
    expect(s().drawingsFor(A_DAILY).map((d) => d.id)).toEqual(['d1']);
  });

  it('clearAll on one slot leaves the other slot of the same symbol intact', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('m1', 100));
    s().add(A_DAILY, mkHline('d1', 200));
    s().clearAll(A_DAILY);
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect(s().drawingsFor(A_DAILY)).toHaveLength(0);
  });

  it('undo history is per-slot — Ctrl+Z on minute does not rewind daily', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A_DAILY, mkHline('d1', 200));
    s().add(A, mkHline('m1', 100));
    s().undo(A);
    expect(s().drawingsFor(A)).toHaveLength(0);
    expect(s().drawingsFor(A_DAILY)).toHaveLength(1); // 일봉 히스토리는 무사
  });

  it('selection is per-slot', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('m1', 100));
    s().add(A_DAILY, mkHline('d1', 200));
    s().setSelected(A, 'm1');
    expect(s().selectedFor(A)).toBe('m1');
    expect(s().selectedFor(A_DAILY)).toBeNull();
  });

  it('each slot persists under its own key', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('m1', 100));
    s().add(A_DAILY, mkHline('d1', 200));
    s().flushPending();
    expect(JSON.parse(localStorage.getItem('replay.drawings.v2.005930|minute') as string))
      .toEqual({ v: 1, items: [mkHline('m1', 100)] });
    expect(JSON.parse(localStorage.getItem('replay.drawings.v2.005930|D') as string))
      .toEqual({ v: 1, items: [mkHline('d1', 200)] });
  });
});

describe('useDrawingsStore — mutations', () => {
  it('selection is independent across codes (멀티창 C2c-2 후속)', () => {
    // 다른 종목 창 2개: A 선택이 B 선택에 영향 없음(전역 selectedId 경합 제거).
    useDrawingsStore.getState().add(A, mkHline('a1', 1));
    useDrawingsStore.getState().add(B, mkHline('b1', 2));
    useDrawingsStore.getState().setSelected(A, 'a1');
    useDrawingsStore.getState().setSelected(B, 'b1');
    expect(useDrawingsStore.getState().selectedFor(A)).toBe('a1');
    expect(useDrawingsStore.getState().selectedFor(B)).toBe('b1');
    // A 의 드로잉 제거 → A 선택만 해제, B 유지.
    useDrawingsStore.getState().remove(A, 'a1');
    expect(useDrawingsStore.getState().selectedFor(A)).toBeNull();
    expect(useDrawingsStore.getState().selectedFor(B)).toBe('b1');
  });

  it('mutations target the explicit code regardless of activeScope (멀티창, C2c-2b)', () => {
    // 다른 종목 창 2개: 마지막 마운트 창이 activeScope 를 이겨도(B), A 창의
    // 그리기는 A 로 귀속돼야 한다 — 오귀속 결함의 회귀 가드.
    useDrawingsStore.getState().setActiveScope(B);
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
    useDrawingsStore.getState().undo(A);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(0);
  });

  beforeEach(() => {
    useDrawingsStore.getState().setActiveScope(A);
  });

  it('update patches a drawing by id', () => {
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    useDrawingsStore.getState().update(A, 'h1', { price: 150 } as Partial<Drawing>);
    const found = useDrawingsStore.getState().drawingsFor(A)[0];
    expect((found as { price: number }).price).toBe(150);
  });

  it('remove deletes by id and clears selection if it matched', () => {
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    useDrawingsStore.getState().setSelected(A, 'h1');
    useDrawingsStore.getState().remove(A, 'h1');
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(0);
    expect(useDrawingsStore.getState().selectedFor(A)).toBeNull();
  });

  it('clearAll empties the active Code list only', () => {
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    useDrawingsStore.getState().add(B, mkHline('h2', 200));
    useDrawingsStore.getState().clearAll(B);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
  });
});

describe('useDrawingsStore — persistence integration', () => {
  it('setActiveScope hydrates from localStorage', () => {
    localStorage.setItem(
      'replay.drawings.v2.005930|minute',
      JSON.stringify({ v: 1, items: [mkHline('h1', 100)] }),
    );
    useDrawingsStore.getState().setActiveScope(A);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
  });

  it('flushPending writes the active Code to localStorage', () => {
    useDrawingsStore.getState().add(A, mkHline('h1', 100));
    useDrawingsStore.getState().flushPending();
    const raw = localStorage.getItem('replay.drawings.v2.005930|minute');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ v: 1, items: [mkHline('h1', 100)] });
  });

  // /review audit: per-code debounce isolation. Editing A then switching to
  // B and editing within the debounce window must NOT lose A's edit.
  // Pre-fix, a single shared timer was cancelled by B's edit → A never
  // reached saveDrawings → on reload A's edit was silently lost.
  it('flushPending writes ALL pending codes, not just the most recent', () => {
    useDrawingsStore.getState().add(A, mkHline('a1', 111));
    // Edit B while A's debounce timer is still armed.
    useDrawingsStore.getState().add(B, mkHline('b1', 222));
    useDrawingsStore.getState().flushPending();
    expect(JSON.parse(localStorage.getItem('replay.drawings.v2.005930|minute') as string))
      .toEqual({ v: 1, items: [mkHline('a1', 111)] });
    expect(JSON.parse(localStorage.getItem('replay.drawings.v2.003490|minute') as string))
      .toEqual({ v: 1, items: [mkHline('b1', 222)] });
  });
});

describe('useDrawingsStore — undo/redo (ADR-0107)', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveScope(A);
  });

  it('undo reverts add; redo re-applies it', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    expect(s().drawingsFor(A)).toHaveLength(1);
    s().undo(A);
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().redo(A);
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect((s().drawingsFor(A)[0] as { price: number }).price).toBe(100);
  });

  it('undo reverts remove and clearAll', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().remove(A, 'h1');
    expect(s().drawingsFor(A)).toHaveLength(1);
    s().undo(A);
    expect(s().drawingsFor(A)).toHaveLength(2);
    s().clearAll(A);
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().undo(A);
    expect(s().drawingsFor(A)).toHaveLength(2);
  });

  it('a new mutation clears the redo stack', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().undo(A);
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().add(A, mkHline('h2', 200)); // new mutation → redo dropped
    s().redo(A); // no-op
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect((s().drawingsFor(A)[0] as { id: string }).id).toBe('h2');
  });

  it('consecutive same-target updates collapse into one undo step', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    // Simulate a drag: many updates to the same id in quick succession.
    for (let p = 101; p <= 130; p++) s().update(A, 'h1', { price: p } as Partial<Drawing>);
    expect((s().drawingsFor(A)[0] as { price: number }).price).toBe(130);
    // One undo should return to the pre-drag price (the add), not step through
    // every intermediate frame.
    s().undo(A);
    expect((s().drawingsFor(A)[0] as { price: number }).price).toBe(100);
  });

  it('undo is per-code and a no-op with empty history', () => {
    const s = () => useDrawingsStore.getState();
    s().undo(A); // empty → no throw, no change
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().add(A, mkHline('a1', 1));
    s().undo(B); // B has no history → does not touch A
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect(s().drawingsFor(B)).toHaveLength(0);
  });

  it('undo clears selection when the selected id disappears', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().setSelected(A, 'h1');
    s().undo(A); // h1 removed by undo → selection must clear
    expect(s().selectedFor(A)).toBeNull();
  });

  it('undo/redo persist to localStorage', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().undo(A);
    s().flushPending();
    expect(JSON.parse(localStorage.getItem('replay.drawings.v2.005930|minute') as string))
      .toEqual({ v: 1, items: [] });
  });
});

describe('useDrawingsStore — clearAll 확인 팝업', () => {
  const s = () => useDrawingsStore.getState();

  it('requestClearAll 은 지우지 않고 확인 슬롯만 채운다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().requestClearAll(A);

    expect(s().clearConfirm).toEqual({ scope: A, count: 2, lockedCount: 0 });
    expect(s().drawingsFor(A)).toHaveLength(2); // 확인 전엔 그대로
    expect(s().clearToast).toBeNull(); // 삭제가 없었으니 토스트도 없다
  });

  // 빈 목록에 "정말 지울까요" 를 묻는 팝업은 사용자에게 아무 선택도 주지 않는다.
  it('지울 게 없으면 팝업을 띄우지 않는다', () => {
    s().requestClearAll(A);
    expect(s().clearConfirm).toBeNull();
  });

  it('cancelClearAll 은 슬롯만 비우고 드로잉은 살려둔다', () => {
    s().add(A, mkHline('h1', 100));
    s().requestClearAll(A);
    s().cancelClearAll();

    expect(s().clearConfirm).toBeNull();
    expect(s().drawingsFor(A)).toHaveLength(1);
  });

  it('clearAll 이 실행되면 확인 슬롯이 닫히고 실행취소 토스트로 넘어간다', () => {
    s().add(A, mkHline('h1', 100));
    s().requestClearAll(A);
    s().clearAll(A);

    expect(s().clearConfirm).toBeNull();
    expect(s().drawingsFor(A)).toHaveLength(0);
    expect(s().clearToast).toMatchObject({ scope: A, count: 1 });
  });

  // 팝업이 떠 있는 사이 다른 창이 Ctrl+Z 로 비워버리면 clearAll 은 조기 반환한다.
  // 그때 슬롯을 안 닫으면 확인 버튼이 아무 일도 못 하는 채로 남는다.
  it('빈 목록으로 조기 반환해도 확인 슬롯은 닫는다', () => {
    // 팝업이 떠 있는 사이 다른 창이 Ctrl+Z 로 이미 비워버린 상황 — 슬롯을 직접
    // 채워 재현한다(requestClearAll 은 빈 목록엔 슬롯을 안 연다).
    useDrawingsStore.setState({ clearConfirm: { scope: A, count: 1, lockedCount: 0 } });
    s().clearAll(A);

    expect(s().clearConfirm).toBeNull();
  });

  it('요청한 scope 만 지운다 — 다른 종목·다른 봉은 무사하다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(B, mkHline('h2', 200));
    s().add(A_DAILY, mkHline('h3', 300));
    s().requestClearAll(A);
    s().clearAll(s().clearConfirm!.scope);

    expect(s().drawingsFor(A)).toHaveLength(0);
    expect(s().drawingsFor(B)).toHaveLength(1);
    expect(s().drawingsFor(A_DAILY)).toHaveLength(1);
  });
});

describe('useDrawingsStore — clearAll undo-toast', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveScope(A);
  });

  it('clearAll on an empty list is a no-op and shows no toast', () => {
    const s = () => useDrawingsStore.getState();
    s().clearAll(A);
    expect(s().clearToast).toBeNull();
  });

  it('clearAll surfaces a toast with the pre-clear snapshot', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().clearAll(A);
    expect(s().clearToast).toMatchObject({ scope: A, count: 2 });
    expect(s().clearToast?.snapshot).toHaveLength(2);
  });

  it('restore brings back the snapshot and is itself undoable', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().clearAll(A);
    const snap = s().clearToast!.snapshot;
    s().restore(A, snap);
    expect(s().drawingsFor(A)).toHaveLength(1);
    s().undo(A); // undo the restore
    expect(s().drawingsFor(A)).toHaveLength(0);
  });

  it('restore targets the given code even after switching away', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().clearAll(A);
    const snap = s().clearToast!.snapshot;
    s().setActiveScope(B); // user navigates away while the toast is up
    s().restore(A, snap);
    expect(s().drawingsFor(A)).toHaveLength(1);
  });

  it('dismissClearToast clears the slot', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('h1', 100));
    s().clearAll(A);
    s().dismissClearToast();
    expect(s().clearToast).toBeNull();
  });
});

describe('useDrawingsStore — importDrawings', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveScope(A);
  });

  it('appends imported items with fresh ids as one undoable step', () => {
    const s = () => useDrawingsStore.getState();
    s().add(A, mkHline('existing', 100));
    const n = s().importDrawings(A, [mkHline('existing', 200), mkHline('existing', 300)]);
    expect(n).toBe(2);
    const items = s().drawingsFor(A);
    expect(items).toHaveLength(3);
    // ids were reassigned — no collision with the pre-existing 'existing'.
    expect(new Set(items.map((d) => d.id)).size).toBe(3);
    // one undo removes the whole import
    s().undo(A);
    expect(s().drawingsFor(A)).toHaveLength(1);
  });

  it('is a no-op with an empty list', () => {
    const s = () => useDrawingsStore.getState();
    expect(s().importDrawings(A, [])).toBe(0);
    expect(s().drawingsFor(A)).toHaveLength(0);
  });
});

describe('useDrawingsStore — defaults', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawingsStore.getState().__resetForTests();
  });

  it('exposes INITIAL_DEFAULTS when no persisted defaults exist', () => {
    expect(useDrawingsStore.getState().defaults).toEqual(INITIAL_DEFAULTS);
  });

  it('setDefaults patches and persists the session flags', () => {
    useDrawingsStore.getState().setDefaults({ magnet: true });
    expect(useDrawingsStore.getState().defaults.magnet).toBe(true);
    useDrawingsStore.getState().flushPending();
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY)!);
    expect(raw.value.magnet).toBe(true);
  });

  it('setKindStyle patches one kind slot and persists', () => {
    useDrawingsStore.getState().setKindStyle('hline', { color: '#F43F5E' });
    expect(useDrawingsStore.getState().styleForKind('hline').color).toBe('#F43F5E');
    useDrawingsStore.getState().flushPending();
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY)!);
    expect(raw.value.styleByKind.hline.color).toBe('#F43F5E');
  });

  it('update(id, patch) syncs color/width/lineStyle into that kind slot', () => {
    const s = useDrawingsStore.getState();
    s.setActiveScope(A);
    const d: Drawing = {
      id: 'a', kind: 'hline', price: 1000,
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    };
    s.add(A, d);
    s.update(A, 'a', { color: '#10B981', width: 3, lineStyle: 'dashed' });
    expect(useDrawingsStore.getState().styleForKind('hline')).toMatchObject({
      color: '#10B981', width: 3, lineStyle: 'dashed',
    });
  });

  it('per-kind isolation: editing an hline never touches the rect slot', () => {
    const s = useDrawingsStore.getState();
    s.setActiveScope(A);
    s.add(A, { id: 'a', kind: 'hline', price: 1000,
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
    const rectBefore = { ...useDrawingsStore.getState().styleForKind('rect') };
    s.update(A, 'a', { color: '#10B981', width: 4 });
    expect(useDrawingsStore.getState().styleForKind('hline')).toMatchObject({ color: '#10B981', width: 4 });
    expect(useDrawingsStore.getState().styleForKind('rect')).toEqual(rectBefore);
  });

  it('update(id, {fontSize}) syncs the text size into the text slot (sticky)', () => {
    const s = useDrawingsStore.getState();
    s.setActiveScope(A);
    s.add(A, {
      id: 't', kind: 'text', at: { realMs: 1_700_000_000_000, price: 1000 },
      text: 'hi', fontSize: 13, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    });
    s.update(A, 't', { fontSize: 20 } as Partial<Drawing>);
    expect(useDrawingsStore.getState().styleForKind('text').fontSize).toBe(20);
  });

  it('update(id, {fillOpacity}) syncs the rect fill into the rect slot (sticky)', () => {
    const s = useDrawingsStore.getState();
    s.setActiveScope(A);
    s.add(A, {
      id: 'r', kind: 'rect',
      a: { realMs: 1_700_000_000_000, price: 1000 }, b: { realMs: 1_700_000_100_000, price: 1100 },
      fillOpacity: 0.1, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    });
    s.update(A, 'r', { fillOpacity: 0.35 } as Partial<Drawing>);
    expect(useDrawingsStore.getState().styleForKind('rect').fillOpacity).toBe(0.35);
  });

  it('update with no style fields does not touch defaults', () => {
    const s = useDrawingsStore.getState();
    s.setActiveScope(A);
    s.add(A, { id: 'a', kind: 'hline', price: 1000,
            color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
    const before = { ...useDrawingsStore.getState().defaults };
    s.update(A, 'a', { price: 1500 });
    expect(useDrawingsStore.getState().defaults).toEqual(before);
  });
});

/**
 * 스코프 캐시 상한 (2026-07-29).
 *
 * 스코프는 `${code}|${slot}` 이라 종목·타임프레임을 옮겨 다닌 만큼 늘어나는데
 * 버리는 경로가 없었다. 캐시라 버려도 재방문 시 localStorage 에서 다시 읽지만,
 * **저장 대기 중이거나 내용이 있는 스코프를 버리면 그림이 사라진다** — 아래 두
 * 테스트가 그 경계를 고정한다.
 */
describe('useDrawingsStore — 스코프 캐시 상한', () => {
  const scopeAt = (i: number) => drawingScope(String(100000 + i), 'minute');

  it('빈 스코프를 많이 방문해도 캐시가 무한히 자라지 않는다', () => {
    const store = useDrawingsStore.getState();
    for (let i = 0; i < 40; i += 1) store.setActiveScope(scopeAt(i));

    const { byScope, loadedScopes } = useDrawingsStore.getState();
    expect(byScope.size).toBeLessThanOrEqual(16);
    // loadedScopes 도 같이 줄어야 한다 — 남으면 재방문 시 재적재를 건너뛰고
    // byScope 에 없는 스코프를 빈 것으로 오인한다.
    expect(loadedScopes.size).toBe(byScope.size);
  });

  it('도형이 있는 스코프는 상한을 넘겨도 절대 버리지 않는다', () => {
    const store = useDrawingsStore.getState();
    const kept = scopeAt(0);
    store.setActiveScope(kept);
    store.add(kept, mkHline('h1', 100));

    for (let i = 1; i < 40; i += 1) useDrawingsStore.getState().setActiveScope(scopeAt(i));

    expect(useDrawingsStore.getState().drawingsFor(kept)).toHaveLength(1);
  });

  it('저장 대기 중인 스코프는 비어 보여도 버리지 않는다 (지연 저장이 빈 배열을 쓰는 것 방지)', () => {
    const store = useDrawingsStore.getState();
    const pending = scopeAt(0);
    store.setActiveScope(pending);
    store.add(pending, mkHline('h1', 100));
    // 전부 지우면 배열은 비지만 저장은 아직 대기 중이다. 이 순간 캐시에서 축출하면
    // 디바운스 콜백이 `byScope.get(scope) ?? []` 를 읽어 빈 배열을 저장하는데,
    // 그 시점 스토어에 스코프가 없으면 "지웠다" 가 아니라 "몰라서 비었다" 가 된다.
    store.remove(pending, 'h1');

    for (let i = 1; i < 40; i += 1) useDrawingsStore.getState().setActiveScope(scopeAt(i));

    expect(useDrawingsStore.getState().byScope.has(pending)).toBe(true);
  });
});

// ── 잠금 (ADR-0164) ────────────────────────────────────────────────────────
describe('useDrawingsStore — 잠금', () => {
  const s = () => useDrawingsStore.getState();

  /** 잠긴 hline 하나만 있는 scope A 를 만든다. */
  function seedLocked(id = 'h1'): void {
    s().add(A, mkHline(id, 100));
    s().update(A, id, { locked: true });
  }

  it('잠긴 드로잉은 update 를 거부한다', () => {
    seedLocked();
    s().update(A, 'h1', { color: '#FFFFFF' });

    expect(s().drawingsFor(A)[0].color).toBe('#FFD60A');
  });

  it('잠긴 드로잉은 remove 를 거부한다', () => {
    seedLocked();
    s().remove(A, 'h1');

    expect(s().drawingsFor(A)).toHaveLength(1);
  });

  it('키가 locked 뿐인 패치는 통과한다 — 잠금 해제의 유일한 통로', () => {
    seedLocked();
    s().update(A, 'h1', { locked: false });

    expect(s().drawingsFor(A)[0].locked).toBe(false);
    // 풀렸으니 이제 평범한 편집이 먹는다.
    s().update(A, 'h1', { color: '#FFFFFF' });
    expect(s().drawingsFor(A)[0].color).toBe('#FFFFFF');
  });

  // locked 를 끼워 넣어 편집을 무임승차시키는 경로를 막는다. 통과시키면 사용자는
  // 잠긴 상태에서 색이 바뀌는 것을 보게 된다.
  it('locked 에 다른 키가 섞인 패치는 거부한다', () => {
    seedLocked();
    s().update(A, 'h1', { locked: false, color: '#FFFFFF' } as Partial<Drawing>);

    expect(s().drawingsFor(A)[0].locked).toBe(true);
    expect(s().drawingsFor(A)[0].color).toBe('#FFD60A');
  });

  // ⚠ 이 테스트가 이 기능의 핵심 함정을 지킨다. 잠금 검사가 recordHistory 뒤로
  // 가면 거부된 편집마다 undo 스냅샷이 쌓이고 redo 스택이 비워진다 — 잠긴 선에
  // 색을 몇 번 누른 것만으로 Ctrl+Shift+Z 가 죽는데 화면엔 아무 단서도 없다.
  it('거부된 편집은 redo 스택을 비우지 않는다', () => {
    // h1 을 먼저 잠근 뒤 redo 항목을 만든다 — 잠그기 자체는 정당한 변이라
    // recordHistory 를 타고 redo 를 비우므로, 순서가 반대면 이 테스트는 잠금이
    // 아니라 잠그기를 재게 된다.
    s().add(A, mkHline('h1', 100));
    s().update(A, 'h1', { locked: true });
    s().add(A, mkHline('h2', 200));
    s().undo(A); // h2 제거 → redo 스택에 1개
    expect(s().drawingsFor(A).map((d) => d.id)).toEqual(['h1']);

    s().update(A, 'h1', { color: '#FFFFFF' }); // 거부됨
    s().remove(A, 'h1'); // 거부됨

    // 게이트가 recordHistory 뒤에 있으면 위 두 줄이 redo 를 비워 h2 가 안 온다.
    s().redo(A);
    expect(s().drawingsFor(A).map((d) => d.id)).toEqual(['h1', 'h2']);
  });

  it('거부된 편집은 undo 스택에도 쌓이지 않는다', () => {
    seedLocked();
    s().update(A, 'h1', { color: '#FFFFFF' }); // 거부됨
    s().update(A, 'h1', { width: 9 }); // 거부됨
    s().remove(A, 'h1'); // 거부됨

    // 쓰레기 스냅샷이 쌓였다면 첫 undo 는 "잠긴 상태 → 잠긴 상태" 라 잠금이
    // 안 풀린다. 한 번의 undo 가 곧장 잠그기 직전으로 가야 한다.
    s().undo(A);
    expect(s().drawingsFor(A)[0].locked).toBeUndefined();
  });

  it('거부된 패치는 per-kind 스타일 기본값도 건드리지 않는다', () => {
    seedLocked();
    const before = s().styleForKind('hline').color;
    s().update(A, 'h1', { color: '#FFFFFF' });

    expect(s().styleForKind('hline').color).toBe(before);
  });

  // 잠그기 자체는 평범한 update 라 되돌릴 수 있어야 한다. 못 되돌리면 실수로
  // 잠근 것이 Ctrl+Z 로 안 풀린다.
  it('잠그기 자체는 되돌릴 수 있다', () => {
    seedLocked();
    s().undo(A);

    expect(s().drawingsFor(A)[0].locked).toBeUndefined();
  });

  it('모두 지우기는 잠긴 것을 남긴다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().update(A, 'h2', { locked: true });
    s().clearAll(A);

    expect(s().drawingsFor(A).map((d) => d.id)).toEqual(['h2']);
    // 토스트 개수는 **실제로 지운 수**다.
    expect(s().clearToast).toMatchObject({ scope: A, count: 1 });
  });

  it('모두 지우기 실행취소는 잠긴 것을 중복 부활시키지 않는다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().update(A, 'h2', { locked: true });
    s().clearAll(A);
    s().restore(A, s().clearToast!.snapshot);

    expect(s().drawingsFor(A).map((d) => d.id)).toEqual(['h1', 'h2']);
  });

  it('requestClearAll 은 지워질 개수만 세고 잠긴 개수를 따로 보고한다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().update(A, 'h2', { locked: true });
    s().requestClearAll(A);

    expect(s().clearConfirm).toEqual({ scope: A, count: 1, lockedCount: 1 });
  });

  it('전부 잠겼으면 확인 팝업을 아예 열지 않는다', () => {
    seedLocked();
    s().requestClearAll(A);

    expect(s().clearConfirm).toBeNull();
  });

  // 살아남은 잠긴 도형이 선택돼 있었다면 그 선택은 유효하다. 무조건 해제하면
  // 속성 패널이 사라지는데, 그 패널의 자물쇠가 잠금 해제의 유일한 경로다.
  it('모두 지우기 뒤에도 살아남은 도형의 선택은 유지된다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().update(A, 'h2', { locked: true });
    s().setSelected(A, 'h2');
    s().clearAll(A);

    expect(s().selectedFor(A)).toBe('h2');
  });

  it('지워진 도형이 선택돼 있었다면 선택은 해제된다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().update(A, 'h2', { locked: true });
    s().setSelected(A, 'h1');
    s().clearAll(A);

    expect(s().selectedFor(A)).toBeNull();
  });

  // undo/redo/restore/import 는 배열 통째 교체라 잠금을 보지 않는다 — 항목별
  // 게이트가 구조적으로 성립하지 않는다(ADR-0164).
  it('restore 는 잠금을 무시하고 배열을 통째로 교체한다', () => {
    s().add(A, mkHline('h1', 100));
    s().update(A, 'h1', { locked: true });
    s().restore(A, []); // 잠금을 무시하고 통째 교체

    expect(s().drawingsFor(A)).toEqual([]);
  });
});

// ── 일괄 잠금 (ADR-0164 후속) ──────────────────────────────────────────────
describe('useDrawingsStore — setLockedAll', () => {
  const s = () => useDrawingsStore.getState();

  function seedThree() {
    s().add(A, mkHline('h1', 100));
    s().add(A, mkHline('h2', 200));
    s().add(A, mkHline('h3', 300));
  }

  it('전부 잠근다', () => {
    seedThree();
    s().setLockedAll(A, true);

    expect(s().drawingsFor(A).map((d) => d.locked)).toEqual([true, true, true]);
  });

  it('부분 잠금 상태에서도 나머지를 마저 잠근다', () => {
    seedThree();
    s().update(A, 'h2', { locked: true });
    s().setLockedAll(A, true);

    expect(s().drawingsFor(A).every((d) => d.locked === true)).toBe(true);
  });

  // 해제는 `locked: false` 를 남기지 않고 **필드를 지운다** — 부재가 곧 "잠금 없음"
  // 이라는 스키마의 표현이고, 둘 다 쓰면 같은 뜻이 두 가지로 저장된다.
  it('해제는 필드를 남기지 않고 지운다', () => {
    seedThree();
    s().setLockedAll(A, true);
    s().setLockedAll(A, false);

    for (const d of s().drawingsFor(A)) expect('locked' in d).toBe(false);
  });

  // ⚠ 이 액션의 존재 이유. 항목마다 update 를 부르면 20개를 잠근 뒤 Ctrl+Z 를
  // 20번 눌러야 한다.
  it('되돌리기 한 단계로 묶인다', () => {
    seedThree();
    s().setLockedAll(A, true);
    s().undo(A);

    expect(s().drawingsFor(A).every((d) => d.locked === undefined)).toBe(true);
  });

  it('바뀔 것이 없으면 이력을 남기지 않는다', () => {
    seedThree();
    s().setLockedAll(A, true);
    s().setLockedAll(A, true); // no-op 이어야 한다
    s().undo(A);

    // 빈 단계가 쌓였다면 이 undo 가 그 빈 단계를 먹고 잠금이 남아 있다.
    expect(s().drawingsFor(A).every((d) => d.locked === undefined)).toBe(true);
  });

  it('빈 scope 에서는 아무 일도 하지 않는다', () => {
    s().setLockedAll(A, true);
    expect(s().drawingsFor(A)).toEqual([]);
  });

  it('요청한 scope 만 잠근다', () => {
    s().add(A, mkHline('h1', 100));
    s().add(B, mkHline('h2', 200));
    s().setLockedAll(A, true);

    expect(s().drawingsFor(A)[0].locked).toBe(true);
    expect(s().drawingsFor(B)[0].locked).toBeUndefined();
  });

  // 일괄 잠금 뒤엔 개별 편집이 전부 막혀야 한다 — 게이트를 우회하지 않는다는 확인.
  it('일괄 잠금 뒤 개별 편집·삭제가 막힌다', () => {
    seedThree();
    s().setLockedAll(A, true);
    s().update(A, 'h1', { color: '#FFFFFF' });
    s().remove(A, 'h2');

    expect(s().drawingsFor(A)).toHaveLength(3);
    expect(s().drawingsFor(A)[0].color).toBe('#FFD60A');
  });
});
