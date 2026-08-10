// frontend/src/chart/DrawingOverlay.test.tsx
//
// Focused unit tests for the empty-click deselect predicate that powers
// the window-level mousedown listener in DrawingOverlay. The full
// component requires IChartApi + VirtualAxis + paneSeries scaffolding,
// so we extract the predicate and test it in isolation. The companion
// integration coverage lives in the manual QA pass and in ADR-0030 /
// ADR-0032.

import { act, fireEvent, render } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import DrawingOverlay, { __test__ } from './DrawingOverlay';
import { useDrawingsStore } from '../state/drawings';

const { shouldDeselectOnClick } = __test__;

describe('shouldDeselectOnClick', () => {
  const rect = { width: 800, height: 400 };

  it('returns true when the click is inside the overlay and misses every drawing', () => {
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, false, false)).toBe(true);
  });

  it('returns false when the click is inside the overlay but hits a drawing', () => {
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true, false)).toBe(false);
  });

  it('returns false when the click is outside the overlay bounds', () => {
    // Outside on the right edge.
    expect(shouldDeselectOnClick({ x: 900, y: 50 }, rect, false, false)).toBe(false);
    // Outside on the bottom edge.
    expect(shouldDeselectOnClick({ x: 100, y: 500 }, rect, false, false)).toBe(false);
    // Negative — pointer is left/above the overlay.
    expect(shouldDeselectOnClick({ x: -1, y: 50 }, rect, false, false)).toBe(false);
    expect(shouldDeselectOnClick({ x: 100, y: -1 }, rect, false, false)).toBe(false);
  });

  // ADR-0032 — Drawing Property Panel guard. The panel renders over the
  // chart area; its mousedown events would otherwise trigger empty-click
  // deselect, clearing selectedId and unmounting the panel before the
  // user's edit (color / thickness / lineStyle) registers. The delete
  // button worked anyway because it captured `id` in a closure before
  // selectedId went null — masking the bug. This test pins the guard.
  it('returns false when the click originates on the Drawing Property Panel, even if otherwise eligible', () => {
    // Inside the overlay, misses every drawing — would normally deselect.
    // The panel guard wins.
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, false, true)).toBe(false);
  });

  it('the panel guard does not override a click that already hits a drawing', () => {
    // No state change required either way — the click hits a drawing, so
    // empty-click semantics never apply. Asserting both panel-true and
    // panel-false return the same answer keeps the rule orthogonal.
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true, true)).toBe(false);
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true, false)).toBe(false);
  });
});

describe('DrawingOverlay context menu', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  it('switches back to select mode on right-click and suppresses the browser menu', () => {
    useDrawingsStore.getState().setActiveTool('trendline');
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
      panes: () => [],
    };
    const { container } = render(
      <DrawingOverlay
        chart={chart as never}
        axis={{ segments: [] } as never}
        scope="005930|minute"
        paneSeries={new Map()}
      />,
    );
    const overlay = container.querySelector('[data-drawing-overlay]');
    expect(overlay).not.toBeNull();

    const prevented = !fireEvent.contextMenu(overlay!);

    expect(prevented).toBe(true);
    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });
});

describe('DrawingOverlay Alt+C — 모두 지우기', () => {
  const SCOPE = '005930|minute';
  const s = () => useDrawingsStore.getState();

  beforeEach(() => {
    localStorage.clear();
    s().__resetForTests();
  });

  function renderOverlay() {
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
      panes: () => [],
    };
    return render(
      <DrawingOverlay
        chart={chart as never}
        axis={{ segments: [] } as never}
        scope={SCOPE}
        paneSeries={new Map()}
      />,
    );
  }

  function altC() {
    return fireEvent.keyDown(window, { key: 'c', altKey: true });
  }

  const hline = { id: 'h1', kind: 'hline', price: 100, paneId: 'candle' } as never;

  // 단축키가 곧장 지우면 오타 한 번이 그림 전체를 날린다. 메뉴 항목과 똑같이
  // 확인 요청까지만 간다.
  it('요청만 내고 지우지는 않는다', () => {
    s().importDrawings(SCOPE, [hline]);
    renderOverlay();

    altC();

    expect(s().clearConfirm).toEqual({ scope: SCOPE, count: 1 });
    expect(s().drawingsFor(SCOPE)).toHaveLength(1);
  });

  it('지울 게 없으면 팝업도 뜨지 않는다', () => {
    renderOverlay();
    altC();
    expect(s().clearConfirm).toBeNull();
  });

  // 확인 팝업이 떠 있는 동안 차트는 키를 먹지 않는다 — 모달 뒤에서 도구가
  // 바뀌거나 선택이 지워지면 사용자가 못 본 변경이 쌓인다.
  it('팝업이 떠 있는 동안엔 다른 단축키도 무시한다', () => {
    s().importDrawings(SCOPE, [hline]);
    renderOverlay();
    altC();

    fireEvent.keyDown(window, { key: 'b', altKey: true }); // 연필 단축키
    expect(s().activeTool).toBe('select');
  });

  // Ctrl/Meta 조합은 브라우저 몫 — 도구 단축키와 같은 규칙을 따른다.
  it('Ctrl/Meta 가 함께 눌린 Alt+C 는 무시한다', () => {
    s().importDrawings(SCOPE, [hline]);
    renderOverlay();

    fireEvent.keyDown(window, { key: 'c', altKey: true, ctrlKey: true });
    fireEvent.keyDown(window, { key: 'c', altKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: 'c' }); // Alt 없이

    expect(s().clearConfirm).toBeNull();
  });
});

