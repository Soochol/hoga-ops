import type { RangeBundle, Timeframe } from './types';
import { TIMEFRAME_TO_MS } from './types';
import type { LiveVenueOption } from '../state/liveVenue';
import type { SourcePreference } from '../state/sourcePreference';

export type RangeMode = 'hoga' | 'sidecar' | 'candles';

export type RangeRequestOptions = {
  askPeaksEnabled?: boolean | null;
  bidPeaksEnabled?: boolean | null;
  brokerLateEntriesEnabled?: boolean | null;
  brokerLateEntryStartHHMM?: number | null;
  programTradeEnabled?: boolean | null;
  tradeVolumePocEnabled?: boolean | null;
  depthHeatmapEnabled?: boolean | null;
  /** 봉별 최대 체결 벽 배열(`traded_bar_*`) — **옵트인**. 최대벽 pane 의 봉별
   *  모드를 켠 창만 true 를 보낸다: 하루당 최대 정규장 분 수 × 2축 × 2방향이라
   *  페이로드가 자릿수로 커진다(백엔드 `bar_peaks_enabled` 주석). */
  barPeaksEnabled?: boolean | null;
  /** 전체 계열의 봉별 배열 — 체결 계열과 **따로** 옵트인한다(배열이 더 크다). */
  allBarPeaksEnabled?: boolean | null;
  /** 미도달의 봉별 배열 — 계열별 옵트인의 셋째. */
  unreachedBarPeaksEnabled?: boolean | null;
  volumeDistributionBins?: number | null;
  tradeVolumePocBins?: number | null;
  volumeDistributionPriceRange?: { min: number; max: number } | null;
  volumeDistributionCutoffMs?: number | null;
  mode?: RangeMode;
};

export type RangeBundleRequestInput = {
  code: string | null;
  from: string | null;
  to: string | null;
  timeframe: Timeframe | null;
  priceRange?: { min: number; max: number };
  todayKst?: string | null;
  /** undefined = 설정 로딩 중 → `enabled=false`. 기본값으로 메우지 않는다. */
  sourcePref: SourcePreference | undefined;
  /** 어느 거래소의 과거 시계열인가. **쿼리 키에도 들어가야 한다** — 안 들어가면
   *  venue 를 바꿔도 캐시가 안 갈려 이전 venue 데이터가 그대로 보인다(ADR-0140). */
  venue: LiveVenueOption;
  options?: RangeRequestOptions;
};

export type RangeQueryKey = readonly [
  'range',
  string | null,
  string | null,
  string | null,
  number | null,
  number | undefined,
  number | undefined,
  boolean | null,
  number | null,
  number | null,
  number | undefined,
  number | undefined,
  number | null,
  // 설정 로딩 중이면 undefined — 그 사이 `enabled=false` 라 이 키로 조회되지는 않지만,
  // 키 자체는 만들어지므로 타입에 포함한다.
  SourcePreference | undefined,
  RangeMode | null,
  number | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  // venue 이후는 **덧붙이기 전용**이다 — 중간에 넣으면 기존 인덱스가 전부 밀려, 키를
  // 인덱스로 읽는 소비자(RANGE_QUERY_KEY_*_INDEX)와 계약 테스트가 위치만으로 깨진다.
  // 키 안의 순서는 캐시 식별에 의미가 없으므로 새 항목은 이 뒤에 붙인다.
  LiveVenueOption,
  // barPeaksEnabled — **키에 들어가야 한다**: 옵트인이라 끈 창의 응답은 그 배열이
  // 비어 있고, 키가 같으면 켠 창이 그 빈 캐시를 그대로 읽어 pane 이 빈다.
  boolean | null,
  // allBarPeaksEnabled — 같은 이유. 게이트가 독립이므로 키에도 전부 들어간다.
  boolean | null,
  // unreachedBarPeaksEnabled — 셋째.
  boolean | null,
];

export const RANGE_QUERY_KEY_FROM_DATE_INDEX = 2;
export const RANGE_QUERY_KEY_VDIST_PRICE_MIN_INDEX = 10;
export const RANGE_QUERY_KEY_VDIST_PRICE_MAX_INDEX = 11;

export type RangeBundleRequest = {
  enabled: boolean;
  queryKey: RangeQueryKey;
  url: string;
  todayKst: string | null;
};

/** placeholder 를 재사용하려면 **같아야 하는** 키 축들. 여기 없는 인덱스는 아예
 *  비교되지 않으므로, 값이 달라도 이전 번들이 그대로 화면에 남는다.
 *
 *  빠진 것 중 의도적인 것: `1`(code)은 `rangePlaceholderData` 가 따로 비교하고,
 *  `2`·`3`(from·to)은 좌측 팬으로 구간을 넓히는 동안 이전 구간을 보여주는 것이
 *  이 기능의 목적 그 자체다.
 *
 *  **queryKey 에 축을 추가하면 이 목록도 같이 늘린다.** 늘리지 않으면 그 옵션을 바꿔도
 *  placeholder 가 유지돼 옛 데이터가 남는데, 기존 테스트들은 새 인덱스를 양쪽 키에서
 *  같은 값으로 고정하므로 **아무것도 빨개지지 않는다** — 누락이 무증상이다.
 *  실제로 단별 잔량 증감 토글과 `venue` 가 그렇게 빠져 있었다. #490 이
 *  "RangeQueryKey 튜플·queryKey 배열·이 목록에 추가" 라고 세 곳을 커밋 메시지에
 *  적어 뒀지만, 그 규칙이 코드에 없어 다음 두 축이 그대로 샜다. */
const PLACEHOLDER_COMPATIBLE_KEY_INDICES = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
] as const;

function addParam(params: URLSearchParams, key: string, value: number | string | null | undefined): void {
  if (value == null) return;
  params.set(key, String(value));
}

