import { apiAction, apiCall } from './client';
import type { LiveTimeframe } from '../state/livePage';
import type { MASource } from '../chart/projectors/movingAverage';
import type {
  AskPeak,
  BidPeak,
  DayVolumeDistribution,
  OrderbookSnapshot,
  ProgramTradeSeries,
  SourceName,
  TradeVolumePocWire,
} from './types';

export type StudyAggregationBasis = 'close' | 'intra_period_max';
export type StudyDataProvenance = 'live_mixed' | 'study_snapshot' | 'unknown';
export type StudySavedFromRoute = '/live' | '/study';

export type StudyViewport = {
  right_edge_ms: number;
  bar_span: number;
  at_live_edge: boolean;
};

export type StudyMovingAverageConfig = {
  id: string;
  enabled: boolean;
  period: number;
  color: string;
  line_width: 1 | 2 | 3 | 4;
  source: MASource;
};

export type StudyIndicatorState = {
  volume_enabled: boolean;
  quote_totals_enabled: boolean;
  ratio_enabled: boolean;
  fill_strength_enabled: boolean;
  aggregation_basis: StudyAggregationBasis;
  auction_window_mask: boolean;
  ratio_outlier_filter_enabled: boolean;
  ratio_outlier_threshold: number;
  daily_moving_averages?: StudyMovingAverageConfig[];
  daily_moving_average_enabled?: boolean;
  daily_moving_average_hidden?: boolean;
  program_trade_enabled?: boolean;
  trade_volume_poc_enabled?: boolean;
  trade_volume_poc_band_pct?: number;
  trade_volume_poc_color?: string;
  trade_volume_poc_opacity?: number;
  volume_distribution_enabled?: boolean;
  volume_distribution_range_count?: number;
  volume_distribution_color?: string;
  volume_distribution_max_color?: string;
};

export type StudyProvenance = {
  saved_from_route: StudySavedFromRoute;
  data_provenance: StudyDataProvenance;
};

export type StudyOrderbookBucket = {
  t: number;
  snapshot: OrderbookSnapshot | null;
  available: boolean;
};

export type StudyBrokerDetail = {
  broker: string;
  net: number;
  dominant_side: 'buy' | 'sell';
};

export type StudyBrokerBucket = {
  t: number;
  brokers: StudyBrokerDetail[];
  available: boolean;
};

export type StudyDetailWarning = {
  kind: 'orderbook' | 'broker';
  t: number | null;
  code: string;
  date: string | null;
  message: string;
};

export type StudySnapshotBundle = {
  code: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  segments: { date: string; session_open_ms: number; session_close_ms: number; source?: SourceName }[];
  candles: { t: number; open: number; high: number; low: number; close: number; volume: number }[];
  quote_totals: { t: number; bid_total?: number | null; ask_total?: number | null; visible: boolean }[];
  ratio: { t: number; value?: number | null; visible: boolean }[];
  fill_strength: { t: number; buy_qty?: number | null; sell_qty?: number | null; visible: boolean }[];
  program_trade?: ProgramTradeSeries;
  ask_peaks: AskPeak[];
  bid_peaks?: BidPeak[];
  trade_volume_pocs?: TradeVolumePocWire[];
  volume_distributions?: DayVolumeDistribution[];
  data_warnings: string[];
  orderbook_buckets?: StudyOrderbookBucket[];
  broker_buckets?: StudyBrokerBucket[];
  detail_warnings?: StudyDetailWarning[];
};

export type ParquetStudySnapshot = {
  schema_version: 1;
  source_policy: 'fixed';
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  bucket_kind: LiveTimeframe;
  viewport: StudyViewport;
  indicator_state: StudyIndicatorState;
  provenance: StudyProvenance;
  bundle: StudySnapshotBundle;
  captured_at_ms: number;
};

export type ParquetStudyView = {
  schema_version?: 1;
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  viewport: StudyViewport;
  indicator_state: StudyIndicatorState;
  memo: string;
  tags: string[];
  provenance: StudyProvenance;
  snapshot_schema_version: number;
  snapshot_path: string;
  snapshot_size_bytes: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyViewRange = {
  from_date: string;
  to_date: string;
  from_ms: number;
  to_ms: number;
};

export type StudyViewReference = {
  schema_version: 2;
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo: string;
  tags: string[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyViewListRow = ParquetStudyView | StudyViewReference;
export type StudyViewsFile = { schema_version: number; saves: StudyViewListRow[] };

export type ParquetStudyViewWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  viewport: StudyViewport;
  indicator_state: StudyIndicatorState;
  memo?: string;
  tags?: string[];
  provenance: StudyProvenance;
  snapshot: ParquetStudySnapshot;
};

export type StudyViewWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo?: string;
  tags?: string[];
};

export type StudyViewMetadataUpdateRequest = {
  name?: string;
  memo?: string;
};

export type StudyViewSaveWriteRequest = ParquetStudyViewWriteRequest | StudyViewWriteRequest;

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const listStudyViews = () => apiCall<StudyViewsFile>('/api/study-views/saves');
export const createStudyView = (body: StudyViewSaveWriteRequest) =>
  apiCall<StudyViewListRow>('/api/study-views/saves', { method: 'POST', ...json(body) });
export const getStudyView = (id: string) => apiCall<StudyViewListRow>(`/api/study-views/saves/${id}`);
export const getStudyViewSnapshot = (id: string) =>
  apiCall<ParquetStudySnapshot>(`/api/study-views/saves/${id}/snapshot`);
export const updateStudyView = (id: string, body: StudyViewSaveWriteRequest) =>
  apiCall<StudyViewListRow>(`/api/study-views/saves/${id}`, { method: 'PUT', ...json(body) });
export const updateStudyViewMetadata = (id: string, body: StudyViewMetadataUpdateRequest) =>
  apiCall<StudyViewListRow>(`/api/study-views/saves/${id}/metadata`, { method: 'PATCH', ...json(body) });
export const deleteStudyView = (id: string) =>
  apiAction(`/api/study-views/saves/${id}`, { method: 'DELETE' });
