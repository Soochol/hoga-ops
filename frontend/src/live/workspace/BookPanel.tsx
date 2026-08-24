/**
 * BookPanel — /live 워크스페이스 10호가 창 본문 (십자 배치).
 *
 * 레이아웃(참조 화면 구조):
 *
 *     [매도 잔량 바 ]  [ 가격+등락률 ]  [ 요약 패널  ]
 *     [체결강도·체결]  [ 가격+등락률 ]  [매수 잔량 바]
 *
 * 중앙 가격축을 좌우 4개 블록이 둘러싼다. **우측 요약 패널의 높이는 정확히 11행
 * (상한가 1 + 매도 10)이어야** 그 아래 매수 잔량 바가 매수 가격 행과 정렬된다 —
 * 항목을 늘리거나 줄일 때 SUMMARY_ROWS 개수를 함께 맞출 것.
 *
 * **이 패널은 /live 와 /study 가 공유하는 단일 10호가 표면이다** — /live 는
 * DataWindow, /study 는 studyWindowContents 의 BookContent 가 각각 자기 자료원으로
 * props 를 채워 렌더한다. 따라서 여기의 레이아웃·색 규약을 바꾸면 두 페이지가
 * 함께 바뀐다. (#808 이전엔 /study 만 좁은 2열 표 sidebar/OrderbookTable 을 썼는데,
 * 같은 이름의 창이 페이지마다 다르게 생기는 것이 창 모델의 취지에 반해 이 패널로
 * 통일했다. 그 컴포넌트는 소비처가 0이 되어 삭제됐다.)
 */
import type { OrderbookSnapshot } from '../../api/types';
import type { OrderbookDeltaBadges, OrderbookDeltaBadge } from '../../sidebar/orderbookDeltaBadges';
import type { LiveViEvent } from '../../api/liveViStatus';
import { priceDirClass } from '../../ui/priceDir';
import { viExpectedDown, viExpectedUp } from '../krxTick';
import type { AfterHoursTotals, LiveTradeSummary } from '../liveSidebarAdapters';
import { BOOK_PANEL_GRID_COLS, BOOK_PANEL_MIN_W } from './bookPanelMetrics';

/** 체결 리스트 한 줄. */
export type BookTrade = { price: number; qty: number; side: number };

/** 상하한가·기준가·250일 최고/최저 — /api/live/stock-limits(키움 ka10001) 부분집합.
 *  **날짜 단위 상수**다: 오늘 안에서는 시각이 달라도 고정이라 당일 스팟 커서에서
 *  유효하지만(요약 지표와 달리 비우지 않는다), 과거 날짜 커서에서는 그날의 기준가에서
 *  파생된 상하한가와 다르므로 호출부가 null 로 비운다.
 *  base_price 는 VI 예상가의 장전 폴백(시가 형성 전 기준가). */
export type BookStockLimits = {
  base_price: number | null;
  upper_limit: number | null;
  lower_limit: number | null;
  high_250: number | null;
  low_250: number | null;
};

type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  /** 전일종가 — 등락률 분모이자 가격 색 기준. */
  baselinePrice: number | null;
  summary: LiveTradeSummary;
  trades: readonly BookTrade[];
  /** 종가 동시호가 구간이면 매수/매도 비율을 가린다(ADR-0062). */
  maskRatio: boolean;
  /** 현재가 — 해당 호가 행을 박스로 강조. */
  lastPrice: number | null;
  /** HTS식 순간 증감 뱃지(#750, 직전 스냅샷 대비). 스팟 커서 중에는 null —
   *  과거 시점 위 "방금 변화"는 거짓 정보다. */
  deltaBadges?: OrderbookDeltaBadges | null;
  /** 상하한가·250일 최고/최저. null = 미로드/미제공 → 대시. */
  limits?: BookStockLimits | null;
  /** 종목의 최신 VI 이벤트(키움 1h). null = 오늘 이벤트 없음 → 예상가만 표시. */
  vi?: LiveViEvent | null;
  /**
   * 시간외 총잔량(키움 0E). 있으면 하단 스트립이 `snapshot` 의 총잔량 대신 이 값을
   * 쓰고 "시간외" 라벨을 단다. null/미지정이면 종전 그대로 정규장 총잔량.
   *
   * **사다리는 갈아치우지 않는다** — 0E 에는 단계별 호가가 없어서 바꿀 것이 없고,
   * 위 사다리는 15:30 정규장 마지막 스냅샷으로 남는다. 그래서 이 상태에서는
   * "사다리 잔량 합 ≠ 총잔량" 이 **정상**이다: 두 숫자의 출처와 시각이 다르다.
   * 라벨이 그 불일치를 설명하는 유일한 장치라 값과 함께 반드시 뜬다.
   */
  afterHoursTotals?: AfterHoursTotals | null;
  /**
   * 시간외 스트립 라벨. 두 모드가 같은 자리를 쓰지만 **의미가 다르다**:
   *
   *   '시간외'       15:40–16:00 · WS `0E` 총잔량만(사다리는 15:30 정규장 값)
   *   '시간외 단일가' 16:00–18:00 · REST `ka10087` — **사다리도 시간외 값**이고 5단이라
   *                  격자 바깥 5행이 빈다
   *
   * 두 번째 모드에서 라벨이 특히 load-bearing 하다 — 빈 5행이 "데이터 결손"이 아니라
   * "그 시장에 없는 단계" 임을 말하는 유일한 장치다.
   */
  afterHoursLabel?: string;
  /**
   * 사다리가 **현재 커서의 것이 아닐 수 있다** — 새 시점의 조회가 비행 중.
   *
   * 로딩 문구로 갈아치우지 않고 흐리게만 하는 이유: 커서를 훑으면 버킷마다
   * 조회가 새로 뜨는데, 그때마다 사다리를 비우면 스크럽 내내 화면이 깜빡여
   * 정작 읽으려던 값을 못 읽는다. 값은 남기고 확정 여부만 낮춘다.
   *
   * **딤은 스냅샷에서 온 것에만 건다** — 사다리·중앙 가격축·예상체결·총잔량.
   * 체결강도·시/고/저·요약 패널은 커서에서 즉시 파생되므로 이미 새 시점의
   * 정확한 값이고, 같이 흐려지면 "이것도 낡았다" 는 거짓말이 된다.
   *
   * 남는 비대칭 하나는 **의도된 것**이다: 요약의 최고/최저 색과 사다리 행의
   * 시/고/저 칩은 커서 시점 값을 스냅샷 시점 분모에 견주므로 비행 중 잠깐
   * 어긋난다. 분모를 한 벌 더 조회해 맞출 수 있지만 그러면 날짜마다 쿼리가
   * 불어난다 — 사다리가 눈에 띄게 흐려져 있는 동안의 색조 하나를 위해 치를
   * 값이 아니다.
   */
  stale?: boolean;
};

