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
import { useEffect, useState } from 'react';
import { SectorFlowCard } from './SectorFlowCard';
import { InvestorCard } from './InvestorFlowCard';
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
  useMarketProgram,
  useMarketSectors,
  useMarketStreaks,
  type MarketName,
  type MarketVolatility,
  type ProgramAxis,
  type StreakDirection,
  type StreakRow,
} from '../api/market';
import { useLiveRankings } from '../api/liveRankings';
import { heatBg } from '../heatmap/heat';
import { useJumpToLive } from '../live/useJumpToLive';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import type { LiveIndexId } from '../live/liveInstrument';
import { PAGE_MAX_W, PageContainer } from '../layout/PageContainer';
import { persistJson, readJsonObject } from '../state/persist';
import {
  CARD_HEADER_RULE,
  CardHeader,
  EmptyNote,
  MarketCard,
  ModeSwitch,
  useCardPref,
} from './marketCardBits';
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
import { MARKET_LABELS, SERIES_COLORS, fmtSigned, stockSeriesDiffs, wonToJo } from './marketFormat';
import { TradeValueCard } from './TradeValueCard';

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
 *  **한 벌을 부모가 들고 있는다.** 카드마다 `useState` 를 두면 두 가지가 따라온다:
 *  ① 저장할 때 마운트 시점 스냅샷을 쓰면 마지막에 누른 카드가 다른 카드의 선택을
 *  덮어쓴다(그래서 원래는 저장 때마다 병합했다). ② 더 중요한 쪽 — 어느 카드도 모드를
 *  모르는 부모가 **분봉 폴링을 켤지 끌지 판정할 수 없다.** 그 판정은 모든 카드의
 *  모드를 동시에 봐야 나온다. 부모 단일 state 는 ①을 원리적으로 없애고 ②를 가능하게 한다.
 *
 *  저장은 여전히 **다시 읽어 병합**한다 — 이 state 는 지금 화면에 있는 카드만 알고
 *  있어서, 통째로 쓰면 다른 화면·이전 버전이 남긴 선택을 지운다. */
function useCardModes(): [Record<string, CardMode>, (id: string, next: CardMode) => void] {
  const [modes, setModes] = useState<Record<string, CardMode>>(() =>
    Object.fromEntries(
      Object.entries(readJsonObject(CARD_MODE_KEY))
        .filter(([, v]) => v === 'futures')
        .map(([id]) => [id, 'futures' as CardMode]),
    ),
  );
  const setMode = (id: string, next: CardMode) => {
    setModes((prev) => ({ ...prev, [id]: next }));
    persistJson(CARD_MODE_KEY, { ...readJsonObject(CARD_MODE_KEY), [id]: next });
  };
  return [modes, setMode];
}

/** 이 카드의 값이 지금 세션의 것이 아니면 그 사실을 문구로. null 이면 최신이다.
 *
 *  **카드마다 따로 판정한다.** 야간엔 유동성에 따라 종목별로 갈리기 때문이다 —
 *  KOSPI200 은 WS 틱이 붙어 실시간인데 코스닥150 은 무음이라 주간 마감본일 수 있다.
 *  스냅샷 하나로 판정하면 둘 중 하나는 반드시 틀린 배지를 단다.
 *
 *  **사용자가 직접 다른 세션을 골랐으면 침묵한다**(`viewingAlt`). 이 배지는 "의도하지
 *  않았는데 값이 어긋났다" 는 **예외** 채널이다. 고른 결과를 같은 문구로 알리면
 *  경고와 확인이 한 자리에서 섞이고, 그 순간부터 배지가 어느 질문에 답하는지
 *  알 수 없어진다. 어느 세션 값인지는 라벨 옆 칩이 이미 상태로 말한다. */
function stalenessNote(
  future: FuturesQuote,
  snapshot: FuturesQuotesSnapshot | undefined,
  viewingAlt: boolean,
): string | null {
  if (viewingAlt) return null;
  if (!snapshot || snapshot.session === future.dataSession) return null;
  return snapshot.session === 'night' ? '주간 마감값' : '장 마감';
}

