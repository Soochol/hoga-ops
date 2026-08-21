import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useRangeSyncFollow, useRangeSyncPublish } from './useRangeSync';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import type { VirtualAxis } from '../util/virtualAxis';

/** 축은 항등 — 테스트가 보는 virtual ms 는 곧 real ms 다. */
const axis = {
  toReal: (v: number) => v,
  toVirtual: (ms: number) => ms,
} as unknown as VirtualAxis;

const MINUTE_ORIGIN: SidebarCursorOrigin = {
  windowId: 'minute-window', group: 1, code: '064350', timeframe: '1m',
};

const setVisibleLogicalRange = vi.fn();
let rangeHandler: (() => void) | null = null;

/** `getVisibleRange` 가 돌려줄 값(초 단위). 테스트가 팬을 흉내 낼 때 갈아 끼운다. */
let visibleRange: { from: number; to: number } | null = { from: 1_000, to: 2_000 };
/** 소비 창의 현재 논리 범위. */
let visibleLogical: { from: number; to: number } | null = { from: 100, to: 200 };

function makeChart() {
  const timeScale = {
    getVisibleRange: () => visibleRange,
    getVisibleLogicalRange: () => visibleLogical,
    // 시각(초) → 논리 인덱스. 축이 항등이라 초를 그대로 인덱스로 쓴다.
    timeToIndex: (t: number) => t,
    setVisibleLogicalRange,
    subscribeVisibleLogicalRangeChange: vi.fn((h: () => void) => { rangeHandler = h; }),
    unsubscribeVisibleLogicalRangeChange: vi.fn(() => { rangeHandler = null; }),
  };
  return { timeScale: () => timeScale };
}

/** rAF 를 한 프레임 흘린다 — 발행·추종 둘 다 rAF 로 미룬다. */
const flushFrame = async () => {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
};

