import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import StudyCursorSyncCrosshair from './StudyCursorSyncCrosshair';
import { useLiveCursorStore, type SidebarCursorOrigin } from '../live/useLiveCursorStore';
import { WindowViewContext, type WindowViewValue } from '../live/workspace/windowView';
import type { VirtualAxis } from '../util/virtualAxis';

const DAY_20250619 = Date.UTC(2025, 5, 19, 0, 0);
const DAY_20250620 = Date.UTC(2025, 5, 20, 0, 0);
const CURSOR_1500 = Date.UTC(2025, 5, 19, 6, 0);

const CANDLES = [
  { ts_ms: DAY_20250619, close: 212000 },
  { ts_ms: DAY_20250620, close: 220500 },
];

const MINUTE_ORIGIN: SidebarCursorOrigin = {
  windowId: 'minute-window', group: null, code: '064350', timeframe: '3m',
};

/** `axis.toVirtual` 는 항등 — 테스트가 보는 축 값은 곧 ms/1000. */
const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;

const setCrosshairPosition = vi.fn();
const clearCrosshairPosition = vi.fn();

function makeChart(coords: Map<number, number | null>) {
  const timeScale = {
    width: () => 500,
    height: () => 28,
    timeToCoordinate: vi.fn((t: number) => coords.get(t) ?? null),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  return { timeScale: () => timeScale, setCrosshairPosition, clearCrosshairPosition };
}

const candleSeries = { __series: true };
const paneSeries = new Map([['candle', candleSeries]]) as never;

function renderCrosshair(coords = new Map([[DAY_20250619 / 1000, 260]])) {
  const view = { windowId: 'daily-window' } as WindowViewValue;
  return render(
    <WindowViewContext.Provider value={view}>
      <StudyCursorSyncCrosshair
        chart={makeChart(coords) as never}
        axis={axis}
        candles={CANDLES}
        paneSeries={paneSeries}
        code="064350"
      />
    </WindowViewContext.Provider>,
  );
}

function publish(tsMs = CURSOR_1500, origin = MINUTE_ORIGIN) {
  act(() => { useLiveCursorStore.getState().setSyncCursor(tsMs, origin); });
}

describe('StudyCursorSyncCrosshair', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    setCrosshairPosition.mockClear();
    clearCrosshairPosition.mockClear();
  });
  afterEach(cleanup);

  it('선은 lwc 에 맡긴다 — 종가와 스냅된 일봉 시각으로 setCrosshairPosition 을 부른다', () => {
    renderCrosshair();
    publish();

    // 가격은 그 날 **종가**(분봉 가격을 일봉에 옮기는 건 의미가 없다),
    // 시각은 15:00 커서가 아니라 **일봉 캔들** 앵커로 접힌 값이다.
    expect(setCrosshairPosition).toHaveBeenCalledWith(212000, DAY_20250619 / 1000, candleSeries);
  });

  it('발행이 끊기면 크로스헤어를 지운다 — 안 지우면 화면에 눌어붙는다', () => {
    renderCrosshair();
    publish();
    clearCrosshairPosition.mockClear();

    act(() => { useLiveCursorStore.getState().clearSyncCursorFrom('minute-window'); });

    expect(clearCrosshairPosition).toHaveBeenCalled();
  });

  it('언마운트에서도 지운다 — 창을 닫는 경로', () => {
    const view = renderCrosshair();
    publish();
    clearCrosshairPosition.mockClear();

    view.unmount();

    expect(clearCrosshairPosition).toHaveBeenCalled();
  });

  it('lwc 시간축 배지가 못 채우는 시:분을 칩으로 얹는다', () => {
    renderCrosshair();
    publish();

    expect(screen.getByTestId('study-cursor-sync-chip').textContent).toBe('15:00');
  });

  it('자기 창이 발행하면 아무것도 하지 않는다', () => {
    renderCrosshair();
    publish(CURSOR_1500, { ...MINUTE_ORIGIN, windowId: 'daily-window' });

    expect(setCrosshairPosition).not.toHaveBeenCalled();
    expect(screen.queryByTestId('study-cursor-sync')).toBeNull();
  });

  it('대상이 pane 왼쪽 밖이면 방향과 날짜를 가장자리에 남긴다', () => {
    // lwc 는 화면 밖을 그냥 안 그린다 — 그러면 "동기화가 고장났다" 로 읽힌다.
    renderCrosshair(new Map([[DAY_20250619 / 1000, -1236]]));
    publish();

    const edge = screen.getByTestId('study-cursor-sync-edge-left');
    expect(edge.textContent).toContain('06/19 15:00');
    expect(screen.queryByTestId('study-cursor-sync-chip')).toBeNull();
  });

  it('오른쪽 밖이면 반대 방향으로 붙인다', () => {
    renderCrosshair(new Map([[DAY_20250619 / 1000, 900]])); // pane 폭 500
    publish();

    expect(screen.getByTestId('study-cursor-sync-edge-right')).toBeTruthy();
  });

  it('캔버스(z-index:1) 위에 올라가되 pane 박스로 잘린다 (#1238 ↔ #1272)', () => {
    renderCrosshair();
    publish();

    const box = screen.getByTestId('study-cursor-sync');
    expect(box.className).toContain('z-10');
    // `inset-0` 이면 우측 가격축 거터·하단 시간축 위로 칩이 샌다.
    expect(box.style.width).toBe('500px');
    expect(box.style.bottom).toBe('28px');
  });
});