describe('DrawingOverlay pointer-events 게이트 — select 진입 즉시 판정', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  /**
   * 그리기 도구를 우클릭으로 놓으면 커서는 방금 그린 도형 위에 멈춰 있다. 게이트가
   * 무조건 'none' 으로 초기화하던 시절엔 그 도형이 **손을 움직이기 전까지** 클릭
   * 불가라, select 모드가 안 걸린 것처럼 보여 사용자가 우클릭을 한 번 더 눌렀다
   * (실제로 상태를 바꾼 건 두 번째 클릭이 아니라 그 사이의 마우스 흔들림이었다).
   * 그래서 여기선 **mousemove 없이** 도구만 바꾸고 게이트를 확인한다.
   */
  function renderOverlay() {
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
      panes: () => [],
    };
    return render(
      <DrawingOverlay
        chart={chart as never}
        axis={{ segments: [] } as never}
        scope="005930|minute"
        paneSeries={new Map()}
      />,
    );
  }

  it('도구 활성 중에는 오버레이가 포인터를 받는다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    const { container } = renderOverlay();

    const overlay = container.querySelector('[data-drawing-overlay]') as HTMLElement;
    expect(overlay.style.pointerEvents).toBe('auto');
  });

  /**
   * 활성 도구를 알려주는 유일한 신호가 헤더 버튼 라벨뿐이라, 우클릭 해제가 걸렸는지
   * 눈으로 확인할 수가 없었다(lightweight-charts 는 커서를 안 건드려 늘 화살표).
   * `TOOLS[].cursor` 는 정의만 있고 아무도 안 읽던 죽은 필드였다.
   */
  it('활성 도구의 커서를 오버레이에 입힌다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    const { container } = renderOverlay();
    const overlay = container.querySelector('[data-drawing-overlay]') as HTMLElement;

    expect(overlay.style.cursor).toBe('crosshair');

    act(() => {
      useDrawingsStore.getState().setActiveTool('text');
    });
    expect(overlay.style.cursor).toBe('text');

    act(() => {
      useDrawingsStore.getState().setActiveTool('select');
    });
    expect(overlay.style.cursor).toBe('default');
  });

  it('지우개는 조준 커서다 — not-allowed 는 "못 지운다"로 읽힌다', () => {
    useDrawingsStore.getState().setActiveTool('eraser');
    const { container } = renderOverlay();
    const overlay = container.querySelector('[data-drawing-overlay]') as HTMLElement;

    expect(overlay.style.cursor).toBe('crosshair');
  });

  it('빈 곳에서 select 로 돌아오면 포인터를 차트에 넘긴다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    const { container } = renderOverlay();
    const overlay = container.querySelector('[data-drawing-overlay]') as HTMLElement;

    // 커서 위치를 기억시킨 뒤(도형 없음 → hit 없음) 도구만 해제한다.
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 });
    act(() => {
      useDrawingsStore.getState().setActiveTool('select');
    });

    expect(overlay.style.pointerEvents).toBe('none');
  });
});