/** 이 값이 **어느 세션의 것인지** — 라벨 옆에 늘 붙는다.
 *
 *  `stalenessNote` 와 축이 다르다. 저쪽은 "지금 세션과 어긋났는가"(예외)를 말하고,
 *  이쪽은 "무슨 값인가"(상태)를 말한다. 상태를 예외 채널로만 표현하면 정상 상태가
 *  화면에서 통째로 사라진다 — 야간 실시간일 때 라벨도 배지도 주간과 똑같아서 값을
 *  외우지 않으면 구별할 수 없었던 것이 그 결과였다(2026-08-07).
 *
 *  `closed` 는 '주간' 으로 읽는다 — 장 마감 중 카드가 들고 있는 값이 그날 주간
 *  마감본이기 때문이다. 그 값이 낡았다는 사실은 `stalenessNote` 가 따로 말한다. */
function sessionLabel(session: FuturesQuote['dataSession']): string {
  return session === 'night' ? '야간' : '주간';
}

/** 회상한 야간 값의 칩 라벨 — `20260807` → `8/7 야간`.
 *
 *  **날짜가 라벨의 본체다.** 이 값은 오늘 야간이 아니라 *지난* 야간이라, 날짜 없이
 *  '야간' 만 쓰면 지금 열려 있는 야간장으로 읽힌다. 그리고 그 날짜 자체가 낡음
 *  표시이기도 하다 — keeper 가 꺼져 있었으면 한참 전 날짜가 뜨고, 그게 정직한
 *  신호다(별도 경고 채널을 만들 이유가 없다). */
function recalledNightLabel(sessionDay: string): string {
  const month = Number(sessionDay.slice(4, 6));
  const day = Number(sessionDay.slice(6, 8));
  if (!month || !day) return '야간';
  return `${month}/${day} 야간`;
}

/** 세션 칩에 쓸 글자 — **상태 한 줄이 곧 라벨**이다.
 *
 *  세 가지가 나온다: 지금 값의 세션(`주간`/`야간`), 야간 카드에서 고른 주간(`주간`),
 *  주간 카드에서 회상한 야간(`8/7 야간`). 마지막만 날짜가 붙는 이유는 그것만이
 *  **오늘이 아닌 값**이기 때문이다. */
function sessionChipText(future: FuturesQuote, viewingAlt: boolean): string {
  if (!viewingAlt) return sessionLabel(future.dataSession);
  if (future.dataSession === 'night') return '주간';
  return future.night ? recalledNightLabel(future.night.sessionDay) : '야간';
}

/** 베이시스·괴리율용 소수 2자리 부호 표기.
 *
 *  `fmtSigned` 를 쓰면 안 된다 — 그쪽은 `Math.round` 라 베이시스 −1.77 이 −2 가 되어
 *  콘탱고/백워데이션의 크기 정보가 통째로 죽는다. */
