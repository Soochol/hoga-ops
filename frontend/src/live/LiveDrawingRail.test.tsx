import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import LiveDrawingRail from './LiveDrawingRail';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import { useDrawingsStore } from '../state/drawings';
import { drawingScope } from '../chart/drawing/persistence';
import type { Drawing, DrawingTool } from '../chart/drawing/types';

const CODE = '005930';

function mkHline(id: string, price: number): Drawing {
  return { id, kind: 'hline', price, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' };
}

describe('LiveDrawingRail', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawingsStore.getState().__resetForTests();
  });

  it('renders the existing drawing tools from the central registry', () => {
    render(<LiveDrawingRail code={CODE} timeframe="1m" />);

    expect(screen.getByRole('toolbar', { name: '그리기 도구' })).toBeInTheDocument();
    const expectedTools: readonly DrawingTool[] = ['select', ...DRAWABLE_TOOLS_ORDER];
    const expected = expectedTools.map((tool) => TOOLS[tool].label);
    for (const label of expected) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '모두 지우기' })).toBeInTheDocument();
  });

  it('switches the active drawing tool and exposes pressed state', () => {
    render(<LiveDrawingRail code={CODE} timeframe="1m" />);

    fireEvent.click(screen.getByRole('button', { name: TOOLS.trendline.label }));

    expect(useDrawingsStore.getState().activeTool).toBe('trendline');
    expect(screen.getByRole('button', { name: TOOLS.trendline.label })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: TOOLS.select.label })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows keyboard shortcuts in drawing tool hover tooltips', () => {
    render(<LiveDrawingRail code={CODE} timeframe="1m" />);

    expect(screen.getByRole('button', { name: TOOLS.select.label })).toHaveAttribute('title', '선택 (Alt+V)');
    expect(screen.getByRole('button', { name: TOOLS.trendline.label })).toHaveAttribute('title', '추세선 (Alt+J)');
  });

  it('clears drawings through the drawing store', () => {
    const scope = drawingScope(CODE, 'minute');
    useDrawingsStore.getState().add(scope, mkHline('h1', 100));
    expect(useDrawingsStore.getState().drawingsFor(scope)).toHaveLength(1);

    render(<LiveDrawingRail code={CODE} timeframe="1m" />);
    fireEvent.click(screen.getByRole('button', { name: '모두 지우기' }));

    expect(useDrawingsStore.getState().drawingsFor(scope)).toHaveLength(0);
  });

  it('clears only the slot the rail is showing', () => {
    // 일봉 레일의 "모두 지우기" 는 같은 종목 분봉 드로잉을 건드리면 안 된다.
    const minute = drawingScope(CODE, 'minute');
    const daily = drawingScope(CODE, 'D');
    useDrawingsStore.getState().add(minute, mkHline('m1', 100));
    useDrawingsStore.getState().add(daily, mkHline('d1', 200));

    render(<LiveDrawingRail code={CODE} timeframe="D" />);
    fireEvent.click(screen.getByRole('button', { name: '모두 지우기' }));

    expect(useDrawingsStore.getState().drawingsFor(daily)).toHaveLength(0);
    expect(useDrawingsStore.getState().drawingsFor(minute)).toHaveLength(1);
  });

  it('does not mutate any scope when no symbol is selected', () => {
    render(<LiveDrawingRail code={null} timeframe="1m" />);
    fireEvent.click(screen.getByRole('button', { name: '모두 지우기' }));
    expect(useDrawingsStore.getState().clearToast).toBeNull();
  });
});
