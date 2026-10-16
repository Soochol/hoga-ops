/**
 * BookPanel — /live 워크스페이스 10호가 창 본문 (십자 배치).
 *
 * 레이아웃(참조 화면 구조):
 *
 *     [매도 잔량 바 ]  [ 가격+등락률 ]  [ 요약 패널  ]
 *     [체결강도·체결]  [ 가격+등락률 ]  [매수 잔량 바]
 *
 * 중앙 가격축을 좌우 4개 블록이 둘러싼다. 매도·매수는 각 10행 공간을 확보해
 * 유효 호가가 줄어도 경계를 중앙에 유지한다. 우측 매도 영역에는 요약 12항목을
 * 펼치고, 창이 좁으면 정보 버튼으로 상세를 연다.
 *
 * **전체 패널 소비처는 `DataWindow` 하나다.** 총잔량 스트립은 `OrderWindow`도 공유한다. 한때 `/study` 의 BookContent 와 공유하는 단일
 * 표면이었으나 그 페이지는 2026-08-23 에 삭제됐다 — 이 파일 곳곳의 주석이 아직
 * `/study` 를 "같은 패널을 쓰는 다른 화면" 으로 언급하는데, 그건 **왜 그 처리가
 * 그렇게 생겼는지의 내력**이지 지금 살아 있는 소비처가 아니다.
 */
import './BookPanel.css';
import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { BookScrollArea } from './BookScrollArea';
import { BookPriceAmount } from './BookPriceAmount';
import { bookDayMarkers, type BookPriceMarker } from './bookDayMarkers';
import type { OrderbookSnapshot } from '../../api/types';
import type { OrderbookDeltaBadges, OrderbookDeltaBadge } from '../../sidebar/orderbookDeltaBadges';
import type { LiveViEvent } from '../../api/liveViStatus';
import { priceDirClass } from '../../ui/priceDir';
import { useTextTooltip } from '../../ui/useTextTooltip';
import { viExpectedDown, viExpectedUp } from '../krxTick';
import type { AfterHoursTotals, LiveTradeSummary } from '../liveSidebarAdapters';
import type { BookSessionControl, BookSessionMode } from '../bookSessionMode';
import { otherBookSessionMode } from '../bookSessionMode';
import { BOOK_PANEL_COMPACT_GRID_COLS, BOOK_PANEL_COMPACT_MIN_W, BOOK_PANEL_GRID_COLS, BOOK_PANEL_MIN_W, BOOK_PANEL_PRICE_COL_W } from './bookPanelMetrics';

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
  /** Live 0D/0H sample with venue, trade-resumption and TTL lifecycle applied.
   * undefined keeps the snapshot source for cursor/stored/single-price displays. */
  expectedFill?: { price: number; qty: number | null } | null;
  /** HTS식 순간 증감 뱃지(#750, 직전 스냅샷 대비). 스팟 커서 중에는 null —
   *  과거 시점 위 "방금 변화"는 거짓 정보다. */
  deltaBadges?: OrderbookDeltaBadges | null;
  /** 상하한가·250일 최고/최저. null = 미로드/미제공 → 대시. */
  limits?: BookStockLimits | null;
  krxClose?: number | null;
  /** Raw close of the previous KRX session, independent of the ladder's baseline. */
  krxPreviousClose?: number | null;
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
   *                  유효한 가격만 표시한다
   *
   * 두 번째 모드의 라벨은 짧은 사다리의 출처가 시간외 시장임을 표시한다.
   */
  afterHoursLabel?: string;
  /**
   * 하단 스트립 중앙에 그릴 세션 표시(`bookSessionMode.bookSessionControl` 의 결과).
   *
   * 미지정이면 `none` — 종전의 조건부 "시간외" 출처 표시로 동작한다. 지금 이 패널을
   * 렌더하는 곳은 `DataWindow` 하나뿐이라 이 기본값을 타는 경로는 테스트뿐이지만,
   * 세션 개념이 **선택적**이라는 것이 이 prop 의 계약이다 — 갈래를 모르는 창
   * (`nxt_enabled` 미도착)이 오늘과 똑같이 동작하는 것도 이 기본값이 보장한다.
   */
  sessionControl?: BookSessionControl;
  /** 지금 그려지고 있는 사다리가 어느 장의 것인가. 라벨 선택에만 쓴다 — 사다리
   *  자체를 고르는 것은 호출부(`DataWindow`)의 일이다. */
  sessionMode?: BookSessionMode;
  /** 토글 클릭. 미지정이면 버튼이 그려져도 아무 일도 하지 않으므로, 갈래 A 를
   *  넘기는 호출부는 반드시 함께 넘긴다. */
  onSelectSessionMode?: (mode: BookSessionMode) => void;
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
/** 부분 호가에서도 매도·매수 각각 10행의 공간을 유지한다. */
const SUMMARY_ROWS = 10;

