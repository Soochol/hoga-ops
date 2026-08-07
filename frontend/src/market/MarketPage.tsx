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
import { SectorFlowCard } from './SectorFlowCard';
import { useLiveIndexCandles } from '../api/liveIndices';
import {
  useMarketFutures,
  useMarketFuturesCandles,
  type FuturesQuote,
  type FuturesQuotesSnapshot,
  type FuturesSpark,
} from '../api/marketFutures';
import { useMarketIndexQuotes } from '../api/marketIndexQuotes';
import {
  useMarketFunds,
  useMarketInvestorFlow,
  useMarketProgram,
  useMarketSectors,
  useMarketStreaks,
  type MarketVolatility,
  type ProgramAxis,
} from '../api/market';
import { useLiveRankings } from '../api/liveRankings';
import { heatBg } from '../heatmap/heat';
import { useJumpToLive } from '../live/useJumpToLive';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import type { LiveIndexId } from '../live/liveInstrument';
import { PageContainer } from '../layout/PageContainer';
import { persistJson, readJsonObject } from '../state/persist';
import { CARD_HEADER_RULE, CardHeader, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import { priceDirClass } from '../ui/priceDir';
import {
  AdvanceDeclineBar,
  ComboNetChart,
  CumLinesChart,
  LegendItem,
  PctText,
  SessionAxisLabels,
  SessionLinesChart,
  Sparkline,
} from './marketBits';
import { SERIES_COLORS, fmtSigned, stockSeriesDiffs, wonToJo } from './marketFormat';

// ── 지수 카드 ─────────────────────────────────────────────────────────────

const MARKET_KEY_BY_INDEX: Record<string, string> = { KOSPI: '0', KOSDAQ: '1' };

/** 카드가 현물을 보여주는가 선물을 보여주는가. */
type CardMode = 'spot' | 'futures';

const CARD_MODE_KEY = 'market.indexCardMode.v1';
const CARD_MODES: ReadonlyArray<readonly [CardMode, string]> = [
  ['spot', '현물'],
  ['futures', '선물'],
];

/** 카드별 현물/선물 선택 — 카드마다 독립이고 새로고침을 넘어 유지된다.
 *
 *  **저장할 때 반드시 다시 읽어 병합한다.** 카드마다 훅 인스턴스가 따로라, 마운트
 *  시점의 스냅샷을 들고 쓰면 마지막에 누른 카드가 다른 카드의 선택을 덮어쓴다. */
function useCardMode(id: string): [CardMode, (next: CardMode) => void] {
  const [mode, setMode] = useState<CardMode>(() =>
    readJsonObject(CARD_MODE_KEY)[id] === 'futures' ? 'futures' : 'spot',
  );
  const update = (next: CardMode) => {
    setMode(next);
    persistJson(CARD_MODE_KEY, { ...readJsonObject(CARD_MODE_KEY), [id]: next });
  };
  return [mode, update];
}

/** 이 카드의 값이 지금 세션의 것이 아니면 그 사실을 문구로. null 이면 최신이다.
 *
 *  **카드마다 따로 판정한다.** 야간엔 유동성에 따라 종목별로 갈리기 때문이다 —
 *  KOSPI200 은 WS 틱이 붙어 실시간인데 코스닥150 은 무음이라 주간 마감본일 수 있다.
 *  스냅샷 하나로 판정하면 둘 중 하나는 반드시 틀린 배지를 단다. */
function stalenessNote(
  future: FuturesQuote,
  snapshot: FuturesQuotesSnapshot | undefined,
): string | null {
  if (!snapshot || snapshot.session === future.dataSession) return null;
  return snapshot.session === 'night' ? '주간 마감값' : '장 마감';
}

/** 베이시스·괴리율용 소수 2자리 부호 표기.
 *
 *  `fmtSigned` 를 쓰면 안 된다 — 그쪽은 `Math.round` 라 베이시스 −1.77 이 −2 가 되어
 *  콘탱고/백워데이션의 크기 정보가 통째로 죽는다. */
function fmtBasis(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** `"0200"` → `"02:00"`. */
function fmtHhmm(hhmm: string): string {
  return hhmm.length === 4 ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
}

/** 야간 스파크라인이 **무엇을 덮는지**. 온전하면 null — 조용해도 되는 상태다.
 *
 *  스파크라인은 x 를 시각이 아니라 **인덱스**로 잡는다(`marketBits.Sparkline`).
 *  그래서 18:00 부터 8시간을 그린 선과 02:00 부터 10분을 그린 선이 화면에서
 *  똑같이 카드를 채운다 — 앞이 잘렸다는 사실은 글자로만 말할 수 있다.
 *
 *  야간 봉은 프로세스 메모리에만 있고 소급 조회 경로가 없어서(WS 는 "지금부터" 만
 *  준다) 재시작·유휴 정지로 잘린 구간은 **복구가 아니라 고백**이 유일한 대응이다. */
function coverageNote(spark: FuturesSpark | undefined): string | null {
  if (!spark || spark.session !== 'night' || !spark.coverage) return null;
  const { firstHhmm, gapCount } = spark.coverage;
  // 18:00 부터 끊김 없이 봤으면 굳이 말하지 않는다 — 정상을 알리는 문구는 소음이다.
  if (firstHhmm === '1800' && gapCount === 0) return null;
  const from = `${fmtHhmm(firstHhmm)}~`;
  return gapCount > 0 ? `${from} 끊김 ${gapCount}곳` : from;
}

/** 선물 카드의 부가 정보 한 줄 — 베이시스·만기·그림 커버리지. 선물을 보는 이유 자체다. */
function FuturesMeta({
  future,
  snapshot,
  spark,
}: {
  future: FuturesQuote;
  snapshot: FuturesQuotesSnapshot | undefined;
  spark: FuturesSpark | undefined;
}) {
  const stale = stalenessNote(future, snapshot);
  const coverage = coverageNote(spark);
  return (
    <div className="flex flex-wrap items-baseline gap-x-xs font-data text-2xs tabular-nums text-fg-dim">
      <span>
        베이시스{' '}
        <span className={priceDirClass(future.marketBasis ?? 0)}>
          {fmtBasis(future.marketBasis)}
        </span>
      </span>
      {future.daysLeft != null && <span>· D-{future.daysLeft}</span>}
      {stale && <span className="text-fg-dimmer">· {stale}</span>}
      {coverage && (
        <span
          className="text-fg-dimmer"
          title="야간 그림이 덮는 구간. 서버 재시작·유휴 정지로 앞이 잘리면 복구할 수 없다."
        >
          · {coverage}
        </span>
      )}
    </div>
  );
}

export function IndexCards() {
  const quotes = useMarketIndexQuotes();
  const sectors = useMarketSectors();
  const futures = useMarketFutures();
  const futuresSparks = useMarketFuturesCandles();

  if (quotes.isLoading) return null;
  const rows = quotes.data ?? [];
  if (rows.length === 0) {
    return (
      <MarketCard className="p-md">
        {/* 원인을 단정하지 않는다 — "자격증명" 으로 못박았다가 실제 원인(마감 후
            tm_n 센티넬 파싱 실패)을 오래 못 찾았다(2026-08-05). */}
        <EmptyNote>지수 시세를 받지 못했습니다. 잠시 후 다시 시도합니다.</EmptyNote>
      </MarketCard>
    );
  }

  const snapshot = futures.data;
  const futureByUnderlying = new Map(
    (snapshot?.quotes ?? [])
      .filter((f): f is FuturesQuote & { underlyingId: string } => f.underlyingId !== null)
      .map((f) => [f.underlyingId, f]),
  );
  // 변동성지수는 현물 지수 카드도 선물 토글도 없는 단독 카드다. 소스는 **키움
  // ka20003 의 업종행 603** 이다 — 예전엔 KIS 선물(A04608)이었는데 그 상품은 당일
  // 거래량 0·미결제 54계약이라 값이 정산가에 굳어 장중 내내 안 움직였다(2026-08-07).
  const volatility = sectors.data?.volatility ?? null;
  // Tailwind 는 런타임에 조합한 클래스명을 만들지 못한다 — 두 리터럴을 그대로 둔다.
  const cols = volatility ? 'grid-cols-5' : 'grid-cols-4';

  return (
    <div className={`grid ${cols} gap-md`}>
      {rows.slice(0, 4).map((q) => {
        const future = futureByUnderlying.get(q.id);
        return (
          <IndexCard
            key={q.id}
            quote={q}
            sectors={sectors.data}
            future={future}
            snapshot={snapshot}
            futureSpark={future ? futuresSparks.data?.[future.id] : undefined}
          />
        );
      })}
      {volatility && <VolatilityCard row={volatility} />}
    </div>
  );
}

/** 변동성지수(VKOSPI) 카드. 현물 토글도 스파크라인도 없다 — ka20003 은 지수 **레벨과
 *  등락률만** 주고, 등락폭을 등락률에서 역산하면 표시용 근사를 진짜 값처럼 보이게 한다.
 *  없는 것을 만들어 채우느니 있는 두 값만 보여준다. */
function VolatilityCard({ row }: { row: MarketVolatility }) {
  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <div className={`flex items-baseline justify-between ${CARD_HEADER_RULE}`}>
        <span className="text-xs font-semibold uppercase text-fg-dim">VKOSPI</span>
      </div>
      <div className="flex flex-col">
        <span
          className={`font-data text-xl font-semibold tabular-nums ${priceDirClass(row.change_pct ?? 0)}`}
        >
          {row.value === null
            ? '—'
            : row.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
        </span>
        {/* 5열이 되면 마지막 카드가 우측 레일에 가려 가장 좁아진다 — nowrap 이 없으면
            거기서만 등락률이 두 줄로 접힌다. */}
        <span
          className={`whitespace-nowrap font-data text-sm tabular-nums ${priceDirClass(row.change_pct ?? 0)}`}
        >
          <PctText pct={row.change_pct} />
        </span>
      </div>
    </MarketCard>
  );
}

/** 지수 카드 1장. **카드가 컴포넌트여야** 분봉 훅을 카드마다 부를 수 있다 —
 *  리스트 안에서 훅을 부르면 순서 규칙을 깬다. */
function IndexCard({
  quote,
  sectors,
  future,
  snapshot,
  futureSpark,
}: {
  quote: ReturnType<typeof useMarketIndexQuotes>['data'] extends (infer T)[] | undefined ? T : never;
  sectors: ReturnType<typeof useMarketSectors>['data'];
  /** 대응 선물. 없으면 토글 자체를 그리지 않는다(코스피·코스닥 종합엔 선물이 없다). */
  future: FuturesQuote | undefined;
  snapshot: FuturesQuotesSnapshot | undefined;
  /** 선물 모드의 스파크라인. 현물 분봉(키움)과 벤더가 달라 별도로 들어온다. */
  futureSpark: FuturesSpark | undefined;
}) {
  const [mode, setMode] = useCardMode(quote.id);
  const today = todayKstYyyymmdd();
  // 당일 1분봉 — 종가 배열이 곧 스파크라인이다. 지수당 1콜이고 ka20005 는 자기
  // 버킷(5 req/s)을 쓰므로 4장이 다른 표면과 경합하지 않는다.
  const candles = useLiveIndexCandles(quote.id as LiveIndexId, '1m', today, today);
  const bars = candles.data?.candles ?? [];
  const closes = bars.map((c) => c.close);
  // 당일 시가 — 색 기준. 큰 숫자(전일 대비)와 색이 갈릴 수 있고 그게 의도다.
  const dayOpen = bars[0]?.open;

  // 등락종목수는 종합지수(코스피·코스닥)에만 붙는다 — 지수 상품은 부재가 정상(#1100).
  // 그래서 헤더 우측이 비는 카드가 정확히 선물이 있는 카드다. 토글이 그 자리를 쓴다.
  const mkey = MARKET_KEY_BY_INDEX[quote.id];
  const breadth = mkey ? sectors?.markets[mkey]?.index : undefined;

  // 선물 값이 아직 없으면 현물로 되돌린다 — 토글은 눌리는데 카드가 비는 상태를
  // 만들지 않는다. 저장된 선택은 건드리지 않으므로 데이터가 오면 알아서 복귀한다.
  const showFutures = future != null && mode === 'futures';
  const shown = showFutures
    ? { value: future.value, change: future.change, changeRate: future.changeRate }
    : { value: quote.value, change: quote.change, changeRate: quote.changeRate };

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-sm gap-y-2xs ${CARD_HEADER_RULE}`}
      >
        <span className="text-xs font-semibold uppercase text-fg-dim">
          {showFutures ? future.label : quote.label}
        </span>
        {breadth?.rising != null && breadth.falling != null && (
          <span className="font-data text-2xs text-fg-dim tabular-nums">
            <span className="text-price-up">▲{breadth.rising}</span>
            {' · '}
            <span className="text-price-down">▼{breadth.falling}</span>
          </span>
        )}
        {future != null && (
          <ModeSwitch
            label={`${quote.label} 현물/선물`}
            value={mode}
            onChange={setMode}
            options={CARD_MODES}
          />
        )}
      </div>
      <div className="flex items-end justify-between gap-sm">
        <div className="flex flex-col">
          <span className={`font-data text-xl font-semibold tabular-nums ${priceDirClass(shown.change)}`}>
            {shown.value.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}
          </span>
          <span
            className={`whitespace-nowrap font-data text-sm tabular-nums ${priceDirClass(shown.change)}`}
          >
            {shown.change > 0 ? '+' : ''}
            {shown.change.toFixed(2)} <PctText pct={shown.changeRate} />
          </span>
        </div>
        {/* 분봉이 아직 없거나 실패하면 그냥 안 그린다 — 한 점짜리 선은 거짓 정보다.
            모드마다 **다른 소스**를 쓴다: 현물은 키움 ka20005(1분봉), 선물은
            KIS FHKIF03020200(5분봉). 선물 모드에 현물 분봉을 그리면 더 나쁜 거짓말이다. */}
        {showFutures
          ? futureSpark && (
              <Sparkline points={futureSpark.closes} baseline={futureSpark.dayOpen ?? undefined} />
            )
          : <Sparkline points={closes} baseline={dayOpen} />}
      </div>
      {showFutures && <FuturesMeta future={future} snapshot={snapshot} spark={futureSpark} />}
      {!showFutures && breadth && (
        <AdvanceDeclineBar rising={breadth.rising} falling={breadth.falling} flat={breadth.flat} />
      )}
    </MarketCard>
  );
}

// ── 투자자 수급 ───────────────────────────────────────────────────────────

const MARKET_LABELS: Record<string, string> = { KOSPI: '코스피', KOSDAQ: '코스닥' };

/** epoch ms → KST 자정 기준 초. 세션축(09:00–15:30) x 위치 계산용. */
function kstSecOfDay(tMs: number): number {
  const kst = new Date(tMs + 9 * 3600_000);
  return kst.getUTCHours() * 3600 + kst.getUTCMinutes() * 60 + kst.getUTCSeconds();
}

export function InvestorCard() {
  const [mode, setMode] = useState<'intraday' | 'daily'>('intraday');
  const flow = useMarketInvestorFlow();
  const data = flow.data;
  const cov = data?.coverage;

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
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
    </MarketCard>
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
            {/* 벤더 누적을 그대로, x 는 세션 시간 비례 — 표본 4개가 전폭으로 늘어나
                "하루치 흐름" 처럼 읽히던 왜곡 제거. 부분 커버리지는 부분 선이다. */}
            <SessionLinesChart
              series={actors.map(([, color, vals]) => ({
                color,
                points: points.map((pt, i) => ({ sec: kstSecOfDay(pt.t_ms), v: vals[i] })),
              }))}
              height={96}
            />
            <SessionAxisLabels />
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
    <MarketCard className="flex flex-col gap-sm p-md">
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
    </MarketCard>
  );
}

// ── 프로그램 매매 ────────────────────────────────────────────────────────

export function ProgramCard() {
  const [axis, setAxis] = useState<ProgramAxis>('intraday');
  const program = useMarketProgram(axis);
  const markets = program.data?.markets ?? {};
  return (
    <MarketCard className="flex flex-col gap-sm p-sm">
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
          // 일별은 20일만(프로토타입 확정) — 100일 막대는 콤보에서도 좁아진다.
          const asc = axis === 'daily' ? [...points].reverse().slice(-20) : [...points].reverse();
          const total = asc[asc.length - 1]?.total_net_eok ?? null;
          // 당일(분 단위 ~330점)은 **누적 라인만** — 막대를 겹치면 1px 줄무늬
          // 노이즈가 된다(실화면, 2026-08-05). 막대+라인 콤보는 일별(20점)의 문법.
          const isIntraday = axis === 'intraday';
          const hasValues = asc.some((p) => p.arb_net_eok !== null || p.non_arb_net_eok !== null);
          const secOf = (t: string, i: number) =>
            isIntraday && t.length === 6
              ? Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4))
              : i;
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
              {!hasValues ? (
                <EmptyNote>프로그램 값이 아직 없습니다.</EmptyNote>
              ) : isIntraday ? (
                <>
                  <SessionLinesChart
                    series={[
                      { color: SERIES_COLORS.arb,
                        points: asc.map((p, i) => ({ sec: secOf(p.t, i), v: p.arb_net_eok })) },
                      { color: SERIES_COLORS.nonArb,
                        points: asc.map((p, i) => ({ sec: secOf(p.t, i), v: p.non_arb_net_eok })) },
                    ]}
                    height={56}
                  />
                  <SessionAxisLabels />
                </>
              ) : (
                <ComboNetChart
                  a={{ color: SERIES_COLORS.arb, values: asc.map((p) => p.arb_net_eok) }}
                  b={{ color: SERIES_COLORS.nonArb, values: asc.map((p) => p.non_arb_net_eok) }}
                  height={56}
                />
              )}
            </div>
          );
        })
      )}
    </MarketCard>
  );
}

// ── 순매수 상위 (주체별 2카드) ───────────────────────────────────────────

export function ActorNetCard({ actor }: { actor: '외국인' | '기관' }) {
  const jump = useJumpToLive();
  const streaks = useMarketStreaks();
  const rows = (streaks.data?.[actor] ?? []) as import('../api/market').StreakRow[];
  const accent = actor === '외국인' ? SERIES_COLORS.foreign : SERIES_COLORS.institution;
  return (
    <MarketCard className="flex flex-col gap-xs p-sm">
      <h2 className={`flex items-center gap-2xs text-sm text-fg ${CARD_HEADER_RULE}`}>
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
                  className={`text-right font-data text-sm tabular-nums ${r.streak_net_eok === null ? 'text-fg-dim' : priceDirClass(r.streak_net_eok)}`}
                >
                  {fmtSigned(r.streak_net_eok)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </MarketCard>
  );
}

// ── 시장 폭 · 증시 주변 자금 ─────────────────────────────────────────────

const FUND_SPANS = [
  ['20', '20일'],
  ['60', '60일'],
  ['120', '120일'],
] as const;
type FundSpan = (typeof FUND_SPANS)[number][0];

function FundsCard() {
  const [span, setSpan] = useState<FundSpan>('60');
  const funds = useMarketFunds();
  const data = funds.data;
  // 잔고(스톡) 지표라 "기간" = 시작 대비 증감의 창이다 — 토글이 곧 해석의 창.
  const series = (data?.series ?? []).slice(-Number(span));
  const last = series[series.length - 1];
  const asOf = data?.as_of;
  return (
    <MarketCard className="flex flex-col gap-xs p-sm">
      <div className={`flex flex-wrap items-center justify-between gap-x-sm gap-y-2xs ${CARD_HEADER_RULE}`}>
        <h2 className="text-sm text-fg">
          증시 주변 자금{' '}
          <span className="text-2xs text-fg-dim">
            {asOf ? `조원 · ${asOf.slice(4, 6)}/${asOf.slice(6)} 기준` : '조원'}
          </span>
        </h2>
        <ModeSwitch value={span} onChange={setSpan} options={FUND_SPANS} label="자금 집계 기간" />
      </div>
      {data?.unavailable === 'credentials_missing' ? (
        <EmptyNote>KOFIA 인증키가 설정되지 않았습니다(.env: KOFIA_API_KEY).</EmptyNote>
      ) : series.length === 0 ? (
        <EmptyNote>자금 데이터를 받지 못했습니다.</EmptyNote>
      ) : (
        <>
          <CumLinesChart
            series={[
              { color: SERIES_COLORS.deposit, values: stockSeriesDiffs(series.map((r) => wonToJo(r.deposit_won))) },
              { color: SERIES_COLORS.credit, values: stockSeriesDiffs(series.map((r) => wonToJo(r.credit_won))) },
              { color: SERIES_COLORS.cma, values: stockSeriesDiffs(series.map((r) => wonToJo(r.cma_won))) },
            ]}
            height={72}
          />
          <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
            <span>{series[0] ? `${series[0].date.slice(4, 6)}/${series[0].date.slice(6)}` : ''}</span>
            <span>{last ? `${last.date.slice(4, 6)}/${last.date.slice(6)}` : ''}</span>
          </div>
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
    </MarketCard>
  );
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
    <MarketCard className="flex flex-col gap-xs p-md">
      <h2 className={`text-sm text-fg ${CARD_HEADER_RULE}`}>{title}</h2>
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
    </MarketCard>
  );
}

export function MarketPage() {
  // 레이아웃 = 중앙 고정 폭(1680px) + 행 재균형 — 초광폭에서 카드가 무한 확장돼
  // 차트가 납작해지던 문제의 답(프로토타입 A 승자, 2026-08-05 사용자 확정.
  // 3변형은 prototype/market-layout-variants-2026-08-05 브랜치 보존).
  // 업종 온도(세로로 긴 리스트)는 우측 열, 좌측은 수급 + 보조 2×2 로 높이를 맞춘다.
  return (
    <PageContainer>
      {/* 간격도 분리 수단이다 — 이전 `gap-xs`(4.5px)는 헤더 밑줄과 함께 써도 카드가
          붙어 보였다. 카드 사이 `md`, 성격이 다른 좌우 열 사이만 `xl`
          (DESIGN.md 가 "Major section dividers" 로 정의한 그 값). */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1680px] flex-col gap-md overflow-y-auto">
        <IndexCards />
        <div className="grid grid-cols-[2fr_1fr] gap-x-xl gap-y-md">
          <div className="flex flex-col gap-md">
            <InvestorCard />
            <div className="grid grid-cols-2 gap-md">
              <ProgramCard />
              <FundsCard />
              <ActorNetCard actor="외국인" />
              <ActorNetCard actor="기관" />
            </div>
          </div>
          <div className="flex flex-col gap-md">
            <SectorCard />
            <SectorFlowCard />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-md">
          <RankCard title="상승률 상위" kind="change" direction="up" />
          <RankCard title="하락률 상위" kind="change" direction="down" />
          <RankCard title="거래대금 상위" kind="value" direction="up" />
        </div>
      </div>
    </PageContainer>
  );
}

export default MarketPage;
