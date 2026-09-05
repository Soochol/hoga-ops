/** 캡처 유래 가격을 **캔들과 같은 척도**로 옮긴다 (#1229 의 짝).
 *
 * ## 왜 필요한가
 *
 * `/api/live/past-candles` 의 봉은 **수정주가**다(오늘 기준 계수를 곱한 값). 반면
 * `/api/range` 가 싣는 지표 — 호가 잔량 히트맵·최대벽·거래량 POC·매물대 —
 * 와 `/api/orderbook` 의 커서 스팟 10호가는 디스크에 캡처된 **원주가**다. 앞의 것들은
 * lightweight-charts 의 **같은 price scale** 에 그려지고(`DepthHeatmapPrimitive` 가 캔들
 * 시리즈의 `priceToCoordinate` 를 쓴다), 호가창은 같은 순간 같은 레벨을 **옆 창에 숫자로**
 * 띄운다 — 어느 쪽이든 계수 ≠ 1 인 구간에서 두 척도가 한 화면에 공존한다.
 *
 * 009830(한화솔루션) 2026-06-12 실측 — 2026-06-15 효력, 계수 0.9432:
 *
 *     캔들      34,662 ~ 36,596   (past-candles, 수정주가)
 *     히트맵    36,300 ~ 39,250   (range depth_heatmap, 원주가)
 *     실제 시장  36,750 ~ 38,800   (KIS 원주가 일봉 — 히트맵 쪽이 그날 실가격)
 *
 * 380개 1분 버킷 전부에서 (캔들 종가 / 호가 mid) = **0.9430 ± 0.0007**. 상수 배율은
 * "데이터가 밀렸다" 가 아니라 **스케일이 다른 두 소스**의 지문이다. 캡처 종목 351개
 * 중 최소 7개가 이 상태였다(LS ELECTRIC 0.2 = 5배, 알테오젠 0.7695, …).
 *
 * ## 기하는 안 깨진다 — 표시 숫자만 바뀐다
 *
 * 히트맵 셀 높이는 `halfTick` 을 **가격공간 델타**로 두고 `priceToCoordinate` 를 두 번
 * 불러 낸다. 전 가격에 ×f 하면 델타도 ×f 라 타일링이 그대로 보존된다. 바뀌는 것은
 * 라벨에 뜨는 숫자뿐이고(34,690.5원 같은 비실재 가격), 그건 캔들이 이미 그렇다 —
 * 화면 전체가 한 척도가 되므로 일관성은 오히려 좋아진다.
 *
 * ## 계수는 **캔들 응답에서만** 온다
 *
 * 따로 조회하지 않는다. 두 곳이 각자 구하면 서로 다른 기준일의 값을 쥘 수 있고, 그
 * 순간 한 차트에 두 척도가 다시 섞인다 — #1229 가 없애려던 바로 그 상태다. 백엔드가
 * **실제로 곱한** 계수를 봉과 같은 응답에 싣고(`adjust_factors`), 병합도 봉과
 * lockstep 이라, 날짜 D 의 봉과 지표는 구조적으로 같은 숫자를 쓴다.
 *
 * ## 모르는 날짜는 건드리지 않는다
 *
 * 계수 테이블 밖 날짜는 키가 없다(= 모른다, 1.0 아님). 그런 날짜는 봉도 안 실리므로
 * (`_apply_walk_result` 의 무척도 봉 방출 금지) 지표만 덩그러니 남는 일이 없다.
 * 계수를 통째로 못 받은 경우(구백엔드·`rest_bypass` 콜드)는 **원본을 그대로 돌려준다**
 * — 환산 전 화면(=이 수정 전과 동일)으로 degrade 하지, 절반만 환산하지 않는다.
 */
import type {
  AskPeak,
  BidPeak,
  Candle,
  DayVolumeDistribution,
  DepthHeatmapPointWire,
  PriceLevelHit,
  RangeBundle,
  TradeVolumePocWire,
  VolumeProfile,
} from '../api/types';

export type AdjustFactors = Readonly<Record<string, number>>;

