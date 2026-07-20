import { beforeEach, describe, expect, it } from 'vitest';
import * as entryDrag from './entryDrag';
import { useEntryDragStore } from './entryDrag';

function resetEntryDragState() {
  (useEntryDragStore.setState as unknown as (state: Record<string, unknown>) => void)({
    draggingCode: null,
    overChart: false,
    hitTestChart: null,
    overStudy: false,
    hitTestStudy: null,
    dragPoint: null,
    chartDropResolver: null,
    targets: {},
  });
}

describe('entryDrag study drop-target seam', () => {
  beforeEach(() => {
    resetEntryDragState();
  });

  it('returns true from isPointOnChart when a live target is registered', () => {
    const hitTest = (clientX: number, clientY: number) => clientX === 120 && clientY === 64;

    useEntryDragStore.getState().registerChartTarget(hitTest);

    expect(entryDrag.isPointOnChart({ x: 120, y: 64 })).toBe(true);
    expect(entryDrag.isPointOnChart({ x: 121, y: 64 })).toBe(false);
  });

  it('returns true from isPointOnStudy when a study target is registered', () => {
    expect(entryDrag).toHaveProperty('isPointOnStudy');
    const registerStudyTarget = (useEntryDragStore.getState() as unknown as {
      registerStudyTarget?: (hitTest: (clientX: number, clientY: number) => boolean) => void;
    }).registerStudyTarget;
    expect(registerStudyTarget).toBeTypeOf('function');

    const hitTest = (clientX: number, clientY: number) => clientX === 360 && clientY === 240;
    registerStudyTarget?.(hitTest);

    expect((entryDrag as typeof entryDrag & {
      isPointOnStudy: (point: { x: number; y: number } | null) => boolean;
    }).isPointOnStudy({ x: 360, y: 240 })).toBe(true);
    expect((entryDrag as typeof entryDrag & {
      isPointOnStudy: (point: { x: number; y: number } | null) => boolean;
    }).isPointOnStudy({ x: 361, y: 240 })).toBe(false);
  });

  it('clearing one target does not clear the other target', () => {
    expect(entryDrag).toHaveProperty('isPointOnStudy');
    const state = useEntryDragStore.getState() as unknown as {
      registerStudyTarget?: (hitTest: (clientX: number, clientY: number) => boolean) => void;
      clearStudyTarget?: (hitTest: (clientX: number, clientY: number) => boolean) => void;
    };
    expect(state.registerStudyTarget).toBeTypeOf('function');
    expect(state.clearStudyTarget).toBeTypeOf('function');

    const liveHitTest = (clientX: number, clientY: number) => clientX === 100 && clientY === 200;
    const studyHitTest = (clientX: number, clientY: number) => clientX === 300 && clientY === 400;

    useEntryDragStore.getState().registerChartTarget(liveHitTest);
    state.registerStudyTarget?.(studyHitTest);

    useEntryDragStore.getState().clearChartTarget(liveHitTest);
    expect(entryDrag.isPointOnChart({ x: 100, y: 200 })).toBe(false);
    expect((entryDrag as typeof entryDrag & {
      isPointOnStudy: (point: { x: number; y: number } | null) => boolean;
    }).isPointOnStudy({ x: 300, y: 400 })).toBe(true);

    state.clearStudyTarget?.(studyHitTest);
    expect((entryDrag as typeof entryDrag & {
      isPointOnStudy: (point: { x: number; y: number } | null) => boolean;
    }).isPointOnStudy({ x: 300, y: 400 })).toBe(false);
  });
});

describe('entryDrag 창별 정밀 드롭 리졸버 (ADR-0119 PR-D2)', () => {
  beforeEach(() => {
    resetEntryDragState();
  });

  it('리졸버 미등록이면 resolveDropOnChart 는 false(활성 그룹 폴백)', () => {
    expect(entryDrag.resolveDropOnChart({ x: 10, y: 20 }, { code: '005930' })).toBe(false);
  });

  it('null 좌표면 false', () => {
    useEntryDragStore.getState().registerChartDropResolver(() => true);
    expect(entryDrag.resolveDropOnChart(null, { code: '005930' })).toBe(false);
  });

  it('리졸버가 처리하면 true, entry 를 그대로 전달한다', () => {
    let received: { point: { x: number; y: number }; entry: entryDrag.ChartDropEntry } | null = null;
    useEntryDragStore.getState().registerChartDropResolver((point, entry) => {
      received = { point, entry };
      return true;
    });
    expect(entryDrag.resolveDropOnChart({ x: 42, y: 7 }, { code: '000660', name: '하이닉스' })).toBe(true);
    expect(received).toEqual({ point: { x: 42, y: 7 }, entry: { code: '000660', name: '하이닉스' } });
  });

  it('리졸버가 창을 못 찾으면(false 반환) resolveDropOnChart 도 false', () => {
    useEntryDragStore.getState().registerChartDropResolver(() => false);
    expect(entryDrag.resolveDropOnChart({ x: 1, y: 1 }, { code: '005930' })).toBe(false);
  });

  it('clearChartDropResolver 는 자기 fn 일 때만 해제(remount 안전)', () => {
    const a = () => true;
    const b = () => true;
    useEntryDragStore.getState().registerChartDropResolver(a);
    useEntryDragStore.getState().registerChartDropResolver(b); // b 가 덮음
    useEntryDragStore.getState().clearChartDropResolver(a); // 늦은 a cleanup — 무해
    expect(useEntryDragStore.getState().chartDropResolver).toBe(b);
    useEntryDragStore.getState().clearChartDropResolver(b);
    expect(useEntryDragStore.getState().chartDropResolver).toBeNull();
  });

  it('setDragPoint 는 같은 좌표면 no-op(프레임당 호출 방지)', () => {
    useEntryDragStore.getState().setDragPoint({ x: 5, y: 5 });
    let calls = 0;
    const unsub = useEntryDragStore.subscribe(() => { calls += 1; });
    useEntryDragStore.getState().setDragPoint({ x: 5, y: 5 }); // 같은 값
    expect(calls).toBe(0);
    useEntryDragStore.getState().setDragPoint({ x: 6, y: 5 }); // 다른 값
    unsub();
    expect(calls).toBe(1);
  });
});
