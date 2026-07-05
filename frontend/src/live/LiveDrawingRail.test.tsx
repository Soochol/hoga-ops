import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import LiveDrawingRail from './LiveDrawingRail';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import { useDrawingsStore } from '../state/drawings';
import type { Drawing, DrawingTool } from '../chart/drawing/types';

describe('LiveDrawingRail', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawingsStore.getState().__resetForTests();
  });

  it('renders the existing drawing tools from the central registry', () => {
    render(<LiveDrawingRail />);

    expect(screen.getByRole('toolbar', { name: '그리기 도구' })).toBeInTheDocument();
    const expectedTools: readonly DrawingTool[] = ['select', ...DRAWABLE_TOOLS_ORDER];
    const expected = expectedTools.map((tool) => TOOLS[tool].label);
    for (const label of expected) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '모두 지우기' })).toBeInTheDocument();
  });

  it('switches the active drawing tool and exposes pressed state', () => {
    render(<LiveDrawingRail />);

    fireEvent.click(screen.getByRole('button', { name: TOOLS.trendline.label }));

    expect(useDrawingsStore.getState().activeTool).toBe('trendline');
    expect(screen.getByRole('button', { name: TOOLS.trendline.label })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: TOOLS.select.label })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows keyboard shortcuts in drawing tool hover tooltips', () => {
    render(<LiveDrawingRail />);

    expect(screen.getByRole('button', { name: TOOLS.select.label })).toHaveAttribute('title', '선택 (Alt+V)');
    expect(screen.getByRole('button', { name: TOOLS.trendline.label })).toHaveAttribute('title', '추세선 (Alt+J)');
  });

  it('clears drawings through the drawing store', () => {
    const drawing: Drawing = {
      id: 'h1',
      kind: 'hline',
      price: 100,
      color: '#14B8A6',
      width: 2,
      lineStyle: 'solid',
      paneId: 'candle',
    };
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(drawing);
    expect(useDrawingsStore.getState().drawingsFor('005930')).toHaveLength(1);

    render(<LiveDrawingRail />);
    fireEvent.click(screen.getByRole('button', { name: '모두 지우기' }));

    expect(useDrawingsStore.getState().drawingsFor('005930')).toHaveLength(0);
  });
});