function fmtBasis(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** 선물 카드의 부가 정보 한 줄 — 베이시스·만기. 선물을 보는 이유 자체다.
 *
 *  **야간 그림의 커버리지(`02:00~`·`끊김 2곳`)는 여기서 뺐다**(2026-08-07, 사용자
 *  요청). 원래는 스파크라인에 축이 없어 "8시간짜리 선과 10분짜리 선이 똑같이 카드를
 *  채운다" 는 것을 글자로 고백하는 장치였는데, 스케줄러 keeper(#1218)를 켜면 관측이
 *  항상 18:00 부터라 그 문구가 사실상 뜨지 않는다. 응답(`spark.coverage`)은 계속
 *  오므로 필요해지면 되살릴 수 있다. */
function FuturesMeta({
  future,
  snapshot,
  alt = null,
}: {
  future: FuturesQuote;
  snapshot: FuturesQuotesSnapshot | undefined;
  /** 사용자가 고른 **반대편 세션 값**. `null` 이면 자동(카드가 그리는 그대로)이다.
   *
   *  베이시스도 여기서 갈린다 — 값만 반대편으로 바꾸고 베이시스를 그대로 두면 한
   *  카드가 두 시각을 가리킨다. 방향(주간↔야간)은 이 컴포넌트가 알 필요가 없다. */
  alt?: { marketBasis: number | null } | null;
}) {
  const stale = stalenessNote(future, snapshot, alt != null);
  const basis = alt ? alt.marketBasis : future.marketBasis;
  return (
    <div className="flex flex-wrap items-baseline gap-x-xs font-data text-2xs tabular-nums text-fg-dim">
      <span>
        베이시스 <span className={priceDirClass(basis ?? 0)}>{fmtBasis(basis)}</span>
      </span>
      {future.daysLeft != null && <span>· D-{future.daysLeft}</span>}
      {/* `text-fg-dimmer` 를 쓰지 않는다 — 소형 텍스트에는 WCAG AA 미달이다(DESIGN.md
          텍스트 대비 규칙). 이 줄은 전부 `2xs` 라 예외 없이 대상이다. */}
      {stale && <span>· {stale}</span>}
    </div>
  );
}

export function IndexCards() {
  const quotes = useMarketIndexQuotes();
  const sectors = useMarketSectors();
  const futures = useMarketFutures();
  const [modes, setMode] = useCardModes();

  const snapshot = futures.data;
  const futureByUnderlying = new Map(
    (snapshot?.quotes ?? [])
      .filter((f): f is FuturesQuote & { underlyingId: string } => f.underlyingId !== null)
      .map((f) => [f.underlyingId, f]),
  );

  // 분봉은 **선물을 실제로 그리는 카드가 하나라도 있을 때만** 부른다. 판정은 카드의
  // `showFutures` 와 같은 식이어야 한다 — 저장된 선택이 `futures` 여도 선물 값이 아직
  // 없으면 카드는 현물을 그리므로(아래 `IndexCard` 주석), 그때 분봉을 부르면 아무도
  // 안 보는 응답을 60초마다 받는다.
  const anyFutures = (quotes.data ?? []).some(
    (q) => modes[q.id] === 'futures' && futureByUnderlying.has(q.id),
  );
  const futuresSparks = useMarketFuturesCandles(anyFutures);

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
            mode={modes[q.id] ?? 'spot'}
            onModeChange={(next) => setMode(q.id, next)}
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
  mode,
  onModeChange,
}: {
  quote: ReturnType<typeof useMarketIndexQuotes>['data'] extends (infer T)[] | undefined ? T : never;
  sectors: ReturnType<typeof useMarketSectors>['data'];
  /** 대응 선물. 없으면 토글 자체를 그리지 않는다(코스피·코스닥 종합엔 선물이 없다). */
  future: FuturesQuote | undefined;
  snapshot: FuturesQuotesSnapshot | undefined;
  /** 선물 모드의 스파크라인. 현물 분봉(키움)과 벤더가 달라 별도로 들어온다. */
  futureSpark: FuturesSpark | undefined;
  /** 선택은 **부모가 들고 있다** — 분봉 폴링을 켤지가 카드 전체의 모드에 달려서다. */
  mode: CardMode;
  onModeChange: (next: CardMode) => void;
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
  // 그래서 헤더 우측이 비는 카드가 정확히 선물이 있는 카드다. 토글이 그 자리를 쓴다.
  const mkey = MARKET_KEY_BY_INDEX[quote.id];
  const breadth = mkey ? sectors?.markets[mkey]?.index : undefined;

  // 선물 값이 아직 없으면 현물로 되돌린다 — 토글은 눌리는데 카드가 비는 상태를
  // 만들지 않는다. 저장된 선택은 건드리지 않으므로 데이터가 오면 알아서 복귀한다.
  const showFutures = future != null && mode === 'futures';

  // 카드가 지금 그리는 것의 **반대편 세션 값**. 방향은 백엔드가 정한다:
  //  - 야간 값을 그리는 중이면 `day`   → 누르면 그날 주간 마감본
  //  - 주간 값을 그리는 중이면 `night` → 누르면 **직전 야간장**(디스크 기록)
  //
  // 둘은 동시에 오지 않는다. 그래서 화면은 "반대편이 있는가" 하나만 보면 되고,
  // 어느 방향인지는 `dataSession` 이 이미 말한다.
  //
  // 비대칭이 하나 있고 의도다: 야간 세션 중 **무음 카드**(값이 주간 마감본)에는
  // `night` 가 오지 않는다. 오늘 야간이 도는 중에 지난 밤을 선택지로 내밀면 그것을
  // "지금 야간" 으로 읽기 때문이다(백엔드 `_recall_night`).
  //
  // **영속하지 않는다**(현물/선물 모드와 다른 점). 그쪽은 취향이지만 이쪽은 시간에
  // 종속된 선택이라, localStorage 에 남기면 다음 날 아침 유령으로 남는다.
  // 선택지가 사라지면 아래 effect 가 자동으로 되돌린다.
  const [preferAlt, setPreferAlt] = useState(false);
  const alt = future == null ? null : future.dataSession === 'night' ? future.day : future.night;
  const canPickSession = showFutures && alt != null;
  useEffect(() => {
    if (!canPickSession) setPreferAlt(false);
  }, [canPickSession]);
  const viewingAlt = canPickSession && preferAlt;
  /** 회상한 야간을 보고 있는가 — 라벨에 날짜를 붙여야 하는 방향. */
  const viewingRecalledNight = viewingAlt && future?.dataSession !== 'night';

  // 값·등락·베이시스가 **같은 세션에서** 나와야 한다. 하나만 갈아끼우면 한 카드가
  // 두 시각을 동시에 가리킨다.
  const futureValues = viewingAlt && alt ? alt : future;

  // **그림의 세션이 값의 세션과 다르면 그리지 않는다.** 백엔드는 야간 봉이 아직
  // 부족한 구간에 시리즈를 아예 주지 않지만(#1164), `/api/market/futures-candles` 의
  // TTL 캐시는 빈 수집으로 last-good 을 축출하지 않으므로 **직전 주간 시리즈를 계속
  // 내보낸다**. 그대로 그리면 값은 야간 상승인데 그림은 그날 주간 하락선이 되고,
  // 낡음 배지는 값 기준(`dataSession`)이라 이 어긋남에 침묵한다.
  //
  // 반대 방향도 같은 창으로 생긴다 — 시세 캐시 20초 · 분봉 캐시 60초라 세션이 바뀌는
  // 순간 값이 먼저 주간으로 돌아오고 그림만 야간으로 남는다. 그쪽도 그리지 않는다.
  //
  // 응답은 이미 진실을 말하고 있었다(`session`) — 읽지 않는 쪽이 결함이었다.
  const sparkInSync =
    future != null && futureSpark?.session === future.dataSession ? futureSpark : undefined;

  // 반대편을 골랐을 때 그릴 그림 — 값과 **같은 방향**으로 고른다.
  //
  // 주간 방향엔 경로가 둘이고 둘 다 필요하다: 응답이 이미 주간 시리즈면 그것이 곧
  // 답이고(시세는 야간인데 분봉 캐시가 아직 주간인 창), 야간 시리즈면 짝으로 실려 온
  // `day` 를 쓴다. 야간 방향은 디스크 기록이라 경로가 하나뿐이다.
  const altSpark: { closes: number[]; dayOpen: number | null } | undefined =
    futureSpark == null
      ? undefined
      : viewingRecalledNight
        ? // 회상한 야간엔 기준선을 주지 않는다 — 첫 점이 곧 그 밤의 시가다.
          // 주간 시가로 색칠하면 등락 방향이 뒤집힌다.
          futureSpark.night
          ? { closes: futureSpark.night.closes, dayOpen: null }
          : undefined
        : futureSpark.session === 'day'
          ? { closes: futureSpark.closes, dayOpen: futureSpark.dayOpen }
          : (futureSpark.day ?? undefined);
  const shownSpark = viewingAlt
    ? altSpark
    : sparkInSync && { closes: sparkInSync.closes, dayOpen: sparkInSync.dayOpen };

  const shown =
    showFutures && futureValues != null
      ? {
          value: futureValues.value,
          change: futureValues.change,
          changeRate: futureValues.changeRate,
        }
      : { value: quote.value, change: quote.change, changeRate: quote.changeRate };

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-sm gap-y-2xs ${CARD_HEADER_RULE}`}
      >
        <span className="inline-flex items-baseline gap-2xs text-xs font-semibold uppercase text-fg-dim">
          {showFutures ? future.label : quote.label}
          {/* 세션 칩 — **선물 모드에만** 붙는다. 현물 지수는 주간뿐이라 물음 자체가 없다.
              굵기를 낮춰 라벨과 위계를 가른다(같은 색이면 이름의 일부로 읽힌다).

              **선택 가능할 때 같은 자리가 버튼이 된다.** 자리를 새로 만들지 않은 것이
              요점이다 — 이 칩은 "무슨 값인가" 를 말하는 곳이고, 토글은 정확히 그것을
              바꾸는 조작이다. 옆에 스위치를 하나 더 놓으면 같은 질문에 답하는 자리가
              둘이 되고, 5열일 때 가장 좁은 카드에서 헤더가 먼저 깨진다.

              색으로 강조하지 않는다(`accent` 는 솔리드 채움 문맥 전용, DESIGN.md).
              무엇을 보고 있는지는 칩 **글자 자체**가 이미 말한다. */}
          {showFutures &&
            (canPickSession ? (
              <button
                type="button"
                onClick={() => setPreferAlt((v) => !v)}
                title={
                  viewingAlt
                    ? `${sessionLabel(future.dataSession)} 값으로 되돌리기`
                    : future.dataSession === 'night'
                      ? '주간 마감값으로 전환'
                      : '직전 야간장 마지막 값으로 전환'
                }
                aria-label={`${future.label} 세션 — 현재 ${sessionChipText(future, viewingAlt)}, 눌러서 전환`}
                className="rounded px-2xs text-2xs font-normal hover:bg-bg-input-hover"
              >
                {sessionChipText(future, viewingAlt)}
              </button>
            ) : (
              <span className="text-2xs font-normal">{sessionLabel(future.dataSession)}</span>
            ))}
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
            onChange={onModeChange}
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
          ? shownSpark && (
              <Sparkline points={shownSpark.closes} baseline={shownSpark.dayOpen ?? undefined} />
            )
          : <Sparkline points={closes} baseline={dayOpen} />}
      </div>
      {/* 카드 마지막 줄 — **모드가 바뀌어도 높이가 변하면 안 된다.**
          지수 상품(코스피200·코스닥150)은 등락종목수가 없어서(#1100) 현물 모드에 이
          줄이 통째로 비는데, 선물 모드에선 베이시스 한 줄이 생긴다. 그 차이만큼 카드가
          자라고 **그리드 행 전체가 위아래로 튄다** — 토글을 누를 때마다 아래 카드들이
          밀린다. 그래서 현물 모드에서도 같은 마크업을 `invisible` 로 깔아 자리를 잡는다.

          `min-height` 상수를 박지 않은 이유: 그 줄의 높이는 폰트·줌·`text-2xs` 의
          line-height 가 정하므로 하드코딩하면 사용자 줌에서 어긋난다. 같은 컴포넌트를
          그대로 재사용하면 정의상 높이가 일치한다. */}
      {showFutures ? (
        <FuturesMeta future={future} snapshot={snapshot} alt={viewingAlt ? alt : null} />
      ) : breadth ? (
        <AdvanceDeclineBar rising={breadth.rising} falling={breadth.falling} flat={breadth.flat} />
      ) : future != null ? (
        <div aria-hidden="true" className="invisible">
          <FuturesMeta future={future} snapshot={snapshot} />
        </div>
      ) : null}
    </MarketCard>
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

// ── 연속 순매수·순매도 상위 (주체별 2카드) ───────────────────────────────

const DIRECTION_LABELS: Record<StreakDirection, string> = { buy: '순매수', sell: '순매도' };
const DIRECTIONS: ReadonlyArray<readonly [StreakDirection, string]> = [
  ['buy', DIRECTION_LABELS.buy],
  ['sell', DIRECTION_LABELS.sell],
];
const STREAK_MARKET_LABELS: Record<MarketName, string> = { KOSPI: '코스피', KOSDAQ: '코스닥' };
const STREAK_MARKETS: ReadonlyArray<readonly [MarketName, string]> = [
  ['KOSPI', STREAK_MARKET_LABELS.KOSPI],
  ['KOSDAQ', STREAK_MARKET_LABELS.KOSDAQ],
];
const DIRECTION_KEY = 'market.actorNetDirection.v1';
// 축마다 저장 키를 나눈다 — 한 객체에 두 축을 담으면 필드 이름이
// `외국인_direction` 처럼 합성 키가 되고, 그 순간 `useCardPref` 의 필드 규약이
// 카드마다 달라진다. 키가 하나 느는 대신 두 축이 같은 모양을 유지한다.
const MARKET_KEY = 'market.actorNetMarket.v1';

/** 주체 하나의 연속 매매 상위 — 시장·방향을 카드마다 따로 고른다.
 *
 *  **카드를 늘리지 않고 토글로 간 이유**는 레이아웃이다. 좌측 2×2 그리드가 우측 열
 *  (업종 온도 + 업종 수급) 높이에 맞춰져 있어(아래 `MarketPage` 주석) 카드를 더하면
 *  그 균형이 통째로 깨진다. 축이 둘로 늘어난 지금은 더 그렇다 — 조합이 4개라 카드로
 *  펼치면 8장이 된다.
 *
 *  두 축을 **카드별로** 두는 것은 지수 카드(현물/선물)와 같은 규율이다 — 외국인 코스피
 *  순매도 옆에 기관 코스닥 순매수를 놓고 보는 것이 이 페이지에서 자연스러운 비교다.
 *  둘이 같은 조합이면 쿼리 키가 같아 벤더 콜도 한 벌이다.
 *
 *  **정렬은 벤더 순서 그대로다**(모든 조합 동일). 벤더 `rank` 는 연속 금액이 아니라
 *  **당일 순매매 대금** 순이라(2026-08-10 실측: 193432 · 185256 · 135670 … 단조감소)
 *  화면의 금액 열과 순서가 어긋나 보이는데, 이건 순매수 카드가 원래 갖고 있던 성질
 *  이다. 한쪽만 재정렬하면 조합마다 서로 다른 질문에 답하게 된다. */
export function ActorNetCard({ actor }: { actor: '외국인' | '기관' }) {
  const jump = useJumpToLive();
  const [market, setMarket] = useCardPref<MarketName>(MARKET_KEY, actor, 'KOSPI');
  const [direction, setDirection] = useCardPref<StreakDirection>(DIRECTION_KEY, actor, 'buy');
  const streaks = useMarketStreaks(market, direction);
  const rows = (streaks.data?.[actor] ?? []) as StreakRow[];
  const accent = actor === '외국인' ? SERIES_COLORS.foreign : SERIES_COLORS.institution;
  return (
    <MarketCard className="flex flex-col gap-xs p-sm">
      {/* 토글이 둘이라 좁은 폭에서는 헤더가 줄바꿈된다(`flex-wrap`) — 잘리는 대신
          높이를 내주는 쪽이 맞다. 읽는 순서대로 시장 → 방향. */}
      <div className={`flex flex-wrap items-center justify-between gap-x-sm gap-y-2xs ${CARD_HEADER_RULE}`}>
        {/* 색 바는 **주체**의 표식이라 시장·방향을 따라가지 않는다 — 방향은 토글과
            값의 색(적/청)이 이미 말한다. */}
        <h2 className="flex items-center gap-2xs text-sm text-fg">
          <span className="inline-block h-[2px] w-[10px]" style={{ background: accent }} />
          {actor} <span className="text-2xs text-fg-dim">연속 · 억원</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2xs">
          <ModeSwitch
            value={market}
            onChange={setMarket}
            options={STREAK_MARKETS}
            label={`${actor} 연속 매매 시장`}
          />
          <ModeSwitch
            value={direction}
            onChange={setDirection}
            options={DIRECTIONS}
            label={`${actor} 연속 매매 방향`}
          />
        </div>
      </div>
      {rows.length === 0 ? (
        // 어느 조합이 빈 것인지 문구가 말한다 — 토글이 넷이라 더 그렇다.
        <EmptyNote>
          {STREAK_MARKET_LABELS[market]} 연속 {DIRECTION_LABELS[direction]} 종목이 없습니다.
        </EmptyNote>
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
                {/* 순매도 방향은 일수가 음수로 온다 — 부호는 백엔드가 보존하고
                    "며칠째인가" 로 읽는 것은 여기의 결정이다(`-2일` 은 안 읽힌다). */}
                <span className="text-right font-data text-sm font-semibold text-fg tabular-nums">
                  {Math.abs(r.streak_days)}일
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
      <div className={`mx-auto flex h-full min-h-0 w-full ${PAGE_MAX_W} flex-col gap-md overflow-y-auto`}>
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
        {/* 좌우 그리드 **밖**이다 — 안에 넣으면 열 높이 균형(위 주석)이 깨진다.
            전폭이라 120일 라인에 가장 유리하기도 하다. */}
        <TradeValueCard />
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
