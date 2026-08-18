import {
  LineSeries,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokensThemed } from '../../util/tokens';
import { formatKoreanWonEok } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { LINE_HIDDEN_COLOR, maskOutgoingConnector } from '../util/auctionHide';
import { addZeroBaselineGuide, includeZeroAutoscale } from '../util/zeroBaseline';

const TOKEN_SPEC = {
  line: ['--accent', '#F0B429'],
  // 0선은 데이터가 아니라 참조선이므로 중립색 — 호가비 pane 과 동일 토큰.
  baseline: ['--fg-dimmer', '#63636F'],
} as const;

// Color is series-level (thunked in the spec below); the data is value-only.
const lineOptions = () => ({
  color: resolveTokensThemed(TOKEN_SPEC).line,
  lineWidth: 2,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => formatKoreanWonEok(v),
    minMove: 1,
  },
  priceScaleId: 'right' as const,
  // net_amount 는 당일 **누적** 순매수라 한쪽으로만 쌓인 구간을 확대하면 0 이
  // 보이는 범위 밖으로 밀린다 — 정작 부호를 읽어야 할 때 기준선이 사라진다.
  autoscaleInfoProvider: includeZeroAutoscale,
  priceLineVisible: false,
  // ⚠ 앱에서 이 pane 만 true — DESIGN.md 2026-05-23("전 시리즈 off, 최신값은
  // 크로스헤어로") 의 **명시적 예외**이고 드리프트가 아니다. 프로그램은
  // `LEGEND_CELL_PANES`(volume·quote-totals) 밖이라 레전드 값 행이 꺼져 있고,
  // 그 필터는 크로스헤어 유무와 무관하게 행 자체를 거른다 → 이 라벨을 끄면
  // 현재 순매수를 읽을 표면이 남지 않는다. 레전드가 켜지면 같이 끌 것
  // (근거·해소 조건은 DESIGN.md 2026-08-18 항목).
  lastValueVisible: true,
});

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
  bundleKind: 'live', // quote_ratio 를 읽는 라이브 pane
  stretch: 0.35,
  legendToggleKey: 'programTradeEnabled',
  series: [
    {
      type: LineSeries,
      options: lineOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) => projectProgramTradeNetAmount(bundle, axis),
      legend: {
        label: '프로그램 순매수',
        color: () => resolveTokensThemed(TOKEN_SPEC).line,
        format: formatKoreanWonEok, // 억 단위 (라인 축과 동일)
      },
      // 0 = 프로그램 매수/매도 우위의 경계. 누적값이라 이 선을 언제 되돌아
      // 넘는지가 그 자체로 신호다.
      afterAdd: (series) =>
        addZeroBaselineGuide(series, resolveTokensThemed(TOKEN_SPEC).baseline),
    },
  ],
} satisfies PaneSpec;
