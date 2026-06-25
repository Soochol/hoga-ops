import type { RangeBundle } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';
import type {
  ParquetStudyViewWriteRequest,
  StudyDataProvenance,
  StudyIndicatorState,
  StudyProvenance,
  StudySavedFromRoute,
  StudyViewport,
} from '../api/studyViews';
import { projectStudySnapshotHoga } from './studySnapshotProjection';

export type BuildStudySnapshotArgs = {
  name: string;
  memo?: string;
  tags?: string[];
  route: StudySavedFromRoute;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  viewport: StudyViewport;
  indicatorState: StudyIndicatorState;
  bundle: RangeBundle;
  fromIndex: number;
  toIndex: number;
  capturedAtMs?: number;
};

function dataWarnings(bundle: RangeBundle): string[] {
  const warnings = (bundle as RangeBundle & { data_warnings?: unknown }).data_warnings;
  return Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string') : [];
}

export function buildStudySnapshotRequest(args: BuildStudySnapshotArgs): ParquetStudyViewWriteRequest {
  const fromIndex = Math.max(0, Math.min(args.fromIndex, args.bundle.candles.length - 1));
  const toIndex = Math.max(fromIndex, Math.min(args.toIndex, args.bundle.candles.length - 1));
  const candles = args.bundle.candles.slice(fromIndex, toIndex + 1);
  const from = candles[0]?.ts_ms ?? args.viewport.right_edge_ms;
  const to = candles[candles.length - 1]?.ts_ms ?? args.viewport.right_edge_ms;
  const dataProvenance: StudyDataProvenance = args.route === '/study' ? 'study_snapshot' : 'live_mixed';
  const provenance: StudyProvenance = {
    saved_from_route: args.route,
    data_provenance: dataProvenance,
  };

  const segments = args.bundle.segments.filter((s) => s.session_close_ms >= from && s.session_open_ms <= to);
  const segmentDates = new Set(segments.map((s) => s.date));
  const hoga = projectStudySnapshotHoga({
    route: args.route,
    bundle: args.bundle,
    indicatorState: args.indicatorState,
    segments,
    from,
    to,
  });

  const snapshot = {
    schema_version: 1 as const,
    source_policy: 'fixed' as const,
    code: args.code,
    label: args.label,
    timeframe: args.timeframe,
    snapshot_from_ms: from,
    snapshot_to_ms: to,
    bucket_kind: args.timeframe,
    viewport: args.viewport,
    indicator_state: args.indicatorState,
    provenance,
    bundle: {
      code: args.code,
      timeframe: args.timeframe,
      snapshot_from_ms: from,
      snapshot_to_ms: to,
      segments,
      candles: candles.map((c) => ({
        t: c.ts_ms,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.vol_a + c.vol_b,
      })),
      quote_totals: hoga.quote_totals,
      ratio: hoga.ratio,
      fill_strength: hoga.fill_strength,
      ask_peaks: args.bundle.ask_peaks.filter((p) => segmentDates.has(p.date)),
      bid_peaks: (args.bundle.bid_peaks ?? []).filter((p) => segmentDates.has(p.date)),
      trade_volume_pocs: (args.bundle.trade_volume_pocs ?? []).filter((p) => segmentDates.has(p.date)),
      volume_distributions: (args.bundle.volume_distributions ?? [])
        .filter((distribution) => segmentDates.has(distribution.date)),
      data_warnings: dataWarnings(args.bundle),
    },
    captured_at_ms: args.capturedAtMs ?? Date.now(),
  };

  return {
    name: args.name,
    code: args.code,
    label: args.label,
    timeframe: args.timeframe,
    snapshot_from_ms: from,
    snapshot_to_ms: to,
    viewport: args.viewport,
    indicator_state: args.indicatorState,
    snapshot,
    provenance,
    memo: args.memo ?? '',
    tags: args.tags ?? [],
  };
}
