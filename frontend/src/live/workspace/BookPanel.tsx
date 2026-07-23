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
/** 깊이 막대 상하 여백(px). 막대 높이 = ROW_H − 2·BAR_INSET(=16px). 이 여백이
 *  Toss식 행간 "구분선"(흰 띠)을 만든다 — Toss 24/40 비율을 밀도 높은 22px 행에 축소. */
const BAR_INSET = 3;
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
      {/* 예상체결 배너(동시호가에만) — 호가창 전폭 중앙. 평시엔 null 이라 높이 0. */}
      <ExpectedFillBanner
        price={snapshot.exp_price ?? 0}
        qty={snapshot.exp_qty ?? 0}
        baselinePrice={baselinePrice}
      />
      {/* min-w 가 load-bearing: 창을 좁히면 좌우 열이 0 으로 수렴해 잔량 숫자가
          겹친다. 최소 폭을 잡아 두면 대신 가로 스크롤이 생긴다(깨지지 않는다).
          우측 열의 190px 하한도 같은 계약 — fr 의 auto-min 은 콘텐츠를 min-content
          까지 쥐어짜는데, 요약 값이 최장인 경우(250일 "304,000/181,100" 6자리
          고가 종목)가 딱 그 경계라 개행으로 행 높이 계약이 깨졌었다(NAVER 실사례). */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid min-w-[560px] grid-cols-[1fr_minmax(140px,180px)_minmax(190px,1fr)]">
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
            {/* 9행 = 3열 바닥 정렬: 좌측(여백1+매도10+체결강도1+체결9) = 중앙(여백1+
                호가20) = 우측(요약11+매수10) = 21행. 11행이던 시절 좌측만 2행
                삐져나와 하단이 어긋났다. */}
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
              방향(가격축 쪽으로 자람)과 정렬이 담당한다(C안). */}
          <div className="flex flex-col">
            <div style={{ height: ROW_H }} />
            {asksDesc.map((l, i) => (
              <PriceCell
                key={`pa-${snapshot.ask.length - i}`}
                price={l.price}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
                markers={priceMarkers(l.price, summary)}
              />
            ))}
            {bids.map((l, i) => (
              <PriceCell
                key={`pb-${i}`}
                price={l.price}
                baselinePrice={baselinePrice}
                boxed={lastPrice !== null && l.price === lastPrice}
                markers={priceMarkers(l.price, summary)}
                topDivider={i === 0}
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
            {bids.map((l, i) => (
              <QtyBar
                key={`b-${i}`}
                qty={l.qty}
                maxQty={maxQty}
                side="bid"
                badge={deltaBadges?.get(`b:${l.price}`) ?? null}
                topDivider={i === 0}
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

/** 예상체결가·량(키움 0D FID 23/24) — 호가창 **전폭 상단 배너**, 내용 중앙 정렬.
 *  동시호가(단일가) 구간에만 백엔드가 값을 실어 오므로 둘 다 >0 일 때만 렌더하고,
 *  평시엔 null(높이 0)이라 평상시 호가창에 영향이 없다. 가격은 전일종가 대비 방향색. */
function ExpectedFillBanner({
  price,
  qty,
  baselinePrice,
}: {
  price: number;
  qty: number;
  baselinePrice: number | null;
}) {
  if (price <= 0 || qty <= 0) return null;
  const color = dirClass(price, baselinePrice);
  return (
    <div
      className="flex items-baseline justify-center gap-6 bg-bg-card px-3 py-1.5"
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

/** 당일 시가·고가·저가와 일치하는 호가 행에 붙일 칩. 고=빨강·저=파랑(KRX 관습),
 *  시=중립 회색. 한 가격이 둘 이상(예: 시가=고가)이면 배열로 나란히 쌓는다. */
function priceMarkers(price: number, summary: LiveTradeSummary): { label: string; bg: string }[] {
  if (price <= 0) return [];
  const out: { label: string; bg: string }[] = [];
  if (summary.dayHigh !== null && price === summary.dayHigh) out.push({ label: '고', bg: 'bg-price-up' });
  if (summary.dayLow !== null && price === summary.dayLow) out.push({ label: '저', bg: 'bg-price-down' });
  if (summary.dayOpen !== null && price === summary.dayOpen) out.push({ label: '시', bg: 'bg-fg-dim' });
  return out;
}

function PriceCell({
  price,
  baselinePrice,
  boxed,
  markers = [],
  topDivider = false,
}: {
  price: number;
  baselinePrice: number | null;
  boxed: boolean;
  /** 당일 시/고/저 칩(priceMarkers) — 좌측 거터에 absolute 로 얹어 가격 정렬 불변. */
  markers?: { label: string; bg: string }[];
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
      {markers.length > 0 && (
        <span className="absolute left-1 top-1/2 flex -translate-y-1/2 gap-0.5">
          {markers.map((m) => (
            <span
              key={m.label}
              className={`flex items-center justify-center rounded-[3px] px-[3px] py-px font-ui text-[9px] font-semibold leading-none text-white ${m.bg}`}
            >
              {m.label}
            </span>
          ))}
        </span>
      )}
      <span className={`font-data text-[0.75rem] tabular-nums ${color}`}>
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
}: {
  qty: number;
  maxQty: number;
  side: 'ask' | 'bid';
  badge: OrderbookDeltaBadge | null;
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
      }`}
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
          <span className={`shrink-0 text-[10px] ${priceDirClass(badge.delta)}`}>
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
      {/* nowrap = 행 높이 계약(11행=매수 바 정렬)의 CSS 방어선. 폭이 모자라면
          개행으로 계약을 뚫는 대신 그리드의 가로 스크롤로 전가한다(min-w 철학). */}
      <span className="whitespace-nowrap text-xs text-fg-dim">{label}</span>
      <span
        className={`whitespace-nowrap font-data text-sm tabular-nums ${
          color ?? (empty ? 'text-fg-dimmer' : 'text-fg')
        }`}
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
    <div className="border-t border-border">
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
          색·좌우 위치가 의미를 이미 전달하고, aria-label 이 접근성을 담당한다. */}
      <div className="flex items-center justify-between px-2 py-1">
        <span
          aria-label={`매도총잔량 ${ask.toLocaleString('ko-KR')}`}
          className="font-data text-sm tabular-nums text-price-down"
        >
          {ask.toLocaleString('ko-KR')}
        </span>
        <span
          aria-label={`매수총잔량 ${bid.toLocaleString('ko-KR')}`}
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
    <div className="flex h-full w-full items-center justify-center bg-bg-card text-[11px] text-fg-dimmer">
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