describe('DrawingOverlay text editor — pointer isolation', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  // Rich-enough chart/axis/paneSeries stubs for the text tool to resolve an
  // anchor and open the editor. Identity projections: px↔realMs/1000, py↔price.
  function mountWithCandlePane() {
    const fakePane = { paneIndex: () => 0, getHeight: () => 400 };
    const fakeSeries = {
      priceToCoordinate: (p: number) => p,
      coordinateToPrice: (y: number) => y,
      getPane: () => fakePane,
    };
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        coordinateToTime: (x: number) => x,
        timeToCoordinate: (t: number) => t,
        coordinateToLogical: (x: number) => x,
        logicalToCoordinate: (l: number) => l,
      }),
      panes: () => [{ getHeight: () => 400, getSeries: () => [] }],
    };
    const axis = {
      segments: [{ date: '20260101', sessionOpenMs: 0, sessionCloseMs: 10_000_000, virtualStart: 0 }],
      contains: () => true,
      toVirtual: (v: number) => v,
      toReal: (v: number) => v,
    };
    return render(
      <DrawingOverlay
        chart={chart as never}
        scope="005930|minute"
        axis={axis as never}
        paneSeries={new Map([['candle', fakeSeries]]) as never}
      />,
    );
  }

  // Regression for the "입력창이 안 나와요" report: the editor opens at the
  // cursor, so a real user's next press lands ON the input (click-to-type,
  // double-click habit). That pointerdown used to bubble into the overlay's
  // tool dispatch → beginTextEdit saw an open edit → committed the empty value
  // → the box vanished the instant it was touched.
  it('clicking inside the open text input does NOT close it', () => {
    useDrawingsStore.getState().setActiveScope('005930|minute');
    useDrawingsStore.getState().setActiveTool('text');
    const { container } = mountWithCandlePane();
    const overlay = container.querySelector('[data-drawing-overlay]')!;

    // Open the editor with a chart click.
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.pointerUp(overlay, { clientX: 100, clientY: 50, button: 0 });
    const input = container.querySelector('[data-drawing-text-input]');
    expect(input).not.toBeNull();

    // Press inside the input itself — must stay open (propagation stopped).
    fireEvent.pointerDown(input!, { clientX: 102, clientY: 52, button: 0 });
    fireEvent.pointerUp(input!, { clientX: 102, clientY: 52, button: 0 });
    expect(container.querySelector('[data-drawing-text-input]')).not.toBeNull();
  });

  // Regression for the focus-steal kill: a REAL click's native mousedown
  // (compat event, ~1ms after pointerdown) moves focus to the non-focusable
  // overlay, blurring the just-opened editor → onBlur commits empty → the box
  // unmounts within 3ms ("입력창이 안 나와요"). Canceling pointerdown for the
  // text tool suppresses the compat mousedown and its focus default (Pointer
  // Events spec), so the editor keeps focus. jsdom can't run native default
  // actions, so we pin the guard itself: defaultPrevented must be true for the
  // text tool and stay false for others (their gestures rely on defaults).
  it('text-tool pointerdown is defaultPrevented (focus-steal guard); select is not', () => {
    useDrawingsStore.getState().setActiveScope('005930|minute');
    useDrawingsStore.getState().setActiveTool('text');
    const { container } = mountWithCandlePane();
    const overlay = container.querySelector('[data-drawing-overlay]')!;

    // fireEvent returns false when preventDefault() was called.
    const textNotPrevented = fireEvent.pointerDown(overlay, { clientX: 100, clientY: 50, button: 0 });
    expect(textNotPrevented).toBe(false);

    act(() => {
      useDrawingsStore.getState().setActiveTool('select');
    });
    const selectNotPrevented = fireEvent.pointerDown(overlay, { clientX: 300, clientY: 90, button: 0 });
    expect(selectNotPrevented).toBe(true);
  });
});

