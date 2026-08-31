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
  useDrawingsStore.getState().setActiveScope('005930|minute');
});

describe('DrawingPropertyPanel — visibility gate', () => {
  it('does not render when selectedId is null', () => {
    const { container } = render(<DrawingPropertyPanel scope="005930|minute" />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('does not render when activeTool is not select', () => {
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
    useDrawingsStore.getState().setActiveTool('hline');
    const { container } = render(<DrawingPropertyPanel scope="005930|minute" />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('renders when activeTool=select AND a drawing is selected', () => {
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
    // activeTool defaults to 'select'
    const { container } = render(<DrawingPropertyPanel scope="005930|minute" />);
    expect(container.querySelector('[data-drawing-property-panel]')).not.toBeNull();
  });
});

describe('DrawingPropertyPanel — thickness', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveScope('005930|minute');
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
  });

  it('thickness trigger shows current width', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('2px');
  });

  it('clicking the thickness trigger opens a 5-item list', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    const items = screen.getAllByTestId(/^drawing-thickness-item-/);
    expect(items).toHaveLength(STROKE_WIDTHS.length);
  });

  it('clicking an item updates drawing.width and defaults.width', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-4'));
    const drawn = useDrawingsStore.getState().byScope.get('005930|minute')!.find((d) => d.id === 'h1')!;
    expect(drawn.width).toBe(4);
    expect(useDrawingsStore.getState().styleForKind('hline').width).toBe(4);
  });

  it('only one popover open at a time — opening thickness closes color', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
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
    useDrawingsStore.getState().setActiveScope('005930|minute');
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
  });

  it('color trigger renders the drawing colour as the bar fill', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    const bar = screen.getByTestId('drawing-color-bar');
    expect(bar.style.background).toBe('rgb(20, 184, 166)'); // #14B8A6 normalized
  });

  it('clicking the color trigger opens a 16-swatch popover', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    const swatches = screen.getAllByTestId(/^drawing-color-swatch-/);
    expect(swatches).toHaveLength(16);
  });

  it('clicking a swatch updates the drawing and defaults, closes popover', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[2]}`));
    const drawn = useDrawingsStore.getState().byScope.get('005930|minute')!.find((d) => d.id === 'h1')!;
    expect(drawn.color).toBe(COLOR_PALETTE[2]);
    expect(useDrawingsStore.getState().styleForKind('hline').color).toBe(COLOR_PALETTE[2]);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on Escape', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on outside mousedown', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });
});

describe('DrawingPropertyPanel — line style', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveScope('005930|minute');
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
  });

  it('line-style trigger renders a preview of current style', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    const trigger = screen.getByTestId('drawing-line-style-trigger');
    expect(trigger.getAttribute('data-current-style')).toBe('solid');
  });

  it('clicking the trigger opens a 3-item popover', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    const items = screen.getAllByTestId(/^drawing-line-style-item-/);
    expect(items).toHaveLength(LINE_STYLES.length);
  });

  it('selecting "dashed" updates drawing and defaults', () => {
    render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    fireEvent.click(screen.getByTestId('drawing-line-style-item-dashed'));
    const drawn = useDrawingsStore.getState().byScope.get('005930|minute')!.find((d) => d.id === 'h1')!;
    expect(drawn.lineStyle).toBe('dashed');
    expect(useDrawingsStore.getState().styleForKind('hline').lineStyle).toBe('dashed');
  });
});

describe('DrawingPropertyPanel — delete', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveScope('005930|minute');
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
  });

  it('clicking delete removes the drawing and hides the panel', () => {
    const { container } = render(<DrawingPropertyPanel scope="005930|minute" />);
    fireEvent.click(screen.getByTestId('drawing-delete'));
    expect(useDrawingsStore.getState().byScope.get('005930|minute')).toEqual([]);
    expect(useDrawingsStore.getState().selectedFor('005930|minute')).toEqual([]);
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
    useDrawingsStore.getState().setActiveScope('005930|minute');
  });

  it('is fixed at top:8px, left:50%, translateX(-50%) — a top-center toolbar', () => {
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
    render(<DrawingPropertyPanel scope="005930|minute" />);
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
    useDrawingsStore.getState().add('005930|minute', TREND);
    useDrawingsStore.getState().setSelected('005930|minute', 't1');
    render(<DrawingPropertyPanel scope="005930|minute" />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.top).toBe('8px');
    expect(panel.style.left).toBe('50%');
  });

  it('stays docked when the selection changes to another drawing', () => {
    useDrawingsStore.getState().add('005930|minute', HLINE); // h1
    useDrawingsStore.getState().add('005930|minute', HLINE2); // h2
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
    render(<DrawingPropertyPanel scope="005930|minute" />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.left).toBe('50%');
    act(() => {
      useDrawingsStore.getState().setSelected('005930|minute', 'h2');
    });
    expect(panel.style.top).toBe('8px');
    expect(panel.style.left).toBe('50%');
  });

  it('no drag grip (the toolbar is fixed, not draggable)', () => {
    useDrawingsStore.getState().add('005930|minute', HLINE);
    useDrawingsStore.getState().setSelected('005930|minute', 'h1');
    render(<DrawingPropertyPanel scope="005930|minute" />);
    expect(screen.queryByTestId('drawing-panel-grip')).toBeNull();
  });
});

// ── 잠금 (ADR-0164) ────────────────────────────────────────────────────────
describe('DrawingPropertyPanel — 잠금', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();

  beforeEach(() => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    s().add(SCOPE, HLINE);
    s().setSelected(SCOPE, 'h1');
  });

  it('자물쇠 버튼이 잠금을 켠다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    fireEvent.click(screen.getByTestId('drawing-lock'));

    expect(s().drawingsFor(SCOPE)[0].locked).toBe(true);
  });

  it('잠긴 상태에서 다시 누르면 풀린다 — 자물쇠는 잠겨도 살아 있어야 한다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    fireEvent.click(screen.getByTestId('drawing-lock'));
    fireEvent.click(screen.getByTestId('drawing-lock'));

    expect(s().drawingsFor(SCOPE)[0].locked).toBe(false);
  });

  it('잠기면 스타일·삭제 컨트롤이 전부 비활성이고 자물쇠만 살아 있다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    fireEvent.click(screen.getByTestId('drawing-lock'));

    for (const id of ['drawing-color-trigger', 'drawing-thickness-trigger', 'drawing-line-style-trigger', 'drawing-delete']) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    expect(screen.getByTestId('drawing-lock')).not.toBeDisabled();
  });

  it('잠금 상태는 aria-pressed 로 노출된다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    expect(screen.getByTestId('drawing-lock')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('drawing-lock'));
    expect(screen.getByTestId('drawing-lock')).toHaveAttribute('aria-pressed', 'true');
  });

  // useDismissablePopover 는 rootRef **바깥** mousedown 에만 반응하는데 자물쇠는
  // 그 안에 있다 — 파생 게이트가 없으면 팔레트가 죽은 채 펼쳐진 상태로 남는다.
  it('열려 있던 팝오버는 잠그는 순간 닫힌다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    expect(screen.getAllByTestId(/^drawing-color-swatch-/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('drawing-lock'));
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  // 잠긴 도형도 선택되면 패널이 떠야 한다 — 이 패널의 자물쇠가 해제의 유일한
  // 경로라, 패널이 숨으면 사용자가 자기 도형을 영구히 못 푼다.
  it('잠긴 도형이 선택돼도 패널은 뜬다', () => {
    s().update(SCOPE, 'h1', { locked: true });
    const { container } = render(<DrawingPropertyPanel scope={SCOPE} />);

    expect(container.querySelector('[data-drawing-property-panel]')).not.toBeNull();
  });
});

// ─── 다중 선택 툴바 ────────────────────────────────────────────────────────
describe('DrawingPropertyPanel — 다중 선택', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();
  const mk = (id: string, price: number): Drawing => ({ ...HLINE, id, price });

  beforeEach(() => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    s().add(SCOPE, mk('h1', 1000));
    s().add(SCOPE, mk('h2', 2000));
    s().add(SCOPE, mk('h3', 3000));
    s().addToSelection(SCOPE, ['h1', 'h2']);
  });

  it('스타일 편집기 대신 슬림 툴바가 뜬다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    expect(screen.getByTestId('drawing-multi-selection-panel')).toBeTruthy();
    // 종류가 섞이면 공통 속성이 정의되지 않으므로 스타일 컨트롤은 없다.
    expect(screen.queryByTestId('drawing-color-trigger')).toBeNull();
    expect(screen.queryByTestId('drawing-thickness-trigger')).toBeNull();
  });

  it('선택 개수를 보여 준다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    expect(screen.getByTestId('drawing-multi-count').textContent).toBe('2개 선택');
  });

  it('삭제는 선택한 것만 지운다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    act(() => {
      fireEvent.click(screen.getByTestId('drawing-multi-delete'));
    });
    expect(s().drawingsFor(SCOPE).map((d) => d.id)).toEqual(['h3']);
  });

  // 잠근 뒤 선택을 비우는 이유: 잠긴 것을 집합에 남겨 두면 헤일로는 있는데
  // 끌리지 않는, 화면이 설명하지 못하는 상태가 된다.
  it('잠금은 선택한 것만 잠그고 선택을 비운다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    act(() => {
      fireEvent.click(screen.getByTestId('drawing-multi-lock'));
    });
    expect(s().drawingsFor(SCOPE).map((d) => d.locked === true)).toEqual([true, true, false]);
    expect(s().selectedFor(SCOPE)).toEqual([]);
  });

  it('하나로 접히면 다시 스타일 편집기로 돌아온다', () => {
    s().setSelected(SCOPE, 'h1');
    render(<DrawingPropertyPanel scope={SCOPE} />);
    expect(screen.queryByTestId('drawing-multi-selection-panel')).toBeNull();
    expect(screen.getByTestId('drawing-color-trigger')).toBeTruthy();
  });
});
