// ============================================================================
// PROTOTYPE — throwaway. 변형 C: 마스터-디테일 워크벤치.
//
// 구조: 좌(지수·섹터 선택 레일) → 중(선택 지수 대형 차트 + 수급 5일) → 우(해당
// 시장 무버). primary affordance = "하나를 골라 깊게" — A·B 의 전체 조망과 반대.
// 선택 상태는 로컬 useState(프로토타입 — 실구현이면 URL/스토어).
// 실구현 시 중앙 차트는 lightweight-charts + GET /api/live/index-candles.
// ============================================================================
import { useState } from 'react';
import { PanelCard } from '../../ui/PageShell';
import { priceDirClass } from '../../ui/priceDir';
import { heatBg } from '../../heatmap/heat';
import {
  MOCK_AS_OF, MOCK_INDICES, MOCK_INVESTOR_NET, MOCK_NET_TREND, MOCK_SECTORS,
  MOCK_TOP_GAINERS, MOCK_TOP_LOSERS, MOCK_TOP_VALUE, type MockRankRow,
} from './mockData';
import { NetTrendChart, NetTrendLegend, PctText, fmtSigned } from './protoBits';

/** 대형 목업 지수 차트 — 시가 기준선 + 방향색 라인/틴트 면. */
function BigIndexChart({ points }: { points: number[] }) {
  const w = 760;
  const h = 240;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const px = (i: number) => (i / (points.length - 1)) * (w - 8) + 4;
  const py = (v: number) => h - 8 - ((v - min) / span) * (h - 16);
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const open = points[0];
  const up = points[points.length - 1] >= open;
  const color = up ? 'var(--price-up)' : 'var(--price-down)';
  const area = `${line} L${px(points.length - 1).toFixed(1)},${h - 4} L${px(0).toFixed(1)},${h - 4} Z`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" className="block">
      <line x1="4" x2={w - 4} y1={py(open)} y2={py(open)} stroke="var(--border-strong)" strokeDasharray="3 3" />
      <path d={area} fill={`color-mix(in srgb, ${color} 12%, transparent)`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}

/** 5일 순매수 막대 (0 기준 상하). */
function FiveDayBars({ series }: { series: readonly number[] }) {
  const w = 150;
  const h = 44;
  const maxAbs = Math.max(...series.map(Math.abs)) || 1;
  const bw = w / series.length - 4;
  const mid = h / 2;
  return (
    <svg width={w} height={h} aria-hidden="true">
      <line x1="0" x2={w} y1={mid} y2={mid} stroke="var(--border-strong)" />
      {series.map((v, i) => {
        const bh = (Math.abs(v) / maxAbs) * (mid - 3);
        return (
          <rect
            key={i}
            x={i * (bw + 4) + 2}
            y={v >= 0 ? mid - bh : mid}
            width={bw}
            height={Math.max(bh, 1)}
            fill={v >= 0 ? 'var(--price-up)' : 'var(--price-down)'}
          />
        );
      })}
    </svg>
  );
}

function MoverList({ title, rows }: { title: string; rows: MockRankRow[] }) {
  return (
    <div className="flex flex-col gap-2xs">
      <h3 className="text-xs font-semibold uppercase text-fg-dim">{title}</h3>
      <ol className="flex flex-col">
        {rows.slice(0, 5).map((r) => (
          <li
            key={r.code}
            className="grid grid-cols-[1fr_4rem] items-center gap-xs border-b border-grid py-2xs last:border-b-0"
          >
            <span className="truncate text-sm text-fg">{r.name}</span>
            <PctText pct={r.changePct} className="text-right text-sm" />
          </li>
        ))}
      </ol>
    </div>
  );
}

export function VariantC() {
  const [selectedId, setSelectedId] = useState('KOSPI');
  const idx = MOCK_INDICES.find((i) => i.id === selectedId) ?? MOCK_INDICES[0];
  const netMarket = idx.id === 'KOSDAQ' || idx.id === 'KOSDAQ150' ? 'KOSDAQ' : 'KOSPI';
  const net = MOCK_INVESTOR_NET.find((m) => m.market === netMarket);
  const trend = MOCK_NET_TREND.find((t) => t.market === netMarket);

  return (
    <div className="grid h-full min-h-0 grid-cols-[13rem_1fr_17rem] gap-xs">
      {/* 좌 — 마스터 레일: 지수 + 섹터 */}
      <PanelCard borderless flat className="flex min-h-0 flex-col gap-sm overflow-y-auto p-sm">
        <h2 className="text-xs font-semibold uppercase text-fg-dim">지수</h2>
        <ul className="flex flex-col">
          {MOCK_INDICES.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => setSelectedId(i.id)}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-xs rounded-sm px-sm py-xs text-left"
                style={i.id === selectedId ? { background: 'var(--tint-selection)' } : undefined}
              >
                <span className="flex flex-col">
                  <span className="text-sm text-fg">{i.label}</span>
                  <span className={`font-data text-xs tabular-nums ${priceDirClass(i.change)}`}>
                    {i.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
                  </span>
                </span>
                <PctText pct={i.changePct} className="text-sm" />
              </button>
            </li>
          ))}
        </ul>
        <h2 className="mt-sm text-xs font-semibold uppercase text-fg-dim">섹터</h2>
        <ul className="flex flex-col">
          {MOCK_SECTORS.map((s) => (
            <li
              key={s.name}
              className="grid grid-cols-[1fr_3.6rem] items-center gap-xs rounded-sm px-sm py-2xs"
              style={{ background: heatBg(s.changePct, 0.18) }}
            >
              <span className="truncate text-sm text-fg">{s.name}</span>
              <PctText pct={s.changePct} className="text-right text-sm" />
            </li>
          ))}
        </ul>
      </PanelCard>

      {/* 중 — 디테일: 대형 차트 + 수급 */}
      <div className="flex min-h-0 flex-col gap-xs overflow-y-auto">
        <PanelCard borderless flat className="flex flex-col gap-sm p-md">
          <div className="flex items-baseline gap-md">
            <h1 className="text-md font-semibold text-fg">{idx.label}</h1>
            <span className={`font-data text-xl font-semibold tabular-nums ${priceDirClass(idx.change)}`}>
              {idx.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
            </span>
            <span className={`font-data text-sm tabular-nums ${priceDirClass(idx.change)}`}>
              {idx.change > 0 ? '+' : ''}{idx.change.toFixed(2)} <PctText pct={idx.changePct} />
            </span>
            {idx.advance !== null && (
              <span className="ml-auto font-data text-xs text-fg-dim tabular-nums">
                상승 <span className="text-price-up">{idx.advance}</span> · 보합 {idx.flat} · 하락{' '}
                <span className="text-price-down">{idx.decline}</span>
              </span>
            )}
          </div>
          <BigIndexChart points={idx.spark} />
          <p className="text-2xs text-fg-dim">기준 {MOCK_AS_OF} · 목업 — 실구현은 지수 분봉(ka20005) + lightweight-charts</p>
        </PanelCard>

        <PanelCard borderless flat className="flex flex-col gap-sm p-md">
          <h2 className="text-sm text-fg">
            투자자 수급 <span className="text-2xs text-fg-dim">{net ? (net.market === 'KOSPI' ? '코스피' : '코스닥') : ''} · 최근 5일 + 당일 잠정 · 억원</span>
          </h2>
          {net && (
            <div className="grid grid-cols-3 gap-lg">
              {([['개인', net.individual, net.individual5d], ['외국인', net.foreign, net.foreign5d], ['기관', net.institution, net.institution5d]] as const).map(
                ([label, v, series]) => (
                  <div key={label} className="flex flex-col gap-2xs">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-fg-dim">{label}</span>
                      <span className={`font-data text-sm font-semibold tabular-nums ${priceDirClass(v)}`}>
                        {fmtSigned(v)}
                      </span>
                    </div>
                    <FiveDayBars series={series} />
                  </div>
                ),
              )}
            </div>
          )}
          {trend && (
            <div className="flex flex-col gap-2xs border-t border-grid pt-sm">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-fg-dim">기관·외국인 20일 누적 추세</span>
                <NetTrendLegend foreignDaily={trend.foreignDaily} institutionDaily={trend.institutionDaily} />
              </div>
              <NetTrendChart
                foreignDaily={trend.foreignDaily}
                institutionDaily={trend.institutionDaily}
                indexClose={trend.indexClose}
                width={720}
                height={120}
              />
            </div>
          )}
        </PanelCard>
      </div>

      {/* 우 — 해당 시장 무버 */}
      <PanelCard borderless flat className="flex min-h-0 flex-col gap-md overflow-y-auto p-sm">
        <MoverList title="상승률 상위" rows={MOCK_TOP_GAINERS} />
        <MoverList title="하락률 상위" rows={MOCK_TOP_LOSERS} />
        <div className="flex flex-col gap-2xs">
          <h3 className="text-xs font-semibold uppercase text-fg-dim">거래대금 상위</h3>
          <ol className="flex flex-col">
            {MOCK_TOP_VALUE.slice(0, 6).map((r) => (
              <li
                key={r.code}
                className="grid grid-cols-[1fr_auto] items-center gap-xs border-b border-grid py-2xs last:border-b-0"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-fg">{r.name}</span>
                  <span className="font-data text-2xs text-fg-dim tabular-nums">{r.valueEok.toLocaleString('ko-KR')}억</span>
                </span>
                <PctText pct={r.changePct} className="text-sm" />
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-auto text-2xs text-fg-dim">무버는 선택 시장 필터가 실구현 대상(목업은 전시장 고정)</p>
      </PanelCard>
    </div>
  );
}
