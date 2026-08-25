import { useMemo } from 'react';
import type { Candle, PeakBase } from '../api/types';
import type { LiveVenueOption } from '../state/liveVenue';
import { useActivePrefs } from '../state/chartPrefs';
import { type LiveMAConfig } from '../state/livePage';
import { computeDailyMaByDate } from '../chart/projectors/dailyMovingAverage';
import { dailyMaFetchWindow, maxEnabledPeriod, pickTodayLiveClose } from './indicators/dailyMaProjection';
import { useResolvedDailyCandles } from './indicators/useResolvedDailyCandles';
import { useWindowIndicator } from './workspace/windowView';
import type { PeakMaFilterSide } from './peakWallMaFilter';
import type { PeakWallFamilyId } from '../state/peakWallFamilyPrefs';

/**
 * 최대벽을 **일봉 이동평균선** 기준으로 거르는 필터. 형제인 `peakWallMaFilter` 는 현재 보고
 * 있는 분봉의 MA 를 쓰고, 이쪽은 일봉 MA(ADR-0073) 를 쓴다. 둘은 **독립 필터**라 둘 다 켜면
 * 교집합이다.
 *
 * 왜 훨씬 단순한가: 일봉 MA 는 **거래일 계단 함수**다(ADR-0073 — 하루 안에서는 값이 일정).
 * 최대벽도 거래일별이므로 **벽의 `date` 로 바로 조회**하면 그게 곧 화면에 그려진 값이다.
 * 분봉 필터가 필요로 했던 봉 인덱스 정렬(`axis.contains` + 이진 탐색)이 원리적으로 없다.
 */
export type PeakDailyMaFilter = {
  side: PeakMaFilterSide;
  /** 거래일(YYYYMMDD) → 그 날의 일봉 MA. `DailyMovingAverageOverlay` 가 그리는 값과 같은 맵. */
  byDate: ReadonlyMap<string, number>;
};

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * `peaks` 를 일봉 MA 기준으로 거른다. 매도는 MA **위**, 매수는 MA **아래**만 남긴다
 * (분봉 필터와 같은 대칭).
 *
 * fail-open 규칙은 분봉 필터보다 **한 겹 넓다**: warm-up(기간 미만)뿐 아니라 **일봉 데이터가
 * 아직 안 왔거나 못 받은 경우**(비동기 로딩 · 지수 코드 · 무자격 dev · 스크리너 공백)에도
 * 그 날은 판정하지 않고 남긴다. 데이터가 늦게 도착한다는 이유로 지표가 깜빡이며 사라지는
 * 쪽이 훨씬 나쁘다.
 */
export function filterPeaksAgainstDailyMa<T extends PeakBase>(
  peaks: readonly T[],
  intraMax: boolean,
  filter: PeakDailyMaFilter | null,
): T[] {
  if (!filter || peaks.length === 0 || filter.byDate.size === 0) return [...peaks];
  return peaks.filter((peak) => {
    const price = intraMax ? peak.max_price : peak.price;
    if (!finiteNumber(price)) return true;
    const ma = filter.byDate.get(peak.date);
    if (ma === undefined) return true;
    return filter.side === 'ask' ? price > ma : price < ma;
  });
}

type UsePeakDailyMaFilterInput = {
  side: PeakMaFilterSide;
  code: string | null;
  venue: LiveVenueOption;
  todayKst: string;
  /** 현재 분봉 캔들 — 오늘의 미확정 일봉 종가를 현재가로 덮는 데 쓴다(오버레이 미러). */
  candles: readonly Candle[];
  /** 분봉 차트에서만 의미가 있다. `DailyMovingAverageOverlay` 의 게이트와 같은 조건. */
  enabled: boolean;
  kisEnabled?: boolean;
  /** 창이 덮어야 할 표시 하한(계단으로 내린 값). 오버레이·reveal 게이트와 **같은 값**을
   *  받아야 한다 — 아래 ⚠ 의 캐시 공유가 이 값의 일치에도 걸려 있다. */
  displayFloorDate?: string | null;
};

const EMPTY_MAP: ReadonlyMap<string, number> = new Map();

/** 계열별 pref 키 표 — 분봉 필터(`peakWallMaFilter`)의 `MA_PREF_KEYS` 와 같은 이유로
 *  동적 조립 대신 적어 둔다. */
const DAILY_MA_PREF_KEYS = {
  ask: {
    Traded: { on: 'askPeakTradedAboveDailyMaEnabled', period: 'askPeakTradedAboveDailyMaPeriod' },
    Unreached: { on: 'askPeakUnreachedAboveDailyMaEnabled', period: 'askPeakUnreachedAboveDailyMaPeriod' },
    AllWall: { on: 'askPeakAllWallAboveDailyMaEnabled', period: 'askPeakAllWallAboveDailyMaPeriod' },
  },
  bid: {
    Traded: { on: 'bidPeakTradedBelowDailyMaEnabled', period: 'bidPeakTradedBelowDailyMaPeriod' },
    Unreached: { on: 'bidPeakUnreachedBelowDailyMaEnabled', period: 'bidPeakUnreachedBelowDailyMaPeriod' },
    AllWall: { on: 'bidPeakAllWallBelowDailyMaEnabled', period: 'bidPeakAllWallBelowDailyMaPeriod' },
  },
} as const;

/** 한 방향의 계열 셋 → 각 계열의 필터(꺼진 계열은 `null`). */
export type PeakDailyMaFilters = Readonly<Record<PeakWallFamilyId, PeakDailyMaFilter | null>>;

