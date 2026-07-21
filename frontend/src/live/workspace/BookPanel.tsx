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
 * 좁은 사이드바용 2열 표(sidebar/OrderbookTable)는 `/study` replay 가 계속 쓰므로
 * 건드리지 않는다. 이 패널은 /live 워크스페이스 전용이다.
 */
import type { OrderbookSnapshot } from '../../api/types';
import {
  DEPTH_DELTA_DEFAULT_IN_COLOR,
  DEPTH_DELTA_DEFAULT_OUT_COLOR,
} from '../../state/liveIndicatorsPersistence';
import type { OrderbookDeltaBadges, OrderbookDeltaBadge } from '../../sidebar/orderbookDeltaBadges';
import type { LiveViEvent } from '../../api/liveViStatus';
import { priceDirClass } from '../../ui/priceDir';
import { viExpectedDown, viExpectedUp } from '../krxTick';
import type { LiveTradeSummary } from '../liveSidebarAdapters';

/** 체결 리스트 한 줄. */
export type BookTrade = { price: number; qty: number; side: number };

/** 상하한가·기준가·250일 최고/최저 — /api/live/stock-limits(키움 ka10001) 부분집합.
 *  당일 고정값이라 스팟 커서에서도 유효하다(요약 지표와 달리 비우지 않는다).
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
};

const ROW_H = 22; // DESIGN.md — Orderbook table row 22px
/** 요약 패널 행 수 = 상한가 1 + 매도 10. 매수 바 정렬의 근거라 상수로 못박는다. */
const SUMMARY_ROWS = 11;

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
}: Props) {
  if (snapshot === undefined) return <PanelState>커서 위치 로딩 중…</PanelState>;
  if (snapshot === null) return <PanelState>호가 데이터 없음</PanelState>;

  const asksDesc = [...snapshot.ask].reverse(); // 높은 가격이 위
  const bids = snapshot.bid;
  const maxQty = Math.max(
    1,
    ...snapshot.ask.map((l) => l.qty),
    ...snapshot.bid.map((l) => l.qty),
  );

  return (
    <div className="flex h-full flex-col bg-bg-card">
      {/* min-w 가 load-bearing: 창을 좁히면 좌우 1fr 이 0 으로 수렴해 잔량 숫자가
          겹친다. 최소 폭을 잡아 두면 대신 가로 스크롤이 생긴다(깨지지 않는다). */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid min-w-[560px] grid-cols-[1fr_minmax(140px,180px)_1fr]">
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
              />
            ))}
            <div
              className="flex items-center justify-between border-t border-border px-2"
              style={{ height: ROW_H }}
            >
              <span className="text-xs text-fg-dim">체결강도</span>
              <span
                className={`font-mono text-sm tabular-nums ${
                  summary.fillStrengthPct === null ? 'text-fg-dimmer' : 'text-fg'
                }`}
              >
                {summary.fillStrengthPct === null
                  ? '−'
                  : `${summary.fillStrengthPct.toFixed(2)}%`}
              </span>
            </div>
            {trades.slice(0, 11).map((t, i) => (
              <div key={i} className="flex items-center justify-between px-2" style={{ height: ROW_H }}>
                <span
                  className={`font-mono text-sm tabular-nums ${dirClass(t.price, baselinePrice)}`}
                >
                  {t.price.toLocaleString('ko-KR')}
                </span>
                <span
                  className={`font-mono text-sm tabular-nums ${
                    t.side > 0 ? 'text-price-up' : t.side < 0 ? 'text-price-down' : 'text-fg-dim'
                  }`}
                >
                  {t.qty.toLocaleString('ko-KR')}
                </span>
              </div>
            ))}
          </div>

          {/* 중앙: 가격축 */}
          <div className="flex flex-col border-x border-border">
            <div style={{ height: ROW_H }} />
            {asksDesc.map((l, i) => (
              <PriceCell
                key={`pa-${snapshot.ask.length - i}`}
                price={l.price}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
              />
            ))}
            {bids.map((l, i) => (
              <PriceCell
                key={`pb-${i}`}
                price={l.price}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
              />
            ))}
          </div>

          {/* 우: 요약 패널(11행 고정) → 매수 잔량 바 */}
          <div className="flex flex-col">
            <div className="flex flex-col" style={{ height: ROW_H * SUMMARY_ROWS }}>
              <SummaryRow label="시작" value={fmtOr(summary.dayOpen)} />
              <SummaryRow
                label="최고"
                value={fmtOr(summary.dayHigh)}
                color={summary.dayHigh !== null ? dirClass(summary.dayHigh, baselinePrice) : undefined}
              />
              <SummaryRow
                label="최저"
                value={fmtOr(summary.dayLow)}
                color={summary.dayLow !== null ? dirClass(summary.dayLow, baselinePrice) : undefined}
              />
              <SummaryRow label="평균가" value={fmtOr(summary.vwap)} />
              <SummaryRow label="거래량" value={fmtVolumeKo(summary.cumVolume)} divider />
              <SummaryRow
                label="어제보다"
                value={summary.vsPrevVolumePct === null ? '−' : `${summary.vsPrevVolumePct.toFixed(2)}%`}
              />
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
            {bids.map((l, i) => (
              <QtyBar
                key={`b-${i}`}
                qty={l.qty}
                maxQty={maxQty}
                side="bid"
                badge={deltaBadges?.get(`b:${l.price}`) ?? null}
              />
            ))}
          </div>
        </div>
      </div>
      <TotalQtyStrip snapshot={snapshot} maskRatio={maskRatio} />
    </div>
  );
}