function addBoolParam(params: URLSearchParams, key: string, value: boolean | null): void {
  if (value == null) return;
  params.set(key, value ? 'true' : 'false');
}

export function buildRangeBundleRequest(input: RangeBundleRequestInput): RangeBundleRequest {
  const bucketMs = input.timeframe ? TIMEFRAME_TO_MS[input.timeframe] : null;
  const options = input.options ?? {};
  const askPeaksEnabled = options.askPeaksEnabled ?? null;
  const bidPeaksEnabled = options.bidPeaksEnabled ?? null;
  const brokerLateEntriesEnabled = options.brokerLateEntriesEnabled ?? null;
  const brokerLateEntryStartHHMM = options.brokerLateEntryStartHHMM ?? null;
  const programTradeEnabled = options.programTradeEnabled ?? null;
  const tradeVolumePocEnabled = options.tradeVolumePocEnabled ?? null;
  const depthHeatmapEnabled = options.depthHeatmapEnabled ?? null;
  const barPeaksEnabled = options.barPeaksEnabled ?? null;
  const allBarPeaksEnabled = options.allBarPeaksEnabled ?? null;
  const unreachedBarPeaksEnabled = options.unreachedBarPeaksEnabled ?? null;
  const volumeDistributionBins = options.volumeDistributionBins ?? null;
  const tradeVolumePocBins = options.tradeVolumePocBins ?? null;
  const volumeDistributionPriceRange = options.volumeDistributionPriceRange ?? null;
  const volumeDistributionCutoffMs = options.volumeDistributionCutoffMs ?? null;
  const mode = options.mode ?? null;
  // `sourcePref` 가 undefined = 설정 로딩 중. 기본값으로 메우고 조회하면 옵션을 켜 둔
  // 사용자가 kiwoom 키로 한 번, hogaplay 키로 또 한 번 조회해 차트가 갈아끼워진다
  // (`source_pref` 가 쿼리 키에 있다). 정해질 때까지 기다린다 — 설정은 캐시되므로
  // 세션당 한 번뿐이다.
  const enabled = !!(input.code && input.from && input.to && bucketMs && mode && input.sourcePref);

  const queryKey: RangeQueryKey = [
    'range',
    input.code,
    input.from,
    input.to,
    bucketMs,
    input.priceRange?.min,
    input.priceRange?.max,
    brokerLateEntriesEnabled,
    brokerLateEntryStartHHMM,
    volumeDistributionBins,
    volumeDistributionPriceRange?.min,
    volumeDistributionPriceRange?.max,
    tradeVolumePocBins,
    input.sourcePref,
    mode,
    volumeDistributionCutoffMs,
    askPeaksEnabled,
    bidPeaksEnabled,
    programTradeEnabled,
    tradeVolumePocEnabled,
    depthHeatmapEnabled,
    input.venue,  // 위 타입 주석 참조 — 이 뒤는 덧붙이기 전용
    barPeaksEnabled,
    allBarPeaksEnabled,
    unreachedBarPeaksEnabled,
  ];

  const params = new URLSearchParams();
  addParam(params, 'code', input.code);
  addParam(params, 'from', input.from);
  addParam(params, 'to', input.to);
  addParam(params, 'bucket_ms', bucketMs);
  addParam(params, 'price_min', input.priceRange?.min);
  addParam(params, 'price_max', input.priceRange?.max);
  addBoolParam(params, 'ask_peaks_enabled', askPeaksEnabled);
  addBoolParam(params, 'bid_peaks_enabled', bidPeaksEnabled);
  addBoolParam(params, 'broker_late_entries_enabled', brokerLateEntriesEnabled);
  addBoolParam(params, 'program_trade_enabled', programTradeEnabled);
  addBoolParam(params, 'trade_volume_poc_enabled', tradeVolumePocEnabled);
  addBoolParam(params, 'depth_heatmap_enabled', depthHeatmapEnabled);
  addBoolParam(params, 'bar_peaks_enabled', barPeaksEnabled);
  addBoolParam(params, 'all_bar_peaks_enabled', allBarPeaksEnabled);
  addBoolParam(params, 'unreached_bar_peaks_enabled', unreachedBarPeaksEnabled);
  addParam(params, 'broker_late_entry_start_hhmm', brokerLateEntryStartHHMM);
  addParam(params, 'volume_distribution_bins', volumeDistributionBins);
  addParam(params, 'volume_distribution_price_min', volumeDistributionPriceRange?.min);
  addParam(params, 'volume_distribution_price_max', volumeDistributionPriceRange?.max);
  addParam(params, 'volume_distribution_cutoff_ms', volumeDistributionCutoffMs);
  addParam(params, 'trade_volume_poc_bins', tradeVolumePocBins);
  addParam(params, 'source_pref', input.sourcePref);
  addParam(params, 'mode', mode);
  // venue 는 **마지막**에 붙인다 — 기대 URL 문자열이 뒤에 이어 붙이는 형태라
  // 순서를 바꾸면 계약 테스트가 위치만으로 깨진다(쿼리스트링 순서는 의미 없음).
  addParam(params, 'venue', input.venue);

  return {
    enabled,
    queryKey,
    url: `/api/range?${params.toString()}`,
    todayKst: input.todayKst ?? null,
  };
}

export function rangePlaceholderData(
  prev: RangeBundle | undefined,
  currentKey: RangeQueryKey,
  previousKey: readonly unknown[] | undefined,
): RangeBundle | undefined {
  if (!prev || prev.code !== currentKey[1]) return undefined;
  if (!previousKey) return undefined;
  for (const index of PLACEHOLDER_COMPATIBLE_KEY_INDICES) {
    if (previousKey[index] !== currentKey[index]) return undefined;
  }
  return prev;
}
