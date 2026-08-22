import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useRangeSyncFollow, useRangeSyncPublish } from './useRangeSync';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import type { VirtualAxis } from '../util/virtualAxis';
import type { RangeSyncBars } from '../chart/rangeSync';

/** 축은 항등 — 테스트가 보는 virtual ms 는 곧 real ms 다. */
const axis = {
  toReal: (v: number) => v,
  toVirtual: (ms: number) => ms,
} as unknown as VirtualAxis;

/** 발행자는 **다른 일봉 창**이다 — 분봉은 이 채널에서 빠졌다(2026-08-22). */
const DAILY_ORIGIN: SidebarCursorOrigin = {
  windowId: 'other-daily', group: 1, code: '064350', timeframe: 'D',
};
/**
 * 발행 창의 뷰 — 기준 캔들 왼쪽 120봉 ~ **오른쪽 30봉**. `toBars > 0` 이 곧 "캔들
 * 오른쪽 여백을 보고 있다" 다. 목의 `timeToIndex` 가 항등이라 소비 창의 기준
 * 인덱스는 2,000(= `anchorMs`/1000) 이고, 적용 결과는 1,880~2,030 이다.
 */
const BARS: RangeSyncBars = { anchorMs: 2_000_000, fromBars: -120, toBars: 30 };

const setVisibleLogicalRange = vi.fn();
const setVisibleRange = vi.fn();
let rangeHandler: (() => void) | null = null;

/** `getVisibleRange` 가 돌려줄 값(초 단위). 테스트가 팬을 흉내 낼 때 갈아 끼운다. */
let visibleRange: { from: number; to: number } | null = { from: 1_000, to: 2_000 };
/** 소비 창의 현재 논리 범위. */
let visibleLogical: { from: number; to: number } | null = { from: 100, to: 200 };

/**
 * `overrides` 는 **창마다 다른 상태**를 세울 때만 쓴다. 폭 합의처럼 "창 둘이 서로
 * 다른 폭에서 출발한다" 가 전제인 계약은 공유 전역으로는 원리적으로 못 세운다.
 */
function makeChart(overrides: {
  logical?: { from: number; to: number };
  apply?: (r: { from: number; to: number }) => void;
} = {}) {
  const timeScale = {
    getVisibleRange: () => visibleRange,
    getVisibleLogicalRange: () => overrides.logical ?? visibleLogical,
    // 시각(초) → 논리 인덱스. 축이 항등이라 초를 그대로 인덱스로 쓴다.
    timeToIndex: (t: number) => t,
    setVisibleLogicalRange: (r: { from: number; to: number }) => {
      overrides.apply?.(r);
      setVisibleLogicalRange(r);
    },
    setVisibleRange,
    subscribeVisibleLogicalRangeChange: vi.fn((h: () => void) => { rangeHandler = h; }),
    unsubscribeVisibleLogicalRangeChange: vi.fn(() => { rangeHandler = null; }),
  };
  return { timeScale: () => timeScale };
}

/** rAF 를 한 프레임 흘린다 — 발행·추종 둘 다 rAF 로 미룬다. */
const flushFrame = async () => {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
};

/** 발행 창의 마지막 캔들 — 축이 항등이라 가상초 2,000 = 논리 인덱스 2,000. */
const PUBLISHER_LAST_CANDLE_MS = 2_000_000;

