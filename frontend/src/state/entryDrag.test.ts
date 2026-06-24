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
