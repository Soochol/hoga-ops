import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useTimeframeJump } from './useTimeframeJump';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import { minuteRightOffsetBars } from './minuteViewportPolicy';
import type { SyncCandle } from '../chart/cursorSync';
import type { VirtualAxis } from '../util/virtualAxis';

/** 축은 항등 — `realMsToVirtualSeconds` 가 ms/1000 을 반올림하므로 인덱스 = 초. */
const axis = {
  toReal: (v: number) => v,
  toVirtual: (ms: number) => ms,
} as unknown as VirtualAxis;

const DAILY_ORIGIN: SidebarCursorOrigin = {
  windowId: 'daily-window', group: 1, code: '064350', timeframe: 'D',
};

/** 시스템 시각을 고정한다 — 보유 한계(13개월) 판정이 `Date.now()` 를 읽는다.
 *  `Date` 만 가짜로 둔다: rAF 까지 가짜로 두면 착지가 영영 안 돈다. */
const NOW = new Date('2026-08-22T05:00:00Z').getTime(); // KST 14:00
const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 기준 `daysAgo` 일 전 09:00 + `minute` 분. */
function bar(daysAgo: number, minute: number): SyncCandle {
  const kstMidnightUtc = Math.floor((NOW - daysAgo * DAY_MS + 9 * 3_600_000) / DAY_MS) * DAY_MS
    - 9 * 3_600_000;
  return { ts_ms: kstMidnightUtc + 9 * 3_600_000 + minute * 60_000, close: 1000 };
}

/** 어제(=목적지 날) 3봉 + 오늘 2봉. 어제 마지막 봉이 착지 대상이다. */
const YESTERDAY_LAST = bar(1, 380);
const FULL_CANDLES: readonly SyncCandle[] = [
  bar(1, 0), bar(1, 200), YESTERDAY_LAST, bar(0, 0), bar(0, 200),
];
/** 아직 백필이 어제까지 안 온 상태 — 오늘 것만 있다. */
const TODAY_ONLY: readonly SyncCandle[] = [bar(0, 0), bar(0, 200)];

const PLOT_WIDTH = 1_000;
const CURRENT_LOGICAL = { from: 100, to: 200 };

const setVisibleLogicalRange = vi.fn();
const scrollToRealTime = vi.fn();

function makeChart() {
  const timeScale = {
    getVisibleLogicalRange: () => CURRENT_LOGICAL,
    timeToIndex: (t: number) => t,
    width: () => PLOT_WIDTH,
    setVisibleLogicalRange,
    scrollToRealTime,
  };
  return { timeScale: () => timeScale };
}