const ROW_H = 22; // DESIGN.md — Orderbook table row 22px
/** 깊이 막대 상하 여백(px). 막대 높이 = ROW_H − 2·BAR_INSET(=16px). 이 여백이
 *  Toss식 행간 "구분선"(흰 띠)을 만든다 — Toss 24/40 비율을 밀도 높은 22px 행에 축소. */
const BAR_INSET = 3;
/** 요약 패널 행 수 = 상한가 1 + 매도 10. 매수 바 정렬의 근거라 상수로 못박는다. */
const SUMMARY_ROWS = 11;

/**
 * 매도1·매수1의 중간값 — `중` 행(ADR-0140 §7.1).
 *
 * **분기가 없다.** 한 수식이 세 경우를 다 덮는다:
 *  - 정상(매도1 > 매수1) → 둘 사이 값
 *  - lock(매도1 = 매수1) → 그 가격 자체
 *  - 역전(매도1 < 매수1) → 여전히 둘 사이 값
 *
 * 마지막 둘은 단일 거래소에선 불가능하지만 통합(UN) venue 에서는 정상 상태다 —
 * 서로 다른 거래소의 주문은 자동으로 만나지 않는다(전체 시간의 17%, 종목에 따라 80%).
 *
 * 호가 단위 밖 값이 나올 수 있다(1,319,000/1,320,000 → 1,319,500). **주문 가능한
 * 호가가 아니라는 표시가 `중` 뱃지**이고, 이는 키움 앱이 이미 쓰는 규약이다.
 */
export function bookMidPrice(
  ask: readonly { price: number }[],
  bid: readonly { price: number }[],
): number | null {
  const bestAsk = ask[0]?.price ?? 0;
  const bestBid = bid[0]?.price ?? 0;
  if (bestAsk <= 0 || bestBid <= 0) return null;
  return (bestAsk + bestBid) / 2;
}

