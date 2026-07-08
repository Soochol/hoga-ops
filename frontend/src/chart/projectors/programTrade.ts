import {
  LineSeries,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { formatKoreanWonEok } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { LINE_HIDDEN_COLOR, maskOutgoingConnector } from '../util/auctionHide';

const TOKEN_SPEC = {
  line: ['--accent', '#F0B429'],
} as const;

const { line } = resolveTokens(TOKEN_SPEC);

const lineOptions = {
  color: line,
  lineWidth: 2,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => formatKoreanWonEok(v),
    minMove: 1,
  },
  priceScaleId: 'right',
  priceLineVisible: false,
  lastValueVisible: true,
} as const;

export function projectProgramTradeNetAmount(
  bundle: RangeBundle,
  axis: VirtualAxis,
): LineData<Time>[] {
  const byBucket = new Map<number, number>();
  const points = bundle.program_trade?.points ?? [];
  if (points.length === 0) return [];
  for (const p of points) {
    if (p.net_amount == null) continue;
    if (!isKrxRegularProgramTime(bundle, p.t)) continue;
    const t = bucketTime(bundle, p.t);
    if (t == null || !axis.contains(t)) continue;
    byBucket.set(t, p.net_amount);
  }
  const out: LineData<Time>[] = [];
  const hogaPoints = [...bundle.quote_ratio.points].sort((a, b) => a.t - b.t);
  const seenHogaT = new Set<number>();
  let lastEmittedDate: string | null = null;
  for (const p of hogaPoints) {
    const hogaT = bucketTime(bundle, p.t);
    if (hogaT == null || seenHogaT.has(hogaT)) continue;
    seenHogaT.add(hogaT);
    if (!axis.contains(hogaT)) continue;
    const time = (axis.toVirtual(hogaT) / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    const value = byBucket.get(hogaT);
    if (value == null) continue;
    const date = segmentDate(bundle, hogaT);
    if (lastEmittedDate != null && date != null && date !== lastEmittedDate) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
    }
    out.push({ time, value });
    lastEmittedDate = date;
  }
  return out;
}

function bucketTime(bundle: RangeBundle, t: number): number | null {
  const segment = bundle.segments.find((s) => s.session_open_ms <= t && t <= s.session_close_ms);
  if (!segment) return null;
  const bucketMs = Math.max(1, bundle.bucket_ms || 1);
  return segment.session_open_ms + Math.floor((t - segment.session_open_ms) / bucketMs) * bucketMs;
}

function segmentDate(bundle: RangeBundle, t: number): string | null {
  return bundle.segments.find((s) => s.session_open_ms <= t && t <= s.session_close_ms)?.date ?? null;
}

function regularSessionBoundsForDate(yyyymmdd: string): { open: number; close: number } | null {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const open = Date.UTC(y, m - 1, d, 0, 0, 0);
  return { open, close: open + 6.5 * 3600 * 1000 };
}

function isKrxRegularProgramTime(bundle: RangeBundle, t: number): boolean {
  const segment = bundle.segments.find((s) => s.session_open_ms <= t && t <= s.session_close_ms);
  if (!segment) return false;
  const regular = regularSessionBoundsForDate(segment.date);
  if (!regular) return true;
  const closingAuctionStart = regular.close - 10 * 60_000;
  return t >= regular.open && t < closingAuctionStart;
}

export const PROGRAM_TRADE_SPEC = {
  name: 'program-trade' as const,
  live: true,
  stretch: 0.35,
  series: [
    {
      type: LineSeries,
      options: lineOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) => projectProgramTradeNetAmount(bundle, axis),
    },
  ],
} satisfies PaneSpec;
