import type { RangeBundle, Timeframe } from './types';
import { TIMEFRAME_TO_MS } from './types';
import type { SourcePreference } from '../state/sourcePreference';

export type RangeMode = 'full' | 'hoga' | 'sidecar';

export type RangeRequestOptions = {
  brokerLateEntriesEnabled?: boolean | null;
  brokerLateEntryStartHHMM?: number | null;
  volumeDistributionBins?: number | null;
  tradeVolumePocBins?: number | null;
  volumeDistributionPriceRange?: { min: number; max: number } | null;
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
];

export type RangeBundleRequest = {
  enabled: boolean;
  queryKey: RangeQueryKey;
  url: string;
  todayKst: string | null;
};

const PLACEHOLDER_COMPATIBLE_KEY_INDICES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

function addParam(params: URLSearchParams, key: string, value: number | string | null | undefined): void {
  if (value == null) return;
  params.set(key, String(value));
}

export function buildRangeBundleRequest(input: RangeBundleRequestInput): RangeBundleRequest {
  const bucketMs = input.timeframe ? TIMEFRAME_TO_MS[input.timeframe] : null;
  const options = input.options ?? {};
  const brokerLateEntriesEnabled = options.brokerLateEntriesEnabled ?? null;
  const brokerLateEntryStartHHMM = options.brokerLateEntryStartHHMM ?? null;
  const volumeDistributionBins = options.volumeDistributionBins ?? null;
  const tradeVolumePocBins = options.tradeVolumePocBins ?? null;
  const volumeDistributionPriceRange = options.volumeDistributionPriceRange ?? null;
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
  ];

  const params = new URLSearchParams();
  addParam(params, 'code', input.code);
  addParam(params, 'from', input.from);
  addParam(params, 'to', input.to);
  addParam(params, 'bucket_ms', bucketMs);
  addParam(params, 'price_min', input.priceRange?.min);
  addParam(params, 'price_max', input.priceRange?.max);
  if (brokerLateEntriesEnabled === false) params.set('broker_late_entries_enabled', 'false');
  if (brokerLateEntriesEnabled === true) params.set('broker_late_entries_enabled', 'true');
  addParam(params, 'broker_late_entry_start_hhmm', brokerLateEntryStartHHMM);
  addParam(params, 'volume_distribution_bins', volumeDistributionBins);
  addParam(params, 'volume_distribution_price_min', volumeDistributionPriceRange?.min);
  addParam(params, 'volume_distribution_price_max', volumeDistributionPriceRange?.max);
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
