import type { OrderbookSnapshot } from '../api/types';
import { priceDirClass } from '../ui/priceDir';
import type { OrderbookDeltaBadges } from './orderbookDeltaBadges';
import { SidebarState } from './SidebarSurface';

type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  /** KRX 전일 종가(quote.baseline_price). 각 호가 가격을 이와 비교해 색을 정한다
   *  (>전일종가=빨강 / <=파랑 / ==회색). null(신규상장·미체결 등 예외)이면 매도/매수
   *  구분 색으로 폴백. replay 경로(StudyReferenceDetailPanel)는 미전달 → 폴백. */
  baselinePrice?: number | null;
  /** HTS식 순간 증감 뱃지(직전 스냅샷 대비, useOrderbookDeltaBadges 산출).
   *  라이브 latest 표시일 때만 전달 — 스팟 커서·replay 는 null/미전달(과거 시점에
   *  "방금 변화" 뱃지는 거짓이 된다). 색은 KRX 컨벤션(증가 빨강 / 감소 파랑) — 차트
   *  증감 지표의 유입/유출 색조와 의도적으로 다르다(DESIGN.md 2026-07-21). */
  deltaBadges?: OrderbookDeltaBadges | null;
};

export default function OrderbookTable({ snapshot, baselinePrice = null, deltaBadges = null }: Props) {
  if (snapshot === undefined) {
    return (
      <SidebarState>
        커서 위치 로딩 중…
      </SidebarState>
    );
  }
  if (snapshot === null) {
    return (
      <SidebarState>
        호가 데이터 없음
      </SidebarState>
    );
  }
  // Wire shape per ADR-0004: ask/bid each ship as length-10 arrays with
  // index 0 = best price. Rank is the (1-based) index.
  const asks = snapshot.ask;
  const bids = snapshot.bid;

  // Depth bar normalization across all 20 levels.
  const maxQty = Math.max(
    1,
    ...asks.map((l) => l.qty),
    ...bids.map((l) => l.qty),
  );

  // Asks displayed worst → best (top → bottom), so best ask sits directly
  // above best bid. Bids continue best → worst below.
  const displayedAsks = [...asks].reverse();

  return (
    <div className="font-mono text-sm tabular-nums">
      {displayedAsks.map((l, i) => (
        // i counts top→bottom across displayedAsks; reverse it for stable
        // keys tied to rank (best = 1).
        <Row
          key={`a-${asks.length - i}`}
          side="ask"
          price={l.price}
          qty={l.qty}
          maxQty={maxQty}
          baselinePrice={baselinePrice}
          badge={deltaBadges?.get(`a:${l.price}`) ?? null}
        />
      ))}
      {/* Divider marking the ask/bid boundary (best ask above, best bid below). */}
      <div role="separator" className="border-t border-border" />
      {bids.map((l, i) => (
        <Row
          key={`b-${i + 1}`}
          side="bid"
          price={l.price}
          qty={l.qty}
          maxQty={maxQty}
          baselinePrice={baselinePrice}
          badge={deltaBadges?.get(`b:${l.price}`) ?? null}
        />
      ))}
    </div>
  );
}

function Row({
  side,
  price,
  qty,
  maxQty,
  baselinePrice,
  badge,
}: {
  side: 'ask' | 'bid';
  price: number;
  qty: number;
  maxQty: number;
  baselinePrice: number | null;
  badge: { delta: number; atMs: number } | null;
}) {
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  const barBg     = side === 'ask' ? 'var(--bar-ask)' : 'var(--bar-bid)';
  // 가격 텍스트 색 = KRX 전일 종가 대비 방향(>전일종가=빨강 / <=파랑 / ==회색). baseline 이
  // 있으면 매도/매수 무관하게 전일 종가로 판정(급등주는 매수호가도 빨강). 없을 때만(예외)
  // 기존 매도=빨강/매수=파랑 폴백. 깊이 막대(barBg)는 매도/매수 물량 측 표시라 그대로 유지.
  const priceColor = baselinePrice != null && baselinePrice > 0
    ? priceDirClass(price - baselinePrice)
    : (side === 'ask' ? 'text-price-up' : 'text-price-down');
  // Depth bar grows from the qty column (right) inward, with a 0.18 → 0
  // gradient fade. Matches the 2026-05-20 approved mockup
  // (docs/superpowers/designs/2026-05-20-replay-viewer.html lines 379-384).
  return (
    <div className="relative grid grid-cols-[1fr_1fr] gap-3 px-2.5 py-0.5">
      <span
        className="absolute inset-y-0 right-0"
        style={{ width: `${widthPct}%`, background: barBg }}
      />
      <span className={`relative text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      {/* 잔량 셀 — 증감 뱃지는 같은 셀 왼쪽에 flex 로 두어 좁은 카드에서도 가격과
          겹치지 않는다(#746 절대배치 겹침 교훈). */}
      <span className="relative flex items-baseline justify-end gap-1.5">
        {/* 증감 색 = KRX 컨벤션(증가 빨강 / 감소 파랑) — /live 10호가 창 뱃지와
            같은 데이터·같은 의미라 색도 같이 간다(BookPanel 주석 참조). */}
        {badge !== null && (
          <span className={`text-[10px] ${priceDirClass(badge.delta)}`}>
            {badge.delta > 0 ? '+' : '−'}
            {Math.abs(badge.delta).toLocaleString('ko-KR')}
          </span>
        )}
        <span className="text-right text-fg-dim">{qty.toLocaleString('ko-KR')}</span>
      </span>
    </div>
  );
}
