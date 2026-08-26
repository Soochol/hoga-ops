import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AskPeak, Candle, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import { usePeakWallRender } from './usePeakWallRender';

/** 계열 셋 모두 일봉 MA 필터 없음 — 이 파일의 기본 배선. */
const NO_DAILY_MA_FILTERS = { Traded: null, Unreached: null, AllWall: null } as const;

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
    dailyMaFilters: NO_DAILY_MA_FILTERS,
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
      useLivePageStore.setState({
        askPeakEnabled: true,
        askPeakHidden: false,
        // 전역 스토어는 테스트 간 살아남는다 — 하위 토글을 켜는 테스트가 앞서면
        // "꺼짐" 전제가 오염되므로 매번 되돌린다.
        askPeakAllWallLineEnabled: false,
        askPeakUnreachedLineEnabled: false,
        askPeakTradedLineEnabled: true,
        // 강도 pane 슬롯도 전역이라 같은 이유로 되돌린다(공장값 양 방향 T/F/F).
        askPeakTradedPaneEnabled: true,
        askPeakUnreachedPaneEnabled: false,
        askPeakAllWallPaneEnabled: false,
        bidPeakTradedPaneEnabled: true,
        bidPeakUnreachedPaneEnabled: false,
        bidPeakAllWallPaneEnabled: false,
      });
    });
  });

  /**
   * **막는 방향**: 강도 pane 의 계열 선택이 다시 캔들 선 토글에 물리는 것.
   *
   * 두 표면이 답하는 질문이 다르다 — 캔들 오버레이는 "그날 어디에 벽이 있었나",
   * 강도 pane 은 "그 벽이 언제 얼마나 자랐나". 종전엔 스위치가 하나라 한쪽만 보는
   * 조합이 원리적으로 불가능했다. 두 방향을 **각각** 재야 한다: 한쪽만 재면
   * "그냥 둘 다 끄는" 구현도 통과한다.
   */
  it('강도 pane 슬롯은 캔들 선 토글과 독립이다 — 양방향', () => {
    // ① 캔들 선 ON · pane 슬롯 OFF → 그리기는 살고 계단만 빈다.
    act(() => {
      useLivePageStore.setState({
        askPeakTradedLineEnabled: true,
        askPeakTradedPaneEnabled: false,
      });
    });
    const onlyCandle = render(true, [PEAK], true);
    expect(onlyCandle.current.segments).toHaveLength(1);
    expect(onlyCandle.current.stepSegments).toHaveLength(0);

    // ② 캔들 선 OFF · pane 슬롯 ON → 계단만 산다. **이게 종전에 불가능했던 조합이다.**
    act(() => {
      useLivePageStore.setState({
        askPeakTradedLineEnabled: false,
        askPeakTradedPaneEnabled: true,
      });
    });
    const onlyPane = render(true, [PEAK], true);
    expect(onlyPane.current.segments).toHaveLength(0);
    expect(onlyPane.current.stepSegments).toHaveLength(1);
  });

  // 나머지 두 계열도 자기 pane 키를 탄다 — 하나만 배선하고 나머지를 캔들 토글에
  // 남겨 두는 절반 구현이 통과하지 않게.
  it('미도달·전체 계단도 각자 pane 슬롯을 탄다 (캔들 선은 끈 채)', () => {
    act(() => {
      useLivePageStore.setState({
        askPeakUnreachedLineEnabled: false,
        askPeakAllWallLineEnabled: false,
        askPeakUnreachedPaneEnabled: true,
        askPeakAllWallPaneEnabled: true,
      });
    });
    const withArrays: AskPeak = {
      ...PEAK,
      unreached_peaks: [{ price: 120, qty: 700, t_ms: MIN }],
      all_peaks: [{ price: 115, qty: 900, t_ms: MIN }],
    };
    const r = render(true, [withArrays], true);
    expect(r.current.unreachedSegments).toHaveLength(0);   // 캔들 선은 꺼짐
    expect(r.current.allWallSegments).toHaveLength(0);
    expect(r.current.unreachedStepSegments.length).toBeGreaterThan(0);
    expect(r.current.allWallStepSegments.length).toBeGreaterThan(0);
  });

  /**
   * **막는 방향**: 미도달 계단의 후보를 화면 선과 같은 `unreached_peaks` top-3 으로
   * 되돌리는 것(2026-08-26 이전 배선).
   *
   * 판별식은 「미도달 벽이 하나도 안 남은 날」이다 — 구 배선은 그날 행 자체를 건너뛰어
   * 계단이 통째로 비었고, 그래서 빌더의 0-fill 이 발화할 기회조차 없었다. 실측
   * 20260824(갭상승 후 종일 하락)가 바로 그 하루다.
   */
  it('미도달 계단은 그날 다른 계열의 벽도 후보로 쓴다 — unreached 가 0인 날에도 계단이 선다', () => {
    act(() => {
      useLivePageStore.setState({
        askPeakUnreachedLineEnabled: false,
        askPeakUnreachedPaneEnabled: true,
      });
    });
    const noSurvivor: AskPeak = {
      ...PEAK,
      // 미도달 벽 0개 — 그날 알려진 벽은 체결 기록뿐이다.
      unreached_peaks: [],
      traded_record_peaks: [{ price: 105, qty: 300, t_ms: MIN }],
    };
    const r = render(true, [noSurvivor], true);
    expect(r.current.unreachedSegments).toHaveLength(0);          // 화면 선은 그대로 0
    expect(r.current.unreachedStepSegments.length).toBeGreaterThan(0);
  });

  /** 「없음 구간」 색은 계열 본색에서 파생된다 — 사용자가 색을 바꾸면 같이 따라간다. */
  it('unreachedAbsentColor 는 계열 색의 흐린 판이다', () => {
    act(() => {
      useLivePageStore.setState({ askPeakUnreachedColor: '#1E3A8A' });
    });
    const r = render(true, [PEAK], true);
    expect(r.current.unreachedColor).toBe('#1E3A8A');
    expect(r.current.unreachedAbsentColor).toBe('rgba(30, 58, 138, 0.3)');
  });

  /** pane 마스터가 꺼져 있으면 슬롯이 켜져 있어도 계산하지 않는다(`needStepSegments`). */
  it('pane 마스터가 꺼져 있으면 슬롯과 무관하게 계단이 없다', () => {
    const r = render(true, [PEAK], false);
    expect(r.current.stepSegments).toHaveLength(0);
  });

  /**
   * **막는 방향**: 여섯 슬롯이 방향을 잃고 다시 하나로 합쳐지는 것.
   *
   * 이 훅은 방향당 한 번 불리므로, 매도 슬롯을 끄면 **매도 계단만** 비어야 한다.
   * 키가 방향 공용으로 되돌아가면 이 단언이 빨개진다.
   */
  it('pane 슬롯은 방향별이다 — 매도를 꺼도 매수는 산다', () => {
    act(() => {
      useLivePageStore.setState({
        askPeakTradedPaneEnabled: false,
        bidPeakTradedPaneEnabled: true,
        bidPeakEnabled: true,
        bidPeakHidden: false,
        bidPeakTradedLineEnabled: true,
      });
    });
    const ask = render(true, [PEAK], true);
    expect(ask.current.stepSegments).toHaveLength(0);

    const bid = renderHook(() => usePeakWallRender({
      side: 'bid',
      peaks: [PEAK],
      segments: SEGMENTS,
      candles: CANDLES,
      axis,
      todayKst: DAY,
      applicable: true,
      dailyMaFilters: NO_DAILY_MA_FILTERS,
      needStepSegments: true,
    })).result;
    expect(bid.current.stepSegments).toHaveLength(1);
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
      useChartPrefsStore.setState({ askPeakTradedLabelEnabled: false });
    });
    const r = render();
    expect(r.current.drawn).toBe(true);
    expect(r.current.labels).toBe(false);
    expect(r.current.arrows).toBe(true);

    act(() => {
      useChartPrefsStore.setState({
        askPeakTradedLabelEnabled: true,
        askPeakTradedRankArrowEnabled: false,
        askPeakUnreachedRankArrowEnabled: false,
        askPeakAllWallRankArrowEnabled: false,
      });
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

  // ── 전체 최대벽(터치 무관) 하위 선 ────────────────────────────────────────
  const ALL_PEAK: AskPeak = {
    ...PEAK,
    all_price: 130,
    all_qty: 900,
    all_t_ms: 2 * MIN,
    all_max_price: 130,
    all_max_qty: 900,
    all_max_t_ms: 2 * MIN,
  };

  it('전체 최대벽 선은 opt-in — 기본은 비고, 켜면 all_* carrier 로 세그먼트를 짓는다', () => {
    const off = render(true, [ALL_PEAK]);
    expect(off.current.allWallSegments).toEqual([]);
    expect(off.current.allWallDrawn).toBe(false);

    act(() => {
      useLivePageStore.setState({
        askPeakAllWallLineEnabled: true,
        askPeakAllWallColor: '#93C5FD',
        askPeakAllWallLineWidth: 1,
      });
    });
    const on = render(true, [ALL_PEAK]);
    expect(on.current.allWallDrawn).toBe(true);
    expect(on.current.allWallLabels).toBe(true);
    expect(on.current.allWallSegments).toHaveLength(1);
    expect(on.current.allWallSegments[0]).toMatchObject({
      price: 130, qty: 900, color: '#93C5FD', lineWidth: 1,
    });
    // 체결된 벽 선은 영향받지 않는다.
    expect(on.current.segments[0]).toMatchObject({ price: 110, qty: 500 });
  });

  it('눈(hidden)은 전체 최대벽도 drawn 만 내리고 segments 는 남긴다', () => {
    act(() => {
      useLivePageStore.setState({
        askPeakAllWallLineEnabled: true,
        askPeakHidden: true,
      });
    });
    const r = render(true, [ALL_PEAK]);
    expect(r.current.allWallSegments).toHaveLength(1);
    expect(r.current.allWallDrawn).toBe(false);
    expect(r.current.allWallLabels).toBe(false);
  });

  it('마스터를 끄면(enabled=false) 전체 최대벽 세그먼트도 빈다', () => {
    act(() => {
      useLivePageStore.setState({
        askPeakAllWallLineEnabled: true,
        askPeakEnabled: false,
      });
    });
    const r = render(true, [ALL_PEAK]);
    expect(r.current.allWallSegments).toEqual([]);
  });

  it('미도달 벽 선은 opt-in — 켜면 unreached carrier 로 세그먼트를 짓고, 눈은 drawn 만 내린다', () => {
    const UNREACHED_PEAK: AskPeak = {
      ...PEAK,
      unreached_price: 140,
      unreached_qty: 700,
      unreached_t_ms: 2 * MIN,
    };
    const off = render(true, [UNREACHED_PEAK]);
    expect(off.current.unreachedSegments).toEqual([]);
    expect(off.current.unreachedDrawn).toBe(false);

    act(() => {
      useLivePageStore.setState({
        askPeakUnreachedLineEnabled: true,
        askPeakUnreachedColor: '#1E3A8A',
        askPeakUnreachedLineWidth: 2,
      });
    });
    const on = render(true, [UNREACHED_PEAK]);
    expect(on.current.unreachedDrawn).toBe(true);
    expect(on.current.unreachedSegments).toHaveLength(1);
    expect(on.current.unreachedSegments[0]).toMatchObject({
      price: 140, qty: 700, color: '#1E3A8A', lineWidth: 2,
    });
    // legendRankSegments 병합 집합에도 들어간다(레전드·화살표·회피 공용).
    expect(on.current.legendRankSegments.map((s) => s.price)).toContain(140);

    act(() => {
      useLivePageStore.setState({ askPeakHidden: true });
    });
    const hidden = render(true, [UNREACHED_PEAK]);
    expect(hidden.current.unreachedSegments).toHaveLength(1);
    expect(hidden.current.unreachedDrawn).toBe(false);
  });

  it('legendRankSegments 는 체결된 벽 ∪ 전체 벽 — 하위 토글이 꺼지면 segments 와 같은 참조', () => {
    const off = render(true, [ALL_PEAK]);
    expect(off.current.legendRankSegments).toBe(off.current.segments);

    act(() => {
      useLivePageStore.setState({ askPeakAllWallLineEnabled: true });
    });
    const on = render(true, [ALL_PEAK]);
    // ALL_PEAK 은 traded(110, 500)와 all(130, 900)의 가격이 달라 병합 후 2개.
    expect(on.current.legendRankSegments.map((s) => [s.price, s.qty])).toEqual([
      [110, 500],
      [130, 900],
    ]);
  });

  // ── 계열 토글 3형제 대칭(2026-08-25 설정 재구성) ──────────────────────
  it('체결된 벽도 자기 토글로 꺼진다 — 다른 계열은 영향받지 않는다', () => {
    const both: AskPeak = {
      ...PEAK,
      all_price: 130, all_qty: 900, all_t_ms: 2 * MIN,
      all_max_price: 130, all_max_qty: 900, all_max_t_ms: 2 * MIN,
    };
    act(() => {
      useLivePageStore.setState({ askPeakAllWallLineEnabled: true });
    });
    const on = render(true, [both]);
    expect(on.current.segments).toHaveLength(1);
    expect(on.current.allWallSegments).toHaveLength(1);

    // 체결된 벽만 끈다 — 그 선과 그 계단만 비고, 전체 최대벽은 그대로다.
    act(() => {
      useLivePageStore.setState({ askPeakTradedLineEnabled: false });
    });
    const off = render(true, [both]);
    expect(off.current.segments).toEqual([]);
    expect(off.current.allWallSegments).toHaveLength(1);
    // 랭킹 병합 집합에는 전체 최대벽만 남는다.
    expect(off.current.legendRankSegments.map((seg) => seg.price)).toEqual([130]);
  });

  it('레전드 셀 토글은 셀만 가른다 — 선·라벨·화살표는 그대로', () => {
    const on = render();
    expect(on.current.legendCells).toBe(true);

    act(() => {
      useChartPrefsStore.setState({
        askPeakTradedLegendCellEnabled: false,
        askPeakUnreachedLegendCellEnabled: false,
        askPeakAllWallLegendCellEnabled: false,
      });
    });
    const off = render();
    expect(off.current.legendCells).toBe(false);
    // 같은 프레임에서 나머지 표면은 무변경 — 이 토글의 범위가 셀뿐이라는 계약.
    expect(off.current.segments).toHaveLength(1);
    expect(off.current.drawn).toBe(true);
    expect(off.current.labels).toBe(true);
    expect(off.current.arrows).toBe(true);
  });

  /**
   * **계열별 「표시 개수」**(2026-08-25) — 종전엔 전체·미도달이 rank-1 고정이었다.
   * 과거일 wire 가 rank-1 스칼라뿐이었기 때문이고, 백엔드가 top-3 를 싣게 되며 풀렸다.
   *
   * 막는 방향: 세 계열 중 하나가 다시 하드코딩 1 로 돌아가는 것.
   * 못 보는 것: 계단(stepHistory)은 랭크로 자르지 않는다 — 의도된 3 고정이다.
   */
  it('전체·미도달도 자기 표시 개수를 따른다', () => {
    const three = [
      { price: 131, qty: 900, t_ms: 2 * MIN },
      { price: 132, qty: 800, t_ms: 2 * MIN },
      { price: 133, qty: 700, t_ms: 2 * MIN },
    ];
    const peak: AskPeak = {
      ...PEAK,
      all_price: 131, all_qty: 900, all_t_ms: 2 * MIN,
      all_max_price: 131, all_max_qty: 900, all_max_t_ms: 2 * MIN,
      all_peaks: three, all_max_peaks: three,
      unreached_price: 141, unreached_qty: 600, unreached_t_ms: 2 * MIN,
      unreached_peaks: [
        { price: 141, qty: 600, t_ms: 2 * MIN },
        { price: 142, qty: 500, t_ms: 2 * MIN },
        { price: 143, qty: 400, t_ms: 2 * MIN },
      ],
    };
    act(() => {
      useLivePageStore.setState({
        askPeakAllWallLineEnabled: true,
        askPeakUnreachedLineEnabled: true,
      });
    });

    // 기본 1 — 계열당 한 줄.
    const one = render(true, [peak]);
    expect(one.current.allWallSegments).toHaveLength(1);
    expect(one.current.unreachedSegments).toHaveLength(1);

    // 각자 올린다 — 서로 간섭하지 않는다.
    act(() => {
      useChartPrefsStore.setState({
        askPeakAllWallRankLimit: 3,
        askPeakUnreachedRankLimit: 2,
      });
    });
    const more = render(true, [peak]);
    expect(more.current.allWallSegments).toHaveLength(3);
    expect(more.current.unreachedSegments).toHaveLength(2);
    // 체결된 벽은 자기 키를 따르므로 그대로 1 이다.
    expect(more.current.segments).toHaveLength(1);
  });

  // ── 계열별 표면 축(2026-08-25) ────────────────────────────────────────
  //
  // 라벨 · 레전드 순위 셀 · 상위벽 순위 화살표는 종전에 **방향당 하나**였다. 계열마다
  // 갈린 뒤로 두 가지가 새로 가능해졌고, 아래 셋이 그것을 값으로 못 박는다:
  //   1. 한 계열의 표면만 끄고 나머지 계열은 살린다
  //   2. 레전드와 화살표가 **서로 다른 계열 집합**을 본다(의도된 결과)
  describe('계열별 표면', () => {
    /** 체결(110/500)과 전체(130/900)가 **다른 가격**인 벽 — 두 계열이 랭킹에서 구별된다. */
    const BOTH: AskPeak = {
      ...PEAK,
      all_price: 130,
      all_qty: 900,
      all_t_ms: 2 * MIN,
      all_max_price: 130,
      all_max_qty: 900,
      all_max_t_ms: 2 * MIN,
    };
    const withAllWall = () => act(() => {
      useLivePageStore.setState({ askPeakAllWallLineEnabled: true });
    });

    it('체결된 벽 라벨만 끄면 전체 최대벽 라벨은 그대로다', () => {
      withAllWall();
      act(() => {
        useChartPrefsStore.setState({ askPeakTradedLabelEnabled: false });
      });
      const r = render(true, [BOTH]);
      expect(r.current.labels).toBe(false);
      expect(r.current.allWallLabels).toBe(true);
      // 선은 둘 다 살아 있다 — 라벨 토글의 범위가 라벨뿐이라는 계약.
      expect(r.current.segments).toHaveLength(1);
      expect(r.current.allWallSegments).toHaveLength(1);
    });

    it('수평선과 발생 시점 화살표는 서로 독립이다 — 세그먼트에 실려 내려간다', () => {
      // 두 토글이 **세그먼트에** 실리는 것이 계약이다(선 primitive · 도킹 라벨 ·
      // 고저 라벨 회피 셋이 같은 배열을 보므로, 여기서 실어야 셋이 어긋나지 않는다).
      withAllWall();
      act(() => {
        useChartPrefsStore.setState({
          askPeakTradedHorizontalLineEnabled: false,
          askPeakAllWallTimeMarkerEnabled: false,
        });
      });
      const r = render(true, [BOTH]);
      // 체결된 벽: 선만 끔 → 화살표는 남는다.
      expect(r.current.segments[0].horizontalLine).toBe(false);
      expect(r.current.segments[0].timeMarker).toBe(true);
      // 전체 최대벽: 화살표만 끔 → 선은 남는다. 한 계열의 설정이 다른 계열로 새지 않는다.
      expect(r.current.allWallSegments[0].horizontalLine).toBe(true);
      expect(r.current.allWallSegments[0].timeMarker).toBe(false);
      // 계열의 **존재**는 그대로다 — 이 둘은 「어떻게 그릴지」이지 「그릴지」가 아니다.
      expect(r.current.drawn).toBe(true);
      expect(r.current.allWallDrawn).toBe(true);
    });

    it('둘 다 켜져 있으면 세그먼트 배열 참조가 유지된다', () => {
      // 기본 상태에서 사본을 만들면 하류 memo 와 primitive 재갱신이 매번 헛돈다.
      const r = render(true, [BOTH]);
      expect(r.current.segments[0].horizontalLine).toBeUndefined();
      expect(r.current.segments[0].timeMarker).toBeUndefined();
    });

    it('화살표 참여를 끈 계열은 arrowRankSegments 에서 빠진다', () => {
      withAllWall();
      act(() => {
        useChartPrefsStore.setState({ askPeakAllWallRankArrowEnabled: false });
      });
      const r = render(true, [BOTH]);
      expect(r.current.arrowRankSegments.map((seg) => seg.price)).toEqual([110]);
      // 화살표 자체는 남은 계열 때문에 계속 그려진다.
      expect(r.current.arrows).toBe(true);
    });

    /**
     * **이번 변경의 의미론적 요점.** 종전엔 랭킹 집합이 하나뿐이라 레전드 ①②③ 과 화살표
     * ①②③ 이 원리적으로 같은 벽을 가리켰다. 계열별 참여가 생긴 뒤로는 두 표면에 서로
     * 다른 계열을 켜면 **번호가 갈릴 수 있고, 그것이 그 설정의 뜻이다.**
     */
    it('레전드와 화살표는 서로 다른 계열 집합을 볼 수 있다', () => {
      withAllWall();
      act(() => {
        useChartPrefsStore.setState({
          askPeakAllWallRankArrowEnabled: false,
          askPeakTradedLegendCellEnabled: false,
        });
      });
      const r = render(true, [BOTH]);
      expect(r.current.arrowRankSegments.map((seg) => seg.price)).toEqual([110]);
      expect(r.current.legendRankSegments.map((seg) => seg.price)).toEqual([130]);
    });

    it('세 계열 모두 화살표 참여를 끄면 arrows 가 내려간다', () => {
      withAllWall();
      act(() => {
        useChartPrefsStore.setState({
          askPeakTradedRankArrowEnabled: false,
          askPeakUnreachedRankArrowEnabled: false,
          askPeakAllWallRankArrowEnabled: false,
        });
      });
      const r = render(true, [BOTH]);
      expect(r.current.arrows).toBe(false);
      expect(r.current.arrowRankSegments).toEqual([]);
    });
  });
});