export default function BookPanel({
  snapshot,
  baselinePrice,
  summary,
  trades,
  maskRatio,
  lastPrice,
  deltaBadges = null,
  limits = null,
  vi = null,
  afterHoursTotals = null,
  afterHoursLabel = '시간외',
  stale = false,
}: Props) {
  // 스냅샷 파생 블록에만 얹는 딤. 값은 읽히되 확정이 아님을 말한다 — 전환은
  // DESIGN.md Motion 의 상태 전환 규격(150ms ease-in-out).
  const staleDim = `transition-opacity duration-150 ease-in-out${stale ? ' opacity-50' : ''}`;
  if (snapshot === undefined) return <PanelState>커서 위치 불러오는 중…</PanelState>;
  // 사다리가 없어도 **시간외 총잔량은 그린다.** 이 분기가 없으면 0E 가 정상 수신 중인데도
  // 화면이 통째로 "호가 데이터 없음" 이 된다 — 장전 시간외 종가매매(08:30–08:40)가 그
  // 상태다(2026-08-19 실측: 069500 은 그 10분에 0E 119 프레임을 받는 동안 0D 가 0 건).
  //
  // 왜 장후에는 안 터졌는가: 15:40–16:00 에는 **그날 15:30 까지 쌓인 0D 가 버퍼에 남아**
  // snapshot 이 non-null 이라 아래 본문이 그려지고, 스트립이 그 안에서 총잔량만 갈아끼운다.
  // 그 전제는 시간 방향에 의존한다 — 아침에는 그날의 선행 사다리가 원리적으로 없고,
  // 폴백 세 겹(버퍼 · bufferFallbackSnapshot · 서버 last_ob)이 **전부 0D 파생**이라
  // 동시에 빈다. 즉 이것은 데이터 결손이 아니라 표시 경로의 구멍이었다.
  //
  // 사다리를 **합성하지 않는다** — 0E 에는 단계별 호가 FID 가 없어서(kiwoom_fields 0E 절)
  // 만들면 10단이 전부 0 인 가짜 호가창이 된다. 제도상으로도 이 구간은 전일종가 단일가라
  // 사다리라는 개념 자체가 없다. 그려야 할 실체는 총잔량 두 개뿐이다.
  if (snapshot === null) {
    if (afterHoursTotals === null) return <PanelState>호가 데이터 없음</PanelState>;
    return (
      <div className="flex h-full flex-col bg-bg-card">
        <div className="flex min-h-0 flex-1">
          {/* "호가 데이터 없음"(위 분기)과 문구를 갈라 둔다 — 여기는 아래 스트립에
              살아 있는 숫자가 그려지는 상태라, 같은 문구면 화면과 모순된다. */}
          <PanelState>정규장 호가 없음 (시간외 잔량만 수신 중)</PanelState>
        </div>
        <TotalQtyStrip
          totals={afterHoursTotals}
          maskRatio={maskRatio}
          afterHoursTotals={afterHoursTotals}
          afterHoursLabel={afterHoursLabel}
        />
      </div>
    );
  }

  const asksDesc = [...snapshot.ask].reverse(); // 높은 가격이 위
  const bids = snapshot.bid;
  // 중간값은 **한 번만** 계산한다 — 표시값·시고저 칩·현재가 박스 셋이 같은 수를
  // 봐야 한다. 호출을 나누면 세 판정이 서로 다른 스냅샷을 볼 여지가 생긴다.
  const midPrice = bookMidPrice(snapshot.ask, snapshot.bid);
  // 지금 **화면에 가격이 그려진** 자리 전부 — 사다리 20행 + `중` 행. 요약표 칩이
  // 뜰지 말지의 유일한 판정 근거다(`offLadderChip`). 여기서 `중` 을 빼면 중간값이
  // 당일 고가일 때 사다리와 요약표에 칩이 동시에 뜬다.
  const onScreenPrices = new Set<number>([
    ...snapshot.ask.map((l) => l.price),
    ...snapshot.bid.map((l) => l.price),
  ]);
  if (midPrice !== null) onScreenPrices.add(midPrice);
  const maxQty = Math.max(
    1,
    ...snapshot.ask.map((l) => l.qty),
    ...snapshot.bid.map((l) => l.qty),
  );

  return (
    <div className="flex h-full flex-col bg-bg-card">
      {/* 예상체결 배너(동시호가에만) — 호가창 전폭 중앙. 평시엔 null 이라 높이 0.
          `exp_price`/`exp_qty` 가 스냅샷 필드라 사다리와 같이 흐려진다. */}
      <ExpectedFillBanner
        price={snapshot.exp_price ?? 0}
        qty={snapshot.exp_qty ?? 0}
        baselinePrice={baselinePrice}
        dimClass={staleDim}
      />
      {/* min-w 가 load-bearing: 창을 좁히면 좌우 열이 0 으로 수렴해 잔량 숫자가
          겹친다. 최소 폭을 잡아 두면 대신 가로 스크롤이 생긴다(깨지지 않는다).
          우측 열 하한도 같은 계약 — fr 의 auto-min 은 콘텐츠를 min-content 까지
          쥐어짜는데, 요약 값이 최장인 경우(250일 "1,319,000/1,081,100" 7자리 고가
          종목)가 딱 그 경계라 개행으로 행 높이 계약이 깨졌었다(NAVER 실사례).

          두 값의 근거·실측표는 `bookPanelMetrics` 에 있다. **Tailwind 임의값으로
          되돌리지 말 것** — JIT 가 리터럴만 스캔해서 상수 보간이 조용히 죽는다. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="grid"
          style={{ minWidth: BOOK_PANEL_MIN_W, gridTemplateColumns: BOOK_PANEL_GRID_COLS }}
        >
          {/* 좌: 매도 잔량 바 → 체결강도 → 체결 리스트 */}
          <div className="flex flex-col">
            <div style={{ height: ROW_H }} />
            {asksDesc.map((l, i) => (
              <QtyBar
                key={`a-${snapshot.ask.length - i}`}
                qty={l.qty}
                maxQty={maxQty}
                side="ask"
                badge={deltaBadges?.get(`a:${l.price}`) ?? null}
                dimClass={staleDim}
              />
            ))}
            {/* `중` 행의 좌측 빈칸(3열 공통 y). 22행 정렬 계약의 일부다. */}
            <div data-book-divider="" className="border-t border-border" style={{ height: ROW_H }} />
            {/* 매도↔매수 경계선(3열 공통 y). 좌측은 체결강도 행 상단이 그 y라
                여기에 얹는다 — 중앙 PriceCell·우측 QtyBar 의 topDivider 와 같은
                `border` 톤이라야 한 줄로 이어져 보인다(2026-07-22 구분선 최소화
                C안: strong→border 한 단계 완화, 격자는 잔향만). */}
            <div
              data-book-divider=""
              className="flex items-center justify-between border-t border-border px-2"
              style={{ height: ROW_H }}
            >
              <span className="text-xs text-fg-dim">체결강도</span>
              <span
                className={`font-data text-sm tabular-nums ${
                  summary.fillStrengthPct === null ? 'text-fg-dimmer' : 'text-fg'
                }`}
              >
                {summary.fillStrengthPct === null
                  ? '−'
                  : `${summary.fillStrengthPct.toFixed(2)}%`}
              </span>
            </div>
            {/* 9행 = 3열 바닥 정렬: 좌측(여백1+매도10+중1+체결강도1+체결9) = 중앙(여백1+
                매도10+중1+매수10) = 우측(요약11+중1+매수10) = **22행**. 11행이던 시절
                좌측만 2행 삐져나와 하단이 어긋났다. `중` 행(ADR-0140 §7.1)이 들어오며
                21→22 가 됐다 — **중앙에만 넣으면 좌우가 1행씩 짧아져 하단이 어긋난다.** */}
            {trades.slice(0, 9).map((t, i) => (
              <div key={i} className="flex items-center justify-between px-2" style={{ height: ROW_H }}>
                <span
                  className={`font-data text-sm tabular-nums ${dirClass(t.price, baselinePrice)}`}
                >
                  {t.price.toLocaleString('ko-KR')}
                </span>
                <span
                  className={`font-data text-sm tabular-nums ${
                    t.side > 0 ? 'text-price-up' : t.side < 0 ? 'text-price-down' : 'text-fg-dim'
                  }`}
                >
                  {t.qty.toLocaleString('ko-KR')}
                </span>
              </div>
            ))}
          </div>

          {/* 중앙: 가격축 — 세로 프레임(border-x) 없음. 열 분리는 좌우 잔량 바의
              방향(가격축 쪽으로 자람)과 정렬이 담당한다(C안).
              열 전체가 스냅샷 파생(가격·중간가)이라 열 자체에 딤을 건다. */}
          <div className={`flex flex-col ${staleDim}`}>
            <div style={{ height: ROW_H }} />
            {asksDesc.map((l, i) => (
              <PriceCell
                key={`pa-${snapshot.ask.length - i}`}
                price={l.price}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
                marker={dayMarker(l.price, summary)}
              />
            ))}
            <MidPriceRow
              price={midPrice}
              baselinePrice={baselinePrice}
              marker={dayMarker(midPrice, summary)}
              boxed={lastPrice !== null && midPrice === lastPrice}
            />
            {bids.map((l, i) => (
              <PriceCell
                key={`pb-${i}`}
                price={l.price}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
                marker={dayMarker(l.price, summary)}
                topDivider={i === 0}
              />
            ))}
          </div>

          {/* 우: 요약 패널(11행 고정) → 매수 잔량 바 */}
          <div className="flex flex-col">
            <div className="flex flex-col" style={{ height: ROW_H * SUMMARY_ROWS }}>
              {/* 칩은 **사다리 밖일 때만** 뜬다 — 등장 자체가 「이 값은 지금 사다리에
                  없다」는 신호다(`offLadderChip`). 폭은 안전하다: 실측 최고+칩 111px
                  vs 이 열의 제약을 쥔 `250일` 149px. */}
              <SummaryRow
                label="시작"
                value={fmtOr(summary.dayOpen)}
                chip={offLadderChip('시', summary, onScreenPrices)}
              />
              <SummaryRow
                label="최고"
                value={fmtOr(summary.dayHigh)}
                color={summary.dayHigh !== null ? dirClass(summary.dayHigh, baselinePrice) : undefined}
                chip={offLadderChip('고', summary, onScreenPrices)}
              />
              <SummaryRow
                label="최저"
                value={fmtOr(summary.dayLow)}
                color={summary.dayLow !== null ? dirClass(summary.dayLow, baselinePrice) : undefined}
                chip={offLadderChip('저', summary, onScreenPrices)}
              />
              {/* 평균가(VWAP) 행은 사용자 요청으로 거래대금과 교체(2026-07-21) —
                  620 은 파서·저장에 계속 남아 차트 지표 승격 등으로 복귀 가능. */}
              {/* 순서 = 거래량 → 어제보다(그 거래량의 전일 대비) → 거래대금
                  (사용자 지정 2026-07-21) — 어제보다가 거래량 바로 아래 붙어야
                  수식 관계가 읽힌다. */}
              <SummaryRow label="거래량" value={fmtVolumeKo(summary.cumVolume)} divider />
              <SummaryRow
                label="어제보다"
                value={summary.vsPrevVolumePct === null ? '−' : `${summary.vsPrevVolumePct.toFixed(2)}%`}
              />
              <SummaryRow label="거래대금" value={fmtAmountKo(summary.cumValue)} />
              {/* 상한가·하한가·250일 = ka10001(stock-limits). */}
              <SummaryRow
                label="상한가"
                value={fmtOr(limits?.upper_limit ?? null)}
                color={
                  limits?.upper_limit != null ? dirClass(limits.upper_limit, baselinePrice) : undefined
                }
                divider
              />
              <SummaryRow
                label="하한가"
                value={fmtOr(limits?.lower_limit ?? null)}
                color={
                  limits?.lower_limit != null ? dirClass(limits.lower_limit, baselinePrice) : undefined
                }
              />
              <ViRow dir="up" vi={vi} base={viBase(vi, summary, limits)} />
              <ViRow dir="down" vi={vi} base={viBase(vi, summary, limits)} />
              {/* 키움은 52주가 아니라 250거래일 기준(ka10001 250hgst/250lwst)이라
                  라벨도 250일로 정직하게 쓴다. 최고/최저를 한 행에 — 11행 계약. */}
              <SummaryRow label="250일" value={fmtHighLow(limits)} />
            </div>
            {/* `중` 행의 우측 빈칸(3열 공통 y). 22행 정렬 계약의 일부다. */}
            <div data-book-divider="" className="border-t border-border" style={{ height: ROW_H }} />
            {bids.map((l, i) => (
              <QtyBar
                key={`b-${i}`}
                qty={l.qty}
                maxQty={maxQty}
                side="bid"
                badge={deltaBadges?.get(`b:${l.price}`) ?? null}
                topDivider={i === 0}
                dimClass={staleDim}
              />
            ))}
          </div>
        </div>
      </div>
      {/* 총잔량은 **출처가 둘**이라 딤 조건도 둘이다. 시간외(0E·ka10087) 값이면
          커서 스팟 경로를 타지 않으므로 흐리지 않는다 — 사다리가 낡았다는 말이
          그 숫자에는 해당하지 않는다. */}
      <TotalQtyStrip
        totals={afterHoursTotals ?? { ask: snapshot.tot_ask, bid: snapshot.tot_bid }}
        maskRatio={maskRatio}
        afterHoursTotals={afterHoursTotals}
        afterHoursLabel={afterHoursLabel}
        dimClass={afterHoursTotals === null ? staleDim : ''}
      />
    </div>
  );
}

