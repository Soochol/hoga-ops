import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { toFrac } from '../../workspace/rectSpace';
import type { Edge, Rect } from '../../workspace/snapEngine';

// 창 내용만 대체하고 실제 프레임·핸들·캔버스·스토어를 함께 검증한다.
vi.mock('./ChartWindow', () => ({ ChartWindow: () => <div>chart</div> }));
vi.mock('./DataWindow', () => ({ DataWindow: () => <div>data</div> }));
vi.mock('./TitleBarSymbolRow', () => ({ TitleBarSymbolRow: () => <div>symbol</div> }));
vi.mock('../useEffectiveVenue', () => ({ useNxtEnabledResolver: () => () => undefined }));

const CANVAS = { w: 1000, h: 800 };
const ORIGIN: Rect = { x: 300, y: 250, w: 240, h: 200 };
// 이웃은 최소 크기다. 동시 리사이즈가 남아 있으면 타겟을 늘릴 수 없다.
const NEIGHBORS: Record<Edge, Rect> = {
  e: { x: 540, y: 250, w: 160, h: 200 },
  w: { x: 140, y: 250, w: 160, h: 200 },
  s: { x: 300, y: 450, w: 240, h: 120 },
  n: { x: 300, y: 130, w: 240, h: 120 },
};

function expectRect(frame: HTMLElement, rect: Rect) {
  expect(frame).toHaveStyle({
    left: `${rect.x}px`, top: `${rect.y}px`,
    width: `${rect.w}px`, height: `${rect.h}px`,
  });
}

function setup(edge: Edge = 'e') {
  const neighbor: WorkspaceWindow = { id: 'neighbor', kind: 'book', group: 1, rect: toFrac(NEIGHBORS[edge], CANVAS) };
  useWorkspaceStore.setState({
    windows: [
      { id: 'target', kind: 'book', group: 1, rect: toFrac(ORIGIN, CANVAS) },
      neighbor,
    ],
    zOrder: ['neighbor', 'target'],
    groupSymbols: {}, maximizedId: null, pendingNormalize: false,
  });
  const { container } = render(<WorkspaceCanvas />);
  const targetFrame = container.querySelector<HTMLElement>('[data-win="target"]')!;
  const neighborFrame = container.querySelector<HTMLElement>('[data-win="neighbor"]')!;
  const handle = targetFrame.querySelector<HTMLElement>(`[data-handle="${edge}"]`)!;
  const canvas = targetFrame.parentElement!;
  const down = () => fireEvent.pointerDown(handle, { pointerId: 1, buttons: 1, clientX: 500, clientY: 400 });
  const move = (dx: number, dy: number, altKey = false) => fireEvent.pointerMove(canvas, {
    pointerId: 1, buttons: 1, clientX: 500 + dx, clientY: 400 + dy, altKey,
  });
  const up = () => fireEvent.pointerUp(canvas, { pointerId: 1 });
  return { targetFrame, neighborFrame, neighbor, canvas, down, move, up };
}

describe('live 창 경계 — 자석 유지, 대상 창만 리사이즈', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(CANVAS.w);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(CANVAS.h);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, CANVAS.w, CANVAS.h),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    { edge: 'e' as const, dx: 60, dy: 0, expected: { ...ORIGIN, w: 300 } },
    { edge: 'w' as const, dx: -60, dy: 0, expected: { ...ORIGIN, x: 240, w: 300 } },
    { edge: 's' as const, dx: 0, dy: 60, expected: { ...ORIGIN, h: 260 } },
    { edge: 'n' as const, dx: 0, dy: -60, expected: { ...ORIGIN, y: 190, h: 260 } },
    { edge: 'e' as const, dx: -60, dy: 0, expected: { ...ORIGIN, w: 180 } },
    { edge: 'w' as const, dx: 60, dy: 0, expected: { ...ORIGIN, x: 360, w: 180 } },
    { edge: 's' as const, dx: 0, dy: -60, expected: { ...ORIGIN, h: 140 } },
    { edge: 'n' as const, dx: 0, dy: 60, expected: { ...ORIGIN, y: 310, h: 140 } },
  ])('$edge 변 ($dx, $dy) 드래그는 이웃을 고정하고 겹침·빈 공간을 허용한다', ({ edge, dx, dy, expected }) => {
    const { targetFrame, neighborFrame, neighbor, down, move, up } = setup(edge);
    down();
    move(dx, dy);
    expectRect(targetFrame, expected);
    expectRect(neighborFrame, NEIGHBORS[edge]);
    // 프리뷰 동안은 저장된 타겟 rect도 바꾸지 않는다.
    expect(useWorkspaceStore.getState().windows[0].rect).toEqual(toFrac(ORIGIN, CANVAS));
    up();
    expect(useWorkspaceStore.getState().windows[0].rect).toEqual(toFrac(expected, CANVAS));
    expect(useWorkspaceStore.getState().windows[1]).toBe(neighbor);
    expectRect(neighborFrame, NEIGHBORS[edge]);
  });

  it.each([
    { edge: 'e' as const, near: [8, 0], far: [20, 0], expected: { ...ORIGIN, w: 260 } },
    { edge: 's' as const, near: [0, 8], far: [0, 20], expected: { ...ORIGIN, h: 220 } },
  ])('$edge 변은 이웃 경계에서 자석이 풀렸다가 다시 붙는다', ({ edge, near, far, expected }) => {
    const { targetFrame, neighborFrame, neighbor, down, move, up } = setup(edge);
    down();
    move(near[0], near[1]);
    expectRect(targetFrame, ORIGIN);
    move(far[0], far[1]);
    expectRect(targetFrame, expected);
    move(near[0], near[1]);
    expectRect(targetFrame, ORIGIN);
    up();
    expect(useWorkspaceStore.getState().windows[1]).toBe(neighbor);
    expectRect(neighborFrame, NEIGHBORS[edge]);
  });

  it('Alt는 기존처럼 자석만 해제하고 이웃은 고정한다', () => {
    const { targetFrame, neighbor, down, move, up } = setup();
    down();
    move(8, 0, true);
    expectRect(targetFrame, { ...ORIGIN, w: 248 });
    up();
    expect(useWorkspaceStore.getState().windows[0].rect.w).toBe(0.248);
    expect(useWorkspaceStore.getState().windows[1]).toBe(neighbor);
  });
});