function Publisher({ enabled = true }: { enabled?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef(MINUTE_ORIGIN);
  useRangeSyncPublish({
    chart: makeChart() as never,
    axis,
    containerRef,
    enabled,
    originRef,
  });
  return <div ref={containerRef} data-testid="pane" />;
}

function Follower(props: {
  enabled?: boolean;
  myCode?: string | null;
  allowCrossSymbol?: boolean;
  candleCount?: number;
  syncZoom?: boolean;
  myGroup?: number | null;
}) {
  useRangeSyncFollow({
    chart: makeChart() as never,
    axis,
    candleCount: props.candleCount ?? 400,
    enabled: props.enabled ?? true,
    syncZoom: props.syncZoom ?? false,
    myWindowId: 'daily-window',
    myGroup: props.myGroup ?? 1,
    myCode: props.myCode ?? '064350',
    allowCrossSymbol: props.allowCrossSymbol ?? false,
  });
  return null;
}

const publishRange = (from: number, to: number, origin = MINUTE_ORIGIN) =>
  act(() => { useLiveCursorStore.getState().setSyncRange(from, to, origin); });

beforeEach(() => {
  useLiveCursorStore.getState().resetCursor();
  setVisibleLogicalRange.mockClear();
  rangeHandler = null;
  visibleRange = { from: 1_000, to: 2_000 };
  visibleLogical = { from: 100, to: 200 };
});
afterEach(cleanup);

/**
 * **발행은 사용자 제스처 중에만.**
 *
 * **이 가드가 막는 방향**: 새 캔들 도착·백필 재앵커처럼 사용자가 안 민 범위 변화가
 * 발행되는 것. 그게 새면 일봉 창이 틱마다 오늘로 끌려가 다른 기간을 볼 수 없다.
 * **못 보는 것**: 제스처 중에 일어난 프로그램적 변화는 함께 실린다 — 그때 화면에
 * 보이는 범위가 곧 사용자가 만든 범위라 해가 없다.
 */
describe('useRangeSyncPublish — 제스처 게이트', () => {
  it('제스처 없이 범위가 바뀌면 발행하지 않는다', async () => {
    render(<Publisher />);
    act(() => { rangeHandler?.(); });
    await flushFrame();

    expect(useLiveCursorStore.getState().syncRange).toBeNull();
  });

  it('제스처 시작 시점의 범위를 **즉시** 싣는다 — 소비 창의 줌 기준선', async () => {
    // rAF 를 기다리지 않는다. 이 발행이 없으면 그 제스처가 만든 범위 변화가 소비 창의
    // **첫 발행**이 되어 비교할 짝이 없고, 줌 동기화가 한 박자 늦는다(도그푸딩 실측:
    // 분봉은 확대됐는데 일봉 라벨 간격이 그대로).
    const view = render(<Publisher />);
    view.getByTestId('pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(useLiveCursorStore.getState().syncRange?.fromMs).toBe(1_000_000);
  });

  it('드래그 중 범위가 바뀌면 발행한다', async () => {
    const view = render(<Publisher />);
    view.getByTestId('pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    act(() => { rangeHandler?.(); });
    await flushFrame();

    const r = useLiveCursorStore.getState().syncRange;
    // 발행값은 **실시각**이다 — 논리 인덱스를 실으면 창마다 캔들 수가 달라 해석 불가.
    expect(r).toMatchObject({ fromMs: 1_000_000, toMs: 2_000_000, seq: 1 });
    expect(r?.origin.windowId).toBe('minute-window');
  });

  it('드래그가 한 프레임 안에 끝나도 최종 위치를 발행한다', async () => {
    // 범위 변화는 rAF 로 미루는데, 빠른 플릭·합성 드래그는 그 rAF 가 pointerup **뒤에**
    // 돈다. flush 가 없으면 그 제스처의 발행이 통째로 사라진다(도그푸딩 실측 —
    // 분봉은 움직였는데 일봉이 그대로였다). 느린 드래그의 마지막 프레임도 같은 경로다.
    const view = render(<Publisher />);
    view.getByTestId('pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    visibleRange = { from: 7_000, to: 8_000 };
    act(() => { rangeHandler?.(); });
    window.dispatchEvent(new Event('pointerup'));
    await flushFrame();

    expect(useLiveCursorStore.getState().syncRange?.fromMs).toBe(7_000_000);
  });

  it('포인터를 놓으면 그 뒤 범위 변화는 발행하지 않는다', async () => {
    const view = render(<Publisher />);
    view.getByTestId('pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    act(() => { rangeHandler?.(); });
    await flushFrame();
    window.dispatchEvent(new Event('pointerup'));
    await flushFrame(); // 종료 flush 1회(같은 범위라 store no-op)

    visibleRange = { from: 5_000, to: 6_000 };
    act(() => { rangeHandler?.(); });
    await flushFrame();

    // 첫 발행 그대로 — 놓은 뒤의 라이브 엣지 추종이 실리지 않았다.
    expect(useLiveCursorStore.getState().syncRange?.fromMs).toBe(1_000_000);
  });

  it('휠은 꼬리 시간 동안 제스처로 친다 — pointerup 같은 종료 이벤트가 없다', () => {
    // fake timer 는 rAF 도 함께 가짜로 만든다 — 그래서 한 시계로 꼬리와 프레임을 같이 민다.
    vi.useFakeTimers();
    try {
      const view = render(<Publisher />);
      view.getByTestId('pane').dispatchEvent(new Event('wheel', { bubbles: true }));
      act(() => { rangeHandler?.(); });
      act(() => { vi.advanceTimersByTime(20) as unknown as void; });

      expect(useLiveCursorStore.getState().syncRange?.fromMs).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('휠 꼬리가 지나면 그 뒤 범위 변화는 발행하지 않는다 — 라이브 엣지 추종이 새지 않는다', () => {
    vi.useFakeTimers();
    try {
      const view = render(<Publisher />);
      view.getByTestId('pane').dispatchEvent(new Event('wheel', { bubbles: true }));
      // 꼬리(150ms) 만료 — 이때 **최종 위치를 한 번 싣고** 닫는다(드래그 종료와 같은 규칙).
      act(() => { vi.advanceTimersByTime(300) as unknown as void; });
      expect(useLiveCursorStore.getState().syncRange?.fromMs).toBe(1_000_000);

      visibleRange = { from: 9_000, to: 9_500 };
      act(() => { rangeHandler?.(); });
      act(() => { vi.advanceTimersByTime(20) as unknown as void; });

      // 닫힌 뒤의 변화는 갱신하지 않는다.
      expect(useLiveCursorStore.getState().syncRange?.fromMs).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('발행 자격이 없으면 구독조차 걸지 않는다', () => {
    render(<Publisher enabled={false} />);
    expect(rangeHandler).toBeNull();
  });
});

/**
 * **추종**. 여기서 재는 것은 판정이 아니라 배선이다 — 순수 수식이 옳아도 훅이
 * `setVisibleLogicalRange` 를 안 부르면 `rangeSync.test.ts` 는 전부 초록이다.
 */
/**
 * **줌 동기화 배선**(`rangeSyncZoom`, 기본 끔).
 *
 * 순수 수식(`zoomedSpan`)이 옳아도 훅이 그 결과를 `spanOverride` 로 안 넘기면
 * `rangeSync.test.ts` 는 전부 초록이다. 여기서 재는 것은 그 배선이고, **판별 케이스는
 * 「끈 상태에서도 위치는 따라간다」** 다 — 줌 동기화를 끄는 것과 기간 동기화 자체를
 * 끄는 것은 다른 일이다.
 */
describe('useRangeSyncFollow — 줌 동기화 배선', () => {
  /** 기준선을 세우고(1회) 그 다음 발행으로 비율을 만든다. */
  const seedThenZoom = async (nextFrom: number, nextTo: number) => {
    publishRange(1_000_000, 2_000_000); // 기준선: 폭 1,000,000ms
    await flushFrame();
    setVisibleLogicalRange.mockClear();
    visibleLogical = { from: 100, to: 200 }; // 현재 폭 100
    publishRange(nextFrom, nextTo);
    await flushFrame();
  };

  it('끈 상태에서는 폭이 그대로 — 하지만 위치는 따라간다', async () => {
    render(<Follower syncZoom={false} />);
    await seedThenZoom(3_000_000, 3_500_000); // 폭 절반

    // 중점 3,250 → from = 3,250 - 50 = 3,200, 폭 100 유지.
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 3_200, to: 3_300 });
  });

  it('켜면 발행 폭이 절반일 때 추종 폭도 절반', async () => {
    render(<Follower syncZoom />);
    await seedThenZoom(3_000_000, 3_500_000);

    // 폭 100 → 50. 중점 3,250 → from = 3,225.
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 3_225, to: 3_275 });
  });

  it('켜도 팬만이면 폭이 그대로 — 데드밴드', async () => {
    render(<Follower syncZoom />);
    // 폭은 같고 위치만 이동(1,000,000ms 유지).
    await seedThenZoom(3_000_000, 4_000_000);

    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 3_450, to: 3_550 });
  });

  it('발행 창이 바뀌면 그 라운드는 폭을 건드리지 않는다 — 유령 줌 방지', async () => {
    // 분봉 창이 둘이고 배율이 다르면, 번갈아 발행할 때마다 가짜 비율이 나온다.
    render(<Follower syncZoom />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();
    setVisibleLogicalRange.mockClear();
    visibleLogical = { from: 100, to: 200 };
    publishRange(3_000_000, 3_500_000, { ...MINUTE_ORIGIN, windowId: 'other-minute' });
    await flushFrame();

    // 폭 100 유지 — 다른 창의 폭과 비교하지 않는다.
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 3_200, to: 3_300 });
  });

  it('첫 발행은 폭을 건드리지 않는다 — 비율을 잴 짝이 없다', async () => {
    render(<Follower syncZoom />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1_450, to: 1_550 });
  });
});

describe('useRangeSyncFollow — 배선', () => {
  it('발행을 받으면 그 기간을 중앙에 두도록 논리 범위를 민다', async () => {
    render(<Follower />);
    // from 1,000,000ms → 1,000 초 → 인덱스 1,000 / to → 2,000. 중점 1,500.
    // 현재 span 100 → from = 1,450, to = 1,550.
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1_450, to: 1_550 });
  });

  it('마운트 전의 발행은 적용하지 않는다 — 저장뷰 착석과 싸운다', async () => {
    publishRange(1_000_000, 2_000_000);
    render(<Follower />);
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('마운트 뒤의 새 발행은 적용한다 — stale 가드가 기능을 죽이지 않는다', async () => {
    publishRange(1_000_000, 2_000_000);
    render(<Follower />);
    await flushFrame();
    publishRange(3_000_000, 4_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 3_450, to: 3_550 });
  });

  it('창번호가 다르면 따라가지 않는다', async () => {
    render(<Follower myGroup={2} />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('자기 발행은 따라가지 않는다', async () => {
    render(<Follower />);
    publishRange(1_000_000, 2_000_000, { ...MINUTE_ORIGIN, windowId: 'daily-window' });
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('종목이 다르면 토글이 꺼진 동안 따라가지 않는다', async () => {
    render(<Follower allowCrossSymbol={false} />);
    publishRange(1_000_000, 2_000_000, { ...MINUTE_ORIGIN, code: '005930' });
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('토글이 켜져 있으면 종목이 달라도 따라간다', async () => {
    render(<Follower allowCrossSymbol />);
    publishRange(1_000_000, 2_000_000, { ...MINUTE_ORIGIN, code: '005930' });
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalled();
  });

  it('캔들이 아직 없으면 움직이지 않는다 — 빈 축에 인덱스가 없다', async () => {
    render(<Follower candleCount={0} />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('이미 중앙이면 부르지 않는다 — 같은 값을 되쓰면 떤다', async () => {
    visibleLogical = { from: 1_450, to: 1_550 };
    render(<Follower />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });
});
