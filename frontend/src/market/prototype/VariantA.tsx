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
  MOCK_AS_OF, MOCK_BREADTH, MOCK_INDICES, MOCK_KRX_SECTORS, MOCK_MARKET_FUNDS,
  MOCK_NET_TREND, MOCK_OPTION_SENTIMENT, MOCK_PROGRAM_TREND, MOCK_SECTORS,
  MOCK_STREAKS, MOCK_TOP_GAINERS, MOCK_TOP_LOSERS, MOCK_TOP_VALUE, MOCK_TREND_DATES,
  mockIndividualDaily, type MockRankRow,
} from './mockData';
import {
  AdvanceDeclineBar, BreadthTiles, DailyNetBars, NetTrendChart, NetTrendLegend, PctText,
  ProgramTrendChart, ProgramTrendLegend, Sparkline, fmtSigned,
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
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">
        투자자 수급 일별 흐름{' '}
        <span className="text-2xs text-fg-dim">20거래일 일별 순매수 · 억원 · 오늘 = 잠정 (ka10051 일자별)</span>
      </h2>
      <div className="grid grid-cols-2 gap-lg">
        {MOCK_NET_TREND.map((t) => {
          const individual = mockIndividualDaily(t);
          const last5 = MOCK_TREND_DATES.length - 5;
          return (
            <div key={t.market} className="flex flex-col gap-xs">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-fg-dim">
                  {t.market === 'KOSPI' ? '코스피' : '코스닥'}
                </span>
                <NetTrendLegend
                  foreignDaily={t.foreignDaily}
                  institutionDaily={t.institutionDaily}
                  showIndex={false}
                />
              </div>
              <DailyNetBars foreignDaily={t.foreignDaily} institutionDaily={t.institutionDaily} />
              <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
                <span>{MOCK_TREND_DATES[0]}</span>
                <span>{MOCK_TREND_DATES[MOCK_TREND_DATES.length - 1]}</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-2xs text-fg-dim">
                    <th className="py-2xs text-left font-medium">날짜</th>
                    <th className="py-2xs text-right font-medium">개인</th>
                    <th className="py-2xs text-right font-medium">외국인</th>
                    <th className="py-2xs text-right font-medium">기관</th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_TREND_DATES.slice(last5).map((d, j) => {
                    const i = last5 + j;
                    const today = i === MOCK_TREND_DATES.length - 1;
                    return (
                      <tr key={d} className="border-b border-grid last:border-b-0">
                        <td className="py-2xs font-data text-xs text-fg-dim tabular-nums">
                          {d}
                          {today && <span className="text-2xs"> 잠정</span>}
                        </td>
                        {[individual[i], t.foreignDaily[i], t.institutionDaily[i]].map((v, k) => (
                          <td
                            key={k}
                            className={`py-2xs text-right font-data text-xs tabular-nums ${priceDirClass(v)} ${today ? 'font-semibold' : ''}`}
                          >
                            {fmtSigned(v)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
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
      <h2 className="text-sm text-fg">
        섹터 온도 <span className="text-2xs text-fg-dim">좌 관심 폴더 · 우 KRX 업종(ka20003)</span>
      </h2>
      <div className="grid grid-cols-2 gap-x-md">
        <div className="flex flex-col gap-2xs">
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
        <div className="flex flex-col gap-2xs">
          {MOCK_KRX_SECTORS.map((s) => (
            <div
              key={s.name}
              className="grid grid-cols-[1fr_auto] items-center gap-sm rounded-sm px-sm py-2xs"
              style={{ background: heatBg(s.changePct, 0.22) }}
            >
              <span className="truncate text-sm text-fg">{s.name}</span>
              <PctText pct={s.changePct} className="w-[3.8rem] text-right text-sm" />
            </div>
          ))}
        </div>
      </div>
    </PanelCard>
  );
}

function ProgramCard() {
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">
        프로그램 매매 <span className="text-2xs text-fg-dim">당일 누적 · 억원 (ka90005)</span>
      </h2>
      {MOCK_PROGRAM_TREND.map((p) => (
        <div key={p.market} className="flex flex-col gap-2xs">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold text-fg-dim">
              {p.market === 'KOSPI' ? '코스피' : '코스닥'}
              {'  '}
              <span className={`font-data tabular-nums ${priceDirClass(p.totalEok)}`}>
                {fmtSigned(p.totalEok)}
              </span>
            </span>
            <ProgramTrendLegend arbDaily={p.arbDaily} nonArbDaily={p.nonArbDaily} />
          </div>
          <ProgramTrendChart arbDaily={p.arbDaily} nonArbDaily={p.nonArbDaily} height={64} />
        </div>
      ))}
    </PanelCard>
  );
}

function StreakCard() {
  return (
    <PanelCard borderless flat className="flex flex-col gap-xs p-md">
      <h2 className="text-sm text-fg">
        연속 순매수 <span className="text-2xs text-fg-dim">기관·외국인 (ka10131)</span>
      </h2>
      <ol className="flex flex-col">
        {MOCK_STREAKS.map((r) => (
          <li
            key={`${r.code}-${r.actor}`}
            className="grid grid-cols-[2.6rem_1fr_2.4rem_4.2rem] items-center gap-sm border-b border-grid py-2xs last:border-b-0"
          >
            <span className="text-2xs text-fg-dim">{r.actor}</span>
            <span className="truncate text-sm text-fg">{r.name}</span>
            <span className="text-right font-data text-sm font-semibold text-fg tabular-nums">{r.days}일</span>
            <span className={`text-right font-data text-sm tabular-nums ${priceDirClass(r.netEok)}`}>
              {fmtSigned(r.netEok)}
            </span>
          </li>
        ))}
      </ol>
    </PanelCard>
  );
}

function BreadthCard() {
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">
        시장 폭 <span className="text-2xs text-fg-dim">종목수 (ka10016·17·19)</span>
      </h2>
      {MOCK_BREADTH.map((b) => (
        <div key={b.market} className="flex flex-col gap-2xs">
          <span className="text-xs font-semibold text-fg-dim">
            {b.market === 'KOSPI' ? '코스피' : '코스닥'}
          </span>
          <BreadthTiles {...b} />
        </div>
      ))}
      <p className="text-2xs text-fg-dim">
        신고·신저 격차가 등락종목수(TR 공백)의 대용 지표 — 격차 축소는 추세 약화 신호.
      </p>
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

/** 계열 색 — 남은 MA 슬롯 사용 (수급 --ma-3/4 · 프로그램 --ma-6/7 과 안 겹치게) */
const FUND_COLORS = ['var(--ma-1)', 'var(--ma-2)', 'var(--ma-8)'];

function FundsCard() {
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <h2 className="text-sm text-fg">
        증시 주변 자금{' '}
        <span className="text-2xs text-fg-dim">조원 · {MOCK_MARKET_FUNDS.asOf} 기준(T+2)</span>
      </h2>
      <div className="flex flex-col gap-xs">
        {MOCK_MARKET_FUNDS.series.map((s, i) => {
          const last = s.values[s.values.length - 1];
          const prev = s.values[s.values.length - 2];
          const delta = Number((last - prev).toFixed(1));
          return (
            <div key={s.label} className="grid grid-cols-[4.6rem_1fr_auto] items-center gap-sm">
              <span className="flex items-center gap-2xs text-xs text-fg-dim">
                <span className="inline-block h-[2px] w-[10px]" style={{ background: FUND_COLORS[i] }} />
                {s.label}
              </span>
              <Sparkline points={s.values} width={90} height={22} strokeVar={FUND_COLORS[i]} />
              <span className="text-right font-data text-sm tabular-nums">
                <span className="font-semibold text-fg">{last.toFixed(1)}조</span>{' '}
                <span className={priceDirClass(delta)}>
                  {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-2xs text-fg-dim">
        키움 TR 없음 — 금융투자협회(KOFIA) 공시, 공공데이터포털 오픈 API. 일 1회 · T+2 지연.
      </p>
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
      <div className="grid grid-cols-4 gap-xs">
        <ProgramCard />
        <StreakCard />
        <BreadthCard />
        <FundsCard />
      </div>
      <div className="grid grid-cols-3 gap-xs">
        <RankCard title="상승률 상위" rows={MOCK_TOP_GAINERS} />
        <RankCard title="하락률 상위" rows={MOCK_TOP_LOSERS} />
        <RankCard title="거래대금 상위" rows={MOCK_TOP_VALUE} />
      </div>
    </div>
  );
}