/** KST 거래일(`YYYYMMDD`). 지표 항목이 `date` 를 안 들고 t_ms 만 들 때 쓴다. */
function kstDate(tMs: number): string {
  const kst = new Date(tMs + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 원 단위 반올림. 캔들도 벤더가 반올림한 정수라 같은 규약을 쓴다 — 안 맞추면
 *  히트맵 레벨이 캔들 종가와 1원 어긋나 최대벽 라벨이 캔들 밖에 뜬다. */
function scalePrice(price: number, factor: number): number {
  return Math.round(price * factor);
}

/** `[price, ...rest]` 튜플의 **첫 원소만** 가격이다(qty·delta 는 주식 수라 안 곱한다 —
 *  #1229 실측: 분봉은 `upd=1`/`upd=0` 의 거래량이 같다).
 *
 *  이 자리가 이 파일에서 가장 놓치기 쉬운 곳이다: 가격이 **이름 없이 위치로만** 있어서
 *  `price` 로 grep 해도 안 걸린다. `depth_heatmap` 이 그 형태다. */
function scaleLevels<T extends readonly [number, ...number[]]>(levels: T[], factor: number): T[] {
  return levels.map(
    (level) => [scalePrice(level[0], factor), ...level.slice(1)] as unknown as T,
  );
}

function scaleNullable(price: number | null | undefined, factor: number): number | null {
  return price == null ? null : scalePrice(price, factor);
}

/** `/api/range` 의 캔들은 **디스크 캡처**라 원주가다(벤더 캔들은 past-candles 쪽).
 *  `/live` 는 이 배열을 안 쓰지만(chartBundle 분리) 같은 번들에 실려 있으므로 척도를
 *  맞춰 둔다 — 안 맞추면 이 배열을 읽는 다음 소비자가 같은 함정을 밟는다. */
function scaleCandle(candle: Candle, factor: number): Candle {
  return {
    ...candle,
    open: scalePrice(candle.open, factor),
    high: scalePrice(candle.high, factor),
    low: scalePrice(candle.low, factor),
    close: scalePrice(candle.close, factor),
  };
}

function scaleVolumeProfile(profile: VolumeProfile, factor: number): VolumeProfile {
  return {
    ...profile,
    price_min: scalePrice(profile.price_min, factor),
    price_max: scalePrice(profile.price_max, factor),
    // bin_width 도 가격공간 값이다 — 안 곱하면 bin 격자가 축과 어긋난다.
    bin_width: scalePrice(profile.bin_width, factor),
    bins: profile.bins.map((bin) => ({ ...bin, price_low: scalePrice(bin.price_low, factor) })),
  };
}

function scaleDistribution(dist: DayVolumeDistribution, factor: number): DayVolumeDistribution {
  return {
    ...dist,
    price_min: scalePrice(dist.price_min, factor),
    price_max: scalePrice(dist.price_max, factor),
    bins: dist.bins.map((bin) => ({
      ...bin,
      price_low: scalePrice(bin.price_low, factor),
      price_high: scalePrice(bin.price_high, factor),
    })),
  };
}

function scalePeak<T extends AskPeak | BidPeak>(peak: T, factor: number): T {
  const rank = (rows: { price: number; qty: number }[] | undefined) =>
    rows?.map((row) => ({ ...row, price: scalePrice(row.price, factor) }));
  return {
    ...peak,
    price: scaleNullable(peak.price, factor),
    max_price: scaleNullable(peak.max_price, factor),
    all_price: scaleNullable(peak.all_price, factor),
    all_max_price: scaleNullable(peak.all_max_price, factor),
    // 순위 배열은 **네 갈래**다 — traded/all × 스냅샷/일중최대. 손으로 훑으면
    // `all_*` 두 개를 빠뜨리기 쉽고(초판이 실제로 그랬다), 그러면 "전체 호가 기준" 벽
    // 라벨만 옛 척도로 남는다. 계약 테스트가 이 누락을 잡는다.
    traded_peaks: rank(peak.traded_peaks),
    traded_max_peaks: rank(peak.traded_max_peaks),
    traded_record_peaks: rank(peak.traded_record_peaks),
    traded_record_max_peaks: rank(peak.traded_record_max_peaks),
    traded_bar_peaks: rank(peak.traded_bar_peaks),
    traded_bar_max_peaks: rank(peak.traded_bar_max_peaks),
    all_peaks: rank(peak.all_peaks),
    all_max_peaks: rank(peak.all_max_peaks),
    unreached_price: scaleNullable(peak.unreached_price, factor),
    unreached_peaks: rank(peak.unreached_peaks),
  };
}

function scalePoc(poc: TradeVolumePocWire, factor: number): TradeVolumePocWire {
  return {
    ...poc,
    center_price: scalePrice(poc.center_price, factor),
    low_price: scalePrice(poc.low_price, factor),
    high_price: scalePrice(poc.high_price, factor),
  };
}

function scaleHit(hit: PriceLevelHit, factor: number): PriceLevelHit {
  return { ...hit, price: scalePrice(hit.price, factor) };
}

function scaleHeatmapPoint(
  point: DepthHeatmapPointWire,
  factor: number,
): DepthHeatmapPointWire {
  return {
    ...point,
    asks: scaleLevels(point.asks, factor),
    bids: scaleLevels(point.bids, factor),
    asks_max: point.asks_max ? scaleLevels(point.asks_max, factor) : point.asks_max,
    bids_max: point.bids_max ? scaleLevels(point.bids_max, factor) : point.bids_max,
    // 새 계열도 **가격**이라 같이 환산해야 한다 — 빠뜨리면 액면분할 종목에서 이 모드만
    // 원가격으로 남아 캔들과 어긋난다(다른 두 계열은 멀쩡해서 더 늦게 발견된다).
    asks_price_max: point.asks_price_max
      ? scaleLevels(point.asks_price_max, factor)
      : point.asks_price_max,
    bids_price_max: point.bids_price_max
      ? scaleLevels(point.bids_price_max, factor)
      : point.bids_price_max,
  };
}

/** 포인트 단위 환산 캐시 — **참조 안정성이 계약이다**.
 *
 * `/api/range` 델타 병합은 미변경 버킷의 wire point **참조를 보존**하도록 설계돼 있고
 * (`range.ts` 의 uniqueBy, `mergeDepthHeatmapToday`), 하위 wire→domain 변환이 그 참조를
 * WeakMap 키로 써서 "틱당 신규 도메인 객체 = 실제 바뀐 버킷뿐" 을 지킨다
 * (`depthHeatmapWire._domainCache`). 환산이 매 memo 재실행마다 전 포인트를 새 객체로
 * 감싸면 그 불변식이 계수 ≠ 1 종목에서만 조용히 깨져 — 병합마다 전 구간이 재변환된다.
 *
 * 그래서 원본 포인트를 키로 환산본을 붙들어 둔다. 계수가 바뀌면(밤사이 재척도) 값이
 * 달라져야 하므로 factor 를 함께 저장해 대조한다.
 */
const _scaledPointCache = new WeakMap<object, { factor: number; scaled: unknown }>();

function scaleCached<T extends object>(point: T, factor: number, fn: (p: T, f: number) => T): T {
  const hit = _scaledPointCache.get(point);
  if (hit && hit.factor === factor) return hit.scaled as T;
  const scaled = fn(point, factor);
  _scaledPointCache.set(point, { factor, scaled });
  return scaled;
}

/** 계수가 전부 1.0(또는 없음)이면 `true` — 그때는 원본 참조를 그대로 돌려준다.
 *  하위 변환들이 wire 객체 **참조**를 WeakMap 키로 쓰므로(`depthHeatmapWire`), 값이
 *  같은 새 객체를 만들면 캐시가 전부 미스가 나고 SSE 틱마다 전 구간이 재변환된다. */
function isIdentity(factors: AdjustFactors | undefined): boolean {
  if (!factors) return true;
  for (const value of Object.values(factors)) if (value !== 1) return false;
  return true;
}

/** 항목별 계수 조회. 키가 없으면 `null` = **모른다** → 그 항목은 손대지 않는다. */
function factorFor(factors: AdjustFactors, date: string | undefined): number | null {
  if (date === undefined) return null;
  const value = factors[date];
  return value === undefined ? null : value;
}

/** 날짜별 계수를 적용한 새 번들. 적용할 것이 없으면 **원본 참조 그대로**. */
export function scaleRangeBundlePrices(
  bundle: RangeBundle,
  factors: AdjustFactors | undefined,
): RangeBundle {
  if (isIdentity(factors)) return bundle;
  const f = factors as AdjustFactors;
  const byDate = <T extends { date: string }>(rows: T[], fn: (row: T, factor: number) => T): T[] =>
    rows.map((row) => {
      const factor = factorFor(f, row.date);
      return factor === null ? row : fn(row, factor);
    });
  const byTMs = <T extends { t_ms: number }>(rows: T[], fn: (row: T, factor: number) => T): T[] =>
    rows.map((row) => {
      const factor = factorFor(f, kstDate(row.t_ms));
      return factor === null ? row : fn(row, factor);
    });

  // `volume_profile_by_day` 만 `date` 가 없다 — 모델 계약상 `segments` 와 **같은 순서**
  // 의 per-segment 배열이라 인덱스로 날짜를 얻는다(RangeBundle docstring: "per-segment
  // because each Stock-Date has its own price grid").
  const dailyProfiles = bundle.volume_profile_by_day.map((profile, i) => {
    const factor = factorFor(f, bundle.segments[i]?.date);
    return factor === null ? profile : scaleVolumeProfile(profile, factor);
  });

  // `volume_profile_range` 는 **구간 전체** 집계라 날짜가 없다. 구간 안에서 계수가
  // 갈리면(수정 이벤트를 걸치는 뷰) 이 그리드는 애초에 서로 다른 가격대의 거래를 한
  // 격자에 합산한 것이라 의미가 성립하지 않는다 — 이 수정 이전에도 그랬고, 여기서
  // 고칠 수 있는 문제가 아니다. 화면 축과 어긋나는 것만이라도 막기 위해 **마지막
  // 세그먼트**(= 가장 최근, 보통 계수 1.0)의 계수를 쓴다.
  const lastSegmentDate = bundle.segments.at(-1)?.date;
  const rangeFactor = factorFor(f, lastSegmentDate);

  // 캔들만 `ts_ms` 다(나머지 지표는 `t_ms`) — 같은 번들 안에서 시간 필드 이름이 갈리는
  // 유일한 자리라 공용 `byTMs` 를 못 쓴다.
  const scaledCandles = bundle.candles.map((candle) => {
    const factor = factorFor(f, kstDate(candle.ts_ms));
    return factor === null ? candle : scaleCandle(candle, factor);
  });

  return {
    ...bundle,
    candles: scaledCandles,
    volume_profile_range: rangeFactor === null
      ? bundle.volume_profile_range
      : scaleVolumeProfile(bundle.volume_profile_range, rangeFactor),
    volume_profile_by_day: dailyProfiles,
    volume_distributions: byDate(bundle.volume_distributions, scaleDistribution),
    ask_peaks: byDate(bundle.ask_peaks, scalePeak),
    bid_peaks: bundle.bid_peaks ? byDate(bundle.bid_peaks, scalePeak) : bundle.bid_peaks,
    price_level_hits: bundle.price_level_hits
      ? byDate(bundle.price_level_hits, scaleHit)
      : bundle.price_level_hits,
    trade_volume_pocs: bundle.trade_volume_pocs
      ? byDate(bundle.trade_volume_pocs, scalePoc)
      : bundle.trade_volume_pocs,
    // 이것만 포인트 캐시를 탄다 — 하루 380개 × 날짜 수로 개수가 압도적이고, 위
    // `_scaledPointCache` 주석의 참조 불변식이 걸린 배열도 이것뿐이다.
    depth_heatmap: bundle.depth_heatmap
      ? byTMs(bundle.depth_heatmap, (p, f) => scaleCached(p, f, scaleHeatmapPoint))
      : bundle.depth_heatmap,
  };
}

/** 커서 스팟 10호가 스냅샷을 같은 척도로 옮긴다.
 *
 * 이 스냅샷은 `/api/orderbook`(디스크 캡처 = 원주가)에서 오는데, 같은 순간의 히트맵
 * 셀은 이제 환산가로 그려진다 — 안 맞추면 **같은 호가 레벨이 패널엔 38,550, 차트엔
 * 36,350** 으로 갈린다.
 *
 * **날짜 하나로 계층 분기가 사라진다**: 오늘 계수는 정의상 1.0 이므로(`AdjustFactors`
 * 의 `as_of` 쪽 끝) 실시간 WS 스냅샷이 이 함수를 지나도 값이 안 바뀐다. 그래서
 * "과거냐 오늘이냐" 를 따로 가르지 않는다.
 *
 * `tot_ask`/`tot_bid`/`qty` 는 **수량**이라 곱하지 않는다. `exp_price`(예상체결가)는
 * 백엔드 `ApiOrderbookSnapshot` 에 없고 WS 경로에서만 채워지지만, 타입상 올 수 있으므로
 * 있으면 함께 옮긴다 — 0/부재는 그대로 둔다(`BookPanel` 의 "값>0" 게이트 보존).
 */
export function scaleOrderbookSnapshot<
  T extends {
    ask: readonly { price: number; qty: number }[];
    bid: readonly { price: number; qty: number }[];
    exp_price?: number;
  },
>(snapshot: T, factors: AdjustFactors | undefined, date: string | undefined): T {
  if (!factors) return snapshot;
  const factor = factorFor(factors, date);
  if (factor === null || factor === 1) return snapshot;
  const levels = (rows: readonly { price: number; qty: number }[]) =>
    rows.map((row) => ({ ...row, price: scalePrice(row.price, factor) }));
  return {
    ...snapshot,
    ask: levels(snapshot.ask),
    bid: levels(snapshot.bid),
    ...(snapshot.exp_price ? { exp_price: scalePrice(snapshot.exp_price, factor) } : {}),
  };
}

/** 화면(수정주가) 가격 → 서버(원주가) 가격. 요청 파라미터가 가는 **반대 방향**이다.
 *
 * `volume_distribution_price_min/max` 는 사용자가 차트에서 고른 밴드를 서버로 보내는
 * 값인데, 서버의 매물대 격자는 원주가 공간에 있다. 응답만 환산하고 요청을 그대로 두면
 * 계수 ≠ 1 인 구간에서 **엉뚱한 가격대의 매물대**가 돌아온다(0.9432 면 6% 어긋난 밴드).
 */
export function unscalePriceForRequest(
  price: number,
  factors: AdjustFactors | undefined,
  date: string | undefined,
): number {
  if (!factors) return price;
  const factor = factorFor(factors, date);
  if (factor === null || factor === 0) return price;
  return Math.round(price / factor);
}