function Consumer(props: {
  candles: readonly SyncCandle[];
  myGroup?: number | null;
  myTimeframe?: '1m' | 'D';
  onResult?: (r: ReturnType<typeof useTimeframeJump>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const result = useTimeframeJump({
    chart: makeChart() as never,
    axis,
    containerRef,
    candles: props.candles,
    enabled: true,
    myWindowId: 'minute-window',
    myTimeframe: props.myTimeframe ?? '1m',
    myGroup: props.myGroup === undefined ? 1 : props.myGroup,
    myCode: '064350',
    allowCrossSymbol: false,
  });
  props.onResult?.(result);
  return (
    <div ref={containerRef} data-testid="pane">
      <span data-testid="status">{result.state?.status ?? 'none'}</span>
      <span data-testid="date">{result.state?.date ?? ''}</span>
      <span data-testid="backfill">{result.backfillFromDate ?? ''}</span>
    </div>
  );
}

/** rAF 한 프레임 — 착지는 rAF 로 미룬다. */
const flushFrame = async () => {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
};

async function requestJump(toMs: number, origin: SidebarCursorOrigin = DAILY_ORIGIN) {
  await act(async () => {
    useLiveCursorStore.getState().requestTimeframeJump(toMs, origin);
  });
}

/** 앵커 봉이 화면 오른쪽 끝에 서는 논리 범위(테스트가 기대하는 값). */
function expectedRange(anchor: SyncCandle) {
  const span = CURRENT_LOGICAL.to - CURRENT_LOGICAL.from;
  const to = Math.round(anchor.ts_ms / 1000) + 1 + minuteRightOffsetBars(span, PLOT_WIDTH);
  return { from: to - span, to };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useLiveCursorStore.getState().resetCursor();
  setVisibleLogicalRange.mockClear();
  scrollToRealTime.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('착지', () => {
  it('그 날 **마지막 봉**을 화면 오른쪽 끝에 놓는다', async () => {
    render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(bar(1, 0).ts_ms); // 그 날 아무 시각이나 — 날짜만 읽는다
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledWith(expectedRange(YESTERDAY_LAST));
  });

  it('폭은 옮기지 않는다 — 일봉 폭을 분봉에 씌우면 렌더 한계를 넘는다', async () => {
    render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    const applied = setVisibleLogicalRange.mock.calls[0][0];
    expect(applied.to - applied.from).toBe(CURRENT_LOGICAL.to - CURRENT_LOGICAL.from);
  });

  it('착지하면 상태가 landed 로 간다', async () => {
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('landed');
  });
});

describe('래치 — seq 하나는 한 번만 착지한다', () => {
  it('착지 뒤 캔들이 갱신돼도 다시 앉히지 않는다 (SSE 틱마다 끌려오지 않는다)', async () => {
    const { rerender } = render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledTimes(1);

    // 틱이 새 캔들을 붙인다 — 배열 정체성이 바뀌므로 이펙트가 다시 돈다.
    for (let i = 0; i < 3; i += 1) {
      rerender(<Consumer candles={[...FULL_CANDLES, bar(0, 300 + i)]} />);
      await flushFrame();
    }
    expect(setVisibleLogicalRange).toHaveBeenCalledTimes(1);
  });

  it('같은 날짜로 다시 누르면 seq 가 올라 래치가 풀린다', async () => {
    render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledTimes(2);
  });
});

describe('재시도 — 백필을 기다린다', () => {
  it('그 날 봉이 아직 없으면 움직이지 않고 seeking 으로 남는다', async () => {
    const { getByTestId } = render(<Consumer candles={TODAY_ONLY} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(getByTestId('status').textContent).toBe('seeking');
  });

  it('백필이 그 날을 채우면 그때 앉는다', async () => {
    const { rerender, getByTestId } = render(<Consumer candles={TODAY_ONLY} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    rerender(<Consumer candles={FULL_CANDLES} />);
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledWith(expectedRange(YESTERDAY_LAST));
    expect(getByTestId('status').textContent).toBe('landed');
  });
});

describe('중단 — 사용자가 그 창을 만지면 포기한다', () => {
  it('기다리는 동안 팬하면 뒤늦게 캔들이 와도 끌어가지 않는다', async () => {
    const { rerender, getByTestId } = render(<Consumer candles={TODAY_ONLY} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    fireEvent.pointerDown(getByTestId('pane'));
    rerender(<Consumer candles={FULL_CANDLES} />);
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('휠도 같은 중단 신호다', async () => {
    const { rerender } = render(<Consumer candles={TODAY_ONLY} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    fireEvent.wheel(document.querySelector('[data-testid="pane"]')!);
    rerender(<Consumer candles={FULL_CANDLES} />);
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });
});

describe('게이트', () => {
  it('창번호가 다르면 아무 일도 없다', async () => {
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} myGroup={2} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(getByTestId('status').textContent).toBe('none');
    // 받지도 않은 점프를 위해 과거를 긁지 않는다.
    expect(getByTestId('backfill').textContent).toBe('');
  });

  it('마운트 전에 있던 발행은 무시한다 (baseline seq)', async () => {
    await requestJump(YESTERDAY_LAST.ts_ms);
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} />);
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(getByTestId('status').textContent).toBe('none');
  });
});

describe('보유 한계 밖', () => {
  const OLD_MS = NOW - 400 * DAY_MS;

  it('상태만 알리고 움직이지 않는다', async () => {
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(OLD_MS);
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('out-of-retention');
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('백필 목표로도 내보내지 않는다 — 긁어도 빈 응답만 온다', async () => {
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(OLD_MS);
    await flushFrame();
    expect(getByTestId('backfill').textContent).toBe('');
  });
});

describe('백필 목표', () => {
  it('게이트를 통과한 목적지 날짜를 내보낸다', async () => {
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(getByTestId('backfill').textContent).toBe(getByTestId('date').textContent);
    expect(getByTestId('backfill').textContent).toMatch(/^\d{8}$/);
  });
});

describe('해제', () => {
  it('× 는 이 창만 풀고 라이브 엣지로 돌아간다', async () => {
    let latest: ReturnType<typeof useTimeframeJump> | null = null;
    const { getByTestId } = render(
      <Consumer candles={FULL_CANDLES} onResult={(r) => { latest = r; }} />,
    );
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('landed');

    await act(async () => { latest!.clear(); });
    expect(getByTestId('status').textContent).toBe('none');
    expect(scrollToRealTime).toHaveBeenCalled();
    // 슬롯은 그대로 둔다 — 지우면 **다른 분봉 창의 칩까지** 사라진다.
    expect(useLiveCursorStore.getState().jumpRequest).not.toBeNull();
  });
});