export default function BookPanel({
  snapshot,
  baselinePrice,
  summary,
  trades,
  maskRatio,
  lastPrice,
  expectedFill,
  deltaBadges = null,
  limits = null,
  krxClose = null,
  krxPreviousClose = null,
  vi = null,
  afterHoursTotals = null,
  afterHoursLabel = '시간외',
  sessionControl = { kind: 'none' },
  sessionMode = 'regular',
  onSelectSessionMode,
  stale = false,
}: Props) {
  const [infoOpen, setInfoOpen] = useState(false);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const infoId = useId();
  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    infoButtonRef.current?.focus({ preventScroll: true });
  }, []);
  const { ref: infoRef, style: infoStyle } = useAnchoredPopover<HTMLDivElement>(infoOpen, infoButtonRef, closeInfo, 260);
  // 스냅샷 파생 블록에만 얹는 딤. 값은 읽히되 확정이 아님을 말한다 — 전환은
  // DESIGN.md Motion 의 상태 전환 규격(150ms ease-in-out).
  const staleDim = `transition-opacity duration-150 ease-in-out${stale ? ' opacity-50' : ''}`;
  /** 갈래 A(토글 있음)에서 시간외를 보고 있는가 — 빈 상태 문구가 여기서 갈린다.
   *  갈래 B·모름에서는 `false` 라 종전 문구가 그대로 나온다. */
  const inAfterHoursMode = sessionControl.kind === 'toggle' && sessionMode === 'afterHours';
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
    if (afterHoursTotals === null) {
      // 시간외 모드에서 사다리가 없는 것은 **"호가 데이터 없음" 과 다른 사실**이다:
      // 장중이면 그 장이 아직 안 열렸다는 뜻이고, 18:00 이후면 벤더 창이 닫혔다는
      // 뜻이다. 정규장 데이터는 멀쩡히 있으므로 일반 문구는 화면과 모순된다.
      //
      // ⚠ **이 상태에서 세션 컨트롤이 특히 살아 있어야 한다.** 화면에 아무것도 없는
      // 상태라 사용자가 할 수 있는 유일한 행동이 "정규장으로 되돌리기" 인데, 그 수단이
      // 사라지면 막다른 길이 된다 — 이 기능이 애초에 고치려던 바로 그 상태다
      // (16:00 에 자동 전환된 뒤 되돌릴 수 없음).
      return (
        <div className="flex h-full flex-col bg-bg-card">
          <div className="flex min-h-0 flex-1">
            <PanelState>{inAfterHoursMode ? '시간외 호가 없음' : '호가 데이터 없음'}</PanelState>
          </div>
          <SessionOnlyStrip
            control={sessionControl}
            mode={sessionMode}
            onSelect={onSelectSessionMode}
          />
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col bg-bg-card">
        <div className="flex min-h-0 flex-1">
          {/* "호가 데이터 없음"(위 분기)과 문구를 갈라 둔다 — 여기는 아래 스트립에
              살아 있는 숫자가 그려지는 상태라, 같은 문구면 화면과 모순된다.
              시간외 모드의 문구가 다른 이유: 그 구간(15:40–16:00 종가매매)은 당일
              종가 단일 가격이라 **사다리라는 개념이 없다** — 결손이 아니다. */}
          <PanelState>
            {inAfterHoursMode
              ? '시간외 사다리 없음 (총잔량만)'
              : '정규장 호가 없음 (시간외 잔량만 수신 중)'}
          </PanelState>
        </div>
        <TotalQtyStrip
          totals={afterHoursTotals}
          maskRatio={maskRatio}
          afterHoursTotals={afterHoursTotals}
          afterHoursLabel={afterHoursLabel}
          sessionControl={sessionControl}
          sessionMode={sessionMode}
          onSelectSessionMode={onSelectSessionMode}
        />
      </div>
    );
  }

  // 벤더의 10칸/시간외 5칸 패딩은 호가가 아니다. 가격이 있는 단계만
  // 양쪽 열에서 함께 걸러 잔량·가격 정렬을 유지한다. 유효 가격의 잔량 0은 남긴다.
  const asksDesc = snapshot.ask.filter((l) => Number.isFinite(l.price) && l.price > 0).reverse();
  const bids = snapshot.bid.filter((l) => Number.isFinite(l.price) && l.price > 0);
  const dayMarkers = bookDayMarkers([...asksDesc, ...bids].map(level => level.price), summary);
  const summaryHeight = ROW_H * SUMMARY_ROWS;
  const askPadding = ROW_H * Math.max(0, SUMMARY_ROWS - asksDesc.length);
  const bidPadding = ROW_H * Math.max(0, SUMMARY_ROWS - bids.length);
  const maxQty = Math.max(
    1,
    ...asksDesc.map((l) => l.qty),
    ...bids.map((l) => l.qty),
  );

  return (
    <div className="book-panel flex h-full flex-col bg-bg-card">
      {/* 실시간 0D/0H 예상 표본 또는 커서·시간외 스냅샷. 없으면 높이를 차지하지 않는다. */}
      <ExpectedFillBanner
        price={expectedFill === undefined ? snapshot.exp_price ?? 0 : expectedFill?.price ?? 0}
        qty={expectedFill === undefined ? snapshot.exp_qty ?? 0 : expectedFill?.qty ?? null}
        baselinePrice={baselinePrice}
        dimClass={staleDim}
      />
      {/* 컨테이너 폭으로 요약만 팝오버로 옮긴다. 압축 하한 아래는 가로 스크롤하며
          가격·등락률·잔량·체결의 폰트와 행 정렬을 유지한다. */}
      <BookScrollArea>
        <div
          className="book-panel-grid grid"
          style={{ '--book-wide-min-w': `${BOOK_PANEL_MIN_W}px`, '--book-wide-cols': BOOK_PANEL_GRID_COLS,
            '--book-compact-min-w': `${BOOK_PANEL_COMPACT_MIN_W}px`, '--book-compact-cols': BOOK_PANEL_COMPACT_GRID_COLS,
            '--book-price-w': `${BOOK_PANEL_PRICE_COL_W}px` } as React.CSSProperties}
        >
          {/* 좌: 매도 잔량 바 → 체결강도 → 체결 리스트 */}
          <div className="flex flex-col" style={{ paddingTop: askPadding }}>
            {asksDesc.map((l, i) => (
              <QtyBar
                key={`a-${i}`}
                qty={l.qty}
                maxQty={maxQty}
                side="ask"
                badge={deltaBadges?.get(`a:${l.price}`) ?? null}
                dimClass={staleDim}
              />
            ))}
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
            {/* 체결은 최신 9건을 유지한다. 매수 호가가 적어도 체결 내역은 자르지 않는다. */}
            {trades.slice(0, 9).map((t, i) => (
              <div key={i} className="book-trade-row flex items-center justify-between gap-1 px-2" style={{ height: ROW_H }}>
                <span
                  className={`shrink-0 font-data text-sm tabular-nums ${dirClass(t.price, baselinePrice)}`}
                >
                  {t.price.toLocaleString('ko-KR')}
                </span>
                <span
                  title={t.qty.toLocaleString('ko-KR')}
                  className={`min-w-0 truncate font-data text-sm tabular-nums ${
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
              열 전체가 스냅샷 파생(가격)이라 열 자체에 딤을 건다. */}
          <div className={`flex flex-col ${staleDim}`} style={{ paddingTop: askPadding, paddingBottom: bids.length > 0 ? bidPadding : 0 }}>
            {asksDesc.map((l, i) => (
              <PriceCell
                key={`pa-${i}`}
                price={l.price}
                qty={l.qty}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
                marker={dayMarkers.get(l.price) ?? null}
              />
            ))}
            {bids.map((l, i) => (
              <PriceCell
                key={`pb-${i}`}
                price={l.price}
                qty={l.qty}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
                marker={dayMarkers.get(l.price) ?? null}
                topDivider={i === 0}
              />
            ))}
            {bids.length === 0 && <div aria-hidden="true" data-book-divider="" className="border-t border-border" style={{ height: summaryHeight }} />}
          </div>

          {/* 우: 고정 매도 10행의 요약 슬롯 → 매수 잔량 바 */}
          <div className="flex flex-col" style={{ paddingBottom: bids.length > 0 ? bidPadding : 0 }}>
            <div className="book-summary-slot" style={{ height: summaryHeight }}>
              <div className="book-inline-summary">
                <BookSummary summary={summary} baselinePrice={baselinePrice}
                  limits={limits} krxClose={krxClose} krxPreviousClose={krxPreviousClose} vi={vi} height={summaryHeight} />
              </div>
              <div className="book-compact-info">
                <button ref={infoButtonRef} type="button" aria-label="종목 상세 정보" aria-haspopup="dialog"
                  aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined}
                  onClick={() => setInfoOpen(open => !open)}>정보</button>
              </div>
            </div>
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
            {bids.length === 0 && <div aria-hidden="true" data-book-divider="" className="border-t border-border" style={{ height: summaryHeight }} />}
          </div>
        </div>
      </BookScrollArea>
      {infoOpen && createPortal(<div ref={infoRef} id={infoId} role="dialog" aria-label="종목 상세 정보" className="book-info-popover font-data" style={infoStyle}>
        <div className="book-info-heading"><span>종목 상세 정보</span><button type="button" aria-label="상세 정보 닫기" onClick={closeInfo}>닫기</button></div>
        <BookSummary summary={summary} baselinePrice={baselinePrice}
          limits={limits} krxClose={krxClose} krxPreviousClose={krxPreviousClose} vi={vi} height={264} />
      </div>, document.body)}
      {/* 총잔량은 **출처가 둘**이라 딤 조건도 둘이다. 시간외(0E·ka10087) 값이면
          커서 스팟 경로를 타지 않으므로 흐리지 않는다 — 사다리가 낡았다는 말이
          그 숫자에는 해당하지 않는다. */}
      <TotalQtyStrip
        totals={afterHoursTotals ?? { ask: snapshot.tot_ask, bid: snapshot.tot_bid }}
        maskRatio={maskRatio}
        afterHoursTotals={afterHoursTotals}
        afterHoursLabel={afterHoursLabel}
        sessionControl={sessionControl}
        sessionMode={sessionMode}
        onSelectSessionMode={onSelectSessionMode}
        dimClass={afterHoursTotals === null ? staleDim : ''}
      />
    </div>
  );
}

/** 10호가·주문창이 공유하는 시세 상세 정보. 계좌 잔고는 포함하지 않는다. */
export function BookSummary({
  summary, baselinePrice, limits = null, krxClose = null, krxPreviousClose = null, vi = null,
  height = ROW_H * SUMMARY_ROWS,
}: {
  summary: LiveTradeSummary;
  baselinePrice: number | null;
  limits?: BookStockLimits | null;
  krxClose?: number | null;
  krxPreviousClose?: number | null;
  vi?: LiveViEvent | null;
  height?: number;
}) {
  return (
    <div className="book-summary flex flex-col" data-testid="book-summary" style={{ height, '--book-summary-row-height': `${height / 12}px` } as React.CSSProperties}>
      <SummaryRow
        label="시작"
        value={fmtOr(summary.dayOpen)}
        tooltipPrice={summary.dayOpen}
        tooltipBaseline={krxPreviousClose}
      />
      <SummaryRow
        label="최고"
        value={fmtOr(summary.dayHigh)}
        tooltipPrice={summary.dayHigh}
        tooltipBaseline={krxPreviousClose}
        color={summary.dayHigh !== null ? dirClass(summary.dayHigh, baselinePrice) : undefined}
      />
      <SummaryRow
        label="최저"
        value={fmtOr(summary.dayLow)}
        tooltipPrice={summary.dayLow}
        tooltipBaseline={krxPreviousClose}
        color={summary.dayLow !== null ? dirClass(summary.dayLow, baselinePrice) : undefined}
      />
      <SummaryRow label="KRX종가" value={fmtOr(krxClose)} />
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
      <div className="book-summary-extra">
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
            라벨도 250일로 정직하게 쓴다. 최고/최저를 한 행에 표시한다. */}
        <SummaryRow label="250일" value={fmtHighLow(limits)} />
      </div>
    </div>
  );
}

/** 전일종가 대비 방향 색. baseline 이 없으면(예외) 중립. */
function dirClass(price: number, baselinePrice: number | null): string {
  if (baselinePrice === null || baselinePrice <= 0) return 'text-fg-dim';
  return priceDirClass(price - baselinePrice);
}

/** 예상체결가·량(키움 0D/0H 또는 시간외 조회) — 호가창 전폭 상단 배너, 중앙 정렬.
 *  qty=null은 수량 미제공인 가격 전용 표본이다. 0·불량 수량인 쌍은 숨긴다.
 *  가격은 전일종가 대비 방향색이다. */
export function ExpectedFillBanner({
  price,
  qty,
  baselinePrice,
  dimClass = '',
}: {
  price: number;
  qty: number | null;
  baselinePrice: number | null;
  /** stale 딤 — `exp_price`/`exp_qty` 는 스냅샷 필드라 사다리와 함께 흐려진다. */
  dimClass?: string;
}) {
  if (!Number.isFinite(price) || price <= 0
    || (qty !== null && (!Number.isFinite(qty) || qty <= 0))) return null;
  const color = dirClass(price, baselinePrice);
  return (
    <div
      className={`book-expected-fill flex shrink-0 flex-wrap items-baseline justify-center gap-x-6 gap-y-1.5 bg-bg-card px-3 py-1.5 ${dimClass}`}
      data-testid="book-expected-fill"
    >
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-xs text-fg-dim">예상 체결가</span>
        <span className={`font-data text-sm tabular-nums ${color}`}>
          {price.toLocaleString('ko-KR')}원
        </span>
      </span>
      {qty !== null && <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-xs text-fg-dim">예상 체결량</span>
        <span className="font-data text-sm tabular-nums text-fg">
          {qty.toLocaleString('ko-KR')}
        </span>
      </span>}
    </div>
  );
}

/** 호가 가격 왼쪽 뱃지 한 알의 공통 형태. */
const BADGE_CLS =
  'items-center justify-center rounded-sm px-[3px] py-px font-ui text-badge font-semibold leading-none';

/** 가격 span의 상시 왼쪽 여백(24px) 안에 놓는다. ADR-0170의 absolute 배치를
 * 유지하되 칩 폭도 가격 열 예산에 포함한다. 칩 없는 행에도 같은 여백이 있으므로
 * 가격 x 정렬은 변하지 않고, 긴 가격에서도 잔량 열을 침범하지 않는다. */
function PriceBadges({ marker }: { marker: BookPriceMarker | null }) {
  const tooltip = useTextTooltip(marker?.tooltip ?? '', 500, 'book-price-tooltip');
  if (marker === null) return null;
  return (
    <>
      <span data-price-badges="" className="absolute left-0 top-1/2 flex w-5 -translate-y-1/2 justify-end">
        <span className={`flex ${BADGE_CLS} text-white ${marker.bg}`} role="img" aria-label={marker.tooltip}
          tabIndex={0} aria-describedby={tooltip.id}
          onMouseEnter={event => tooltip.show(event.currentTarget)} onMouseLeave={tooltip.hide}
          onFocus={event => tooltip.showOnFocus(event.currentTarget)} onBlur={tooltip.hide}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); tooltip.hide(); } }}
        >{marker.label}</span>
      </span>
      {tooltip.tooltip}
    </>
  );
}

/** 10호가·주문창의 가격 왼쪽 시·고·저 칩과 우선순위를 공유한다. */
export function BookDayMarker({ marker }: { marker: BookPriceMarker | null }) {
  return <PriceBadges marker={marker} />;
}

/** 같은 가격의 잔량 유입·유출 표시. 10호가와 주문창이 같은 색·부호를 쓴다. */
export function BookQtyDelta({ badge }: { badge: OrderbookDeltaBadge | null }) {
  if (badge === null) return null;
  const text = `${badge.delta > 0 ? '+' : '−'}${Math.abs(badge.delta).toLocaleString('ko-KR')}`;
  return <span title={text} className={`book-qty-delta shrink-0 text-2xs ${priceDirClass(badge.delta)}`}>{text}</span>;
}

function PriceCell({
  price,
  qty,
  baselinePrice,
  boxed,
  marker = null,
  topDivider = false,
}: {
  price: number;
  qty: number;
  baselinePrice: number | null;
  boxed: boolean;
  /** 당일 시/고/저 칩(최대 하나). 모든 가격 행의 고정 여백에 놓는다. */
  marker?: BookPriceMarker | null;
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
        boxed ? 'rounded-md border border-fg-dim bg-tint-selection font-semibold' : ''
      }`}
      style={{ height: topDivider ? ROW_H - 1 : ROW_H }}
    >
      <span className={`relative shrink-0 whitespace-nowrap pl-6 font-data text-base tabular-nums ${color}`}>
        <PriceBadges marker={marker} />
        <BookPriceAmount price={price} qty={qty} />
      </span>
      {pct !== null && price > 0 && (
        <span
          className={`shrink-0 whitespace-nowrap font-data text-badge tabular-nums text-left opacity-70 ${color}`}
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
  // 셀(ROW_H-1) = ROW_H 라 3열 20행 정렬 계약은 유지된다.
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
   *  래퍼를 하나 두면 3열 20행 정렬 계약을 세는 자리(BookPanel.test.tsx 의
   *  자식 수 단언)가 깨진다. 구조를 안 바꾸는 것이 이 prop 의 존재 이유다. */
  dimClass?: string;
  /** 매수 1호가 바에만 true — 매도/매수 경계선(3열 공통 y). 여기선 boxed 같은
   *  경쟁 테두리가 없어 셀에 직접 border-t 를 얹는다(border-box 라 22px 유지).
   *  ADR-0170 이 `중` 행을 지운 뒤로 이 선이 그 경계의 **유일한** 표시다. */
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
            겹치는 레이어가 없어 관례색을 그대로 쓴다 — 차트 위에 같은 셀로 겹쳐 그리던
            증감 오버레이는 teal/fuchsia 를 썼지만(히트맵과의 색 충돌 회피), 2026-08-25
            에 제거됐다. */}
        <BookQtyDelta badge={badge} />
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
  tooltipPrice = null,
  tooltipBaseline = null,
}: {
  label: string;
  value: string;
  color?: string;
  divider?: boolean;
  highlight?: boolean;
  tooltipPrice?: number | null;
  tooltipBaseline?: number | null;
}) {
  const empty = value === '−';
  const pct = tooltipPrice != null && Number.isFinite(tooltipPrice) && tooltipPrice > 0
    && tooltipBaseline != null && Number.isFinite(tooltipBaseline) && tooltipBaseline > 0
    ? (tooltipPrice / tooltipBaseline - 1) * 100 : null;
  // Normalize rounded zero so a tiny negative change cannot display "-0.00%".
  const roundedPct = pct == null ? null : Number(pct.toFixed(2));
  const tooltipText = roundedPct == null ? '' : `전일 KRX 종가 대비 ${roundedPct > 0 ? '+' : ''}${roundedPct.toFixed(2)}%`;
  const tip = useTextTooltip(tooltipText, 500, `book-price-tooltip ${priceDirClass(pct ?? 0)}`);
  return (
    <div
      className={`flex items-center justify-between gap-3 px-2 ${
        divider ? 'border-t border-border' : ''
      } ${highlight ? 'bg-bg-subtle' : ''}`}
      style={{ height: 'var(--book-summary-row-height, 22px)' }}
    >
      {/* nowrap = 상세정보 전체 높이와 매수 바 정렬을 지키는 CSS 방어선. 폭이 모자라면
          개행으로 계약을 뚫는 대신 그리드의 가로 스크롤로 전가한다(min-w 철학). */}
      <span className="whitespace-nowrap text-xs text-fg-dim">{label}</span>
      <span
        aria-label={tooltipText ? `${label} 가격 ${value}원` : undefined}
        aria-describedby={tip.id}
        tabIndex={tooltipText ? 0 : undefined}
        onMouseEnter={e => tip.show(e.currentTarget)} onMouseLeave={tip.hide}
        onFocus={e => tip.showOnFocus(e.currentTarget)} onBlur={tip.hide}
        onKeyDown={e => { if (e.key === 'Escape' && tooltipText) { e.stopPropagation(); tip.hide(); } }}
        className={`flex items-center whitespace-nowrap font-data text-sm tabular-nums ${
          color ?? (empty ? 'text-fg-dimmer' : 'text-fg')
        }`}
      >
        {value}
      </span>
      {tip.tooltip}
    </div>
  );
}

export function TotalQtyStrip({
  totals,
  maskRatio,
  afterHoursTotals,
  afterHoursLabel,
  sessionControl,
  sessionMode,
  onSelectSessionMode,
  dimClass = '',
}: {
  /** 스트립 중앙에 그릴 세션 선택기. `none` 이면 종전의 조건부 출처 표시로 폴백한다 —
   *  `nxt_enabled` 를 모르는 창에서 오늘과 같이 동작해야 하기 때문이다. */
  sessionControl: BookSessionControl;
  sessionMode: BookSessionMode;
  onSelectSessionMode?: (mode: BookSessionMode) => void;
  /** 그릴 총잔량. **어느 출처를 쓸지는 호출부가 정한다** — 시간외 값이 있으면 그것,
   *  없으면 사다리 스냅샷의 총잔량. 여기서 `snapshot` 을 직접 받아 `?? ` 로 떨어뜨리면
   *  "사다리도 없고 시간외도 없다" 는 **불가능한 상태가 타입에 생기고**, 그 폴백이
   *  0 을 조용히 삼켜 `0fr 0fr` 격자가 된다. 각 호출부가 non-null 을 보장한다. */
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
          지금 그 자리에 있는 것은 **세션 선택기**다(`BookSessionCenter`). 원래는
          "시간외" 조건부 출처 표시(`fallbackLabel`)였고 그것이 설명하던 불일치는
          "사다리는 정규장 15:30 · 총잔량만 시간외" 였다.
          ⚠ **그 불일치는 2026-08-28 에 돌아왔다** — 15:40–16:00 의 정규장 모드가
          다시 그 상태다(`DataWindow` 의 `afterHoursTotals`). 갈래 A 에서는 이 자리를
          토글이 차지해 `fallbackLabel` 이 그려지지 않으므로, 설명 하중은 토글의
          `regularLabel`('정규장 · 잔량 시간외')이 진다. 갈래 없음(`none`)에서는
          종전대로 `fallbackLabel` 이 그 일을 한다. 나머지 하중은 16:00–18:00 의 빈
          바깥 5행 설명이고, 그건 시간외 선택 라벨이 그대로 진다. */}
      <div className="flex items-center justify-between px-2 py-1">
        <span
          aria-label={`${isAfterHours ? `${afterHoursLabel} ` : ''}매도총잔량 ${ask.toLocaleString('ko-KR')}`}
          className="font-data text-sm tabular-nums text-price-down"
        >
          {ask.toLocaleString('ko-KR')}
        </span>
        {/* 여기 라벨 아래에 누적 체결량("체결 17,474")을 두 줄로 쌓았었다. **뺐다**
            (사용자 결정 2026-08-19) — 그것을 두었던 근거가 무효가 됐기 때문이다.
            원 주석은 "시간외 단일가는 개별 체결 내역이 없어 이 누적이 그 구간에
            움직이는 유일한 체결 신호" 였는데, #1417 이 체결창에 주기별 개별 행을
            그리면서 그 자리가 생겼다. */}
        <BookSessionCenter
          control={sessionControl}
          mode={sessionMode}
          onSelect={onSelectSessionMode}
          fallbackLabel={isAfterHours ? afterHoursLabel : null}
        />
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

/**
 * 총잔량 스트립 중앙의 세션 표시 — 갈래에 따라 **버튼이거나 텍스트다**.
 *
 * 지금 보고 있는 장의 이름 **하나만** 그린다(두 개를 나란히 두지 않는다). 자리가
 * 총잔량 두 숫자 사이라 좁고, 참조 화면(토스)도 현재 상태 하나를 밑줄로 보이고
 * 누르면 전환하는 규약이다.
 *
 * **밑줄이 곧 "누를 수 있다" 의 신호다.** 그래서 갈래 B(NXT)는 밑줄 없는 텍스트로
 * 그린다 — 클릭 안 되는 것에 밑줄을 주면 "왜 안 눌리지" 가 된다.
 */
function BookSessionCenter({
  control,
  mode,
  onSelect,
  fallbackLabel,
}: {
  control: BookSessionControl;
  mode: BookSessionMode;
  onSelect?: (mode: BookSessionMode) => void;
  /** `control.kind === 'none'` 일 때의 종전 동작 — 시간외 총잔량이면 그 라벨. */
  fallbackLabel: string | null;
}) {
  if (control.kind === 'toggle') {
    const labelFor = (m: BookSessionMode) =>
      m === 'regular' ? control.regularLabel : control.afterHoursLabel;
    const next = otherBookSessionMode(mode);
    return (
      <button
        type="button"
        onClick={() => onSelect?.(next)}
        // 라벨만으로는 "지금 이 장을 보고 있다" 인지 "누르면 이 장으로 간다" 인지
        // 알 수 없다 — 스크린리더에는 둘 다 말한다.
        aria-label={`${labelFor(mode)} 호가 표시 중 — 누르면 ${labelFor(next)}`}
        title={`${labelFor(next)} 보기`}
        className="whitespace-nowrap text-xs text-fg-dim underline decoration-dotted underline-offset-2 transition-colors duration-150 ease-in-out hover:text-fg"
        data-testid="book-session-toggle"
        data-mode={mode}
      >
        {labelFor(mode)}
      </button>
    );
  }
  if (control.kind === 'label') {
    return (
      <span
        className="whitespace-nowrap text-xs text-fg-dim"
        data-testid="book-session-label"
      >
        {control.label}
      </span>
    );
  }
  if (fallbackLabel === null) return null;
  return (
    <span className="whitespace-nowrap text-xs text-fg-dim" data-testid="book-total-after-hours">
      {fallbackLabel}
    </span>
  );
}

/**
 * 세션 컨트롤만 있는 하단 바 — **사다리도 총잔량도 없을 때** 쓴다.
 *
 * `TotalQtyStrip` 을 재사용할 수 없다: 그쪽은 그릴 총잔량이 있다는 전제(non-null 계약)
 * 위에 서 있고, 없을 때 0 을 넣으면 `0fr 0fr` 격자가 된다.
 *
 * **왜 따로 만들 값어치가 있는가**: 컨트롤의 수명이 총잔량의 수명에 묶여 있었다.
 * 하단 스트립은 원래 총잔량을 그리는 자리라 총잔량이 없으면 통째로 건너뛰는 것이
 * 옳았는데, 거기에 세션 컨트롤을 얹으면서 **독립적인 두 가지가 한 조건을 공유**하게
 * 됐다(2026-08-27 실측: 장 마감 후 시간외 모드에서 토글이 통째로 사라져 정규장으로
 * 되돌아갈 수 없었다).
 *
 * 갈래가 없으면(`none`) 아무것도 그리지 않는다 — 그때는 종전처럼 빈 화면이 맞다.
 */
function SessionOnlyStrip({
  control,
  mode,
  onSelect,
}: {
  control: BookSessionControl;
  mode: BookSessionMode;
  onSelect?: (mode: BookSessionMode) => void;
}) {
  if (control.kind === 'none') return null;
  return (
    <div
      className="flex items-center justify-center border-t border-border px-2 py-1"
      data-testid="book-session-only-strip"
    >
      <BookSessionCenter control={control} mode={mode} onSelect={onSelect} fallbackLabel={null} />
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