// 팬/줌 중 hover 프로브 스로틀. select 모드의 게이팅 effect 는 window mousemove
// 마다 hitTestAt 을 돌리는데, `dragRef` 가드는 오버레이 자신의 도형 드래그일
// 때만 걸린다 — 차트 팬은 lightweight-charts 가 처리하므로 팬 내내 프레임마다
// 전 도형이 재투영됐다. 뷰포트 변경 구독으로 그 구간만 건너뛴다.
describe('DrawingOverlay hover probe — 팬/줌 스로틀', () => {
  const RECT = {
    left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;

  let origRaf: typeof globalThis.requestAnimationFrame;
  let rafQueue: FrameRequestCallback[] = [];
  /** 예약된 rAF 콜백을 한 프레임분 실행한다. */
  const flushRaf = () => {
    const q = rafQueue;
    rafQueue = [];
    act(() => { for (const cb of q) cb(0); });
  };

  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    origRaf = globalThis.requestAnimationFrame;
    rafQueue = [];
    vi.useFakeTimers();
    // rAF 는 큐잉만 하고 flushRaf() 로 수동 실행한다. 동기 실행 스텁을 쓰면
    // `hoverRaf = requestAnimationFrame(cb)` 에서 콜백의 `hoverRaf = null` 이
    // 바깥 대입보다 먼저 끝나 id 가 되살아나고, 이후 mousemove 가 전부
    // coalesce 게이트에 막힌다 (실제 rAF 는 비동기라 생기지 않는 순서 역전).
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as never;
    // jsdom 의 rect 는 전부 0 이라 프로브의 "오버레이 안" 판정이 항상 실패한다.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = origRaf;
    vi.restoreAllMocks();
  });

  /** 항등 투영(px↔realMs, py↔price) 차트 스텁. 뷰포트 변경 핸들러를 모아 둔다. */
  function mountWithHline() {
    const handlers: Array<() => void> = [];
    const timeScale = {
      subscribeVisibleLogicalRangeChange: vi.fn((h: () => void) => { handlers.push(h); }),
      unsubscribeVisibleLogicalRangeChange: vi.fn((h: () => void) => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      }),
      coordinateToTime: (x: number) => x,
      timeToCoordinate: (t: number) => t,
      coordinateToLogical: (x: number) => x,
      logicalToCoordinate: (l: number) => l,
    };
    const fakePane = { paneIndex: () => 0, getHeight: () => 400 };
    const fakeSeries = {
      priceToCoordinate: (p: number) => p,
      coordinateToPrice: (y: number) => y,
      getPane: () => fakePane,
    };
    const chart = {
      timeScale: () => timeScale,
      panes: () => [{ getHeight: () => 400, getSeries: () => [] }],
    };
    const axis = {
      segments: [{ date: '20260101', sessionOpenMs: 0, sessionCloseMs: 10_000_000, virtualStart: 0 }],
      contains: () => true,
      toVirtual: (v: number) => v,
      toReal: (v: number) => v,
    };

    const s = useDrawingsStore.getState();
    s.setActiveScope('005930|minute');
    s.setActiveTool('select');
    // 가격 100 → y 100 (항등 투영). 커서 y=100 이면 hit, y=300 이면 miss.
    s.add('005930|minute', {
      id: 'h1', kind: 'hline', price: 100, color: '#fff', width: 1, lineStyle: 'solid', paneId: 'candle',
    });

    const view = render(
      <DrawingOverlay
        chart={chart as never}
        scope="005930|minute"
        axis={axis as never}
        paneSeries={new Map([['candle', fakeSeries]]) as never}
      />,
    );
    const overlay = view.container.querySelector('[data-drawing-overlay]') as HTMLElement;
    return { ...view, overlay, handlers, timeScale };
  }

  /** 커서를 옮기고 그 프레임의 프로브까지 실행한다. */
  const hoverAt = (clientX: number, clientY: number) => {
    fireEvent.mouseMove(window, { clientX, clientY });
    flushRaf();
  };

  /** 뷰포트가 움직였다고 알린다(= 사용자가 차트를 팬/줌 중). */
  const movePan = (handlers: Array<() => void>) => {
    act(() => { for (const h of [...handlers]) h(); });
  };

  it('평상시에는 커서 아래 도형 유무를 그대로 반영한다', () => {
    const { overlay } = mountWithHline();

    hoverAt(100, 100);
    expect(overlay.style.pointerEvents).toBe('auto');

    hoverAt(100, 300);
    expect(overlay.style.pointerEvents).toBe('none');
  });

  it('팬 중에는 프로브를 건너뛰고, 팬이 멎으면 1회 프로브로 커서 아래 도형을 되찾는다', () => {
    const { overlay, handlers } = mountWithHline();

    // 도형 밖에서 시작 → 'none'.
    hoverAt(100, 300);
    expect(overlay.style.pointerEvents).toBe('none');

    // 팬 시작. 이후 커서가 도형 위로 올라가도 프로브는 돌지 않는다.
    movePan(handlers);
    hoverAt(100, 100);
    expect(overlay.style.pointerEvents).toBe('none');

    // 팬이 계속되는 동안에도 그대로.
    movePan(handlers);
    hoverAt(100, 100);
    expect(overlay.style.pointerEvents).toBe('none');

    // 팬 종료 → settle 프로브가 마지막 커서 위치로 1회 실행.
    // 이게 없으면 pointerEvents 가 'none' 에 갇혀 도형을 잡을 수 없다.
    act(() => { vi.advanceTimersByTime(200); });
    expect(overlay.style.pointerEvents).toBe('auto');
  });

  /**
   * 그리기 도구를 든 상태의 게이트 — 실측 치수를 그대로 넣는다(/live 1280px:
   * 컨테이너 560.6×555.1, pane 폭 498, 시간축 28). jsdom 의
   * `getBoundingClientRect` 는 전부 0 이라 스텁하지 않으면 플롯 판정이 성립하지
   * 않는다.
   */
  function mountWithTool(tool: 'pencil' | 'hline') {
    const handlers: Array<() => void> = [];
    const timeScale = {
      subscribeVisibleLogicalRangeChange: vi.fn((h: () => void) => { handlers.push(h); }),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      width: () => 498,
      height: () => 28,
      coordinateToTime: (x: number) => x,
      timeToCoordinate: (t: number) => t,
      coordinateToLogical: (x: number) => x,
      logicalToCoordinate: (l: number) => l,
    };
    const chart = {
      timeScale: () => timeScale,
      panes: () => [{ getHeight: () => 400, getSeries: () => [] }],
    };
    const s = useDrawingsStore.getState();
    s.setActiveScope('005930|minute');
    s.setActiveTool(tool);

    const view = render(
      <DrawingOverlay
        chart={chart as never}
        scope="005930|minute"
        axis={{ segments: [], contains: () => true, toVirtual: (v: number) => v, toReal: (v: number) => v } as never}
        paneSeries={new Map() as never}
      />,
    );
    const overlay = view.container.querySelector('[data-drawing-overlay]') as HTMLElement;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 560.6, height: 555.1, right: 560.6, bottom: 555.1, x: 0, y: 0 }) as DOMRect;
    return { ...view, overlay };
  }

  // 예전엔 도구를 들면 게이트가 무조건 'auto' 라 컨테이너가 덮는 축 거터까지
  // 오버레이가 삼켰고, 그 결과 **축 드래그(가격축 세로 스케일 · 시간축 barSpacing)가
  // 완전히 죽었다**. 플롯 안/가격축/시간축 세 지점을 한 테스트에서 본다 — 한 축만
  // 재면 나머지 축의 실수가 그대로 남는다.
  it('그리기 도구 중에도 축 거터 위에서는 포인터를 lwc 에 넘긴다', () => {
    const { overlay } = mountWithTool('pencil');

    hoverAt(300, 300); // 플롯 안
    expect(overlay.style.pointerEvents).toBe('auto');

    hoverAt(530, 300); // 우측 가격축 거터(498 < x)
    expect(overlay.style.pointerEvents).toBe('none');

    hoverAt(300, 540); // 하단 시간축(555.1 - 28 = 527.1 < y)
    expect(overlay.style.pointerEvents).toBe('none');

    hoverAt(300, 300); // 플롯으로 복귀
    expect(overlay.style.pointerEvents).toBe('auto');
  });

  // 선택 모드는 컨테이너 전체를 유지해야 한다 — hline 히트는 y 거리만 보므로
  // 가격축에 그려진 가격 배지 위에서도 잡히고, 그게 배지로 선을 고르는 경로다.
  it('선택 모드에서는 가격축 위의 hline 배지도 여전히 잡는다', () => {
    const { overlay } = mountWithHline();

    hoverAt(530, 100); // 가격축 거터 x, hline 의 y
    expect(overlay.style.pointerEvents).toBe('auto');
  });

  it('언마운트 시 뷰포트 구독을 해제한다', () => {
    const { unmount, timeScale, handlers } = mountWithHline();
    // 정확히 1개 — 스로틀용 구독뿐이다. 렌더는 pane primitive 가 lwc 프레임 안에서
    // 직접 처리하므로 이 컴포넌트에 렌더용 뷰포트 구독이 있으면 안 된다(있으면
    // rAF 중첩으로 1프레임 지연이 되살아난다).
    expect(handlers).toHaveLength(1);

    unmount();
    expect(timeScale.unsubscribeVisibleLogicalRangeChange).toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });
});

