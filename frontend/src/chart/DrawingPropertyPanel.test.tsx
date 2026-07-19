import { render, fireEvent, screen, act } from '@testing-library/react';
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
    const { container } = render(<DrawingPropertyPanel code="005930" />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('does not render when activeTool is not select', () => {
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
    useDrawingsStore.getState().setActiveTool('hline');
    const { container } = render(<DrawingPropertyPanel code="005930" />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('renders when activeTool=select AND a drawing is selected', () => {
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
    // activeTool defaults to 'select'
    const { container } = render(<DrawingPropertyPanel code="005930" />);
    expect(container.querySelector('[data-drawing-property-panel]')).not.toBeNull();
  });
});

describe('DrawingPropertyPanel — thickness', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('thickness trigger shows current width', () => {
    render(<DrawingPropertyPanel code="005930" />);
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('2px');
  });

  it('clicking the thickness trigger opens a 5-item list', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    const items = screen.getAllByTestId(/^drawing-thickness-item-/);
    expect(items).toHaveLength(STROKE_WIDTHS.length);
  });

  it('clicking an item updates drawing.width and defaults.width', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-4'));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.width).toBe(4);
    expect(useDrawingsStore.getState().defaults.width).toBe(4);
  });

  it('only one popover open at a time — opening thickness closes color', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    expect(screen.getAllByTestId(/^drawing-color-swatch-/)).toHaveLength(16);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
    expect(screen.getAllByTestId(/^drawing-thickness-item-/)).toHaveLength(5);
  });
});

describe('DrawingPropertyPanel — color', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('color trigger renders the drawing colour as the bar fill', () => {
    render(<DrawingPropertyPanel code="005930" />);
    const bar = screen.getByTestId('drawing-color-bar');
    expect(bar.style.background).toBe('rgb(20, 184, 166)'); // #14B8A6 normalized
  });

  it('clicking the color trigger opens a 16-swatch popover', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    const swatches = screen.getAllByTestId(/^drawing-color-swatch-/);
    expect(swatches).toHaveLength(16);
  });

  it('clicking a swatch updates the drawing and defaults, closes popover', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[2]}`));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.color).toBe(COLOR_PALETTE[2]);
    expect(useDrawingsStore.getState().defaults.color).toBe(COLOR_PALETTE[2]);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on Escape', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on outside mousedown', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });
});

describe('DrawingPropertyPanel — line style', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('line-style trigger renders a preview of current style', () => {
    render(<DrawingPropertyPanel code="005930" />);
    const trigger = screen.getByTestId('drawing-line-style-trigger');
    expect(trigger.getAttribute('data-current-style')).toBe('solid');
  });

  it('clicking the trigger opens a 3-item popover', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    const items = screen.getAllByTestId(/^drawing-line-style-item-/);
    expect(items).toHaveLength(LINE_STYLES.length);
  });

  it('selecting "dashed" updates drawing and defaults', () => {
    render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    fireEvent.click(screen.getByTestId('drawing-line-style-item-dashed'));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.lineStyle).toBe('dashed');
    expect(useDrawingsStore.getState().defaults.lineStyle).toBe('dashed');
  });
});

describe('DrawingPropertyPanel — delete', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('clicking delete removes the drawing and hides the panel', () => {
    const { container } = render(<DrawingPropertyPanel code="005930" />);
    fireEvent.click(screen.getByTestId('drawing-delete'));
    expect(useDrawingsStore.getState().byCode.get('005930')).toEqual([]);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });
});

describe('DrawingPropertyPanel — top-center dock (fixed toolbar)', () => {
  const HLINE2: Drawing = {
    id: 'h2', kind: 'hline', price: 2000,
    color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
  };

  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
  });

  it('is fixed at top:8px, left:50%, translateX(-50%) — a top-center toolbar', () => {
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel code="005930" />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.top).toBe('8px');
    expect(panel.style.left).toBe('50%');
    expect(panel.style.transform).toBe('translateX(-50%)');
  });

  it('docks the same way for a trendline (not anchored to the shape)', () => {
    const TREND: Drawing = {
      id: 't1', kind: 'trendline',
      a: { realMs: 1, price: 100 }, b: { realMs: 2, price: 200 },
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    };
    useDrawingsStore.getState().add('005930', TREND);
    useDrawingsStore.getState().setSelected('t1');
    render(<DrawingPropertyPanel code="005930" />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.top).toBe('8px');
    expect(panel.style.left).toBe('50%');
  });

  it('stays docked when the selection changes to another drawing', () => {
    useDrawingsStore.getState().add('005930', HLINE); // h1
    useDrawingsStore.getState().add('005930', HLINE2); // h2
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel code="005930" />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.left).toBe('50%');
    act(() => {
      useDrawingsStore.getState().setSelected('h2');
    });
    expect(panel.style.top).toBe('8px');
    expect(panel.style.left).toBe('50%');
  });

  it('no drag grip (the toolbar is fixed, not draggable)', () => {
    useDrawingsStore.getState().add('005930', HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel code="005930" />);
    expect(screen.queryByTestId('drawing-panel-grip')).toBeNull();
  });
});
