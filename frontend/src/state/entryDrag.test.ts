import { beforeEach, describe, expect, it } from 'vitest';
import * as entryDrag from './entryDrag';
import { useEntryDragStore } from './entryDrag';

function resetEntryDragState() {
  (useEntryDragStore.setState as unknown as (state: Record<string, unknown>) => void)({
    draggingCode: null,
    overChart: false,
    hitTestChart: null,
    dragPoint: null,
    chartDropResolver: null,
    targets: {},
  });
}

describe('entryDrag drop-target seam', () => {
  beforeEach(() => {
    resetEntryDragState();
  });

  it('returns true from isPointOnChart when a live target is registered', () => {
    const hitTest = (clientX: number, clientY: number) => clientX === 120 && clientY === 64;

    useEntryDragStore.getState().registerChartTarget(hitTest);

    expect(entryDrag.isPointOnChart({ x: 120, y: 64 })).toBe(true);
    expect(entryDrag.isPointOnChart({ x: 121, y: 64 })).toBe(false);
  });

  // 여기 학습뷰 타깃 케이스 둘이 있었다(2026-08-23 제거) — `isPointOnStudy` 와
  // "한쪽 해제가 다른 쪽을 안 건드린다". `/study` 와 함께 그 축이 사라져 **등록 가능한
  // 타깃이 `liveChart` 하나**가 됐고, 두 케이스 다 재던 성질이 남지 않았다.
  //
  // ⚠ 그 케이스들은 `as unknown as` 캐스트로 스토어에 닿았다 — 그래서 축을 지워도
  // **타입체크가 조용했고** 런타임에서야 깨졌다. 새 케이스를 그 방식으로 쓰지 말 것.
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
