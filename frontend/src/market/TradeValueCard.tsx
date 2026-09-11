/** Daily amounts and baselines share a zero-based scale across both markets. */
import { useState } from 'react';
import { useMarketSectors, useMarketTradeValue, type TradeValuePoint } from '../api/market';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { ChartProbe } from './ChartProbe';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import { MARKET_LABELS, SERIES_COLORS, eokToJoText, formatMarketTime } from './marketFormat';

const SPANS = [['20', '20거래일'], ['60', '60거래일'], ['120', '120거래일']] as const;
type Span = (typeof SPANS)[number][0];
const MARKETS = ['KOSPI', 'KOSDAQ'] as const;
const COLORS = { KOSPI: SERIES_COLORS.deposit, KOSDAQ: SERIES_COLORS.arb };
const mmdd = (date: string) => `${Number(date.slice(4, 6))}/${Number(date.slice(6, 8))}`;

function Tile({ name, points, base, samples, max, today, fetchedAt }: {
  name: typeof MARKETS[number]; points: TradeValuePoint[]; base: number | null;
  samples: number; max: number; today: string; fetchedAt: number;
}) {
  const last = points[points.length - 1];
  // The API has no finality signal for today's point. Keep it provisional even
  // after the clock passes closing time; that alone cannot confirm this sample.
  const provisional = last.date === today;
  const difference = base ? (last.value_eok / base - 1) * 100 : null;
  const positions = points.map((_, i) => (i + 0.5) / points.length);
  return <section aria-label={`${MARKET_LABELS[name]} 거래대금`} className="min-w-0 flex flex-col gap-xs">
    <div className="flex flex-wrap items-baseline gap-x-sm gap-y-2xs">
      <span className="text-sm font-semibold text-fg">{MARKET_LABELS[name]}</span>
      <span className="text-xs text-fg-dim">{provisional ? '오늘 누적' : `${mmdd(last.date)} 거래대금`}</span>
      <strong className="font-data text-xl text-fg tabular-nums">{eokToJoText(last.value_eok)}</strong>
      <span className="text-xs text-fg-dim">{provisional ? '집계 중 · 잠정' : difference == null ? '비교 이력 부족' : `하루 평균 대비 ${difference > 0 ? '+' : ''}${difference.toFixed(0)}%`}</span>
    </div>
    <p className="font-data text-xs text-fg-dim tabular-nums">직전 {samples}거래일 하루 평균 {eokToJoText(base)}</p>
    <div className="flex gap-xs">
      <div aria-hidden="true" className="flex w-12 shrink-0 flex-col justify-between text-right font-data text-2xs text-fg-dim tabular-nums">
        <span>{eokToJoText(max)}</span><span>{eokToJoText(max / 2)}</span><span>0조</span>
      </div>
      <div className="relative min-w-0 flex-1" style={{ height: '7rem' }}>
        <svg aria-hidden="true" className="h-full w-full" viewBox="0 0 600 100" preserveAspectRatio="none">
          {[0, 50, 100].map(y => <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="var(--border)" vectorEffect="non-scaling-stroke" />)}
          {points.map((p, i) => <rect key={p.date} x={positions[i] * 600 - 600 / points.length * 0.34}
            y={100 - p.value_eok / max * 100} width={600 / points.length * 0.68} height={p.value_eok / max * 100}
            fill={COLORS[name]} opacity={p.date === today ? 0.35 : 0.8}
            stroke={p.date === today ? COLORS[name] : 'none'} strokeDasharray={p.date === today ? '3 2' : undefined}
            vectorEffect="non-scaling-stroke" />)}
          {base != null && <line x1="0" x2="600" y1={100 - base / max * 100} y2={100 - base / max * 100}
            stroke="var(--fg-dim)" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
        </svg>
        <ChartProbe labels={points.map(p => mmdd(p.date))} positions={positions}
          summaries={points.map(p => `${MARKET_LABELS[name]} ${eokToJoText(p.value_eok)}${p.date === today ? ' · 집계 중 · 잠정' : ''}`)} />
      </div>
    </div>
    <div className="ml-12 flex justify-between font-data text-2xs text-fg-dim tabular-nums">
      <span>{mmdd(points[0].date)}</span><span>{mmdd(last.date)}{provisional ? ' (오늘)' : ''}</span>
    </div>
    <p className="text-2xs text-fg-dim">{fetchedAt ? `${formatMarketTime(fetchedAt)} 조회 · ` : ''}{provisional ? '오늘은 누적 집계액으로, 하루 전체 평균과 증감률을 비교하지 않습니다.' : '마지막 거래일 기준 · 평균은 해당 일을 제외합니다.'}</p>
  </section>;
}

export function TradeValueCard() {
  const [span, setSpan] = useState<Span>('20');
  const days = Number(span);
  // Fetch an extra sample so excluding the last day still leaves n prior days.
  const tv = useMarketTradeValue(days + 1);
  const sectors = useMarketSectors();
  const today = todayKstYyyymmdd();
  const tiles = MARKETS.map((name, i) => {
    const raw = tv.data?.markets[name] ?? [];
    const fresh = sectors.data?.markets[String(i)]?.index?.trade_value_eok;
    const full = raw.map((p, index) => index === raw.length - 1 && p.date === today && fresh != null ? { ...p, value_eok: fresh } : p);
    const past = full.slice(0, -1).slice(-days);
    return { name, points: full.slice(-days), samples: past.length,
      base: past.length ? past.reduce((sum, p) => sum + p.value_eok, 0) / past.length : null,
      fetchedAt: raw.at(-1)?.date === today && fresh != null ? sectors.dataUpdatedAt : tv.dataUpdatedAt };
  });
  const largest = Math.max(1, ...tiles.flatMap(t => [...t.points.map(p => p.value_eok), t.base ?? 0]));
  const step = 10 ** Math.floor(Math.log10(largest));
  const max = Math.ceil(largest * 1.1 / step) * step;
  return <MarketCard className="flex flex-col gap-sm p-md">
    <CardHeader title="거래대금 추이" hint="일별 거래대금 · 조원"
      right={<ModeSwitch value={span} onChange={setSpan} options={SPANS} label="거래대금 기간" />} />
    <div className="market-pair market-trade-body grid gap-md">
      {tiles.every(t => t.points.length === 0) ? <EmptyNote>{tv.isLoading ? '거래대금 이력을 불러오는 중입니다.' : '거래대금 이력을 받지 못했습니다.'}</EmptyNote>
        : tiles.map(t => t.points.length ? <Tile key={t.name} {...t} max={max} today={today} />
          : <EmptyNote key={t.name}>{MARKET_LABELS[t.name]} 이력을 받지 못했습니다.</EmptyNote>)}
    </div>
  </MarketCard>;
}