/**
 * pref + 일봉 데이터 → **계열 셋의** 필터 값. **호출부는 `LiveChartRoot` 한 곳**이고 결과를
 * 소비처 셋에 내려보낸다 — 데이터 fetch 가 걸린 훅이라 소비처마다 부르면 쿼리가 늘어난다.
 *
 * ⚠ **계열이 셋이어도 fetch 는 하나다.** 계열별로 이 훅을 세 번 부르면 기간이 갈리는 순간
 * react-query 키가 셋으로 쪼개져 **일봉 fetch 가 3배**가 된다. 그래서 창은 켜진 계열의
 * **최대 기간**으로 한 번 잡고, 그 한 벌의 일봉에서 계열별 `byDate` 를 파생한다. 계단 값
 * 계산(`computeDailyMaByDate`)은 일봉 수백 개짜리라 세 벌 돌려도 fetch 한 번보다 싸다.
 *
 * ⚠ **fetch 창을 오버레이와 맞춘다.** `dailyMaFetchWindow` 는 슬롯들의 최대 period 로 창을
 * 정하므로, 내 최대 기간이 그보다 작으면 **같은 창 = 같은 react-query 키 = 캐시 공유**다. 내
 * 기간이 더 클 때만 합성 슬롯을 얹어 창을 넓힌다(그 경우만 별도 쿼리가 된다). 이 정렬을
 * 빼면 일봉 fetch 가 조용히 두 배가 된다.
 */
export function usePeakDailyMaFilters({
  side,
  code,
  venue,
  todayKst,
  candles,
  enabled,
  kisEnabled = true,
  displayFloorDate = null,
}: UsePeakDailyMaFilterInput): PeakDailyMaFilters {
  const keys = DAILY_MA_PREF_KEYS[side];
  const tradedOn = useActivePrefs((prefs) => prefs[keys.Traded.on]);
  const tradedPeriod = useActivePrefs((prefs) => prefs[keys.Traded.period]);
  const unreachedOn = useActivePrefs((prefs) => prefs[keys.Unreached.on]);
  const unreachedPeriod = useActivePrefs((prefs) => prefs[keys.Unreached.period]);
  const allWallOn = useActivePrefs((prefs) => prefs[keys.AllWall.on]);
  const allWallPeriod = useActivePrefs((prefs) => prefs[keys.AllWall.period]);
  const slotConfigs = useWindowIndicator((s) => s.dailyMovingAverages);
  // 하나라도 켜져 있으면 일봉을 받는다 — 계열 단위 게이트는 아래 `byDate` 에서 건다.
  const active = (tradedOn || unreachedOn || allWallOn) && enabled && !!code;

  /** 창을 정하는 것은 **켜진** 계열의 최대 기간이다. 꺼진 계열의 기간이 창을 넓히면
   *  안 쓰는 일봉을 받으면서 캐시 공유까지 깨진다. */
  const maxPeriod = Math.max(
    tradedOn ? tradedPeriod : 0,
    unreachedOn ? unreachedPeriod : 0,
    allWallOn ? allWallPeriod : 0,
  );

  const fetchConfigs = useMemo<readonly LiveMAConfig[]>(() => {
    if (maxPeriod <= maxEnabledPeriod(slotConfigs)) return slotConfigs;
    return [
      ...slotConfigs,
      {
        id: '__peakDailyMaFilter', enabled: true, period: maxPeriod, color: '', lineWidth: 1, source: 'close',
      },
    ];
  }, [slotConfigs, maxPeriod]);

  const fetchWindow = useMemo(
    () => dailyMaFetchWindow(todayKst, fetchConfigs, displayFloorDate),
    [todayKst, fetchConfigs, displayFloorDate],
  );

  const daily = useResolvedDailyCandles({
    code,
    from: active ? fetchWindow.from : null,
    to: active ? fetchWindow.to : null,
    venue,
    enabled: active,
    kisEnabled,
  });

  // 오늘의 일봉 종가는 아직 확정 전이다 — 오버레이와 **같은 방식**으로 현재가로 덮는다.
  // 이걸 안 맞추면 오늘 벽만 화면의 일봉 MA 선과 다른 값으로 판정된다.
  const todayLiveClose = useMemo(
    () => (active ? pickTodayLiveClose(candles, todayKst) : null),
    [active, candles, todayKst],
  );

  const dailyCandles = daily.candles;
  const tradedByDate = useMemo(
    () => (active && tradedOn && dailyCandles.length > 0
      ? computeDailyMaByDate(dailyCandles, tradedPeriod, 'close', todayKst, todayLiveClose)
      : EMPTY_MAP),
    [active, tradedOn, dailyCandles, tradedPeriod, todayKst, todayLiveClose],
  );
  const unreachedByDate = useMemo(
    () => (active && unreachedOn && dailyCandles.length > 0
      ? computeDailyMaByDate(dailyCandles, unreachedPeriod, 'close', todayKst, todayLiveClose)
      : EMPTY_MAP),
    [active, unreachedOn, dailyCandles, unreachedPeriod, todayKst, todayLiveClose],
  );
  const allWallByDate = useMemo(
    () => (active && allWallOn && dailyCandles.length > 0
      ? computeDailyMaByDate(dailyCandles, allWallPeriod, 'close', todayKst, todayLiveClose)
      : EMPTY_MAP),
    [active, allWallOn, dailyCandles, allWallPeriod, todayKst, todayLiveClose],
  );

  return useMemo(() => ({
    Traded: active && tradedOn ? { side, byDate: tradedByDate } : null,
    Unreached: active && unreachedOn ? { side, byDate: unreachedByDate } : null,
    AllWall: active && allWallOn ? { side, byDate: allWallByDate } : null,
  }), [
    active, side,
    tradedOn, tradedByDate,
    unreachedOn, unreachedByDate,
    allWallOn, allWallByDate,
  ]);
}