describe('DrawingOverlay undo/redo keyboard (ADR-0107)', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  function mountOverlay() {
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
      panes: () => [],
    };
    return render(
      <DrawingOverlay
        chart={chart as never}
        axis={{ segments: [] } as never}
        scope="005930|minute"
        paneSeries={new Map()}
      />,
    );
  }

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes the last mutation', () => {
    const s = () => useDrawingsStore.getState();
    s().setActiveScope('005930|minute');
    s().add('005930|minute', { id: 'h1', kind: 'hline', price: 100, color: '#fff', width: 1, lineStyle: 'solid', paneId: 'candle' });
    mountOverlay();
    expect(s().drawingsFor('005930|minute')).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(s().drawingsFor('005930|minute')).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(s().drawingsFor('005930|minute')).toHaveLength(1);
  });

  it('Meta+Z (macOS) also undoes', () => {
    const s = () => useDrawingsStore.getState();
    s().setActiveScope('005930|minute');
    s().add('005930|minute', { id: 'h1', kind: 'hline', price: 100, color: '#fff', width: 1, lineStyle: 'solid', paneId: 'candle' });
    mountOverlay();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(s().drawingsFor('005930|minute')).toHaveLength(0);
  });

  // Escape 와 우클릭은 **같은 하나의 출구**다(사용자 결정, 2026-08-08). 단계로 나누면
  // 어느 제스처가 어디까지 되돌리는지 외워야 하므로 예측 가능성을 택했다.
  describe('Escape·우클릭 = 하나의 출구', () => {
    const SCOPE = '005930|minute';
    function seedSelected(tool: 'pencil' | 'rect' | 'select') {
      const s = useDrawingsStore.getState();
      s.setActiveScope(SCOPE);
      s.add(SCOPE, { id: 'h1', kind: 'hline', price: 100, color: '#fff', width: 1, lineStyle: 'solid', paneId: 'candle' });
      s.setSelected(SCOPE, 'h1');
      s.setActiveTool(tool);
    }

    it('Escape 한 번이 도구와 선택을 함께 푼다', () => {
      const s = () => useDrawingsStore.getState();
      seedSelected('pencil');
      mountOverlay();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(s().activeTool).toBe('select');
      expect(s().selectedByScope.get(SCOPE) ?? null).toBeNull();
    });

    it('우클릭 한 번도 같은 상태로 착지한다 — 두 경로가 갈리지 않는다', () => {
      const s = () => useDrawingsStore.getState();

      // Escape 경로
      seedSelected('pencil');
      const viaEscape = mountOverlay();
      fireEvent.keyDown(window, { key: 'Escape' });
      const afterEscape = { tool: s().activeTool, sel: s().selectedByScope.get(SCOPE) ?? null };
      viaEscape.unmount();

      // 우클릭 경로 — 오버레이 위에서. 전역 리스너 쪽은 contextMenuReset.test.tsx 가 잰다.
      seedSelected('pencil');
      const { container } = mountOverlay();
      fireEvent.contextMenu(container.querySelector('[data-drawing-overlay]')!);
      const afterRightClick = { tool: s().activeTool, sel: s().selectedByScope.get(SCOPE) ?? null };

      expect(afterRightClick).toEqual(afterEscape);
      expect(afterRightClick).toEqual({ tool: 'select', sel: null });
    });

    it('그리기 도구로 진입하면 select 모드에서 고른 선택이 끊긴다', () => {
      // 불변식: 그리기 모드 ⇒ 선택 없음. 커밋이 선택하지 않게 됐어도(2026-08-08),
      // select 모드에서 고른 도형은 도구를 켜도 남는다 — 그 헤일로는 그리기
      // 모드에서 "잡을 수 있다" 고 거짓말을 한다(눌러도 새 도형이 그려진다).
      const s = () => useDrawingsStore.getState();
      seedSelected('select');
      const { rerender } = mountOverlay();
      expect(s().selectedByScope.get(SCOPE) ?? null).toBe('h1');

      s().setActiveTool('pencil');
      rerender(<DrawingOverlay
        chart={{ timeScale: () => ({ subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }), panes: () => [] } as never}
        axis={{ segments: [] } as never}
        scope={SCOPE}
        paneSeries={new Map()}
      />);

      expect(s().selectedByScope.get(SCOPE) ?? null).toBeNull();
      expect(s().activeTool).toBe('pencil'); // 도구는 살아 있다
    });

    it('select 모드에서도 Escape 는 선택을 푼다 (종전 동작)', () => {
      const s = () => useDrawingsStore.getState();
      seedSelected('select');
      mountOverlay();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(s().selectedByScope.get(SCOPE) ?? null).toBeNull();
      expect(s().activeTool).toBe('select');
    });
  });
});
