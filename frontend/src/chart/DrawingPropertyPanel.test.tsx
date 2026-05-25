import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import DrawingPropertyPanel from './DrawingPropertyPanel';
import { useDrawingsStore } from '../state/drawings';
import type { Drawing } from './drawing/types';
import { COLOR_PALETTE, STROKE_WIDTHS, LINE_STYLES } from './drawing/types';

const HLINE: Drawing = {
  id: 'h1', kind: 'hline', price: 1000,
  color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
};

beforeEach(() => {
  useDrawingsStore.getState().__resetForTests();
  useDrawingsStore.getState().setActiveCode('005930');
});

describe('DrawingPropertyPanel — visibility gate', () => {
  it('does not render when selectedId is null', () => {
    const { container } = render(<DrawingPropertyPanel />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('does not render when activeTool is not select', () => {
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    useDrawingsStore.getState().setActiveTool('hline');
    const { container } = render(<DrawingPropertyPanel />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('renders when activeTool=select AND a drawing is selected', () => {
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    // activeTool defaults to 'select'
    const { container } = render(<DrawingPropertyPanel />);
    expect(container.querySelector('[data-drawing-property-panel]')).not.toBeNull();
  });
});

describe('DrawingPropertyPanel — color', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('color trigger renders the drawing colour as the bar fill', () => {
    render(<DrawingPropertyPanel />);
    const bar = screen.getByTestId('drawing-color-bar');
    expect(bar.style.background).toBe('rgb(20, 184, 166)'); // #14B8A6 normalized
  });

  it('clicking the color trigger opens a 16-swatch popover', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    const swatches = screen.getAllByTestId(/^drawing-color-swatch-/);
    expect(swatches).toHaveLength(16);
  });

  it('clicking a swatch updates the drawing and defaults, closes popover', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[2]}`));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.color).toBe(COLOR_PALETTE[2]);
    expect(useDrawingsStore.getState().defaults.color).toBe(COLOR_PALETTE[2]);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on Escape', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on outside mousedown', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });
});
