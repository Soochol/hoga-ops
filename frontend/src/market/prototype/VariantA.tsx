// ============================================================================
// PROTOTYPE — throwaway. 변형 A: 지수 커맨드센터.
//
// 구조: 카드 그리드 대시보드. 1행 = 대형 지수 카드 4장(큰 숫자 + 스파크라인 +
// 등락종목수 막대), 2행 = 투자자 수급 + 섹터 온도, 3행 = 순위 3종 컴팩트 카드.
// 정보 위계: "지금 시장이 어디에 있나"(지수) → "누가 사나"(수급) → "무엇이
// 움직이나"(섹터·무버). 한눈 파악 우선, 스크롤 최소.
// ============================================================================
import { PanelCard } from '../../ui/PageShell';
import { priceDirClass } from '../../ui/priceDir';
import { heatBg } from '../../heatmap/heat';
import {
  MOCK_AS_OF, MOCK_INDICES, MOCK_INVESTOR_NET, MOCK_NET_TREND, MOCK_OPTION_SENTIMENT,
  MOCK_SECTORS, MOCK_TOP_GAINERS, MOCK_TOP_LOSERS, MOCK_TOP_VALUE,
  type MockRankRow,
} from './mockData';
import {
  AdvanceDeclineBar, NetBar, NetTrendChart, NetTrendLegend, PctText, Sparkline, fmtSigned,
} from './protoBits';

function IndexCard({ idx }: { idx: (typeof MOCK_INDICES)[number] }) {
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase text-fg-dim">{idx.label}</span>
        {idx.advance !== null && (
          <span className="font-data text-2xs text-fg-dim tabular-nums">
            <span className="text-price-up">▲{idx.advance}</span>
            {' · '}
            <span className="text-price-down">▼{idx.decline}</span>
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-sm">
        <div className="flex flex-col">
          <span className={`font-data text-xl font-semibold tabular-nums ${priceDirClass(idx.change)}`}>
            {idx.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
          </span>
          <span className={`font-data text-sm tabular-nums ${priceDirClass(idx.change)}`}>
            {fmtSigned(idx.change * 100) !== '' && `${idx.change > 0 ? '+' : ''}${idx.change.toFixed(2)}`}
            {'  '}
            <PctText pct={idx.changePct} />
          </span>
        </div>
        <Sparkline points={idx.spark} width={110} height={40} />
      </div>
      <AdvanceDeclineBar advance={idx.advance} decline={idx.decline} flat={idx.flat} />
    </PanelCard>
  );
}

function InvestorCard() {
  const max = Math.max(
    ...MOCK_INVESTOR_NET.flatMap((m) => [m.individual, m.foreign, m.institution].map(Math.abs)),
  );
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">투자자 수급 <span className="text-2xs text-fg-dim">당일 잠정 · 억원</span></h2>
      <div className="grid grid-cols-2 gap-lg">
        {MOCK_INVESTOR_NET.map((m) => (
          <div key={m.market} className="flex flex-col gap-xs">
            <span className="text-xs font-semibold text-fg-dim">{m.market === 'KOSPI' ? '코스피' : '코스닥'}</span>
            {([['개인', m.individual], ['외국인', m.foreign], ['기관', m.institution]] as const).map(
              ([label, v]) => (
                <div key={label} className="grid grid-cols-[3.5rem_1fr_4.5rem] items-center gap-sm">
                  <span className="text-xs text-fg-dim">{label}</span>
                  <NetBar value={v} max={max} />
                  <span className={`text-right font-data text-sm tabular-nums ${priceDirClass(v)}`}>
                    {fmtSigned(v)}
                  </span>
                </div>
              ),
            )}
          </div>
        ))}
      </div>
      <p className="text-2xs text-fg-dim">
        옵션 심리 — P/C(거래량) {MOCK_OPTION_SENTIMENT.pcVolumeRatio.toFixed(2)} · P/C(미결제){' '}
        {MOCK_OPTION_SENTIMENT.pcOiRatio.toFixed(2)} · max pain {MOCK_OPTION_SENTIMENT.maxPain.toFixed(1)}
      </p>
    </PanelCard>
  );
}

function SectorCard() {
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">섹터 온도 <span className="text-2xs text-fg-dim">그룹 평균 등락</span></h2>
      <div className="grid grid-cols-2 gap-x-md gap-y-2xs">
        {MOCK_SECTORS.map((s) => (
          <div
            key={s.name}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-sm rounded-sm px-sm py-2xs"
            style={{ background: heatBg(s.changePct, 0.22) }}
          >
            <span className="truncate text-sm text-fg">{s.name}</span>
            <Sparkline points={s.spark} width={44} height={14} />
            <PctText pct={s.changePct} className="w-[3.8rem] text-right text-sm" />
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

function NetTrendCard() {
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">
        수급 추세 <span className="text-2xs text-fg-dim">기관·외국인 20일 누적 순매수 · 억원 · 지수 대조</span>
      </h2>
      <div className="grid grid-cols-2 gap-lg">
        {MOCK_NET_TREND.map((t) => (
          <div key={t.market} className="flex flex-col gap-2xs">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-fg-dim">
                {t.market === 'KOSPI' ? '코스피' : '코스닥'}
              </span>
              <NetTrendLegend foreignDaily={t.foreignDaily} institutionDaily={t.institutionDaily} />
            </div>
            <NetTrendChart
              foreignDaily={t.foreignDaily}
              institutionDaily={t.institutionDaily}
              indexClose={t.indexClose}
              height={104}
            />
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

function RankCard({ title, rows }: { title: string; rows: MockRankRow[] }) {
  return (
    <PanelCard borderless flat className="flex flex-col gap-xs p-md">
      <h2 className="text-sm text-fg">{title}</h2>
      <ol className="flex flex-col">
        {rows.slice(0, 6).map((r) => (
          <li
            key={r.code}
            className="grid grid-cols-[1.2rem_1fr_5.5rem_4.2rem] items-center gap-sm border-b border-grid py-2xs last:border-b-0"
          >
            <span className="font-data text-2xs text-fg-dim tabular-nums">{r.rank}</span>
            <span className="truncate text-sm text-fg">{r.name}</span>
            <span className="text-right font-data text-sm text-fg tabular-nums">
              {r.price.toLocaleString('ko-KR')}
            </span>
            <PctText pct={r.changePct} className="text-right text-sm" />
          </li>
        ))}
      </ol>
    </PanelCard>
  );
}

export function VariantA() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-xs overflow-y-auto">
      <div className="flex items-baseline justify-between px-2xs">
        <span className="text-2xs text-fg-dim">기준 {MOCK_AS_OF} · 목업 데이터</span>
      </div>
      <div className="grid grid-cols-4 gap-xs">
        {MOCK_INDICES.map((idx) => (
          <IndexCard key={idx.id} idx={idx} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-xs">
        <InvestorCard />
        <SectorCard />
      </div>
      <NetTrendCard />
      <div className="grid grid-cols-3 gap-xs">
        <RankCard title="상승률 상위" rows={MOCK_TOP_GAINERS} />
        <RankCard title="하락률 상위" rows={MOCK_TOP_LOSERS} />
        <RankCard title="거래대금 상위" rows={MOCK_TOP_VALUE} />
      </div>
    </div>
  );
}