/** 전일종가 대비 방향 색. baseline 이 없으면(예외) 중립. */
function dirClass(price: number, baselinePrice: number | null): string {
  if (baselinePrice === null || baselinePrice <= 0) return 'text-fg-dim';
  return priceDirClass(price - baselinePrice);
}

/** 예상체결가·량(키움 0D FID 23/24) — 호가창 **전폭 상단 배너**, 내용 중앙 정렬.
 *  동시호가(단일가) 구간에만 백엔드가 값을 실어 오므로 둘 다 >0 일 때만 렌더하고,
 *  평시엔 null(높이 0)이라 평상시 호가창에 영향이 없다. 가격은 전일종가 대비 방향색. */
function ExpectedFillBanner({
  price,
  qty,
  baselinePrice,
  dimClass = '',
}: {
  price: number;
  qty: number;
  baselinePrice: number | null;
  /** stale 딤 — `exp_price`/`exp_qty` 는 스냅샷 필드라 사다리와 함께 흐려진다. */
  dimClass?: string;
}) {
  if (price <= 0 || qty <= 0) return null;
  const color = dirClass(price, baselinePrice);
  return (
    <div
      className={`flex items-baseline justify-center gap-6 bg-bg-card px-3 py-1.5 ${dimClass}`}
      data-testid="book-expected-fill"
    >
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-xs text-fg-dim">예상 체결가</span>
        <span className={`font-data text-sm tabular-nums ${color}`}>
          {price.toLocaleString('ko-KR')}원
        </span>
      </span>
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-xs text-fg-dim">예상 체결량</span>
        <span className="font-data text-sm tabular-nums text-fg">
          {qty.toLocaleString('ko-KR')}
        </span>
      </span>
    </div>
  );
}

type PriceMarker = { label: string; bg: string };

/** 시·고·저의 라벨·색·출처를 **한 곳에서** 정의한다. **배열 순서가 곧 우선순위**다
 *  (고 > 저 > 시) — `dayMarker` 가 앞에서부터 처음 맞는 하나만 고른다. 사다리 칩과
 *  요약표 칩(`offLadderChip`)이 같은 표를 보므로 색이 두 표면에서 갈릴 수 없다 —
 *  두 벌로 두면 한쪽만 고쳤을 때 같은 뜻의 칩이 다른 색으로 조용히 갈린다. */
const DAY_MARKERS = [
  { label: '고', bg: 'bg-price-up', of: (s: LiveTradeSummary) => s.dayHigh },
  { label: '저', bg: 'bg-price-down', of: (s: LiveTradeSummary) => s.dayLow },
  { label: '시', bg: 'bg-fg-dim', of: (s: LiveTradeSummary) => s.dayOpen },
] as const;

/** 뱃지 한 알의 공통 형태. 사다리 칩·`중` 뱃지·요약표 칩이 전부 이걸 쓴다. */
const BADGE_CLS =
  'items-center justify-center rounded-sm px-[3px] py-px font-ui text-badge font-semibold leading-none';

/**
 * 당일 시가·고가·저가와 일치하는 호가 행에 붙일 칩. 고=빨강·저=파랑(KRX 관습),
 * 시=중립 회색.
 *
 * **한 가격에 칩은 최대 하나다**(사용자 결정 2026-08-24). 시가=고가처럼 값이 겹치면
 * `DAY_MARKERS` 순서대로 **고 > 저 > 시** 중 하나만 남는다. 겹침은 드물지 않다 —
 * 시가=고가는 갭상승 후 하락, 시가=저가는 갭하락 후 상승이다.
 *
 * ⚠ 이유는 **가격 정렬이 아니다.** 뱃지 띠는 `absolute` 라 레이아웃 폭을 안 먹는다 —
 * 실측으로 칩 1개 행과 2개 행의 가격 좌변이 똑같이 217.8px 였다. 두 번째 칩이 하는
 * 일은 띠가 **왼쪽으로 16px 더 자라는** 것과 한 가격을 두 번 읽히는 것뿐이고,
 * 줄인 것은 그 읽는 비용이다.
 *
 * 부수 이득 하나(실측): 하루 마커가 최대 하나가 되면서 **모든 뱃지 띠의 좌변이
 * 199.8px 로 같아졌다.** 종전엔 겹친 행만 183.8px 로 홀로 튀어나와 칩 열이
 * 들쭉날쭉했다 — 가격 x 는 그때도 멀쩡했으므로 이건 칩 열 자체의 정렬 문제였다.
 *
 * 반환형이 **배열이 아니라 `| null`** 인 것이 이 규칙의 집행 지점이다 — 배열이면
 * "최대 하나" 가 관례로만 남아 조용히 둘로 돌아간다. 타입이 그걸 막는다.
 *
 * 고=저(하루 종일 한 가격에만 체결 — 상한가 직행 등)면 `고` 가 남는다. 둘이 같은
 * 값이라 어느 쪽을 골라도 가격은 같고, 표 순서가 그 선택을 이미 못박고 있다.
 *
 * `null`(사다리 한쪽이 비어 중간값이 없는 행)을 **여기서** 흡수한다 — 호출부마다
 * 가드를 두면 `중` 행만 조건이 갈려 다시 어긋난다. 소수 중간값(`.5`)은 정수
 * 시/고/저와 `===` 가 성립하지 않아 **분기 없이** 걸러진다(저가주에선 상시다).
 */
