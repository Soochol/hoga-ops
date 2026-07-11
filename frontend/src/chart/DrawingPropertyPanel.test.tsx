import { render, fireEvent, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('DrawingPropertyPanel — thickness', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('thickness trigger shows current width', () => {
    render(<DrawingPropertyPanel />);
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('2px');
  });

  it('clicking the thickness trigger opens a 5-item list', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    const items = screen.getAllByTestId(/^drawing-thickness-item-/);
    expect(items).toHaveLength(STROKE_WIDTHS.length);
  });

  it('clicking an item updates drawing.width and defaults.width', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-4'));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.width).toBe(4);
    expect(useDrawingsStore.getState().defaults.width).toBe(4);
  });

  it('only one popover open at a time — opening thickness closes color', () => {
    render(<DrawingPropertyPanel />);
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

describe('DrawingPropertyPanel — line style', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('line-style trigger renders a preview of current style', () => {
    render(<DrawingPropertyPanel />);
    const trigger = screen.getByTestId('drawing-line-style-trigger');
    expect(trigger.getAttribute('data-current-style')).toBe('solid');
  });

  it('clicking the trigger opens a 3-item popover', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    const items = screen.getAllByTestId(/^drawing-line-style-item-/);
    expect(items).toHaveLength(LINE_STYLES.length);
  });

  it('selecting "dashed" updates drawing and defaults', () => {
    render(<DrawingPropertyPanel />);
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
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('clicking delete removes the drawing and hides the panel', () => {
    const { container } = render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-delete'));
    expect(useDrawingsStore.getState().byCode.get('005930')).toEqual([]);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });
});

describe('DrawingPropertyPanel — drag', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('dragging the grip translates the panel', () => {
    render(<DrawingPropertyPanel />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    const grip = screen.getByTestId('drawing-panel-grip');
    const startLeft = parseFloat(panel.style.left);
    const startTop = parseFloat(panel.style.top);

    fireEvent.mouseDown(grip, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 130 });
    fireEvent.mouseUp(window);

    expect(parseFloat(panel.style.left)).toBeCloseTo(startLeft + 50);
    expect(parseFloat(panel.style.top)).toBeCloseTo(startTop + 30);
  });
});

describe('DrawingPropertyPanel — initial position per selection', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
  });

  it('calls computeAnchor(drawing) when selectedId changes and applies its result', () => {
    const computeAnchor = vi.fn().mockReturnValue({ x: 120, y: 80 });
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel computeAnchor={computeAnchor} />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(computeAnchor).toHaveBeenCalledWith(HLINE);
    expect(panel.style.left).toBe('120px');
    expect(panel.style.top).toBe('80px');
  });

  it('null anchor (off-axis) falls back to INITIAL_POSITION', () => {
    const computeAnchor = vi.fn().mockReturnValue(null);
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel computeAnchor={computeAnchor} />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.left).toBe('14px');
    expect(panel.style.top).toBe('20px');
  });
});

describe('DrawingPropertyPanel — hline anchoring', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
  });

  // hline panels rest *above* the line (bottom-edge anchored) so the line
  // they describe stays visible. The vertical lift is done with
  // translateY(-100%); without it the panel hangs below `top` and covers the
  // line. The horizontal translateX(-50%) centres the panel on the line.
  it('hline panel is bottom+centre anchored via translate(-50%, -100%)', () => {
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.transform).toBe('translate(-50%, -100%)');
  });

  it('non-hline (trendline) keeps top-left anchoring (no transform)', () => {
    const TREND: Drawing = {
      id: 't1', kind: 'trendline',
      a: { realMs: 1, price: 100 }, b: { realMs: 2, price: 200 },
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    };
    useDrawingsStore.getState().add(TREND);
    useDrawingsStore.getState().setSelected('t1');
    render(<DrawingPropertyPanel />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.transform).toBe('');
  });
});

describe('DrawingPropertyPanel — sticky position after drag (ADR-0108)', () => {
  const HLINE2: Drawing = {
    id: 'h2', kind: 'hline', price: 2000,
    color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
  };
  // h1 anchors at (100,100); h2 would anchor at (300,300). A sticky panel must
  // ignore h2's anchor once the user has dragged.
  const anchorByDrawing = (d: Drawing) =>
    d.id === 'h1' ? { x: 100, y: 100 } : { x: 300, y: 300 };

  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE); // h1
    useDrawingsStore.getState().add(HLINE2); // h2
    useDrawingsStore.getState().setSelected('h1');
  });

  it('re-selecting a different drawing keeps the dragged position (no re-anchor)', () => {
    const computeAnchor = vi.fn(anchorByDrawing);
    render(<DrawingPropertyPanel computeAnchor={computeAnchor} />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    const grip = screen.getByTestId('drawing-panel-grip');

    // First selection anchors normally.
    expect(panel.style.left).toBe('100px');
    expect(panel.style.top).toBe('100px');

    // User drags the panel by (+40, +40).
    fireEvent.mouseDown(grip, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(window);
    expect(panel.style.left).toBe('140px');
    expect(panel.style.top).toBe('140px');

    // Re-selecting a DIFFERENT drawing must NOT snap to its anchor — the bug.
    act(() => {
      useDrawingsStore.getState().setSelected('h2');
    });
    expect(panel.style.left).toBe('140px');
    expect(panel.style.top).toBe('140px');
  });

  it('before any drag, selection still re-anchors per drawing', () => {
    const computeAnchor = vi.fn(anchorByDrawing);
    render(<DrawingPropertyPanel computeAnchor={computeAnchor} />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.left).toBe('100px');

    // No drag yet → switching selection re-anchors to h2's anchor.
    act(() => {
      useDrawingsStore.getState().setSelected('h2');
    });
    expect(panel.style.left).toBe('300px');
    expect(panel.style.top).toBe('300px');
  });
});
