import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useTimeframeJump } from './useTimeframeJump';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import { minuteRightOffsetBars } from './minuteViewportPolicy';
import { bucketEndMs } from './minuteJumpDestination';
import { earliestAllowedMinuteDate, realMsToYyyymmdd, todayKstYyyymmdd } from './liveDateTime';
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
  /** 좌측 팬 하한. 미지정이면 벤더 모드(250일 벽), `null` 이면 디스크 모드(무한). */
  floor?: string | null;
  onResult?: (r: ReturnType<typeof useTimeframeJump>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const result = useTimeframeJump({
    chart: makeChart() as never,
    axis,
    containerRef,
    candles: props.candles,
    enabled: true,
    minuteScrollbackFloorDate:
      props.floor === undefined ? earliestAllowedMinuteDate(todayKstYyyymmdd()) : props.floor,
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

/**
 * 점프 발행. 인자가 **칸 시작**이고 상한은 그 날 끝으로 잡는다 — 일봉 발행의 모양이다
 * (`bucketEndMs('D', …)` 와 같은 값). 주·월봉 칸은 개별 스펙이 직접 만든다.
 */
async function requestJump(fromMs: number, origin: SidebarCursorOrigin = DAILY_ORIGIN) {
  await act(async () => {
    useLiveCursorStore.getState().requestTimeframeJump(
      fromMs, bucketEndMs('D', fromMs, Date.now()), origin,
    );
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

/**
 * #1506 — 크로스헤어 채널 정리가 점프 명령을 연쇄 소거하던 결함.
 *
 * `resetCursorFrom` 은 크로스헤어 정리 경로인데, 주인 판정이 **커서 origin 만** 본다
 * (`sidebarCursorOrigin ?? syncCursorOrigin`). 커서를 아무도 발행하지 않았으면
 * 주인 없음으로 통과해 `resetCursor()` 가 돌고, 그것이 `jumpRequest` 까지 비웠다.
 * 실측 트리거는 **발행 창의 봉 전환**이었다(일→주) — 그 창의 차트가 재생성되며
 * 자기 정리 경로를 태운다.
 */
describe('채널 소거 (#1506)', () => {
  it('크로스헤어 정리가 진행 중인 점프를 지우지 않는다', async () => {
    const { getByTestId, rerender } = render(<Consumer candles={TODAY_ONLY} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('seeking');

    // 발행 창이 봉을 바꿔 자기 차트 정리 경로를 태운다. 커서 발행자가 없으므로
    // 주인 판정을 그대로 통과한다 — 그때 점프까지 지워지면 안 된다.
    await act(async () => {
      useLiveCursorStore.getState().resetCursorFrom(DAILY_ORIGIN.windowId);
    });
    expect(getByTestId('status').textContent).toBe('seeking');

    // 그리고 백필이 오면 여전히 앉는다. **`rerender` 여야 한다** — 새로 `render`
    // 하면 그 창의 baseline seq 가 지금 seq 로 잡혀 명령을 무시한다(그건 이 스펙이
    // 재는 것과 다른 축이다).
    rerender(<Consumer candles={FULL_CANDLES} />);
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledWith(expectedRange(YESTERDAY_LAST));
  });

  it('슬롯이 비워진 뒤의 새 점프도 착지한다 — seq 는 되감기지 않는다', async () => {
    // 첫 점프가 착지하며 그 seq 로 래치를 건다.
    render(<Consumer candles={FULL_CANDLES} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledTimes(1);

    // 슬롯이 통째로 비워진다(테스트 초기화 경로 = 프로덕션의 연쇄 소거와 같은 자리).
    await act(async () => {
      useLiveCursorStore.setState({ jumpRequest: null });
    });

    // 다른 날짜로 다시 누른다. seq 가 1 로 되감기면 이미 걸린 래치에 걸려
    // **조용히 무시되고 칩만 `landed` 를 표시한다** — 그것이 이 이슈의 증상이다.
    const TODAY_LAST = bar(0, 200);
    await requestJump(TODAY_LAST.ts_ms);
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledTimes(2);
    expect(setVisibleLogicalRange).toHaveBeenLastCalledWith(expectedRange(TODAY_LAST));
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

/**
 * F1 — 주·월봉은 칸의 **마지막** 거래일로 간다.
 *
 * 실측(2026-08-23, 005930): 최신 봉을 보고 있는데도 주봉은 08-18, 월봉은 08-03 으로
 * 떨어졌다(마지막 거래일은 08-21 — 월봉은 3주가 어긋났다). 캘린더 봉의 `ts_ms` 가 칸의
 * **시작**이라 그것을 그대로 목적지로 쓴 결과다.
 *
 * 거래일 달력은 쓰지 않는다 — 발행은 **달력상의 칸 끝**만 주고, 그 안의 마지막 거래일을
 * 고르는 일은 이 창이 자기 캔들로 한다.
 */
describe('캘린더 칸 — 마지막 거래일로 간다', () => {
  /** 8/18(화)·8/20(목)·8/21(금) 봉. 8/17 은 대체공휴일이라 그 주 첫 거래일이 화요일이다. */
  const WEEK_CANDLES: readonly SyncCandle[] = [
    bar(4, 0), bar(4, 200), bar(2, 0), bar(1, 0), YESTERDAY_LAST,
  ];

  async function requestWeekJump() {
    const fromMs = bar(4, 0).ts_ms;
    await act(async () => {
      useLiveCursorStore.getState().requestTimeframeJump(
        fromMs, bucketEndMs('W', fromMs, Date.now()), DAILY_ORIGIN,
      );
    });
  }

  it('칸의 첫 거래일이 아니라 **마지막 봉**에 앉는다', async () => {
    render(<Consumer candles={WEEK_CANDLES} />);
    await requestWeekJump();
    await flushFrame();
    expect(setVisibleLogicalRange).toHaveBeenCalledWith(expectedRange(YESTERDAY_LAST));
  });

  it('칩은 **앉은 봉의 날짜**를 말한다 — 상한(비거래일일 수 있다)이 아니라', async () => {
    const { getByTestId } = render(<Consumer candles={WEEK_CANDLES} />);
    await requestWeekJump();
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('landed');
    expect(getByTestId('date').textContent).toBe(realMsToYyyymmdd(YESTERDAY_LAST.ts_ms));
  });

  it('백필은 **칸 시작**을 목표로 한다 — 상한을 물리면 그 칸이 영영 안 온다', async () => {
    const { getByTestId } = render(<Consumer candles={WEEK_CANDLES} />);
    await requestWeekJump();
    await flushFrame();
    expect(getByTestId('backfill').textContent).toBe(realMsToYyyymmdd(bar(4, 0).ts_ms));
  });

  // 상한 이하의 마지막 봉을 그냥 고르면, 칸이 아직 비어 있을 때 **그 앞 칸의 봉**에
  // 앉아 버린다. 백필 도중에 엉뚱한 구간으로 조기 착지하고 래치까지 걸려 되돌릴 수 없다.
  it('칸이 아직 비어 있으면 그 앞 봉으로 내려앉지 않고 기다린다', async () => {
    const BEFORE_WEEK: readonly SyncCandle[] = [bar(9, 0), bar(9, 200)];
    const { getByTestId } = render(<Consumer candles={BEFORE_WEEK} />);
    await requestWeekJump();
    await flushFrame();
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(getByTestId('status').textContent).toBe('seeking');
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

describe('중단은 착지와 구별되지 않는다 — 그래서 문구가 「이동했다」를 주장하면 안 된다', () => {
  it('중단된 seq 도 `landed` 로 정착한다(스피너를 끄기 위해) — 칩 문구의 제약이 여기서 나온다', async () => {
    const { getByTestId } = render(<Consumer candles={TODAY_ONLY} />);
    await requestJump(YESTERDAY_LAST.ts_ms);
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('seeking');
    // 백필을 기다리는 동안 사용자가 그 창을 만진다 — 창은 **움직인 적이 없다**.
    fireEvent.pointerDown(getByTestId('pane'));
    await flushFrame();
    expect(getByTestId('status').textContent).toBe('landed');
    expect(setVisibleLogicalRange).not.toHaveBeenCalled();
  });
});

describe('하한은 창마다 다르다 — 디스크 모드는 막지 않는다 (#1497)', () => {
  const OLD_MS = NOW - 400 * DAY_MS;

  it('하한이 null 이면 같은 날짜라도 out-of-retention 이 아니다', async () => {
    const { getByTestId } = render(<Consumer candles={FULL_CANDLES} floor={null} />);
    await requestJump(OLD_MS);
    await flushFrame();
    expect(getByTestId('status').textContent).not.toBe('out-of-retention');
    // 백필 목표로도 나간다 — 디스크에는 그 구간이 있을 수 있다.
    expect(getByTestId('backfill').textContent).toMatch(/^\d{8}$/);
  });
});