function dayMarker(price: number | null, summary: LiveTradeSummary): PriceMarker | null {
  if (price === null || price <= 0) return null;
  const hit = DAY_MARKERS.find((m) => {
    const v = m.of(summary);
    return v !== null && price === v;
  });
  return hit ? { label: hit.label, bg: hit.bg } : null;
}

/**
 * 요약표(시작·최고·최저) 값에 붙는 칩 — **사다리에 그 가격의 행이 없을 때만** 낸다.
 *
 * 사다리는 현재가 위아래 10틱씩만 덮는다(호가 단위 기준 대략 ±1~2%). 일중 변동이
 * 그보다 크면 시·고·저가 사다리 밖으로 나가 **칩을 붙일 행 자체가 사라진다** —
 * 실측 2026-08-24 삼성전자(-8.5%)는 사다리 252,500~262,500 인데 고가 272,000 ·
 * 시가 271,500 이 전부 밖이었다. 드문 경우가 아니라 변동성 있는 날의 기본값이다.
 *
 * 규칙은 **배타**다: 한 값의 칩은 사다리 아니면 요약표, 한쪽에만 있다. 그래서
 * 「요약표에 칩이 떴다」가 곧 「그 값은 지금 사다리에 없다」를 뜻하고, 칩의
 * **등장 자체가 신호**다(상시 표시면 아무것도 말하지 않는다).
 *
 * ⚠ 예외 하나: 사다리 칩은 **한 가격에 하나**라(`dayMarker`, 고 > 저 > 시) 시가가
 * 고가·저가와 **같은 가격**이고 그 가격이 사다리에 있으면 `시` 칩은 어디에도 안
 * 뜬다 — 그 행은 `고`(또는 `저`)로 라벨되고 `시작` 행은 값만 남는다. 의도한
 * 동작이다: 같은 가격을 두 번 라벨하지 않는 것이 우선순위 규칙의 요점이다.
 *
 * ⚠ `onScreen` 에 **중간값을 포함**한다 — `중` 행도 가격을 그리는 자리이므로,
 * 빠뜨리면 사다리에 칩이 있는데 요약표에도 뜨는 이중 표시가 된다.
 */
function offLadderChip(
  label: '시' | '고' | '저',
  summary: LiveTradeSummary,
  onScreen: ReadonlySet<number>,
): PriceMarker | undefined {
  const m = DAY_MARKERS.find((x) => x.label === label);
  const v = m ? m.of(summary) : null;
  if (!m || v === null || v <= 0 || onScreen.has(v)) return undefined;
  return { label: m.label, bg: m.bg };
}

/**
 * 가격 숫자 왼쪽에 얹는 뱃지 띠 — **시/고/저 칩과 `중` 뱃지가 같은 슬롯을 쓴다.**
 *
 * 둘을 각각 `absolute right-full` 로 두면 같은 자리에 겹친다. 그래서 한 flex 행으로
 * 합치고 `중` 을 **숫자에 가장 가깝게**(오른쪽 끝) 둔다 — 칩이 없을 때 `중` 의 x 가
 * 종전과 정확히 같고, 칩은 왼쪽으로 자란다(`PriceCell` 이 이미 쓰던 방향).
 *
 * ⚠ 띠 전체가 `absolute` 라 **레이아웃 폭을 차지하지 않는다. 이것이 계약이다** —
 * flex 아이템이면 뱃지 유무에 따라 가격 숫자가 밀려 호가 행끼리 x 가 어긋난다
 * (실측 정수 mid +10.5px). 기준 요소(가격 span)가 `relative` 여야 성립한다.
 *
 * 두 행이 이 마크업을 각자 복제하던 것을 합친 것이다 — 갈라져 있으면 한쪽만
 * 손봤을 때 같은 자리의 뱃지가 조용히 다른 모양이 된다.
 */
function PriceBadges({ marker, mid = false }: { marker: PriceMarker | null; mid?: boolean }) {
  if (marker === null && !mid) return null;
  return (
    <span data-price-badges="" className="absolute right-full top-1/2 mr-1 flex -translate-y-1/2 gap-0.5">
      {marker && <span className={`flex ${BADGE_CLS} text-white ${marker.bg}`}>{marker.label}</span>}
      {mid && <span className={`flex ${BADGE_CLS} bg-bg-subtle text-fg-dim`}>중</span>}
    </span>
  );
}

/**
 * `중` 행 — 매도10과 매수10 사이 한 행(ADR-0140 §7.1). 값은 `bookMidPrice`.
 *
 * `중` 뱃지가 **"주문 가능한 호가가 아니다"** 를 뜻한다 — 중간값은 호가 단위 밖일 수
 * 있다(호가단위 1,000원인데 1,319,500). 키움 앱이 쓰는 규약을 그대로 따른다.
 *
 * 교차(매수1 ≥ 매도1)에도 **경고·색·문구를 넣지 않는다.** 교차는 데이터 오류가 아니라
 * 서로 다른 거래소의 주문이 자동으로 만나지 않는다는 구조 그 자체이고, 상시 교차하는
 * 종목에선 경고가 늘 켜져 **없는 문제를 찾게 만든다**(ADR-0140 §7.1).
 *
 * 상단 `border-t` 는 매도 블록과의 분리선(3열 공통 y) — 좌우 빈칸도 같은 선을 갖는다.
 * 하단 분리는 첫 매수 행의 `topDivider` 가 이미 담당한다.
 *
 * ⚠ `중` 뱃지는 **`PriceCell` 의 시/고/저 칩과 같은 슬롯**을 가격 span 안에서
 * 공유한다(`PriceBadges`) — 뱃지가 flex 아이템이면 폭을 차지해 가격 숫자가
 * 다른 호가 행보다 오른쪽으로 밀린다(실측 정수 mid +10.5px). 소수 mid 는 `.5` 가
 * 늘린 폭이 중앙정렬에서 되밀어 +4.9px 로 **작게 보였을 뿐** 같은 결함이었다.
 * 뺀 뒤에는 flex 내용물이 PriceCell 과 동일(가격 + gap + 7ch 등락률)해 **정수 mid 는
 * x 가 정확히 일치**한다. 소수 mid 만 `.5` 폭의 절반(≈5px)만큼 왼쪽에 남는데, 이걸
 * 없애려면 모든 호가 행에 소수 자리를 예약해야 해서 가격축 전체가 움직인다 —
 * 한 행의 5px 잔차보다 비싸다.
 */
