import type { RangeBundle, Timeframe } from './types';
import { TIMEFRAME_TO_MS } from './types';
import type { SourcePreference } from '../state/sourcePreference';

export type RangeMode = 'full' | 'hoga' | 'sidecar' | 'candles';

export type RangeRequestOptions = {
  askPeaksEnabled?: boolean | null;
  bidPeaksEnabled?: boolean | null;
  brokerLateEntriesEnabled?: boolean | null;
  brokerLateEntryStartHHMM?: number | null;
  programTradeEnabled?: boolean | null;
  tradeVolumePocEnabled?: boolean | null;
  depthHeatmapEnabled?: boolean | null;
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
  sourcePref: SourcePreference;
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
  SourcePreference,
  RangeMode | null,
  number | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
  boolean | null,
];

export const RANGE_QUERY_KEY_FROM_DATE_INDEX = 2;

export type RangeBundleRequest = {
  enabled: boolean;
  queryKey: RangeQueryKey;
  url: string;
  todayKst: string | null;
};

const PLACEHOLDER_COMPATIBLE_KEY_INDICES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const;

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
  const volumeDistributionBins = options.volumeDistributionBins ?? null;
  const tradeVolumePocBins = options.tradeVolumePocBins ?? null;
  const volumeDistributionPriceRange = options.volumeDistributionPriceRange ?? null;
  const volumeDistributionCutoffMs = options.volumeDistributionCutoffMs ?? null;
  const mode = options.mode ?? null;
  const enabled = !!(input.code && input.from && input.to && bucketMs && mode);

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
  addParam(params, 'broker_late_entry_start_hhmm', brokerLateEntryStartHHMM);
  addParam(params, 'volume_distribution_bins', volumeDistributionBins);
  addParam(params, 'volume_distribution_price_min', volumeDistributionPriceRange?.min);
  addParam(params, 'volume_distribution_price_max', volumeDistributionPriceRange?.max);
  addParam(params, 'volume_distribution_cutoff_ms', volumeDistributionCutoffMs);
  addParam(params, 'trade_volume_poc_bins', tradeVolumePocBins);
  addParam(params, 'source_pref', input.sourcePref);
  addParam(params, 'mode', mode);

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