/** 전일종가 대비 방향 색. baseline 이 없으면(예외) 중립. */
function dirClass(price: number, baselinePrice: number | null): string {
  if (baselinePrice === null || baselinePrice <= 0) return 'text-fg-dim';
  return priceDirClass(price - baselinePrice);
}

function PriceCell({
  price,
  baselinePrice,
  boxed,
}: {
  price: number;
  baselinePrice: number | null;
  boxed: boolean;
}) {
  const color = dirClass(price, baselinePrice);
  const pct =
    baselinePrice !== null && baselinePrice > 0
      ? ((price - baselinePrice) / baselinePrice) * 100
      : null;
  // 가격과 등락률은 **한 덩어리**로 읽혀야 한다 — justify-between 으로 컬럼 양 끝에
  // 밀어놓으면 폭이 넓을수록 시선이 끊긴다. 가운데 모아 붙이고, 등락률에 최소폭을
  // 줘서 값 길이(-0.19% ↔ +30.00%)가 달라져도 가격 우측 끝이 흔들리지 않게 한다.
  // 위계는 크기로 준다: 가격 base(13px) vs 등락률 badge(8.5px) — 보조 정보라
  // 뚜렷하게 작아야 가격이 먼저 읽힌다(이전 sm/xs 는 1px 차라 위계가 없었다).
  return (
    <div
      className={`flex items-baseline justify-center gap-1.5 px-2 ${
        boxed ? 'rounded-md border border-fg-dim' : ''
      }`}
      style={{ height: ROW_H }}
    >
      <span className={`font-mono text-base tabular-nums ${color}`}>
        {price > 0 ? price.toLocaleString('ko-KR') : ''}
      </span>
      {pct !== null && price > 0 && (
        <span
          className={`font-mono text-badge tabular-nums text-left opacity-70 ${color}`}
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
}

/** 깊이 막대. ask 는 가격축 쪽(우)에서, bid 는 가격축 쪽(좌)에서 자란다. */
function QtyBar({
  qty,
  maxQty,
  side,
  badge,
}: {
  qty: number;
  maxQty: number;
  side: 'ask' | 'bid';
  badge: OrderbookDeltaBadge | null;
}) {
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  const isAsk = side === 'ask';
  return (
    <div className="relative flex items-center" style={{ height: ROW_H }}>
      <span
        className={`absolute inset-y-px ${isAsk ? 'right-0' : 'left-0'}`}
        style={{ width: `${widthPct}%`, background: isAsk ? 'var(--bar-ask)' : 'var(--bar-bid)' }}
      />
      {/* 뱃지는 잔량과 같은 flex 안에 둔다(#746 절대배치 겹침 교훈). 가격축 반대편에
          붙여 잔량 숫자가 항상 가격 쪽에 남게 한다. */}
      <span
        className={`relative flex w-full items-baseline gap-1.5 px-2 font-mono text-sm tabular-nums ${
          isAsk ? '' : 'flex-row-reverse'
        }`}
      >
        {/* 뱃지는 막대 **바깥쪽 끝**(가격축 반대편)에 붙인다 — 잔량 쪽에 두면 긴 막대가
            뱃지를 덮어 읽을 수 없다. 잔량은 flex-1 로 남은 폭을 먹고 가격축 쪽으로
            정렬하므로 뱃지가 없어도 위치가 흔들리지 않는다. */}
        {badge !== null && (
          <span
            key={badge.atMs}
            className="book-delta-flash shrink-0 text-[10px]"
            style={{
              color: badge.delta > 0 ? DEPTH_DELTA_DEFAULT_IN_COLOR : DEPTH_DELTA_DEFAULT_OUT_COLOR,
            }}
          >
            {badge.delta > 0 ? '+' : '−'}
            {Math.abs(badge.delta).toLocaleString('ko-KR')}
          </span>
        )}
        <span className={`flex-1 text-fg-dim ${isAsk ? 'text-right' : 'text-left'}`}>
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
}: {
  label: string;
  value: string;
  color?: string;
  divider?: boolean;
  highlight?: boolean;
}) {
  const empty = value === '−';
  return (
    <div
      className={`flex items-center justify-between gap-3 px-2 ${
        divider ? 'border-t border-border' : ''
      } ${highlight ? 'bg-bg-subtle' : ''}`}
      style={{ height: ROW_H }}
    >
      <span className="text-xs text-fg-dim">{label}</span>
      <span
        className={`font-mono text-sm tabular-nums ${color ?? (empty ? 'text-fg-dimmer' : 'text-fg')}`}
      >
        {value}
      </span>
    </div>
  );
}

function TotalQtyStrip({
  snapshot,
  maskRatio,
}: {
  snapshot: OrderbookSnapshot;
  maskRatio: boolean;
}) {
  const ask = snapshot.tot_ask;
  const bid = snapshot.tot_bid;
  return (
    <div className="border-t border-border-strong">
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
      <div className="flex items-center justify-between px-2 py-1">
        <span
          aria-label={`매도총잔량 ${ask.toLocaleString('ko-KR')}`}
          className="font-mono text-sm tabular-nums text-price-down"
        >
          {ask.toLocaleString('ko-KR')}
        </span>
        <span className="text-xs text-fg-dimmer">판매대기 · 구매대기</span>
        <span
          aria-label={`매수총잔량 ${bid.toLocaleString('ko-KR')}`}
          className="font-mono text-sm tabular-nums text-price-up"
        >
          {bid.toLocaleString('ko-KR')}
        </span>
      </div>
    </div>
  );
}

function PanelState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-card text-[11px] text-fg-dimmer">
      <span className="font-mono">{children}</span>
    </div>
  );
}

function fmtOr(n: number | null): string {
  return n === null ? '−' : n.toLocaleString('ko-KR');
}

/** 250일 최고/최저 한 행 표기. 둘 다 없으면 대시 하나(dim 판정과 일치). */
function fmtHighLow(limits: BookStockLimits | null): string {
  const hi = limits?.high_250 ?? null;
  const lo = limits?.low_250 ?? null;
  if (hi === null && lo === null) return '−';
  return `${fmtOr(hi)} / ${fmtOr(lo)}`;
}

/** 46,689,105 → "4,668만" (좁은 열에서 줄바꿈되지 않도록 만 단위 절사). */
function fmtVolumeKo(n: number | null): string {
  if (n === null) return '−';
  const man = Math.floor(n / 10_000);
  return man > 0 ? `${man.toLocaleString('ko-KR')}만` : n.toLocaleString('ko-KR');
}