function MidPriceRow({
  price,
  baselinePrice,
  marker = null,
  boxed = false,
}: {
  price: number | null;
  baselinePrice: number | null;
  /** 당일 시/고/저 칩(최대 하나) — **`PriceCell` 과 같은 규약**이다. 이 배선이 빠져 있으면
   *  중간값이 사다리 20행 어디에도 없는 가격일 때(넓은 스프레드·교차) 화면에
   *  가격은 보이는데 라벨만 사라진다 — 그 행이 그 가격을 그리는 유일한 자리다.
   *  ADR-0140 §7.1 이 이 행을 추가할 때 칩·박스 배선이 따라오지 않았다. */
  marker?: PriceMarker | null;
  /** 현재가가 중간값과 같을 때의 박스 — 역시 `PriceCell` 과 같은 규약. */
  boxed?: boolean;
}) {
  const color = price !== null ? dirClass(price, baselinePrice) : 'text-fg-dim';
  const pct =
    price !== null && baselinePrice !== null && baselinePrice > 0
      ? ((price - baselinePrice) / baselinePrice) * 100
      : null;
  // 경계선(border-t)과 현재가 박스(border)를 **다른 요소**에 그린다 — 한 요소면
  // 둘 다 4변 border-color 를 걸어 박스 윗변만 색이 갈린다. `PriceCell` 이
  // `topDivider` 에서 이미 겪고 래퍼로 푼 문제이고, 래퍼(1px) + 셀(ROW_H−1) = ROW_H
  // 라 22행 정렬 계약은 그대로다. 식별자(testid·divider·mid-price)는 **래퍼에**
  // 남긴다 — 기존 단언들이 이 행을 지목하는 앵커다.
  return (
    <div
      data-testid="book-mid-row"
      data-book-divider=""
      data-mid-price={price ?? ''}
      className="border-t border-border"
    >
      <div
        className={`flex items-baseline justify-center gap-1.5 px-2 ${
          boxed ? 'rounded-md border border-fg-dim' : ''
        }`}
        style={{ height: ROW_H - 1 }}
      >
        <span className={`relative font-data text-[0.75rem] tabular-nums ${color}`}>
          <PriceBadges marker={marker} mid />
          {price !== null ? price.toLocaleString('ko-KR') : '−'}
        </span>
        {/* 폭 계약은 PriceCell 과 동일(7ch) — 등락률 유무로 가격 x 가 흔들리지 않는다. */}
        <span
          className={`font-data text-badge tabular-nums text-left opacity-70 ${color}`}
          style={{ minWidth: '7ch' }}
        >
          {pct !== null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}
        </span>
      </div>
    </div>
  );
}

function PriceCell({
  price,
  baselinePrice,
  boxed,
  marker = null,
  topDivider = false,
}: {
  price: number;
  baselinePrice: number | null;
  boxed: boolean;
  /** 당일 시/고/저 칩(`dayMarker`, 최대 하나) — 가격 숫자 왼쪽 바로 옆(가격 span
   *  기준 right-full)에 absolute 로 얹는다. 셀 좌단 고정이던 것을 가격 옆으로 당겨
   *  중앙에 가깝게 읽히되, 가격 x 정렬은 여전히 불변(칩 유무가 가격 위치를 안 바꾼다). */
  marker?: PriceMarker | null;
  /** 매수 1호가 행에만 true — 매도/매수 경계선(3열 공통 y). */
  topDivider?: boolean;
}) {
  const color = dirClass(price, baselinePrice);
  const pct =
    baselinePrice !== null && baselinePrice > 0
      ? ((price - baselinePrice) / baselinePrice) * 100
      : null;
  // 가격과 등락률은 **한 덩어리**로 읽혀야 한다 — justify-between 으로 컬럼 양 끝에
  // 밀어놓으면 폭이 넓을수록 시선이 끊긴다. 가운데 모아 붙이고, 등락률에 최소폭을
  // 줘서 값 길이(-0.19% ↔ +30.00%)가 달라져도 가격 우측 끝이 흔들리지 않게 한다.
  // 위계는 크기로 준다: 가격 12px intent(0.75rem) vs 등락률 badge(8.5px) — 보조
  // 정보라 뚜렷하게 작아야 가격이 먼저 읽힌다(이전 sm/xs 는 1px 차라 위계가 없었다).
  const cell = (
    <div
      className={`relative flex items-baseline justify-center gap-1.5 px-2 ${
        boxed ? 'rounded-md border border-fg-dim' : ''
      }`}
      style={{ height: topDivider ? ROW_H - 1 : ROW_H }}
    >
      <span className={`relative font-data text-[0.75rem] tabular-nums ${color}`}>
        <PriceBadges marker={marker} />
        {price > 0 ? price.toLocaleString('ko-KR') : ''}
      </span>
      {pct !== null && price > 0 && (
        <span
          className={`font-data text-badge tabular-nums text-left opacity-70 ${color}`}
          // 7ch = "+30.00%"(최장). 좌측정렬 + 최장 기준 고정폭이라야 부호 없는
          // 보합행("0.00%")만 중앙정렬이 흔들려 오른쪽으로 밀리는 일이 없다.
          style={{ minWidth: '7ch' }}
        >
          {pct > 0 ? '+' : ''}
          {pct.toFixed(2)}%
        </span>
      )}
    </div>
  );
  if (!topDivider) return cell;
  // 경계선을 셀 **바깥** 래퍼에 그린다 — 현재가가 매수 1호가인 흔한 경우 boxed 의
  // 전체 테두리와 같은 요소를 다투게 되어 박스 윗변만 색이 갈린다. 래퍼(1px) +
  // 셀(ROW_H-1) = ROW_H 라 21행 정렬 계약은 유지된다.
  return <div data-book-divider="" className="border-t border-border">{cell}</div>;
}

