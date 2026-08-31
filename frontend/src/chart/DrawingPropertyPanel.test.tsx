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

  it('단일 편집기 대신 다중 툴바가 뜬다 — 스타일 컨트롤은 함께 온다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    expect(screen.getByTestId('drawing-multi-selection-panel')).toBeTruthy();
    // 집합이 전부 hline 이므로 색·두께·선 스타일이 뜨고, 텍스트/사각형 전용
    // 컨트롤은 뜨지 않는다(그 속성을 가진 멤버가 없다).
    expect(screen.getByTestId('drawing-color-trigger')).toBeTruthy();
    expect(screen.getByTestId('drawing-thickness-trigger')).toBeTruthy();
    expect(screen.getByTestId('drawing-line-style-trigger')).toBeTruthy();
    expect(screen.queryByTestId('drawing-font-size-trigger')).toBeNull();
    expect(screen.queryByTestId('drawing-fill-trigger')).toBeNull();
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

  // 잠근 뒤에도 선택은 남는다. 잠긴 채 선택된 상태가 이제 정당하기 때문이다 —
  // 그 상태의 툴바가 곧 해제 버튼을 내밀므로 잠금이 그 자리에서 되돌려진다.
  it('잠금은 선택한 것만 잠그고 선택은 유지한다', () => {
    render(<DrawingPropertyPanel scope={SCOPE} />);
    act(() => {
      fireEvent.click(screen.getByTestId('drawing-multi-lock'));
    });
    expect(s().drawingsFor(SCOPE).map((d) => d.locked === true)).toEqual([true, true, false]);
    expect(s().selectedFor(SCOPE)).toEqual(['h1', 'h2']);
  });

  it('하나로 접히면 다시 스타일 편집기로 돌아온다', () => {
    s().setSelected(SCOPE, 'h1');
    render(<DrawingPropertyPanel scope={SCOPE} />);
    expect(screen.queryByTestId('drawing-multi-selection-panel')).toBeNull();
    expect(screen.getByTestId('drawing-color-trigger')).toBeTruthy();
  });
});

