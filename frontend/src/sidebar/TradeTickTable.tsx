/**
 * 체결창 — WS 체결 틱을 발생 순서대로 한 줄씩 보여주는 표.
 *
 * 4열(시각·체결가·체결량·구분). 최신이 맨 위이고, 행 배경의 깊이 막대는 표시
 * 구간 최대 체결량 대비 비율이라 대량 체결이 눈에 띈다(수량 필터 대신 시각적
 * 강조를 택했다 — 필터는 임계값 영속 배선을 요구하고, 걸러낸 체결이 안 보이면
 * 흐름 판독이 되레 어려워진다).
 *
 * 색 규약(DESIGN.md KRX 컨벤션): 체결가는 **전일 종가 대비** 방향색으로 —
 * OrderbookTable 과 같은 기준이라 두 창을 나란히 놓아도 색이 어긋나지 않는다.
 * 전일 종가를 모를 때만(prev_close 미수신) 매수/매도 구분색으로 폴백한다.
 *
 * 깊이 막대는 --tint-price-*(10%)를 쓴다 — 호가창의 --bar-*(28%)가 아니다.
 * 호가창은 2열이라 우측에서 자라는 막대가 수량 칸에만 걸쳤지만, 여기는 4열이라
 * 같은 막대가 우측 끝 '구분' 라벨 뒤를 덮어 텍스트를 읽기 어렵게 만든다
 * (실데이터 렌더로 발견). DESIGN.md 가 tint 계열을 "buy/sell depth bar" 로
 * 정의한 것도 이 용도다.
 */
import { priceDirClass } from '../ui/priceDir';
import { unixMsToKSTClock } from '../util/time';
import { SidebarState } from './SidebarSurface';
import type { TradeTick, TradeTickView } from '../live/tradeTicks';

/** 4열 트랙 SSOT — 헤더와 본문이 어긋나면 표가 아니라 목록이 된다. */
const COLS = 'grid-cols-[6.2em_1fr_1fr_2.6em]';

export default function TradeTickTable({ view }: { view: TradeTickView }) {
  if (view.ticks.length === 0) {
    return <SidebarState>체결 데이터 없음</SidebarState>;
  }
  return (
    <div className="font-mono text-sm tabular-nums">
      <div
        className={`sticky top-0 z-10 grid ${COLS} gap-2 border-b border-border bg-bg-card px-2.5 py-1 text-[10.5px] text-fg-dimmer`}
      >
        <span>시각</span>
        <span className="text-right">체결가</span>
        <span className="text-right">체결량</span>
        <span className="text-right">구분</span>
      </div>
      {view.ticks.map((t) => (
        <Row key={t.key} tick={t} prevClose={view.prevClose} maxQty={view.maxQty} />
      ))}
    </div>
  );
}

function Row({
  tick,
  prevClose,
  maxQty,
}: {
  tick: TradeTick;
  prevClose: number | null;
  maxQty: number;
}) {
  const { tMs, price, qty, side } = tick;
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  // side==0 은 동시호가·장전 체결 — 방향이 없으므로 막대도 구분 라벨도 중립.
  const barBg = side > 0
    ? 'var(--tint-price-up)'
    : side < 0 ? 'var(--tint-price-down)' : 'transparent';
  const priceColor = prevClose != null && prevClose > 0
    ? priceDirClass(price - prevClose)
    : priceDirClass(side);
  return (
    <div className={`relative grid ${COLS} gap-2 px-2.5 py-0.5`}>
      <span
        className="absolute inset-y-0 right-0"
        style={{ width: `${widthPct}%`, background: barBg }}
      />
      <span className="relative text-fg-dimmer">{unixMsToKSTClock(tMs)}</span>
      <span className={`relative text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      <span className="relative text-right text-fg-dim">{qty.toLocaleString('ko-KR')}</span>
      <span className={`relative text-right text-[11px] ${priceDirClass(side)}`}>
        {side > 0 ? '매수' : side < 0 ? '매도' : '—'}
      </span>
    </div>
  );
}