/** 깊이 막대. ask 는 가격축 쪽(우)에서, bid 는 가격축 쪽(좌)에서 자란다. */
function QtyBar({
  qty,
  maxQty,
  side,
  badge,
  topDivider = false,
  dimClass = '',
}: {
  qty: number;
  maxQty: number;
  side: 'ask' | 'bid';
  badge: OrderbookDeltaBadge | null;
  /** stale 딤 유틸리티. **래퍼가 아니라 셀에 직접 얹는다** — 잔량 바를 묶는
   *  래퍼를 하나 두면 3열 22행 정렬 계약을 세는 자리(BookPanel.test.tsx 의
   *  자식 수 단언)가 깨진다. 구조를 안 바꾸는 것이 이 prop 의 존재 이유다. */
  dimClass?: string;
  /** 매수 1호가 바에만 true — 매도/매수 경계선(3열 공통 y). 여기선 boxed 같은
   *  경쟁 테두리가 없어 셀에 직접 border-t 를 얹는다(border-box 라 22px 유지). */
  topDivider?: boolean;
}) {
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  const isAsk = side === 'ask';
  return (
    <div
      data-book-divider={topDivider ? '' : undefined}
      className={`relative flex items-center ${
        topDivider ? 'border-t border-border' : ''
      } ${dimClass}`}
      style={{ height: ROW_H }}
    >
      {/* Toss식 알약형 깊이 막대(2026-07-23 실측 이식). 행(ROW_H)보다 위아래
          BAR_INSET 만큼 짧게 두어 생기는 흰 여백이 곧 행 사이 "구분선" 역할 —
          Toss 호가는 실제 border 선이 없고(측정 확인), 라운드 막대+여백으로 분리한다.
          라운드는 가격축 반대편 끝(매도=좌, 매수=우)에만 준다. */}
      <span
        className={`absolute rounded-md ${isAsk ? 'right-0 rounded-r-none' : 'left-0 rounded-l-none'}`}
        style={{
          top: BAR_INSET,
          bottom: BAR_INSET,
          width: `${widthPct}%`,
          background: isAsk ? 'var(--bar-ask)' : 'var(--bar-bid)',
        }}
      />
      {/* 뱃지는 잔량과 같은 flex 안에 둔다(#746 절대배치 겹침 교훈). 가격축 반대편에
          붙여 잔량 숫자가 항상 가격 쪽에 남게 한다. */}
      <span
        className={`relative flex w-full items-baseline gap-1.5 px-2 font-data text-sm tabular-nums ${
          isAsk ? '' : 'flex-row-reverse'
        }`}
      >
        {/* 뱃지는 막대 **바깥쪽 끝**(가격축 반대편)에 붙인다 — 잔량 쪽에 두면 긴 막대가
            뱃지를 덮어 읽을 수 없다. 잔량은 flex-1 로 남은 폭을 먹고 가격축 쪽으로
            정렬하므로 뱃지가 없어도 위치가 흔들리지 않는다. */}
        {/* 증감 색 = KRX 컨벤션(증가 빨강 / 감소 파랑, priceDirClass SSOT).
            차트 오버레이(DepthDeltaOverlay)는 계속 teal/fuchsia 다 — 거긴 호가
            히트맵(빨강·파랑)과 같은 셀에 겹쳐 켜지므로 색이 충돌하면 판독 불가라
            다른 색조가 필수지만, 이 뱃지는 겹치는 레이어가 없다. */}
        {badge !== null && (
          <span className={`shrink-0 text-2xs ${priceDirClass(badge.delta)}`}>
            {badge.delta > 0 ? '+' : '−'}
            {Math.abs(badge.delta).toLocaleString('ko-KR')}
          </span>
        )}
        {/* 잔량 숫자 색은 side 별 토큰(--qty-ask/--qty-bid). 증감 뱃지의
            priceDirClass 와는 **다른 축**이다 — 뱃지는 delta 의 부호(늘었나/줄었나),
            이건 호가의 방향(매도냐/매수냐)이라 같은 행에서 두 색이 어긋날 수 있고
            그게 정상이다(매수 잔량이 줄면 빨간 숫자 옆에 파란 −뱃지). */}
        <span className={`flex-1 ${isAsk ? 'text-right text-qty-ask' : 'text-left text-qty-bid'}`}>
          {qty > 0 ? qty.toLocaleString('ko-KR') : ''}
        </span>
      </span>
    </div>
  );
}

/** VI 예상가의 정적기준가 — 우선순위: 당일 VI 발동가(해제 단일가 ≈ 발동가 근사)
 *  → 시가(0B FID 16) → 전일 기준가(ka10001, 장전 폴백). VI 가 한 번 걸리면
 *  기준가가 시가에서 해제 단일가로 갱신되는데 그 값을 주는 API 가 없어 발동가로
 *  근사한다(연구 문서 §4 — 다음 이벤트가 오면 자가 보정). */
function viBase(
  vi: LiveViEvent | null,
  summary: LiveTradeSummary,
  limits: BookStockLimits | null,
): number | null {
  return vi?.trigger_price ?? summary.dayOpen ?? limits?.base_price ?? null;
}

/** 상승/하강 VI 행 — 평시엔 계산한 예상 발동가, 해당 방향 발동 중엔 발동가 강조.
 *  예상가는 계산값이라 dim 톤(실측 수신값과 시각적으로 구분 — 상한가 행과 대비). */
function ViRow({
  dir,
  vi,
  base,
}: {
  dir: 'up' | 'down';
  vi: LiveViEvent | null;
  base: number | null;
}) {
  const active = vi?.active === true && vi.direction === dir;
  const dirColor = dir === 'up' ? 'text-price-up' : 'text-price-down';
  if (active) {
    return (
      <SummaryRow
        label={dir === 'up' ? '상승VI' : '하강VI'}
        value={`${fmtOr(vi.trigger_price)} 발동`}
        color={dirColor}
        highlight
      />
    );
  }
  const expected =
    base !== null ? (dir === 'up' ? viExpectedUp(base) : viExpectedDown(base)) : null;
  return (
    <SummaryRow
      label={dir === 'up' ? '상승VI' : '하강VI'}
      value={fmtOr(expected)}
      color={expected !== null ? 'text-fg-dim' : undefined}
    />
  );
}

/** divider=그룹 시작. border-box 라 border-t 가 행 높이를 늘리지 않는다(정렬 유지).
 *  대시(미수신/미제공)는 실데이터와 같은 대비로 찍히면 "깨진 값"처럼 읽혀 dim.
 *  highlight = 상태 행(VI 발동 중) — 배경 틴트로 "지금 벌어지는 일"을 표시. */
function SummaryRow({
  label,
  value,
  color,
  divider,
  highlight,
  chip,
}: {
  label: string;
  value: string;
  color?: string;
  divider?: boolean;
  highlight?: boolean;
  /** 시/고/저 칩 — 그 값이 사다리 밖일 때만 온다(`offLadderChip`). 값 **왼쪽**에
   *  붙어 오른쪽 정렬된 숫자의 우측 끝을 흔들지 않는다. */
  chip?: PriceMarker;
}) {
  const empty = value === '−';
  return (
    <div
      className={`flex items-center justify-between gap-3 px-2 ${
        divider ? 'border-t border-border' : ''
      } ${highlight ? 'bg-bg-subtle' : ''}`}
      style={{ height: ROW_H }}
    >
      {/* nowrap = 행 높이 계약(11행=매수 바 정렬)의 CSS 방어선. 폭이 모자라면
          개행으로 계약을 뚫는 대신 그리드의 가로 스크롤로 전가한다(min-w 철학). */}
      <span className="whitespace-nowrap text-xs text-fg-dim">{label}</span>
      <span
        className={`flex items-center whitespace-nowrap font-data text-sm tabular-nums ${
          color ?? (empty ? 'text-fg-dimmer' : 'text-fg')
        }`}
      >
        {chip && <span className={`mr-1 flex ${BADGE_CLS} text-white ${chip.bg}`}>{chip.label}</span>}
        {value}
      </span>
    </div>
  );
}

