import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import CursorSyncCrosshair from './CursorSyncCrosshair';
import { hasSyntheticCrosshair } from './syntheticCrosshair';
import { useLiveCursorStore, type SidebarCursorOrigin } from '../live/useLiveCursorStore';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { LiveTimeframe } from '../state/livePage';
import {
  WindowViewContext,
  type WindowViewValue,
} from '../live/workspace/windowView';
import type { VirtualAxis } from '../util/virtualAxis';

const DAY_20250619 = Date.UTC(2025, 5, 19, 0, 0);
const DAY_20250620 = Date.UTC(2025, 5, 20, 0, 0);
const CURSOR_1500 = Date.UTC(2025, 5, 19, 6, 0);

const CANDLES = [
  { ts_ms: DAY_20250619, close: 212000 },
  { ts_ms: DAY_20250620, close: 220500 },
];

const MINUTE_ORIGIN: SidebarCursorOrigin = {
  windowId: 'minute-window', group: 1, code: '064350', timeframe: '3m',
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

/** 마지막으로 렌더한 차트 — 합성 표시(`syntheticCrosshair`)가 **인스턴스별**이라
 *  그 축을 재려면 테스트가 같은 객체를 쥐고 있어야 한다. */
let lastChart: ReturnType<typeof makeChart> | null = null;

function renderCrosshair(
  coords = new Map([[DAY_20250619 / 1000, 260]]),
  code = '064350',
  timeframe: LiveTimeframe = 'D',
  candles: readonly { ts_ms: number; close: number }[] = CANDLES,
) {
  // `workspace` 는 계약상 필수다(`WindowViewValue`) — 지금까지 아무도 읽지 않아
  // 부분 캐스트로 넘어갔지만, `useActivePrefs` 가 스코프를 잡으려고
  // `workspace.scopePrefix` 를 읽는다. `/live` 창과 같은 값을 실어 준다.
  const view: WindowViewValue = {
    windowId: 'daily-window',
    group: 1,
    code,
    timeframe,
    historicalFromDate: null,
  };
  lastChart = makeChart(coords);
  return render(
    <WindowViewContext.Provider value={view}>
      <CursorSyncCrosshair
        chart={lastChart as never}
        axis={axis}
        candles={candles}
        timeframe={timeframe}
        paneSeries={paneSeries}
        code={code}
      />
    </WindowViewContext.Provider>,
  );
}

function publish(tsMs = CURSOR_1500, origin = MINUTE_ORIGIN) {
  act(() => { useLiveCursorStore.getState().setSyncCursor(tsMs, origin); });
}

describe('CursorSyncCrosshair', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    // 이 컴포넌트는 chartPrefs 도 읽는다 — 다른 스펙이 남긴 토글 값이 새면
    // 종목 축 판정이 조용히 뒤집힌다.
    useChartPrefsStore.getState().resetToDefaults();
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

  it('화면 안이면 DOM 을 내놓지 않는다 — lwc 가 전부 그린다', () => {
    // 분봉의 시:분을 일봉 창에 띄우던 칩은 걷어냈다(2026-08-11 사용자 결정).
    // 일봉 축에 분 단위 시각이 뜨는 것이 축과 맞지 않는다.
    renderCrosshair();
    publish();

    expect(screen.queryByTestId('study-cursor-sync-chip')).toBeNull();
    expect(screen.getByTestId('study-cursor-sync').textContent).toBe('');
  });

  it('자기 창이 발행하면 아무것도 하지 않는다', () => {
    renderCrosshair();
    publish(CURSOR_1500, { ...MINUTE_ORIGIN, windowId: 'daily-window' });

    expect(setCrosshairPosition).not.toHaveBeenCalled();
    expect(screen.queryByTestId('study-cursor-sync')).toBeNull();
  });

  /**
   * ⚙️ 설정 → 차트의 「크로스헤어 동기화 — 다른 종목까지」가 **실제로 배선돼 있는가**.
   *
   * `cursorSync.test.ts` 의 순수 함수 테스트는 이 축을 원리적으로 못 잡는다 —
   * `resolveSyncTarget` 이 옳아도 컴포넌트가 토글을 안 읽으면 전부 초록이다.
   * 그래서 **같은 발행을 두 모드로** 흘려 결과가 갈리는지를 잰다(red-check:
   * `allowCrossSymbol` 전달을 지우면 둘 중 하나가 반드시 빨개진다).
   */
  describe('종목 축 — cursorSyncCrossSymbol 배선', () => {
    /** 이 창은 064350, 발행은 005930 — 종목이 확실히 다르다. */
    const OTHER_SYMBOL: SidebarCursorOrigin = { ...MINUTE_ORIGIN, code: '005930' };

    it('켜져 있으면(기본) 다른 종목 발행도 크로스헤어로 받는다', () => {
      expect(useChartPrefsStore.getState().cursorSyncCrossSymbol).toBe(true);
      renderCrosshair();
      publish(CURSOR_1500, OTHER_SYMBOL);

      expect(setCrosshairPosition).toHaveBeenCalledWith(212000, DAY_20250619 / 1000, candleSeries);
    });

    it('끄면 같은 종목 창끼리만 받는다 — 2026-08-11 동작', () => {
      act(() => { useChartPrefsStore.getState().setToggle('cursorSyncCrossSymbol', false); });
      renderCrosshair();
      publish(CURSOR_1500, OTHER_SYMBOL);

      expect(setCrosshairPosition).not.toHaveBeenCalled();
      expect(screen.queryByTestId('study-cursor-sync')).toBeNull();
    });

    it('꺼도 같은 종목 발행은 그대로 받는다 — 토글이 기능을 통째로 끄는 게 아니다', () => {
      act(() => { useChartPrefsStore.getState().setToggle('cursorSyncCrossSymbol', false); });
      renderCrosshair();
      publish();

      expect(setCrosshairPosition).toHaveBeenCalledWith(212000, DAY_20250619 / 1000, candleSeries);
    });

    it('창번호가 다르면 종목 토글과 무관하게 받지 않는다', () => {
      // 사용자 결정 2026-08-21 — 세 동기화가 같은 범위 규칙(창번호)을 쓴다.
      renderCrosshair();
      publish(CURSOR_1500, { ...MINUTE_ORIGIN, group: 2 });

      expect(setCrosshairPosition).not.toHaveBeenCalled();
      expect(screen.queryByTestId('study-cursor-sync')).toBeNull();
    });

    it('켜져 있으면 지수 창도 개별 종목 호버를 받는다 — 다리가 날짜뿐이다', () => {
      renderCrosshair(new Map([[DAY_20250619 / 1000, 260]]), 'index:KOSPI');
      publish(CURSOR_1500, OTHER_SYMBOL);

      expect(setCrosshairPosition).toHaveBeenCalledWith(212000, DAY_20250619 / 1000, candleSeries);
    });
  });

  /**
   * **일봉 → 일봉**과 **분봉 → 분봉**(2026-08-21). 여기서 재는 것은 판정이 아니라
   * **배선**이다 — 컴포넌트가 자기 봉으로 올바른 다리를 고르는가.
   *
   * `cursorSync.test.ts` 는 이 축을 원리적으로 못 잡는다: 다리 선택이 컴포넌트에
   * 있어서, 판정 함수가 옳아도 분봉 창이 `date` 다리를 고르면 순수 테스트는 전부
   * 초록이다(그리고 화면은 하루 한 점만 가리킨다).
   */
  describe('방향 배선 — 일봉↔일봉 · 분봉↔분봉', () => {
    /** 06/19 14:50 · 14:55 · 15:00 — 분봉 소비 창이 들고 있는 캔들. */
    const M_1450 = Date.UTC(2025, 5, 19, 5, 50);
    const M_1455 = Date.UTC(2025, 5, 19, 5, 55);
    const M_1500 = Date.UTC(2025, 5, 19, 6, 0);
    const MINUTE_CANDLES = [
      { ts_ms: M_1450, close: 211000 },
      { ts_ms: M_1455, close: 211500 },
      { ts_ms: M_1500, close: 212000 },
    ];
    const DAILY_ORIGIN: SidebarCursorOrigin = {
      windowId: 'other-daily', group: 1, code: '005930', timeframe: 'D',
    };

    it('일봉 창이 다른 일봉 창의 발행을 받는다', () => {
      renderCrosshair();
      publish(CURSOR_1500, DAILY_ORIGIN);

      expect(setCrosshairPosition).toHaveBeenCalledWith(212000, DAY_20250619 / 1000, candleSeries);
    });

    it('W 발행은 일봉 창도 받지 않는다 — 열린 건 D 까지다', () => {
      renderCrosshair();
      publish(CURSOR_1500, { ...DAILY_ORIGIN, timeframe: 'W' });

      expect(setCrosshairPosition).not.toHaveBeenCalled();
    });

    it('분봉 창은 같은 순간으로 스냅한다 — 날짜 다리를 쓰면 하루 한 점만 가리킨다', () => {
      // 14:56 커서 → 14:55 봉. `date` 다리였다면 그 날의 **마지막** 봉(15:00)이 나온다.
      // 두 값이 다른 좌표라 이 단언 하나가 다리 선택을 가른다.
      const cursor = Date.UTC(2025, 5, 19, 5, 56);
      renderCrosshair(new Map([[M_1455 / 1000, 260]]), '064350', '1m', MINUTE_CANDLES);
      publish(cursor, { ...MINUTE_ORIGIN, code: '005930' });

      expect(setCrosshairPosition).toHaveBeenCalledWith(211500, M_1455 / 1000, candleSeries);
    });

    it('분봉 창이 일봉 발행을 받아 그 날 **마지막** 봉에 선다', () => {
      // 2026-08-21 에 열린 마지막 방향. 발행 ms 는 그 날 09:00 앵커이므로 최근접
      // 스냅으로 배선하면 첫 봉(14:50 = 211000)이 나온다 — 이 단언이 그 갈림길이다.
      const anchor = Date.UTC(2025, 5, 19, 0, 0);
      renderCrosshair(new Map([[M_1500 / 1000, 260]]), '064350', '1m', MINUTE_CANDLES);
      publish(anchor, DAILY_ORIGIN);

      expect(setCrosshairPosition).toHaveBeenCalledWith(212000, M_1500 / 1000, candleSeries);
    });

    it('그 날이 분봉 창에 없으면 크로스헤어 대신 방향 칩을 남긴다', () => {
      // 06/20 커서, 이 창은 06/19 만 들고 있다. 2026-08-21 이전엔 여기가 **침묵**이라
      // "고장났다" 로 읽혔다 — 이제 사유가 화면에 남는다.
      renderCrosshair(new Map(), '064350', '1m', MINUTE_CANDLES);
      publish(Date.UTC(2025, 5, 20, 6, 0), { ...MINUTE_ORIGIN, code: '005930' });

      expect(setCrosshairPosition).not.toHaveBeenCalled();
      const edge = screen.getByTestId('study-cursor-sync-edge-right');
      expect(edge.textContent).toContain('06/20');
    });

    it('일봉 창이 맥락 밖 날짜를 호버해도 같은 칩이 뜬다 — 방향 무관하게 일괄', () => {
      renderCrosshair();
      publish(Date.UTC(2025, 5, 10, 6, 0), { ...MINUTE_ORIGIN, code: '005930' });

      expect(setCrosshairPosition).not.toHaveBeenCalled();
      expect(screen.getByTestId('study-cursor-sync-edge-left').textContent).toContain('06/10');
    });

    it('⚠ 게이트에 걸린 발행은 칩도 띄우지 않는다 — 자기 발행이 그 함정이다', () => {
      // 게이트 차단이 out-of-range 로 새면 자기 호버마다 자기 창에 "범위 밖" 이 뜬다.
      renderCrosshair(new Map(), '064350', '1m', MINUTE_CANDLES);
      publish(Date.UTC(2025, 5, 10, 6, 0), { ...MINUTE_ORIGIN, windowId: 'daily-window' });

      expect(screen.queryByTestId('study-cursor-sync')).toBeNull();
    });
  });

  it('대상이 pane 왼쪽 밖이면 방향과 날짜를 가장자리에 남긴다', () => {
    // lwc 는 화면 밖을 그냥 안 그린다 — 그러면 "동기화가 고장났다" 로 읽힌다.
    renderCrosshair(new Map([[DAY_20250619 / 1000, -1236]]));
    publish();

    const edge = screen.getByTestId('study-cursor-sync-edge-left');
    // 날짜만 — 시각은 뺐다.
    expect(edge.textContent).toContain('06/19');
    expect(edge.textContent).not.toContain('15:00');
  });

  it('오른쪽 밖이면 반대 방향으로 붙인다', () => {
    renderCrosshair(new Map([[DAY_20250619 / 1000, 900]])); // pane 폭 500
    publish();

    expect(screen.getByTestId('study-cursor-sync-edge-right')).toBeTruthy();
  });

  /**
   * 합성 표시(`syntheticCrosshair`) — **그리는 쪽**의 절반.
   *
   * 나머지 절반은 `LiveChartRoot.test.tsx` 의 발행 게이트다. 둘을 갈라 둔 이유는
   * 표시가 **두 층의 계약**이기 때문이다: 여기서 안 걸면 가드가 조용히 열리고,
   * 거기서 안 읽으면 표시가 write-only 로 썩는다.
   */
  describe('합성 크로스헤어 표시', () => {
    it('크로스헤어를 걸면 이 차트를 합성으로 표시한다', () => {
      renderCrosshair();
      publish();

      expect(setCrosshairPosition).toHaveBeenCalled();
      expect(hasSyntheticCrosshair(lastChart as never)).toBe(true);
    });

    it('발행이 끊기면 크로스헤어와 함께 표시도 걷는다', () => {
      renderCrosshair();
      publish();
      act(() => { useLiveCursorStore.getState().clearSyncCursorFrom(MINUTE_ORIGIN.windowId); });

      expect(clearCrosshairPosition).toHaveBeenCalled();
      expect(hasSyntheticCrosshair(lastChart as never)).toBe(false);
    });

    it('언마운트도 표시를 남기지 않는다 — 남으면 그 창의 재획득이 영영 막힌다', () => {
      const { unmount } = renderCrosshair();
      publish();
      unmount();

      expect(hasSyntheticCrosshair(lastChart as never)).toBe(false);
    });

    it('게이트에 걸려 아무것도 안 그린 창은 표시하지 않는다', () => {
      // 자기 발행 — 크로스헤어를 걸지 않으므로 이 창의 재발화는 여전히 유효하다.
      renderCrosshair();
      publish(CURSOR_1500, { ...MINUTE_ORIGIN, windowId: 'daily-window' });

      expect(setCrosshairPosition).not.toHaveBeenCalled();
      expect(hasSyntheticCrosshair(lastChart as never)).toBe(false);
    });
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
