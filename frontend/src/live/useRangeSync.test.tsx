import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useRangeSyncFollow, useRangeSyncPublish } from './useRangeSync';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import type { VirtualAxis } from '../util/virtualAxis';
import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

const RIGHT_OFFSET = CHART_TIMESCALE_OPTIONS.rightOffset ?? 0;

/** 축은 항등 — 테스트가 보는 virtual ms 는 곧 real ms 다. */
const axis = {
  toReal: (v: number) => v,
  toVirtual: (ms: number) => ms,
} as unknown as VirtualAxis;

const MINUTE_ORIGIN: SidebarCursorOrigin = {
  windowId: 'minute-window', group: 1, code: '064350', timeframe: '1m',
};

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
  syncPeer?: boolean;
  myGroup?: number | null;
  /** 우측 클램프 기준. 기본은 아주 먼 미래라 클램프가 안 걸린다. */
  lastCandleMs?: number | null;
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
    lastCandleMs: props.lastCandleMs ?? null,
    enabled: props.enabled ?? true,
    syncPeer: props.syncPeer ?? true,
    myWindowId: props.myWindowId ?? 'daily-window',
    myTimeframe: props.myTimeframe ?? 'D',
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
describe('useRangeSyncFollow — peer 모드', () => {
  const DAILY_ORIGIN: SidebarCursorOrigin = {
    windowId: 'other-daily', group: 1, code: '064350', timeframe: 'D',
  };
  // 소비 창의 현재 시각 범위 — 목이 `getVisibleRange` 하나를 공유하므로 여기서 민다.
  // 기본값(1,000~2,000)은 복제 대상과 같아 "이미 그 구간" 가드에 걸린다.
  beforeEach(() => { visibleRange = { from: 9_000, to: 9_500 }; });

  it('같은 봉 발행을 받아 구간을 복제한다 — 축이 항등이라 ms/1000 이 가상초', async () => {
    render(<Follower myTimeframe="D" />);
    publishRange(1_000_000, 2_000_000, DAILY_ORIGIN);
    await flushFrame();
    expect(setVisibleRange).toHaveBeenCalledWith({ from: 1_000, to: 2_000 });
    // 중앙 정렬 경로는 타지 않는다.
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('토글을 끄면 복제하지 않는다 — **중앙 정렬로 떨어지지도 않는다**', async () => {
    // 판별 케이스다. 한때 토글이 꺼지면 peer 가 중앙 정렬 경로로 갔는데, 그러면 두
    // 창이 **같은 구간을 보지 않으면서 동기화된 것처럼 보인다**. 지금은 `syncModeFor`
    // 가 peer 를 없는 모드로 만들어 아무 경로도 타지 않는다.
    render(<Follower myTimeframe="D" syncPeer={false} />);
    publishRange(1_000_000, 2_000_000, DAILY_ORIGIN);
    await flushFrame();
    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('주봉 창은 주봉 발행만 받는다 — 일↔주는 통하지 않는다', async () => {
    render(<Follower myTimeframe="W" />);
    publishRange(1_000_000, 2_000_000, DAILY_ORIGIN);
    await flushFrame();
    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('주봉 ↔ 주봉은 복제한다', async () => {
    render(<Follower myTimeframe="W" />);
    publishRange(1_000_000, 2_000_000, { ...DAILY_ORIGIN, timeframe: 'W' });
    await flushFrame();
    expect(setVisibleRange).toHaveBeenCalledWith({ from: 1_000, to: 2_000 });
  });

  it('창번호가 다르면 peer 도 막힌다 — 범위 규칙은 모드와 무관하다', async () => {
    render(<Follower myTimeframe="D" myGroup={2} />);
    publishRange(1_000_000, 2_000_000, DAILY_ORIGIN);
    await flushFrame();
    expect(setVisibleRange).not.toHaveBeenCalled();
  });

  it('이미 그 구간이면 되쓰지 않는다', async () => {
    visibleRange = { from: 1_000, to: 2_000 };
    render(<Follower myTimeframe="D" />);
    publishRange(1_000_000, 2_000_000, DAILY_ORIGIN);
    await flushFrame();
    expect(setVisibleRange).not.toHaveBeenCalled();
  });
});

/**
 * **폭 합의** — 분봉 하나를 만지면 일봉 창이 **모두 똑같아진다**(사용자 요구
 * 2026-08-22: "일봉 폭도 완전히 동일하게").
 *
 * **이 가드가 막는 방향**: 각 창이 자기 현재 폭을 보존해 같은 발행에도 창 크기만큼
 * 결과가 갈리는 것(실측: 171봉 vs 118봉).
 * **못 보는 것**: 누가 seed 하는가. 마운트 순서에 달렸고 한 라운드 뒤 자기안정이라
 * 계약이 아니다 — 그래서 "첫 창의 폭" 이 아니라 **"둘이 같다"** 를 잰다.
 */
describe('useRangeSyncFollow — 폭 합의', () => {
  it('폭이 다른 두 일봉 창이 같은 발행에 **같은 범위**를 쓴다', async () => {
    const wide = vi.fn();
    const narrow = vi.fn();
    render(
      <>
        <Follower myWindowId="d1" logical={{ from: 0, to: 180 }} apply={wide} />
        <Follower myWindowId="d2" logical={{ from: 60, to: 180 }} apply={narrow} />
      </>,
    );
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    const w = wide.mock.calls.at(-1)?.[0];
    const n = narrow.mock.calls.at(-1)?.[0];
    expect(w).toBeDefined();
    expect(n).toBeDefined();
    // 축이 같은 테스트라 위치까지 같다. 실물에서는 로드 이력이 달라 인덱스가 갈릴 수
    // 있고, 그때도 **폭은** 같아야 한다 — 아래 단언이 계약의 핵심이다.
    expect(w.to - w.from).toBe(n.to - n.from);
    expect(w).toEqual(n);
  });

  it('「같은 봉 창끼리」를 끄면 합의도 꺼진다 — 각자 자기 배율을 지킨다', async () => {
    // 이 토글이 **일봉↔일봉 결합을 통째로** 쥔다는 계약. 폭 합의는 트리거만 분봉일
    // 뿐 결합의 실체는 일봉끼리라, 여기서 빠지면 "일봉끼리 동기화를 껐는데 분봉을
    // 만지면 일봉 폭이 서로 같아지는" 모순이 된다.
    const wide = vi.fn();
    const narrow = vi.fn();
    render(
      <>
        <Follower myWindowId="d1" syncPeer={false} logical={{ from: 0, to: 180 }} apply={wide} />
        <Follower myWindowId="d2" syncPeer={false} logical={{ from: 60, to: 180 }} apply={narrow} />
      </>,
    );
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    // 위치(중점 1,500)는 둘 다 따라간다 — 꺼지는 것은 폭 결합뿐이다.
    expect(wide.mock.calls.at(-1)?.[0]).toEqual({ from: 1_410, to: 1_590 });
    expect(narrow.mock.calls.at(-1)?.[0]).toEqual({ from: 1_440, to: 1_560 });
    expect(useLiveCursorStore.getState().crossSpanAgreement).toBeNull();
  });

  it('발행이 바뀌면 합의를 새로 잡는다 — 낡은 폭에 갇히지 않는다', async () => {
    const applied = vi.fn();
    const view = render(<Follower logical={{ from: 0, to: 100 }} apply={applied} />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();
    expect(applied.mock.calls.at(-1)?.[0]).toMatchObject({ from: 1_450, to: 1_550 });

    // 사용자가 이 창을 직접 확대해 폭이 바뀌었다. 다음 발행은 그 새 폭을 따라야 한다.
    view.rerender(<Follower logical={{ from: 0, to: 40 }} apply={applied} />);
    publishRange(3_000_000, 4_000_000);
    await flushFrame();

    expect(applied.mock.calls.at(-1)?.[0]).toMatchObject({ from: 3_480, to: 3_520 });
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

  it('자기 데이터 밖으로는 밀지 않는다 — 우측 끝에서 멈춘다', async () => {
    // 축이 항등이라 lastCandleMs 3,000,000 → 인덱스 3,000. 우측 끝 = 3,000 + 1 + 여백.
    // 중앙 정렬만 하면 to = 3,050(중점 3,000 + 폭/2)이라 끝을 넘는다.
    render(<Follower lastCandleMs={3_000_000} />);
    publishRange(3_000_000, 3_000_000);
    await flushFrame();

    const arg = setVisibleLogicalRange.mock.calls.at(-1)?.[0] as { from: number; to: number };
    // 폭(100)은 보존하고 우측 끝에 붙는다 — 그 값이 곧 일봉의 평소 오른쪽 끝이다.
    expect(arg.to - arg.from).toBe(100);
    expect(arg.to).toBeLessThanOrEqual(3_001 + RIGHT_OFFSET);
    expect(arg.to).toBeGreaterThan(3_000);
  });

  it('과거 날짜에서는 클램프가 안 걸려 중앙 정렬이 온전하다', async () => {
    render(<Follower lastCandleMs={9_000_000} />);
    publishRange(1_000_000, 2_000_000);
    await flushFrame();

    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1_450, to: 1_550 });
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
