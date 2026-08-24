import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AskPeak, Candle, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import { usePeakWallRender } from './usePeakWallRender';

const MIN = 60_000;
const DAY = '20260822';
const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;
const CANDLES: Candle[] = [0, 1, 2].map((i) => (
  { ts_ms: i * MIN, open: 100, high: 100, low: 100, close: 100, vol_a: 0, vol_b: 0 }
));
const SEGMENTS: RangeSegment[] = [{ date: DAY, session_open_ms: 0, session_close_ms: 10 * MIN }];
const PEAK: AskPeak = {
  date: DAY,
  price: 110,
  qty: 500,
  t_ms: MIN,
  max_price: 110,
  max_qty: 500,
  max_t_ms: MIN,
};

function render(applicable = true, peaks: AskPeak[] = [PEAK], needStepSegments = false) {
  return renderHook(() => usePeakWallRender({
    side: 'ask',
    peaks,
    segments: SEGMENTS,
    candles: CANDLES,
    axis,
    todayKst: DAY,
    applicable,
    visibleTimeCutoff: null,
    dailyMaFilter: null,
    needStepSegments,
  })).result;
}

/**
 * **최대벽 렌더의 단일 소스** — 세그먼트 하나와 「무엇이 그려지는가」 플래그들.
 *
 * 종전엔 이 계산이 여섯 곳에서 각자 돌았고 게이트가 네 가지 표기로 손으로 적혀 있었다.
 * 여기 모은 뒤로 그 표기는 하나다 — 이 테스트가 그 하나를 값으로 못 박는다.
 */
describe('usePeakWallRender', () => {
  beforeEach(() => {
    act(() => {
      useChartPrefsStore.setState({ ...DEFAULT_PREFS });
      useLivePageStore.setState({ askPeakEnabled: true, askPeakHidden: false });
    });
  });

  /**
   * ⚠ **불변식: `segments` 는 `enabled` 기준으로만 계산한다.**
   *
   * 눈(hidden)으로 숨겨도 레전드는 값을 유지해야 한다(MA 의 "hide 는 선만 숨긴다" 규칙).
   * 그래서 hidden 은 `drawn` 만 내리고 `segments` 는 건드리지 않는다. 이 분리가 깨지면
   * 눈을 끄는 순간 레전드가 비어 버린다 — 이 리포가 red-check 으로 두 번 확인한 규칙이라
   * 계산이 컴포넌트 밖으로 나온 지금 **여기**가 그 규칙의 집이다.
   */
  it('눈(hidden)은 drawn 만 내리고 segments 는 남긴다', () => {
    act(() => {
      useLivePageStore.setState({ askPeakHidden: true });
    });
    const r = render();
    expect(r.current.segments).toHaveLength(1);
    expect(r.current.drawn).toBe(false);
    expect(r.current.labels).toBe(false);
    expect(r.current.arrows).toBe(false);
  });

  it('지표를 끄면(enabled=false) segments 도 빈다', () => {
    act(() => {
      useLivePageStore.setState({ askPeakEnabled: false });
    });
    const r = render();
    expect(r.current.segments).toEqual([]);
    expect(r.current.drawn).toBe(false);
  });

  it('분봉이 아니면(applicable=false) 계산하지 않는다', () => {
    expect(render(false).current.segments).toEqual([]);
  });

  it('라벨·화살표 토글은 각자 자기 플래그만 내린다', () => {
    act(() => {
      useChartPrefsStore.setState({ askPeakLabelEnabled: false });
    });
    const r = render();
    expect(r.current.drawn).toBe(true);
    expect(r.current.labels).toBe(false);
    expect(r.current.arrows).toBe(true);

    act(() => {
      useChartPrefsStore.setState({ askPeakLabelEnabled: true, askPeakRankArrowEnabled: false });
    });
    const r2 = render();
    expect(r2.current.labels).toBe(true);
    expect(r2.current.arrows).toBe(false);
  });

  it('선 색·두께를 그대로 실어 나른다(표면이 primitive 에 넘긴다)', () => {
    act(() => {
      useLivePageStore.setState({ askPeakColor: '#ABCDEF', askPeakLineWidth: 3 });
    });
    const r = render();
    expect(r.current.color).toBe('#ABCDEF');
    expect(r.current.lineWidth).toBe(3);
    expect(r.current.segments[0]).toMatchObject({ color: '#ABCDEF', lineWidth: 3 });
  });

  /** 빈 상태가 매번 새 배열이면 소비처 memo 가 매 렌더 다시 돈다(P1 재렌더 차단이 무너진다). */
  it('stepSegments 는 기록 갱신 시퀀스를 담는다 — top-3 이 못 나르는 오전 기록 포함', () => {
    // 벽이 장중에 커진 날: 최종 top-3(traded_peaks)은 전부 오후, 오전 기록(당시엔
    // 최대였던 작은 벽)은 traded_record_peaks 에만 있다. 그리기(표시 개수 1)는 1개,
    // 계단 입력은 기록 ∪ top-3 전부 — 오전에 선이 없다가 오후에 생기던 보고의 해법.
    const grewAllDay: AskPeak = {
      ...PEAK,
      traded_peaks: [
        { price: 210, qty: 1000, t_ms: 2 * MIN },
        { price: 211, qty: 950, t_ms: 2 * MIN + 1 },
        { price: 212, qty: 990, t_ms: 2 * MIN + 2 },
      ],
      traded_record_peaks: [
        { price: 100, qty: 50, t_ms: 0 },          // 오전 첫 기록 — top-3 밖
        { price: 210, qty: 1000, t_ms: 2 * MIN },  // 최종 기록(top-1 과 동일)
      ],
    };
    const r = render(true, [grewAllDay], true);
    expect(r.current.segments).toHaveLength(1);
    const qtys = r.current.stepSegments.map((seg) => seg.qty).sort((a, b) => a - b);
    // 기록 2 + top-3 중 기록에 없는 950·990 — 랭크로 자르지 않는다.
    expect(qtys).toEqual([50, 950, 990, 1000]);
  });

  it('구백엔드(기록 필드 없음) 폴백 — stepSegments 는 traded top-3 으로 동작한다', () => {
    const noRecords: AskPeak = {
      ...PEAK,
      traded_peaks: [
        { price: 110, qty: 500, t_ms: 2 * MIN },
        { price: 105, qty: 200, t_ms: 0 },
      ],
    };
    const r = render(true, [noRecords], true);
    expect(r.current.segments).toHaveLength(1);       // 그리기: 표시 개수 1
    expect(r.current.stepSegments).toHaveLength(2);   // 계단: top-3 폴백
  });

  it('빈 결과는 참조가 안정적이다', () => {
    act(() => {
      useLivePageStore.setState({ askPeakEnabled: false });
    });
    expect(render().current.segments).toBe(render().current.segments);
  });
});