function Publisher({ enabled = true }: { enabled?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef(DAILY_ORIGIN);
  const lastCandleMsRef = useRef<number | null>(PUBLISHER_LAST_CANDLE_MS);
  useRangeSyncPublish({
    chart: makeChart() as never,
    axis,
    containerRef,
    enabled,
    originRef,
    lastCandleMsRef,
  });
  return <div ref={containerRef} data-testid="pane" />;
}

function Follower(props: {
  enabled?: boolean;
  myCode?: string | null;
  allowCrossSymbol?: boolean;
  candleCount?: number;
  myGroup?: number | null;
  myTimeframe?: 'D' | 'W' | 'M' | '1m';
  /** 이 창만의 현재 논리 범위 — 생략하면 공유 전역. */
  logical?: { from: number; to: number };
  /** 이 창에 적용된 범위만 받는 스파이. */
  apply?: (r: { from: number; to: number }) => void;
  myWindowId?: string;
}) {
  useRangeSyncFollow({
    chart: makeChart({ logical: props.logical, apply: props.apply }) as never,
    axis,
    candleCount: props.candleCount ?? 400,
    enabled: props.enabled ?? true,
    myWindowId: props.myWindowId ?? 'daily-window',
    myTimeframe: props.myTimeframe ?? 'D',
    myGroup: props.myGroup ?? 1,
    myCode: props.myCode ?? '064350',
    allowCrossSymbol: props.allowCrossSymbol ?? false,
  });
  return null;
}

const publishRange = (
  from: number, to: number, origin = DAILY_ORIGIN, bars?: RangeSyncBars,
) => act(() => { useLiveCursorStore.getState().setSyncRange(from, to, origin, bars); });

/** 정상 발행 한 건 — 봉 단위 뷰까지 실린 것이 기본값이다. */
const peerPublish = (origin = DAILY_ORIGIN, bars: RangeSyncBars = BARS) =>
  publishRange(1_000_000, 2_000_000, origin, bars);

beforeEach(() => {
  useLiveCursorStore.getState().resetCursor();
  setVisibleLogicalRange.mockClear();
  setVisibleRange.mockClear();
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

  it('제스처 시작 시점의 범위를 **즉시** 싣는다 — 소비 창이 한 프레임 늦지 않게', async () => {
    // rAF 를 기다리지 않는다. 어긋난 채 있던 두 창이 **손을 대는 순간** 맞춰진다
    // (첫 움직임까지 기다리지 않는다). 도입 사유였던 줌 기준선은 2026-08-22 에
    // 줌 동기화와 함께 사라졌고, 이 즉시 발행은 위 사유로 남는다.
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
    expect(r?.origin.windowId).toBe('other-daily');
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

  it('⚠ 옆 창의 pointerup 은 내 발행을 만들지 않는다', async () => {
    // `pointerup` 은 `window` 에 걸려 있어(포인터가 창 밖에서 떨어져도 제스처를
    // 닫아야 한다) **옆 창의 드래그도 여기로 들어온다.** 종료 flush 가 게이트를 안
    // 보면 이 창이 자기 범위를 발행해 방금 옆 창이 만든 뷰포트를 되돌린다.
    //
    // 실측(2026-08-21, 사용자 신고): 일봉을 과거로 드래그하면 오늘 캔들이 우측에
    // 오는 위치로 되돌아왔고, 버스의 발행자는 만진 적 없는 분봉 창이었다.
    render(<Publisher />);
    window.dispatchEvent(new Event('pointerup'));
    await flushFrame();

    expect(useLiveCursorStore.getState().syncRange).toBeNull();
  });

  it('발행 자격이 없으면 구독조차 걸지 않는다', () => {
    render(<Publisher enabled={false} />);
    expect(rangeHandler).toBeNull();
  });
});

/**
 * **발행이 여백을 담는가.**
 *
 * **이 가드가 막는 방향**: `getVisibleRange()`(데이터로 클램프된 시각)만 싣고 캔들
 * 오른쪽 여백을 잃는 것. 그러면 소비 창은 데이터 부분만 복제해 **다른 화면**이 된다
 * (실사용 실측 2026-08-22: 발행 120봉 → 소비 74봉).
 * **못 보는 것**: `timeToIndex` 가 없는 환경 — 그때 `bars` 는 안 실리고 peer 는
 * 아무것도 하지 않는다(위 peer describe 가 그 케이스를 본다).
 */
describe('useRangeSyncPublish — 봉 단위 뷰', () => {
  it('논리 범위에서 만든다 — 시각 범위와 값이 다르다는 것이 판별식', () => {
    // 목: 시각 1,000~2,000 · 논리 100~200 · 기준 캔들 인덱스 2,000.
    // 시각을 썼다면 fromBars 는 -1,000 이 됐을 것이다.
    const view = render(<Publisher />);
    view.getByTestId('pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(useLiveCursorStore.getState().syncRange?.bars).toEqual({
      anchorMs: PUBLISHER_LAST_CANDLE_MS, fromBars: -1_900, toBars: -1_800,
    });
  });

  it('시각이 같아도 봉이 움직이면 발행한다 — 여백 안에서 팬해도 멎지 않는다', async () => {
    // 여백 구간에서는 `getVisibleRange()` 가 데이터 끝에 붙어 거의 안 움직인다.
    // dedup 이 시각만 봤다면 이 두 번째 발행이 통째로 사라진다.
    const view = render(<Publisher />);
    view.getByTestId('pane').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const first = useLiveCursorStore.getState().syncRange;

    visibleLogical = { from: 140, to: 240 };
    act(() => { rangeHandler?.(); });
    await flushFrame();

    const next = useLiveCursorStore.getState().syncRange;
    expect(next?.seq).toBe((first?.seq ?? 0) + 1);
    expect(next?.fromMs).toBe(first?.fromMs);
    expect(next?.bars?.fromBars).toBe(-1_860);
  });
});

/**
 * **추종**. 여기서 재는 것은 판정이 아니라 배선이다 — 순수 수식이 옳아도 훅이
 * `setVisibleLogicalRange` 를 안 부르면 `rangeSync.test.ts` 는 전부 초록이다.
 */
/**
 * **peer 모드**(같은 캘린더 봉끼리) — 발행 구간을 그대로 복제한다.
 *
 * **판별 케이스**: cross 는 `setVisibleLogicalRange`(중앙 정렬), peer 는
 * `setVisibleRange`(구간 복제)로 **다른 API** 를 쓴다. 한쪽으로 잘못 배선하면
 * 이 쌍이 갈린다.
 */
describe('useRangeSyncFollow — 복제', () => {

  it('발행 창의 뷰를 봉 단위로 복제한다 — **여백까지**', async () => {
    render(<Follower myTimeframe="D" />);
    peerPublish();
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1_880, to: 2_030 });
    // 시각 경로는 타지 않는다 — `getVisibleRange()` 가 데이터로 클램프돼 여백을 잃는다.
    expect(setVisibleRange).not.toHaveBeenCalled();
  });

  it('봉 단위 뷰가 없는 발행은 적용하지 않는다 — 시각으로 되돌아가지 않는다', async () => {
    // `timeToIndex` 를 못 쓰는 환경의 발행. 여기서 시각 복제로 폴백하면 여백 소실
    // 버그가 되살아나므로, **아무것도 하지 않는 쪽**이 계약이다.
    render(<Follower myTimeframe="D" />);
    publishRange(1_000_000, 2_000_000, DAILY_ORIGIN);
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(setVisibleRange).not.toHaveBeenCalled();
  });

  it('주봉 창은 주봉 발행만 받는다 — 일↔주는 통하지 않는다', async () => {
    render(<Follower myTimeframe="W" />);
    peerPublish();
    await flushFrame();
    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('주봉 ↔ 주봉은 복제한다', async () => {
    render(<Follower myTimeframe="W" />);
    peerPublish({ ...DAILY_ORIGIN, timeframe: 'W' });
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1_880, to: 2_030 });
  });

  it('창번호가 다르면 peer 도 막힌다 — 범위 규칙은 모드와 무관하다', async () => {
    render(<Follower myTimeframe="D" myGroup={2} />);
    peerPublish();
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('이미 그 구간이면 되쓰지 않는다', async () => {
    visibleLogical = { from: 1_880, to: 2_030 };
    render(<Follower myTimeframe="D" />);
    peerPublish();
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });
});


describe('useRangeSyncFollow — 게이트와 stale', () => {
  it('마운트 전의 발행은 적용하지 않는다 — 저장뷰 착석과 싸운다', async () => {
    peerPublish();
    render(<Follower />);
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('마운트 뒤의 새 발행은 적용한다 — stale 가드가 기능을 죽이지 않는다', async () => {
    peerPublish();
    render(<Follower />);
    await flushFrame();
    peerPublish(DAILY_ORIGIN, { ...BARS, fromBars: -60, toBars: 40 });
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1_940, to: 2_040 });
  });

  it('창번호가 다르면 따라가지 않는다', async () => {
    render(<Follower myGroup={2} />);
    peerPublish();
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('자기 발행은 따라가지 않는다', async () => {
    render(<Follower />);
    peerPublish({ ...DAILY_ORIGIN, windowId: 'daily-window' });
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('종목이 다르면 토글이 꺼진 동안 따라가지 않는다', async () => {
    render(<Follower allowCrossSymbol={false} />);
    peerPublish({ ...DAILY_ORIGIN, code: '005930' });
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('토글이 켜져 있으면 종목이 달라도 따라간다', async () => {
    render(<Follower allowCrossSymbol />);
    peerPublish({ ...DAILY_ORIGIN, code: '005930' });
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalled();
  });

  it('캔들이 아직 없으면 움직이지 않는다 — 빈 축에 인덱스가 없다', async () => {
    render(<Follower candleCount={0} />);
    peerPublish();
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  /**
   * **분봉 발행은 받지 않는다**(사용자 결정 2026-08-22).
   *
   * 판정 층(`rangeSync.test.ts`)이 이미 같은 것을 재지만, 배선이 그 판정을 실제로
   * 부르는지는 여기서만 드러난다 — 훅이 판정을 건너뛰면 순수 층은 전부 초록이다.
   */
  it('분봉 창의 발행은 받지 않는다 — 분봉을 밀어도 일봉은 움직이지 않는다', async () => {
    render(<Follower />);
    peerPublish({ ...DAILY_ORIGIN, windowId: 'minute-window', timeframe: '1m' });
    await flushFrame();

    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });
});
