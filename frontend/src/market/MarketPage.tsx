/** 시장 종합 — 지수 커맨드센터 (#1102).
 *
 * 프로토타입 A 변형(`market/prototype/VariantA.tsx`)의 확정 구성을 실데이터로 옮긴 것이다.
 * 목업이 감추고 있던 두 가지가 여기서 드러난다:
 *
 * **① 값은 없을 수 있다.** 부분 실패(한 시장만 실패)·미수집(수집기가 늦게 뜸)·무자격
 * (KOFIA 키 없음)이 전부 정상 경로다. 그래서 `null` 을 0 으로 채우지 않고 `—` 로
 * 그린다 — 0 으로 채우면 "그날 예탁금이 0" 같은 거짓말이 된다.
 *
 * **② 없음에도 종류가 있다.** 지수 상품의 등락종목수는 **벤더에 값이 없어서**가 아니라
 * 표시 규칙상 안 붙이는 것이고(#1100), 확정 이력이 빈 것은 **아직 쌓이는 중**이며,
 * 자금 카드가 빈 것은 **키가 없어서**다. 셋을 같은 빈 화면으로 보이면 진단이 흐려진다.
 */
import { useState } from 'react';
import { useLiveIndexCandles } from '../api/liveIndices';
import { useMarketIndexQuotes } from '../api/marketIndexQuotes';
import {
  useMarketBreadth,
  useMarketFunds,
  useMarketInvestorFlow,
  useMarketProgram,
  useMarketSectors,
  useMarketStreaks,
  type ProgramAxis,
} from '../api/market';
import { useLiveRankings } from '../api/liveRankings';
import { heatBg } from '../heatmap/heat';
import { useJumpToLive } from '../live/useJumpToLive';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import type { LiveIndexId } from '../live/liveInstrument';
import { PageContainer } from '../layout/PageContainer';
// PROTOTYPE(throwaway) — 레이아웃 변형 평가용 import. 확정 시 제거.
import {
  LayoutSwitcher,
  VariantCentered,
  VariantSplit,
  VariantZones,
} from './layoutPrototype/LayoutVariants';
import { useLayoutVariant } from './layoutPrototype/layoutVariantState';
import { PanelCard, SegmentedControl } from '../ui/PageShell';
import { priceDirClass } from '../ui/priceDir';
import {
  AdvanceDeclineBar,
  BreadthTile,
  ComboNetChart,
  CumLinesChart,
  LegendItem,
  PctText,
  Sparkline,
} from './marketBits';
import { SERIES_COLORS, fmtSigned, wonToJo } from './marketFormat';