function TotalQtyStrip({
  totals,
  maskRatio,
  afterHoursTotals,
  afterHoursLabel,
  dimClass = '',
}: {
  /** 그릴 총잔량. **어느 출처를 쓸지는 호출부가 정한다** — 시간외 값이 있으면 그것,
   *  없으면 사다리 스냅샷의 총잔량. 여기서 `snapshot` 을 직접 받아 `?? ` 로 떨어뜨리면
   *  "사다리도 없고 시간외도 없다" 는 **불가능한 상태가 타입에 생기고**, 그 폴백이
   *  0 을 조용히 삼켜 `0fr 0fr` 격자가 된다. 두 호출부 모두 non-null 을 보장한다. */
  totals: { ask: number; bid: number };
  maskRatio: boolean;
  /** 값이 아니라 **출처 판정**용이다 — non-null 이면 위 `totals` 가 시간외 값이라는 뜻이라
   *  라벨·체결량 줄이 붙는다. 사다리(정규장 마지막 값)와 합이 안 맞는 것을 설명하는 장치. */
  afterHoursTotals: AfterHoursTotals | null;
  afterHoursLabel: string;
  /** stale 딤. **총잔량은 출처가 둘이라 조건도 둘**이다 — 시간외 값이면 커서
   *  스팟 경로를 타지 않으므로 호출부가 빈 문자열을 넘긴다. */
  dimClass?: string;
}) {
  // 시간외 총잔량이 오면 그걸 쓴다 — 위 사다리(정규장 15:30 마지막 스냅샷)는
  // 그대로 두고 이 스트립만 살아 움직인다. KRX-only 종목은 15:30 에 0D 가 끊겨
  // 여기가 시간외의 유일한 호가 신호다(Props.afterHoursTotals 주석). 사다리가 아예
  // 없는 장전 08:30–08:40 에는 이 스트립이 **패널의 유일한 내용**이 된다.
  const isAfterHours = afterHoursTotals !== null;
  const { ask, bid } = totals;
  return (
    <div data-testid="book-total-strip" className={`border-t border-border ${dimClass}`}>
      {maskRatio ? (
        <div className="h-1 bg-bg-subtle" data-testid="book-total-masked" />
      ) : (
        <div
          className="grid h-1"
          style={{ gridTemplateColumns: `${ask}fr ${bid}fr` }}
          data-testid="book-total-fill"
        >
          <div style={{ background: 'var(--price-down)' }} />
          <div style={{ background: 'var(--price-up)' }} />
        </div>
      )}
      {/* 중앙 라벨("판매대기 · 구매대기")은 사용자 요청으로 삭제(2026-07-21) —
          색·좌우 위치가 의미를 이미 전달하고, aria-label 이 접근성을 담당한다.
          아래 "시간외"는 그 상시 라벨의 부활이 아니라 **조건부 출처 표시**다:
          이 숫자만 시간외 값이고 위 사다리는 정규장 마지막 값이라 둘의 합이
          안 맞는데, 그 불일치를 설명하는 장치가 이것뿐이다. */}
      <div className="flex items-center justify-between px-2 py-1">
        <span
          aria-label={`${isAfterHours ? `${afterHoursLabel} ` : ''}매도총잔량 ${ask.toLocaleString('ko-KR')}`}
          className="font-data text-sm tabular-nums text-price-down"
        >
          {ask.toLocaleString('ko-KR')}
        </span>
        {isAfterHours && (
          // 여기 라벨 아래에 누적 체결량("체결 17,474")을 두 줄로 쌓았었다. **뺐다**
          // (사용자 결정 2026-08-19) — 그것을 두었던 근거가 무효가 됐기 때문이다.
          // 원 주석은 "시간외 단일가는 개별 체결 내역이 없어 이 누적이 그 구간에
          // 움직이는 유일한 체결 신호" 였는데, #1417 이 체결창에 주기별 개별 행을
          // 그리면서 그 자리가 생겼다. 총**잔량** 스트립에 체결**량**이 얹혀 있던
          // 것은 자리가 없던 시절의 임시방편이었고, 이제는 축이 다른 숫자가 같은
          // 줄에 섞여 있는 것일 뿐이다.
          <span
            className="whitespace-nowrap text-xs text-fg-dim"
            data-testid="book-total-after-hours"
          >
            {afterHoursLabel}
          </span>
        )}
        <span
          aria-label={`${isAfterHours ? `${afterHoursLabel} ` : ''}매수총잔량 ${bid.toLocaleString('ko-KR')}`}
          className="font-data text-sm tabular-nums text-price-up"
        >
          {bid.toLocaleString('ko-KR')}
        </span>
      </div>
    </div>
  );
}

function PanelState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-card text-xs text-fg-dim">
      <span className="font-data">{children}</span>
    </div>
  );
}

function fmtOr(n: number | null): string {
  return n === null ? '−' : n.toLocaleString('ko-KR');
}

/** 250일 최고/최저 한 행 표기. 둘 다 없으면 대시 하나(dim 판정과 일치).
 *  슬래시 양옆 공백 없음 — 6자리 고가 종목("304,000/181,100" 15자)이 우측 열
 *  190px 하한에 들어가기 위한 폭 예산이다(공백 2개 ≈ 10px 차이가 경계를 가른다). */
function fmtHighLow(limits: BookStockLimits | null): string {
  const hi = limits?.high_250 ?? null;
  const lo = limits?.low_250 ?? null;
  if (hi === null && lo === null) return '−';
  return `${fmtOr(hi)}/${fmtOr(lo)}`;
}

/** 46,689,105 → "4,668만" (좁은 열에서 줄바꿈되지 않도록 만 단위 절사). */
function fmtVolumeKo(n: number | null): string {
  if (n === null) return '−';
  const man = Math.floor(n / 10_000);
  return man > 0 ? `${man.toLocaleString('ko-KR')}만` : n.toLocaleString('ko-KR');
}

/** 거래대금(원) → "824억" · "1조 2,345억" (거래량 만 단위 포맷과 대칭인 억/조 절사).
 *  1억 미만 초저유동성 종목은 만 단위로 강등 — 최장 "1조 2,345억"(8자)이라
 *  250일 행(15자)보다 짧아 우측 열 폭 예산(#776) 안이다. */
function fmtAmountKo(won: number | null): string {
  if (won === null) return '−';
  const eok = Math.floor(won / 100_000_000);
  if (eok >= 10_000) {
    const jo = Math.floor(eok / 10_000);
    const rest = eok % 10_000;
    return rest > 0 ? `${jo}조 ${rest.toLocaleString('ko-KR')}억` : `${jo}조`;
  }
  if (eok > 0) return `${eok.toLocaleString('ko-KR')}억`;
  const man = Math.floor(won / 10_000);
  return man > 0 ? `${man.toLocaleString('ko-KR')}만` : won.toLocaleString('ko-KR');
}
