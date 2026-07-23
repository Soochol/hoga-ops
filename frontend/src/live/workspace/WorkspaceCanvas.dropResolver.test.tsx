import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { useEntryDragStore, resolveDropOnChart } from '../../state/entryDrag';

// 창 본문(차트/데이터)은 이 테스트의 관심사가 아니다 — 리졸버 z-순서 선택만 검증.
vi.mock('./ChartWindow', () => ({ ChartWindow: () => <div>chart</div> }));
vi.mock('./DataWindow', () => ({ DataWindow: () => <div>data</div> }));
// 타이틀바 종목 행은 전역 quote 훅(QueryClient)을 쓴다 — 이 테스트엔 provider 가
// 없고 관심사도 아니므로 stub 한다(ChartWindow mock 과 동일 취지).
vi.mock('./TitleBarSymbolRow', () => ({ TitleBarSymbolRow: () => <div>sym</div> }));

function chart(id: string, group: number, rect: WorkspaceWindow['rect']): WorkspaceWindow {
  return { id, kind: 'chart', group, rect, chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } } };
}

/**
 * 캔버스 크기를 1000×1000 으로 고정한다. rect 는 비율(ADR-0122)이라 캔버스가 0 이면
 * 모든 창이 0px 로 펴져 히트 테스트가 통째로 죽는다 — jsdom 은 레이아웃을 안 하므로
 * clientWidth/Height 를 직접 심어야 한다. 1000 을 쓰면 비율 0.2 = 200px 라 이 파일의
 * px 좌표(50,50 / 300,300)를 그대로 유지할 수 있다.
 */
const CANVAS = 1000;
function stubCanvasSize() {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: CANVAS, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: CANVAS, configurable: true });
}
/** px → 비율(위 캔버스 기준). 테스트 의도를 px 로 읽히게 유지하는 헬퍼. */
const frac = (px: number) => px / CANVAS;

describe('WorkspaceCanvas — 창별 정밀 드롭 리졸버 (ADR-0119 PR-D2)', () => {
  beforeEach(() => {
    cleanup();
    useEntryDragStore.setState({ chartDropResolver: null });
    stubCanvasSize();
    // jsdom 의 getBoundingClientRect 는 0 반환 → 캔버스 left/top=0 → 로컬=클라이언트 좌표.
  });

  it('좌표 아래 z-최상위 창의 그룹 종목을 교체한다(겹친 창=위 창 승리)', () => {
    // a(그룹1)·b(그룹2) 겹침, z순서 a<b → (50,50)에서 b 승리.
    useWorkspaceStore.setState({
      windows: [
        chart('a', 1, { x: 0, y: 0, w: frac(200), h: frac(200) }),
        chart('b', 2, { x: 0, y: 0, w: frac(200), h: frac(200) }),
      ],
      zOrder: ['a', 'b'],
      groupSymbols: {},
    });
    render(<WorkspaceCanvas />);
    const handled = resolveDropOnChart({ x: 50, y: 50 }, { code: '005930', name: '삼성전자' });
    expect(handled).toBe(true);
    // 그룹 2(위 창 b)만 교체, 그룹 1 불변.
    expect(useWorkspaceStore.getState().groupSymbols[2]).toEqual({ code: '005930', name: '삼성전자' });
    expect(useWorkspaceStore.getState().groupSymbols[1]).toBeUndefined();
  });

  it('창 밖(여백) 좌표면 false → 활성 그룹 폴백', () => {
    useWorkspaceStore.setState({
      windows: [chart('a', 1, { x: 0, y: 0, w: frac(100), h: frac(100) })],
      zOrder: ['a'],
      groupSymbols: {},
    });
    render(<WorkspaceCanvas />);
    const handled = resolveDropOnChart({ x: 300, y: 300 }, { code: '005930' });
    expect(handled).toBe(false);
    expect(useWorkspaceStore.getState().groupSymbols[1]).toBeUndefined();
  });

  it('name 부재 시 code 를 name 폴백으로 쓴다(GroupSymbol 계약)', () => {
    useWorkspaceStore.setState({
      windows: [chart('a', 3, { x: 0, y: 0, w: frac(100), h: frac(100) })],
      zOrder: ['a'],
      groupSymbols: {},
    });
    render(<WorkspaceCanvas />);
    resolveDropOnChart({ x: 10, y: 10 }, { code: '000660' });
    expect(useWorkspaceStore.getState().groupSymbols[3]).toEqual({ code: '000660', name: '000660' });
  });
});