/** 카드 헤더의 밀도 우선 토글 — 좁은 카드에서 줄바꿈되도록 헤더가 flex-wrap 이다. */
function ModeSwitch<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  label: string;
}) {
  return (
    <SegmentedControl aria-label={label}>
      {options.map(([key, text]) => {
        const on = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(key)}
            className={`whitespace-nowrap px-2 py-[2px] font-data text-2xs tabular-nums ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
          >
            {text}
          </button>
        );
      })}
    </SegmentedControl>
  );
}

function CardHeader({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-sm gap-y-2xs">
      <h2 className="text-sm text-fg">
        {title} {hint && <span className="text-2xs text-fg-dim">{hint}</span>}
      </h2>
      {right}
    </div>
  );
}

/** 빈 상태 — **왜 비었는지**를 말한다. 같은 회색 박스로 뭉뚱그리지 않는다. */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-sm text-center text-xs text-fg-dim">{children}</p>;
}

// ── 지수 카드 ─────────────────────────────────────────────────────────────

const MARKET_KEY_BY_INDEX: Record<string, string> = { KOSPI: '0', KOSDAQ: '1' };

export function IndexCards() {
  const quotes = useMarketIndexQuotes();
  const sectors = useMarketSectors();

  if (quotes.isLoading) return null;
  const rows = quotes.data ?? [];
  if (rows.length === 0) {
    return (
      <PanelCard borderless flat className="p-md">
        <EmptyNote>지수 시세를 받지 못했습니다 — 키움 자격증명을 확인하세요.</EmptyNote>
      </PanelCard>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-xs">
      {rows.slice(0, 4).map((q) => (
        <IndexCard key={q.id} quote={q} sectors={sectors.data} />
      ))}
    </div>
  );
}

/** 지수 카드 1장. **카드가 컴포넌트여야** 분봉 훅을 카드마다 부를 수 있다 —
 *  리스트 안에서 훅을 부르면 순서 규칙을 깬다. */
function IndexCard({
  quote,
  sectors,
}: {
  quote: ReturnType<typeof useMarketIndexQuotes>['data'] extends (infer T)[] | undefined ? T : never;
  sectors: ReturnType<typeof useMarketSectors>['data'];
}) {
  const today = todayKstYyyymmdd();
  // 당일 1분봉 — 종가 배열이 곧 스파크라인이다. 지수당 1콜이고 ka20005 는 자기
  // 버킷(5 req/s)을 쓰므로 4장이 다른 표면과 경합하지 않는다.
  const candles = useLiveIndexCandles(quote.id as LiveIndexId, '1m', today, today);
  const bars = candles.data?.candles ?? [];
  const closes = bars.map((c) => c.close);
  // 당일 시가 — 색 기준. 큰 숫자(전일 대비)와 색이 갈릴 수 있고 그게 의도다.
  const dayOpen = bars[0]?.open;

  // 등락종목수는 종합지수(코스피·코스닥)에만 붙는다 — 지수 상품은 부재가 정상(#1100).
  const mkey = MARKET_KEY_BY_INDEX[quote.id];
  const breadth = mkey ? sectors?.markets[mkey]?.index : undefined;

  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase text-fg-dim">{quote.label}</span>
        {breadth?.rising != null && breadth.falling != null && (
          <span className="font-data text-2xs text-fg-dim tabular-nums">
            <span className="text-price-up">▲{breadth.rising}</span>
            {' · '}
            <span className="text-price-down">▼{breadth.falling}</span>
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-sm">
        <div className="flex flex-col">
          <span className={`font-data text-xl font-semibold tabular-nums ${priceDirClass(quote.change)}`}>
            {quote.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
          </span>
          <span className={`font-data text-sm tabular-nums ${priceDirClass(quote.change)}`}>
            {quote.change > 0 ? '+' : ''}
            {quote.change.toFixed(2)} <PctText pct={quote.changeRate} />
          </span>
        </div>
        {/* 분봉이 아직 없거나 실패하면 그냥 안 그린다 — 한 점짜리 선은 거짓 정보다. */}
        <Sparkline points={closes} baseline={dayOpen} />
      </div>
      {breadth && (
        <AdvanceDeclineBar rising={breadth.rising} falling={breadth.falling} flat={breadth.flat} />
      )}
    </PanelCard>
  );
}

// ── 투자자 수급 ───────────────────────────────────────────────────────────

const MARKET_LABELS: Record<string, string> = { KOSPI: '코스피', KOSDAQ: '코스닥' };

export function InvestorCard() {
  const [mode, setMode] = useState<'intraday' | 'daily'>('intraday');
  const flow = useMarketInvestorFlow();
  const data = flow.data;
  const cov = data?.coverage;

  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <CardHeader
        title="투자자 수급"
        hint={
          mode === 'intraday'
            ? `당일 누적 · 억원 · 잠정${cov ? ` · 표본 ${cov.sample_count}/${cov.expected_count ?? '—'}` : ''}`
            : '일별 확정 · 억원'
        }
        right={
          <ModeSwitch
            value={mode}
            onChange={setMode}
            options={[
              ['intraday', '당일'],
              ['daily', '일별'],
            ] as const}
            label="수급 표시 구간"
          />
        }
      />
      {mode === 'intraday' && <IntradayFlow data={data} loading={flow.isLoading} />}
      {mode === 'daily' && <DailyFlow data={data} />}
    </PanelCard>
  );
}

function IntradayFlow({
  data,
  loading,
}: {
  data: ReturnType<typeof useMarketInvestorFlow>['data'];
  loading: boolean;
}) {
  if (loading) return null;
  const markets = data?.markets ?? {};
  if (Object.keys(markets).length === 0) {
    // 수집기가 아직 표본을 안 남겼거나 장 시작 전이다 — "실패" 가 아니다.
    return <EmptyNote>오늘 표본이 아직 없습니다. 장중 수집이 시작되면 채워집니다.</EmptyNote>;
  }
  return (
    <div className="grid grid-cols-2 gap-lg">
      {Object.entries(markets).map(([label, points]) => {
        const actors = [
          ['개인', SERIES_COLORS.individual, points.map((p) => p.individual)],
          ['외국인', SERIES_COLORS.foreign, points.map((p) => p.foreign)],
          ['기관', SERIES_COLORS.institution, points.map((p) => p.institution)],
        ] as const;
        const last = points[points.length - 1];
        return (
          <div key={label} className="flex flex-col gap-2xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-sm">
              <span className="text-xs font-semibold text-fg-dim">{MARKET_LABELS[label] ?? label}</span>
              <span className="flex items-center gap-md font-data text-2xs tabular-nums">
                <LegendItem color={SERIES_COLORS.individual} label="개인" value={last?.individual ?? null} />
                <LegendItem color={SERIES_COLORS.foreign} label="외국인" value={last?.foreign ?? null} />
                <LegendItem color={SERIES_COLORS.institution} label="기관" value={last?.institution ?? null} />
              </span>
            </div>
            {/* 벤더가 **누적**을 주므로 그대로 그린다 — 여기서 다시 누적하면 이중이다.
                CumLinesChart 는 delta 를 받으므로 첫 점만 값, 이후는 차분으로 넘긴다. */}
            <CumLinesChart
              series={actors.map(([, color, vals]) => ({
                color,
                values: vals.map((v, i) => (i === 0 ? v : (v ?? 0) - (vals[i - 1] ?? 0))),
              }))}
              height={96}
            />
            <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
              <span>{points[0] ? new Date(points[0].t_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}</span>
              <span>{last ? new Date(last.t_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DailyFlow({ data }: { data: ReturnType<typeof useMarketInvestorFlow>['data'] }) {
  const daily = data?.daily ?? [];
  if (daily.length === 0) {
    // 장중 표본과 달리 확정본은 뒤늦게도 채워진다(base_dt 랜덤 액세스) — "쌓이는 중" 이다.
    return <EmptyNote>확정 이력이 아직 없습니다. 장 마감 뒤 일일 배치가 하루씩 채웁니다.</EmptyNote>;
  }
  return (
    <div className="grid grid-cols-2 gap-lg">
      {Object.values(MARKET_LABELS).map((_, idx) => {
        const key = idx === 0 ? 'KOSPI' : 'KOSDAQ';
        const foreign = daily.map((d) => d.markets[key]?.foreign ?? null);
        const inst = daily.map((d) => d.markets[key]?.institution ?? null);
        return (
          <div key={key} className="flex flex-col gap-2xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-sm">
              <span className="text-xs font-semibold text-fg-dim">{MARKET_LABELS[key]}</span>
              <span className="flex items-center gap-md font-data text-2xs tabular-nums">
                <LegendItem color={SERIES_COLORS.foreign} label="외국인" />
                <LegendItem color={SERIES_COLORS.institution} label="기관" />
              </span>
            </div>
            <ComboNetChart
              a={{ color: SERIES_COLORS.foreign, values: foreign }}
              b={{ color: SERIES_COLORS.institution, values: inst }}
            />
            <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
              <span>{daily[0]?.date.slice(4, 6)}/{daily[0]?.date.slice(6)}</span>
              <span>
                {daily[daily.length - 1]?.date.slice(4, 6)}/{daily[daily.length - 1]?.date.slice(6)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 섹터 온도 (KRX 업종) ─────────────────────────────────────────────────

export function SectorCard() {
  const sectors = useMarketSectors();
  const kospi = sectors.data?.markets['0']?.sectors ?? [];
  const kosdaq = sectors.data?.markets['1']?.sectors ?? [];
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-md">
      <CardHeader title="업종 온도" hint="KRX 업종지수 등락률" />
      {kospi.length === 0 && kosdaq.length === 0 ? (
        <EmptyNote>업종 데이터를 받지 못했습니다.</EmptyNote>
      ) : (
        <div className="grid grid-cols-2 gap-x-md">
          {[kospi, kosdaq].map((list, i) => (
            <div key={i} className="flex flex-col gap-2xs">
              <span className="text-xs font-semibold text-fg-dim">{i === 0 ? '코스피' : '코스닥'}</span>
              {list.slice(0, 12).map((s) => (
                <div
                  key={s.code}
                  className="grid grid-cols-[1fr_auto] items-center gap-sm rounded-sm px-sm py-2xs"
                  style={{ background: heatBg(s.change_pct) }}
                >
                  <span className="truncate text-sm text-fg">{s.name}</span>
                  <PctText pct={s.change_pct} className="w-[3.8rem] text-right text-sm" />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

// ── 프로그램 매매 ────────────────────────────────────────────────────────

export function ProgramCard() {
  const [axis, setAxis] = useState<ProgramAxis>('intraday');
  const program = useMarketProgram(axis);
  const markets = program.data?.markets ?? {};
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-sm">
      <CardHeader
        title="프로그램"
        hint={axis === 'intraday' ? '당일 누적 · 억원' : '일별 · 억원'}
        right={
          <ModeSwitch
            value={axis}
            onChange={setAxis}
            options={[
              ['intraday', '당일'],
              ['daily', '일별'],
            ] as const}
            label="프로그램 표시 구간"
          />
        }
      />
      {Object.keys(markets).length === 0 ? (
        <EmptyNote>프로그램 매매 데이터를 받지 못했습니다.</EmptyNote>
      ) : (
        Object.entries(markets).map(([label, points]) => {
          // 벤더가 최신 우선 역순으로 준다 — 시간축으로 그리려면 뒤집는다.
          const asc = [...points].reverse();
          const arb = asc.map((p) => p.arb_net);
          const nonArb = asc.map((p) => p.non_arb_net);
          const total = asc[asc.length - 1]?.total_net ?? null;
          return (
            <div key={label} className="flex flex-col gap-2xs">
              <div className="flex flex-wrap items-baseline justify-between gap-x-sm">
                <span className="text-xs font-semibold text-fg-dim">
                  {MARKET_LABELS[label] ?? label}{' '}
                  <span className={`font-data tabular-nums ${total === null ? 'text-fg-dim' : priceDirClass(total)}`}>
                    {fmtSigned(total)}
                  </span>
                </span>
                <span className="flex items-center gap-md font-data text-2xs tabular-nums">
                  <LegendItem color={SERIES_COLORS.arb} label="차익" />
                  <LegendItem color={SERIES_COLORS.nonArb} label="비차익" />
                </span>
              </div>
              <ComboNetChart
                a={{ color: SERIES_COLORS.arb, values: arb }}
                b={{ color: SERIES_COLORS.nonArb, values: nonArb }}
                height={56}
              />
            </div>
          );
        })
      )}
    </PanelCard>
  );
}

// ── 순매수 상위 (주체별 2카드) ───────────────────────────────────────────

export function ActorNetCard({ actor }: { actor: '외국인' | '기관' }) {
  const jump = useJumpToLive();
  const streaks = useMarketStreaks();
  const rows = streaks.data?.[actor] ?? [];
  const accent = actor === '외국인' ? SERIES_COLORS.foreign : SERIES_COLORS.institution;
  return (
    <PanelCard borderless flat className="flex flex-col gap-xs p-sm">
      <h2 className="flex items-center gap-2xs text-sm text-fg">
        <span className="inline-block h-[2px] w-[10px]" style={{ background: accent }} />
        {actor} 순매수 <span className="text-2xs text-fg-dim">연속 · 억원</span>
      </h2>
      {rows.length === 0 ? (
        <EmptyNote>연속 순매수 종목이 없습니다.</EmptyNote>
      ) : (
        <ol className="flex flex-col">
          {rows.slice(0, 8).map((r) => (
            <li key={r.code} className="border-b border-grid last:border-b-0">
              <button
                type="button"
                onClick={(e) => jump(r.code, r.name, e)}
                title={`${r.name} 라이브 차트로 (ctrl/⌘ = 새 탭)`}
                className="grid w-full grid-cols-[1fr_2.6rem_3.8rem] items-center gap-xs py-2xs text-left hover:bg-bg-input-hover"
              >
                <span className="truncate text-sm text-fg">{r.name}</span>
                <span className="text-right font-data text-sm font-semibold text-fg tabular-nums">
                  {r.streak_days}일
                </span>
                <span
                  className={`text-right font-data text-sm tabular-nums ${r.streak_net_amt === null ? 'text-fg-dim' : priceDirClass(r.streak_net_amt)}`}
                >
                  {fmtSigned(r.streak_net_amt)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </PanelCard>
  );
}

// ── 시장 폭 · 증시 주변 자금 ─────────────────────────────────────────────

export function BreadthCard() {
  const breadth = useMarketBreadth();
  const markets = breadth.data?.markets ?? {};
  return (
    <PanelCard borderless flat className="flex flex-col gap-sm p-sm">
      <CardHeader title="시장 폭" hint="종목수" />
      {Object.keys(markets).length === 0 ? (
        <EmptyNote>시장 폭 데이터를 받지 못했습니다.</EmptyNote>
      ) : (
        Object.entries(markets).map(([label, b]) => (
          <div key={label} className="flex flex-col gap-2xs">
            <span className="text-xs font-semibold text-fg-dim">{MARKET_LABELS[label] ?? label}</span>
            <div className="grid grid-cols-4 gap-2xs">
              <BreadthTile label="52주 신고" count={b.new_high_52w?.count ?? null} truncated={b.new_high_52w?.truncated} dir="up" />
              <BreadthTile label="52주 신저" count={b.new_low_52w?.count ?? null} truncated={b.new_low_52w?.truncated} dir="down" />
              <BreadthTile label="급등" count={b.surge?.count ?? null} truncated={b.surge?.truncated} dir="up" />
              <BreadthTile label="급락" count={b.plunge?.count ?? null} truncated={b.plunge?.truncated} dir="down" />
            </div>
          </div>
        ))
      )}
    </PanelCard>
  );
}

export function FundsCard() {
  const funds = useMarketFunds();
  const data = funds.data;
  const series = data?.series ?? [];
  const last = series[series.length - 1];
  const asOf = data?.as_of;
  return (
    <PanelCard borderless flat className="flex flex-col gap-xs p-sm">
      <CardHeader
        title="증시 주변 자금"
        // 기준일은 **응답에서** 온다 — "T+2" 를 고정 문구로 박지 않는다(#1098).
        hint={asOf ? `조원 · ${asOf.slice(4, 6)}/${asOf.slice(6)} 기준` : '조원'}
      />
      {data?.unavailable === 'credentials_missing' ? (
        <EmptyNote>KOFIA 인증키가 설정되지 않았습니다(.env: KOFIA_API_KEY).</EmptyNote>
      ) : series.length === 0 ? (
        <EmptyNote>자금 데이터를 받지 못했습니다.</EmptyNote>
      ) : (
        <>
          <CumLinesChart
            series={[
              { color: SERIES_COLORS.deposit, values: diffs(series.map((r) => wonToJo(r.deposit_won))) },
              { color: SERIES_COLORS.credit, values: diffs(series.map((r) => wonToJo(r.credit_won))) },
              { color: SERIES_COLORS.cma, values: diffs(series.map((r) => wonToJo(r.cma_won))) },
            ]}
            height={72}
          />
          <div className="flex flex-col">
            {(
              [
                ['고객예탁금', SERIES_COLORS.deposit, last?.deposit_won],
                ['신용융자', SERIES_COLORS.credit, last?.credit_won],
                ['CMA', SERIES_COLORS.cma, last?.cma_won],
              ] as const
            ).map(([label, color, won]) => (
              <div key={label} className="grid grid-cols-[1fr_auto] items-center gap-sm border-b border-grid py-2xs last:border-b-0">
                <LegendItem color={color} label={label} />
                <span className="font-data text-sm font-semibold text-fg tabular-nums">
                  {won == null ? '—' : `${(won / 1e12).toFixed(1)}조`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </PanelCard>
  );
}

/** 잔고(스톡) 계열 → 기간 시작 대비 증감의 delta 배열. 누적하면 level - start 가 된다. */
function diffs(values: (number | null)[]): (number | null)[] {
  return values.map((v, i) => (i === 0 ? 0 : (v ?? 0) - (values[i - 1] ?? 0)));
}

// ── 순위 3종 ──────────────────────────────────────────────────────────────

export function RankCard({
  title,
  kind,
  direction,
}: {
  title: string;
  kind: 'change' | 'value';
  direction: 'up' | 'down';
}) {
  const jump = useJumpToLive();
  const q = useLiveRankings({ kind, market: 'all', direction, excludeEtf: true });
  const rows = q.data?.rows ?? [];
  return (
    <PanelCard borderless flat className="flex flex-col gap-xs p-md">
      <h2 className="text-sm text-fg">{title}</h2>
      {rows.length === 0 ? (
        <EmptyNote>{q.data && !q.data.marketOpen ? '장 마감 — 순위는 장중에만 갱신됩니다.' : '순위를 받지 못했습니다.'}</EmptyNote>
      ) : (
        <ol className="flex flex-col">
          {rows.slice(0, 6).map((r) => (
            <li key={r.code} className="border-b border-grid last:border-b-0">
              <button
                type="button"
                onClick={(e) => jump(r.code, r.name, e)}
                title={`${r.name} 라이브 차트로 (ctrl/⌘ = 새 탭)`}
                className="grid w-full grid-cols-[1.2rem_1fr_5.5rem_4.2rem] items-center gap-sm py-2xs text-left hover:bg-bg-input-hover"
              >
                <span className="font-data text-2xs text-fg-dim tabular-nums">{r.rank}</span>
                <span className="truncate text-sm text-fg">{r.name}</span>
                <span className="text-right font-data text-sm text-fg tabular-nums">
                  {r.price === null ? '—' : r.price.toLocaleString('ko-KR')}
                </span>
                <PctText pct={r.change_pct} className="text-right text-sm" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </PanelCard>
  );
}

/** 현행 배치 — 레이아웃 프로토타입의 대조군. */
export function CurrentLayout() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-xs overflow-y-auto">
        <IndexCards />
        <div className="grid grid-cols-2 gap-xs">
          <InvestorCard />
          <SectorCard />
        </div>
        <div className="grid grid-cols-[1.15fr_1fr_1fr_1.05fr_1.2fr] gap-xs">
          <ProgramCard />
          <ActorNetCard actor="외국인" />
          <ActorNetCard actor="기관" />
          <BreadthCard />
          <FundsCard />
        </div>
        <div className="grid grid-cols-3 gap-xs">
          <RankCard title="상승률 상위" kind="change" direction="up" />
          <RankCard title="하락률 상위" kind="change" direction="down" />
          <RankCard title="거래대금 상위" kind="value" direction="up" />
        </div>
    </div>
  );
}

export function MarketPage() {
  // PROTOTYPE(throwaway) — 레이아웃 변형 평가 중 (?variant=a|b|c, layoutPrototype/).
  // 확정되면 승자를 CurrentLayout 자리에 접고 이 분기와 layoutPrototype/ 을 지운다.
  const variant = useLayoutVariant();
  return (
    <PageContainer>
      {variant === 'current' && <CurrentLayout />}
      {variant === 'a' && <VariantCentered />}
      {variant === 'b' && <VariantZones />}
      {variant === 'c' && <VariantSplit />}
      <LayoutSwitcher />
    </PageContainer>
  );
}

export default MarketPage;