// ─── 다중 선택 — 스타일 일괄 편집 ──────────────────────────────────────────
describe('DrawingPropertyPanel — 스타일 일괄 편집', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();

  const hline = (id: string, over: Partial<Drawing> = {}): Drawing =>
    ({ ...HLINE, id, ...over }) as Drawing;
  const text = (id: string, over: Record<string, unknown> = {}): Drawing =>
    ({
      id, kind: 'text', at: { realMs: 1_700_000_000_000, price: 1000 }, text: '메모',
      fontSize: 13, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle', ...over,
    }) as Drawing;
  const rect = (id: string, over: Record<string, unknown> = {}): Drawing =>
    ({
      id, kind: 'rect',
      a: { realMs: 1_700_000_000_000, price: 1000 }, b: { realMs: 1_700_000_600_000, price: 2000 },
      color: '#14B8A6', width: 2, lineStyle: 'solid', fillOpacity: 0.1, paneId: 'candle', ...over,
    }) as Drawing;

  const seed = (...items: Drawing[]) => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    items.forEach((d) => s().add(SCOPE, d));
    s().addToSelection(SCOPE, items.map((d) => d.id));
    render(<DrawingPropertyPanel scope={SCOPE} />);
  };
  const get = (id: string) => s().drawingsFor(SCOPE).find((d) => d.id === id)!;

  // ── 어떤 컨트롤이 뜨는가: 그 속성을 가진 멤버가 하나라도 있으면 ──────────
  it('텍스트가 섞이면 글자 크기 컨트롤이 함께 뜬다', () => {
    seed(hline('h1'), text('t1'));
    expect(screen.getByTestId('drawing-font-size-trigger')).toBeTruthy();
    // 두께는 hline 이 가지고 있으므로 여전히 뜬다.
    expect(screen.getByTestId('drawing-thickness-trigger')).toBeTruthy();
  });

  it('텍스트만 고르면 두께·선 스타일이 사라진다', () => {
    seed(text('t1'), text('t2'));
    expect(screen.queryByTestId('drawing-thickness-trigger')).toBeNull();
    expect(screen.queryByTestId('drawing-line-style-trigger')).toBeNull();
    expect(screen.getByTestId('drawing-font-size-trigger')).toBeTruthy();
  });

  it('사각형이 섞이면 채우기 농도가 뜬다', () => {
    seed(hline('h1'), rect('r1'));
    expect(screen.getByTestId('drawing-fill-trigger')).toBeTruthy();
  });

  // ── 혼합 판정은 carrier 만 센다 ──────────────────────────────────────────
  it('값이 모두 같으면 그 값을 보여 준다', () => {
    seed(hline('h1', { width: 3 }), hline('h2', { width: 3 }));
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('3px');
  });

  it('값이 갈리면 "혼합" 을 보여 준다', () => {
    seed(hline('h1', { width: 1 }), hline('h2', { width: 4 }));
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('혼합');
  });

  // ⚠ 텍스트는 두께가 **갈린** 게 아니라 두께라는 개념이 없다. carrier 가 아닌
  // 멤버를 혼합 계산에 넣으면 "2px 두 개 + 텍스트" 가 혼합으로 보인다.
  it('두께를 안 가진 멤버는 혼합 판정에 들어가지 않는다', () => {
    seed(hline('h1', { width: 2 }), hline('h2', { width: 2 }), text('t1', { width: 5 }));
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('2px');
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).not.toContain('혼합');
  });

  it('혼합일 때는 팝오버의 어느 줄도 강조되지 않는다', () => {
    seed(hline('h1', { width: 1 }), hline('h2', { width: 4 }));
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    const highlighted = STROKE_WIDTHS.filter((w) =>
      screen.getByTestId(`drawing-thickness-item-${w}`).className.includes('text-accent'),
    );
    expect(highlighted).toEqual([]);
  });

  // ── 적용 ────────────────────────────────────────────────────────────────
  it('색은 집합 전체에 적용된다', () => {
    seed(hline('h1'), text('t1'), rect('r1'));
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[2]}`));
    expect(s().drawingsFor(SCOPE).map((d) => d.color)).toEqual([
      COLOR_PALETTE[2], COLOR_PALETTE[2], COLOR_PALETTE[2],
    ]);
  });

  // ⚠ 부분 적용. 텍스트에 width 를 흘리면 저장 데이터에 유령 필드가 남는다.
  it('두께는 그 속성을 가진 멤버에게만 간다 — 텍스트는 건너뛴다', () => {
    seed(hline('h1', { width: 1 }), text('t1'));
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-5'));
    expect((get('h1') as { width: number }).width).toBe(5);
    expect((get('t1') as { width?: number }).width).toBe(2); // 원래 값 그대로
  });

  it('글자 크기는 텍스트에게만 간다', () => {
    seed(hline('h1'), text('t1', { fontSize: 13 }));
    fireEvent.click(screen.getByTestId('drawing-font-size-trigger'));
    fireEvent.click(screen.getByTestId('drawing-font-size-item-20'));
    expect((get('t1') as { fontSize: number }).fontSize).toBe(20);
    expect(get('h1')).not.toHaveProperty('fontSize');
  });

  it('일괄 편집은 되돌리기 한 단계다', () => {
    seed(hline('h1', { color: '#14B8A6' }), hline('h2', { color: '#14B8A6' }));
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[1]}`));
    expect(s().drawingsFor(SCOPE).map((d) => d.color)).toEqual([COLOR_PALETTE[1], COLOR_PALETTE[1]]);

    act(() => {
      s().undo(SCOPE);
    });
    expect(s().drawingsFor(SCOPE).map((d) => d.color)).toEqual(['#14B8A6', '#14B8A6']);
  });

  // sticky(다음에 그릴 도형이 물려받는 마지막 스타일)는 건드리지 않는다 — 종류가
  // 섞인 배치를 어느 kind 에 귀속시킬지 정의가 없다. 단건 편집과의 의도적 비대칭.
  it('일괄 편집은 per-kind sticky 를 갱신하지 않는다', () => {
    const before = s().styleForKind('hline').color;
    seed(hline('h1'), hline('h2'));
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[3]}`));
    expect(s().styleForKind('hline').color).toBe(before);
  });

  it('잠긴 멤버는 일괄 편집에서 빠진다', () => {
    seed(hline('h1', { width: 1 }), hline('h2', { width: 1 }));
    act(() => {
      s().update(SCOPE, 'h2', { locked: true });
    });
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-5'));
    expect((get('h1') as { width: number }).width).toBe(5);
    expect((get('h2') as { width: number }).width).toBe(1);
  });
});

// ── 우측 확장 ──────────────────────────────────────────────────────────────
//
// 두 버튼의 성격 차이가 여기서 굳는다: 토글은 도형의 플래그를 뒤집고(눌린 상태를
// 갖는다), 액션은 좌표를 한 번 옮긴다(상태가 없다).
describe('DrawingPropertyPanel — 우측 확장', () => {
  const SCOPE = '005930|minute';
  const RECT: Drawing = {
    id: 'r1', kind: 'rect',
    a: { realMs: 100_000, price: 1000 },
    b: { realMs: 200_000, price: 1500 },
    fillOpacity: 0.1, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
  };

  function mount(drawing: Drawing = RECT, resolve?: () => number | null) {
    useDrawingsStore.getState().add(SCOPE, drawing);
    useDrawingsStore.getState().setSelected(SCOPE, drawing.id);
    return render(<DrawingPropertyPanel scope={SCOPE} resolveVisibleRightRealMs={resolve} />);
  }
  const rectOf = (): Drawing => useDrawingsStore.getState().byScope.get(SCOPE)![0];

  it('사각형에만 뜬다 — 수평선에는 없다', () => {
    mount(HLINE);
    expect(screen.queryByTestId('drawing-extend-right')).toBeNull();
    expect(screen.queryByTestId('drawing-extend-to-view')).toBeNull();
  });

  it('토글이 extendRight 를 켜고 끈다', () => {
    mount();
    fireEvent.click(screen.getByTestId('drawing-extend-right'));
    const on = rectOf();
    expect(on.kind === 'rect' && on.extendRight).toBe(true);
    fireEvent.click(screen.getByTestId('drawing-extend-right'));
    const off = rectOf();
    expect(off.kind === 'rect' && off.extendRight).toBe(false);
  });

  it('토글은 눌린 상태를 aria-pressed 로 말한다', () => {
    mount({ ...RECT, extendRight: true });
    expect(screen.getByTestId('drawing-extend-right').getAttribute('aria-pressed')).toBe('true');
  });

  it('"보이는 영역까지" 는 오른쪽 코너의 realMs 만 옮긴다 — price 와 왼쪽 코너는 그대로', () => {
    mount(RECT, () => 900_000);
    fireEvent.click(screen.getByTestId('drawing-extend-to-view'));
    const r = rectOf();
    expect(r.kind === 'rect' && r.b).toEqual({ realMs: 900_000, price: 1500 });
    expect(r.kind === 'rect' && r.a).toEqual(RECT.kind === 'rect' ? RECT.a : null);
  });

  it('화면 끝이 상자 안이면 **줄인다** — 계약은 "보이는 영역까지" 이지 "늘리기" 가 아니다', () => {
    mount(RECT, () => 150_000);
    fireEvent.click(screen.getByTestId('drawing-extend-to-view'));
    const r = rectOf();
    expect(r.kind === 'rect' && r.b.realMs).toBe(150_000);
  });

  it('코너를 가로질러 끈 사각형에서는 a 쪽이 오른쪽이므로 a 가 움직인다', () => {
    const crossed: Drawing = {
      ...RECT,
      a: { realMs: 200_000, price: 1000 },
      b: { realMs: 100_000, price: 1500 },
    };
    mount(crossed, () => 900_000);
    fireEvent.click(screen.getByTestId('drawing-extend-to-view'));
    const r = rectOf();
    expect(r.kind === 'rect' && r.a).toEqual({ realMs: 900_000, price: 1000 });
    expect(r.kind === 'rect' && r.b.realMs).toBe(100_000);
  });

  it('이미 그 자리면 아무것도 하지 않는다 — 되돌리기에 빈 단계를 쌓지 않는다', () => {
    mount(RECT, () => 200_000);
    fireEvent.click(screen.getByTestId('drawing-extend-to-view'));
    expect(rectOf()).toBe(useDrawingsStore.getState().byScope.get(SCOPE)![0]);
    const r = rectOf();
    expect(r.kind === 'rect' && r.b.realMs).toBe(200_000);
  });

  it('무한 확장 중이면 "보이는 영역까지" 는 비활성 — 눌러도 화면이 안 변하므로', () => {
    mount({ ...RECT, extendRight: true }, () => 900_000);
    const btn = screen.getByTestId('drawing-extend-to-view') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('호스트가 화면 끝을 못 주면 비활성 — 먹통 버튼을 두지 않는다', () => {
    mount(RECT);
    expect((screen.getByTestId('drawing-extend-to-view') as HTMLButtonElement).disabled).toBe(true);
  });

  it('잠기면 둘 다 비활성이고 스토어도 거부한다', () => {
    mount({ ...RECT, locked: true }, () => 900_000);
    const toggle = screen.getByTestId('drawing-extend-right') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect((screen.getByTestId('drawing-extend-to-view') as HTMLButtonElement).disabled).toBe(true);
  });
});

// ─── 다중 선택 — 잠긴 도형이 섞였을 때 ──────────────────────────────────────
//
// 잠긴 것도 고를 수 있게 된 이유는 하나다: **여러 개를 한꺼번에 풀기 위해서**다.
// 그전에는 하나씩 골라 단일 패널의 자물쇠를 누르는 길밖에 없었다. 이동·수정·삭제를
// 막는 것은 그대로다(ADR-0164) — 선택은 지목이지 편집이 아니다.
describe('DrawingPropertyPanel — 잠금 혼재', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();
  const mk = (id: string, price: number): Drawing => ({ ...HLINE, id, price });

  const seed = (lockedIds: string[]) => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    ['h1', 'h2', 'h3'].forEach((id, i) => s().add(SCOPE, mk(id, 1000 * (i + 1))));
    lockedIds.forEach((id) => s().update(SCOPE, id, { locked: true }));
    s().addToSelection(SCOPE, ['h1', 'h2', 'h3']);
    render(<DrawingPropertyPanel scope={SCOPE} />);
  };
  const lockedFlags = () => s().drawingsFor(SCOPE).map((d) => d.locked === true);

  it('잠긴 개수를 함께 보여 준다 — 일부만 움직이는 드래그를 설명한다', () => {
    seed(['h2']);
    expect(screen.getByTestId('drawing-multi-count').textContent).toBe('3개 선택 · 1 잠김');
  });

  it('하나도 안 잠겼으면 개수 뒤에 아무것도 붙지 않는다', () => {
    seed([]);
    expect(screen.getByTestId('drawing-multi-count').textContent).toBe('3개 선택');
  });

  it('일부만 잠겼으면 자물쇠는 여전히 "잠금" 방향이다', () => {
    seed(['h2']);
    const lock = screen.getByTestId('drawing-multi-lock');
    expect(lock.getAttribute('aria-label')).toBe('선택 잠금');
    fireEvent.click(lock);
    expect(lockedFlags()).toEqual([true, true, true]);
  });

  // ⚠ 이 기능의 존재 이유. `updateMany` 의 `locked` 전용 패치 예외가 없으면
  // 여기서 아무 일도 일어나지 않는다.
  it('전부 잠겼으면 자물쇠가 "해제" 로 바뀌고, 한 번에 다 풀린다', () => {
    seed(['h1', 'h2', 'h3']);
    const lock = screen.getByTestId('drawing-multi-lock');
    expect(lock.getAttribute('aria-label')).toBe('선택 잠금 해제');
    fireEvent.click(lock);
    expect(lockedFlags()).toEqual([false, false, false]);
  });

  it('일괄 잠금 해제는 되돌리기 한 단계다', () => {
    seed(['h1', 'h2', 'h3']);
    fireEvent.click(screen.getByTestId('drawing-multi-lock'));
    expect(lockedFlags()).toEqual([false, false, false]);
    act(() => {
      s().undo(SCOPE);
    });
    expect(lockedFlags()).toEqual([true, true, true]);
  });

  // 숨기지 않고 비활성한다 — 눌리는데 아무 일도 안 나는 버튼이 고장으로 읽힌다.
  it('전부 잠겼으면 스타일·삭제가 비활성된다(자물쇠만 살아 있다)', () => {
    seed(['h1', 'h2', 'h3']);
    expect(screen.getByTestId('drawing-color-trigger')).toBeDisabled();
    expect(screen.getByTestId('drawing-thickness-trigger')).toBeDisabled();
    expect(screen.getByTestId('drawing-multi-delete')).toBeDisabled();
    expect(screen.getByTestId('drawing-multi-lock')).not.toBeDisabled();
  });

  it('하나라도 안 잠겼으면 스타일·삭제가 살아 있다', () => {
    seed(['h1', 'h2']);
    expect(screen.getByTestId('drawing-color-trigger')).not.toBeDisabled();
    expect(screen.getByTestId('drawing-multi-delete')).not.toBeDisabled();
  });

  // 표시는 잠긴 것까지 읽고, 편집은 잠기지 않은 것에만 간다. 그래서 적용 뒤에도
  // 잠긴 멤버가 옛 값을 지켜 "혼합" 이 남을 수 있다 — 거짓이 아니라 사실이다.
  it('일괄 스타일은 잠기지 않은 것에만 적용되고, 남은 차이는 혼합으로 보인다', () => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    s().add(SCOPE, { ...mk('h1', 1000), width: 1 } as Drawing);
    s().add(SCOPE, { ...mk('h2', 2000), width: 1 } as Drawing);
    s().update(SCOPE, 'h2', { locked: true });
    s().addToSelection(SCOPE, ['h1', 'h2']);
    render(<DrawingPropertyPanel scope={SCOPE} />);

    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('1px');
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-5'));

    expect(s().drawingsFor(SCOPE).map((d) => (d as { width: number }).width)).toEqual([5, 1]);
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('혼합');
  });
});

// ─── 겹침 순서 버튼 ────────────────────────────────────────────────────────
describe('DrawingPropertyPanel — 겹침 순서', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();
  const mk = (id: string, price: number): Drawing => ({ ...HLINE, id, price });
  const ids = () => s().drawingsFor(SCOPE).map((d) => d.id);

  const seed = (selected: string[]) => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    ['h1', 'h2', 'h3'].forEach((id, i) => s().add(SCOPE, mk(id, 1000 * (i + 1))));
    s().addToSelection(SCOPE, selected);
    render(<DrawingPropertyPanel scope={SCOPE} />);
  };

  it('단일 선택 패널에도 있다', () => {
    seed(['h1']);
    fireEvent.click(screen.getByTestId('drawing-bring-front'));
    expect(ids()).toEqual(['h2', 'h3', 'h1']);
  });

  it('다중 툴바에서 집합 전체를 옮긴다', () => {
    seed(['h1', 'h2']);
    fireEvent.click(screen.getByTestId('drawing-send-back'));
    expect(ids()).toEqual(['h1', 'h2', 'h3']); // 이미 앞이라 그대로
    fireEvent.click(screen.getByTestId('drawing-bring-front'));
    expect(ids()).toEqual(['h3', 'h1', 'h2']);
  });

  it('잠긴 단일 선택에서는 비활성된다', () => {
    seed(['h1']);
    act(() => {
      s().update(SCOPE, 'h1', { locked: true });
    });
    expect(screen.getByTestId('drawing-bring-front')).toBeDisabled();
  });

  it('전부 잠긴 다중 선택에서도 비활성된다', () => {
    seed(['h1', 'h2']);
    act(() => {
      s().updateMany(SCOPE, ['h1', 'h2'].map((id) => ({ id, patch: { locked: true } as Partial<Drawing> })));
    });
    expect(screen.getByTestId('drawing-send-back')).toBeDisabled();
  });
});

// ─── 정렬·분배 팝오버 ──────────────────────────────────────────────────────
describe('DrawingPropertyPanel — 정렬·분배', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();

  // 선형 스텁 — 1 000 ms = 1 px, 가격 1 = 1 px.
  const coords = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    canvasXToRealMs: (px: number) => px * 1_000,
    priceToCanvasY: (price: number) => 400 - price,
    canvasYToPrice: (py: number) => 400 - py,
    priceBoundsForPane: () => ({ top: 10_000, bottom: -10_000 }),
    toBar: (ms: number) => ms,
    toReal: (b: number) => b,
    originBar: -Infinity,
  };

  const hline = (id: string, price: number): Drawing => ({ ...HLINE, id, price });
  const rect = (id: string, ms: number): Drawing =>
    ({
      id, kind: 'rect',
      a: { realMs: ms, price: 100 }, b: { realMs: ms + 10_000, price: 200 },
      color: '#14B8A6', width: 2, lineStyle: 'solid', fillOpacity: 0.1, paneId: 'candle',
    }) as Drawing;

  const seed = (items: Drawing[], withCoords = true) => {
    s().__resetForTests();
    s().setActiveScope(SCOPE);
    items.forEach((d) => s().add(SCOPE, d));
    s().addToSelection(SCOPE, items.map((d) => d.id));
    render(
      <DrawingPropertyPanel
        scope={SCOPE}
        resolveAlignCoords={withCoords ? () => coords : undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('drawing-align-trigger'));
  };

  // ⚠ 이 기능을 두 번 미루게 했던 문제의 UI 쪽 답. 축을 통째로 포기하지 않고
  // 그 축에서 그 종류를 뺀다.
  it('hline 만 고르면 가로 항목만 비활성된다', () => {
    seed([hline('h1', 100), hline('h2', 200)]);
    expect(screen.getByTestId('drawing-align-left')).toBeDisabled();
    expect(screen.getByTestId('drawing-align-right')).toBeDisabled();
    expect(screen.getByTestId('drawing-align-top')).not.toBeDisabled();
    expect(screen.getByTestId('drawing-align-bottom')).not.toBeDisabled();
  });

  it('사각형 둘이면 정렬은 되고 분배는 안 된다 — 둘은 양 끝이다', () => {
    seed([rect('r1', 0), rect('r2', 50_000)]);
    expect(screen.getByTestId('drawing-align-left')).not.toBeDisabled();
    expect(screen.getByTestId('drawing-distribute-horizontal')).toBeDisabled();
  });

  it('셋이면 분배가 열린다', () => {
    seed([rect('r1', 0), rect('r2', 30_000), rect('r3', 90_000)]);
    expect(screen.getByTestId('drawing-distribute-horizontal')).not.toBeDisabled();
  });

  // 좌표를 못 얻으면(차트 미부착) 눌러도 할 일이 없다 — 비활성이 정직하다.
  it('좌표가 없으면 전부 비활성된다', () => {
    seed([rect('r1', 0), rect('r2', 50_000)], false);
    expect(screen.getByTestId('drawing-align-left')).toBeDisabled();
    expect(screen.getByTestId('drawing-align-top')).toBeDisabled();
  });

  it('정렬은 실제로 적용되고 되돌리기 한 단계다', () => {
    seed([rect('r1', 0), rect('r2', 50_000)]);
    fireEvent.click(screen.getByTestId('drawing-align-left'));

    const xs = () => s().drawingsFor(SCOPE).map((d) => (d as { a: { realMs: number } }).a.realMs);
    expect(xs()).toEqual([0, 0]);
    act(() => {
      s().undo(SCOPE);
    });
    expect(xs()).toEqual([0, 50_000]);
  });

  it('분배는 사이를 고르게 벌린다', () => {
    seed([rect('r1', 0), rect('r2', 10_000), rect('r3', 90_000)]);
    fireEvent.click(screen.getByTestId('drawing-distribute-horizontal'));
    expect(
      s().drawingsFor(SCOPE).map((d) => (d as { a: { realMs: number } }).a.realMs),
    ).toEqual([0, 45_000, 90_000]);
  });
});
