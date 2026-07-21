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
 * 머무는 칸이 물량 칸이기 때문이다.
 *
 * **배경을 칠하는 경로는 이 강조 하나뿐이다.** 초기안에 있던 수량 비율 깊이
 * 막대(--tint-price-*)는 제거했다: 정규화 기준이 표시 버퍼 내 최댓값이라 새
 * 체결이 들어올 때마다 같은 수량의 폭이 변해 신뢰할 수 없었고, 방향(매수/매도)은
 * 이미 체결량 글자색이 표현하며, 설정으로 끌 수 없는 상시 배경이 사용자가 지정한
 * 강조색과 섞여 서로를 죽였다. 호가창의 잔량 막대와 달리 체결 틱은 시간축
 * 스트림이라 "화면 안 최대치 대비 비율"에 고정된 의미가 없다.
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
    <div className="font-data text-sm tabular-nums">
      <div
        className={`sticky top-0 z-10 grid ${COLS} gap-2 border-b border-border bg-bg-card px-2.5 py-1 text-[10.5px] text-fg-dimmer`}
      >
        <span>시각</span>
        <span className="text-right">체결가</span>
        <span className="text-right">체결량</span>
      </div>
      {view.ticks.map((t) => (
        <Row key={t.key} tick={t} prevClose={view.prevClose} highlight={highlight} />
      ))}
    </div>
  );
}

function Row({
  tick,
  prevClose,
  highlight,
}: {
  tick: TradeTick;
  prevClose: number | null;
  highlight: TradeHighlightConfig | null;
}) {
  const { tMs, price, qty, side } = tick;
  // side==0 은 동시호가·장전 체결 — 방향이 없으므로 글자색도 중립.
  const priceColor = prevClose != null && prevClose > 0
    ? priceDirClass(price - prevClose)
    : priceDirClass(side);
  const highlighted = highlight !== null && price * qty >= highlight.thresholdWon;
  return (
    <div className={`grid ${COLS} gap-2 px-2.5 py-0.5`}>
      <span className="text-fg-dimmer">{unixMsToKSTClock(tMs)}</span>
      <span className={`text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      <span
        data-testid={highlighted ? 'trade-qty-highlighted' : undefined}
        className={`-mx-1 rounded-sm px-1 text-right ${priceDirClass(side)}`}
        style={highlighted ? { background: `${highlight.color}${HIGHLIGHT_ALPHA_HEX}` } : undefined}
      >
        {qty.toLocaleString('ko-KR')}
      </span>
    </div>
  );
}
