/**
 * 체결창 — WS 체결 틱을 발생 순서대로 한 줄씩 보여주는 표.
 *
 * 3열(시각·체결가·체결량). 최신이 맨 위. 매수/매도는 별도 열이 아니라 **체결량
 * 글자색**으로 표현한다(KRX 컨벤션: 매수=빨강/매도=파랑, side==0 동시호가는 중립)
 * — 구분 열이 있던 초기안에서 열을 줄여 같은 폭에 정보 밀도를 높인 사용자 결정.
 *
 * 색 규약(DESIGN.md KRX 컨벤션): 체결가는 **전일 종가 대비** 방향색 —
 * OrderbookTable 과 같은 기준이라 두 창을 나란히 놓아도 색이 어긋나지 않는다.
 * 전일 종가를 모를 때만(prev_close 미수신) 매수/매도 구분색으로 폴백한다.
 *
 * 대량 체결 강조(⚙️ 설정 「체결창」): 체결가 × 체결량 ≥ 기준 금액이면 체결량
 * 칸 배경을 사용자 색으로 칠한다. 행 전체가 아니라 체결량 칸만 — 스캔 시선이
 * 머무는 칸이 물량 칸이고, 행 전체 강조는 깊이 막대와 겹쳐 서로 죽인다.
 *
 * 깊이 막대는 --tint-price-*(10%)를 쓴다 — 호가창의 --bar-*(28%)가 아니다.
 * 진한 막대는 우측 끝 칸의 텍스트 가독성을 해친다(실데이터 렌더로 발견).
 */
import { priceDirClass } from '../ui/priceDir';
import { unixMsToKSTClock } from '../util/time';
import { SidebarState } from './SidebarSurface';
import type { TradeTick, TradeTickView } from '../live/tradeTicks';

/** 3열 트랙 SSOT — 헤더와 본문이 어긋나면 표가 아니라 목록이 된다. */
const COLS = 'grid-cols-[6.2em_1fr_1fr]';

/** 강조 배경 알파(hex 2자리, ≈35%) — 저장 색은 6자리 hex 이므로 렌더 시 얹는다.
 *  불투명 배경은 다크/라이트 양 테마에서 글자색(매수/매도)을 잡아먹는다. */
const HIGHLIGHT_ALPHA_HEX = '59';

export interface TradeHighlightConfig {
  /** 원(₩) 단위 임계값 — 설정의 만원 값은 호출부에서 환산해 넘긴다. */
  thresholdWon: number;
  /** 6자리 hex. 알파는 이 컴포넌트가 얹는다. */
  color: string;
}

export default function TradeTickTable({
  view,
  highlight = null,
}: {
  view: TradeTickView;
  /** null = 강조 비활성(설정 토글 OFF). */
  highlight?: TradeHighlightConfig | null;
}) {
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
      </div>
      {view.ticks.map((t) => (
        <Row
          key={t.key}
          tick={t}
          prevClose={view.prevClose}
          maxQty={view.maxQty}
          highlight={highlight}
        />
      ))}
    </div>
  );
}

function Row({
  tick,
  prevClose,
  maxQty,
  highlight,
}: {
  tick: TradeTick;
  prevClose: number | null;
  maxQty: number;
  highlight: TradeHighlightConfig | null;
}) {
  const { tMs, price, qty, side } = tick;
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  // side==0 은 동시호가·장전 체결 — 방향이 없으므로 막대도 글자색도 중립.
  const barBg = side > 0 ? 'var(--tint-price-up)' : side < 0 ? 'var(--tint-price-down)' : 'transparent';
  const priceColor = prevClose != null && prevClose > 0
    ? priceDirClass(price - prevClose)
    : priceDirClass(side);
  const highlighted = highlight !== null && price * qty >= highlight.thresholdWon;
  return (
    <div className={`relative grid ${COLS} gap-2 px-2.5 py-0.5`}>
      <span
        className="absolute inset-y-0 right-0"
        style={{ width: `${widthPct}%`, background: barBg }}
      />
      <span className="relative text-fg-dimmer">{unixMsToKSTClock(tMs)}</span>
      <span className={`relative text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      <span
        data-testid={highlighted ? 'trade-qty-highlighted' : undefined}
        className={`relative -mx-1 rounded-sm px-1 text-right ${priceDirClass(side)}`}
        style={highlighted ? { background: `${highlight.color}${HIGHLIGHT_ALPHA_HEX}` } : undefined}
      >
        {qty.toLocaleString('ko-KR')}
      </span>
    </div>
  );
}
