import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BookPanel, { bookMidPrice } from './BookPanel';
import { EMPTY_TRADE_SUMMARY } from '../liveSidebarAdapters';
import type { OrderbookSnapshot } from '../../api/types';

const PREV_CLOSE = 255_000;

/** 참조 스냅샷(005930 실측 기준가) — 매도 최우선 = 현재가 251,500. */
function snap(): OrderbookSnapshot {
  const ask = [251_500, 252_000, 252_500, 253_000, 253_500, 254_000, 254_500, 255_000, 255_500, 256_000]
    .map((price, i) => ({ price, qty: 100 + i }));
  const bid = [251_000, 250_500, 250_000, 249_500, 249_000, 248_500, 248_000, 247_500, 247_000, 246_500]
    .map((price, i) => ({ price, qty: 200 + i }));
  return {
    ts_ms: 1, seq: 0, ask, bid,
    tot_ask: ask.reduce((a, l) => a + l.qty, 0),
    tot_bid: bid.reduce((a, l) => a + l.qty, 0),
  };
}

const SUMMARY = {
  ...EMPTY_TRADE_SUMMARY,
  fillStrengthPct: 99.0,
  vsPrevVolumePct: 104.42,
  cumVolume: 46_689_105,
  cumValue: 82_412_000_000, // 824억 절사 표시
  dayOpen: 245_500,
  dayHigh: 257_500,
  dayLow: 238_500,
};

function renderPanel(over: Partial<Parameters<typeof BookPanel>[0]> = {}) {
  return render(
    <BookPanel
      snapshot={snap()}
      baselinePrice={PREV_CLOSE}
      summary={SUMMARY}
      trades={[{ price: 251_500, qty: 231, side: 1 }, { price: 251_000, qty: 10, side: -1 }]}
      maskRatio={false}
      lastPrice={251_500}
      {...over}
    />,
  );
}

describe('BookPanel', () => {
  it('매도·매수 20단계 가격과 등락률을 모두 그린다', () => {
    renderPanel();
    expect(screen.getByText('256,000')).toBeInTheDocument(); // 매도 최말단
    expect(screen.getByText('246,500')).toBeInTheDocument(); // 매수 최말단
    // 등락률 = (price − prevClose) / prevClose. 255,000 은 보합.
    expect(screen.getByText('0.00%')).toBeInTheDocument();
    expect(screen.getByText('+0.39%')).toBeInTheDocument(); // 256,000
    expect(screen.getByText('-3.33%')).toBeInTheDocument(); // 246,500
  });

  it('요약 패널은 정확히 11행이다 — 매수 잔량 바 정렬의 근거', () => {
    // 이 불변식이 깨지면 우측 매수 바가 매수 가격 행과 어긋난다(조용한 시각 결함).
    // 행 수 = 상한가 여백 1 + 매도 10.
    const { container } = renderPanel();
    const summary = container.querySelector('div[style*="242px"]');
    expect(summary).not.toBeNull();
    expect(summary!.children).toHaveLength(11);
  });

  it('3열 공통 경계선을 두 줄 × 3열 = 6개 그린다 — 한 줄씩 이어져야 한다', () => {
    // 두 줄이다: ① 매도↔`중` ② `중`↔매수. 각 줄이 좌·중앙·우 셋을 모두 가져야
    // 끊기지 않는다. 요약 divider 도 같은 border 토큰을 쓰게 되어(2026-07-22
    // 구분선 최소화 C안: strong→border 완화) 클래스 선택자로는 경계선만 못 세므로
    // 전용 마커(data-book-divider)로 센다. 톤 일관은 클래스 검증으로 함께 못박는다.
    const { container } = renderPanel();
    const grid = container.querySelector('.grid')!;
    const dividers = grid.querySelectorAll('[data-book-divider]');
    expect(dividers).toHaveLength(6);
    dividers.forEach((el) => {
      expect(el).toHaveClass('border-t');
      expect(el).toHaveClass('border-border');
    });
  });

  describe('`중` 행 (ADR-0140 §7.1)', () => {
    it('매도10과 매수10 사이에 중간값을 그린다', () => {
      // 매도1 251,500 · 매수1 251,000 → 중간값 251,250. 기준가 255,000 대비 −1.47%.
      renderPanel();
      const mid = screen.getByTestId('book-mid-row');
      expect(mid).toHaveTextContent('중');
      expect(mid).toHaveTextContent('251,250');
      expect(mid).toHaveTextContent('-1.47%');
    });

    it('한 수식이 정상·lock·역전을 분기 없이 덮는다', () => {
      // 통합(UN) venue 에서 lock·역전은 오류가 아니라 정상 상태다 — 서로 다른
      // 거래소의 주문은 자동으로 만나지 않는다.
      const L = (price: number) => [{ price, qty: 1 }];
      expect(bookMidPrice(L(1_320_000), L(1_318_000))).toBe(1_319_000); // 정상
      expect(bookMidPrice(L(1_685_000), L(1_685_000))).toBe(1_685_000); // lock
      expect(bookMidPrice(L(1_319_000), L(1_320_000))).toBe(1_319_500); // 역전
    });

    it('호가 단위 밖 값을 그대로 낸다 — `중` 뱃지가 주문 불가 표시다', () => {
      // 호가단위 1,000원인데 중간값은 500원 자리다. 키움 앱도 그대로 띄운다.
      const L = (price: number) => [{ price, qty: 1 }];
      expect(bookMidPrice(L(1_686_000), L(1_685_000))).toBe(1_685_500);
    });

    it('사다리 한쪽이 비면 대시로 남긴다 — 행은 유지(정렬 계약)', () => {
      const s = snap();
      const { container } = renderPanel({ snapshot: { ...s, bid: [] } });
      expect(bookMidPrice(s.ask, [])).toBeNull();
      expect(screen.getByTestId('book-mid-row')).toHaveTextContent('−');
      // 행이 사라지면 좌우와 어긋난다.
      expect(container.querySelectorAll('[data-testid="book-mid-row"]')).toHaveLength(1);
    });

    it('교차해도 경고·색을 넣지 않는다 — 값만 바뀐다', () => {
      // 상시 교차하는 종목(80%)에선 경고가 늘 켜져 없는 문제를 찾게 만든다.
      const s = snap();
      const crossed = { ...s, ask: [{ price: 250_500, qty: 1 }, ...s.ask], bid: s.bid };
      renderPanel({ snapshot: crossed });
      const mid = screen.getByTestId('book-mid-row');
      expect(mid).toHaveTextContent('250,750'); // (250,500 + 251,000) / 2
      expect(mid.textContent).not.toMatch(/교차|경고|⚠/);
    });

    it('3열이 모두 22행이다 — 하단 바닥 정렬 계약', () => {
      // 중앙에만 `중` 행을 넣으면 좌우가 1행씩 짧아져 하단이 어긋난다(조용한 시각 결함).
      const trades = Array.from({ length: 9 }, () => ({ price: 251_500, qty: 1, side: 1 as const }));
      const { container } = renderPanel({ trades });
      const [left, center, right] = Array.from(container.querySelector('.grid')!.children);
      expect(left.children).toHaveLength(22); // 여백1 + 매도10 + 중1 + 체결강도1 + 체결9
      expect(center.children).toHaveLength(22); // 여백1 + 매도10 + 중1 + 매수10
      // 우측은 요약 11행이 래퍼 하나에 들어 있어 자식 수 = 1 + 중1 + 매수바10 = 12.
      expect(right.children).toHaveLength(12);
      expect((right.children[0] as HTMLElement).style.height).toBe('242px'); // 11 × 22
    });
  });

  it('경계선이 현재가 박스(boxed)와 같은 요소를 다투지 않는다', () => {
    // 현재가가 매수 1호가인 흔한 경우 — 박스 윗변만 색이 갈리면 안 된다.
    const { container } = renderPanel({ lastPrice: 251_000 });
    const boxed = container.querySelector('.border-fg-dim');
    expect(boxed).not.toBeNull();
    expect(boxed!.classList.contains('border-border')).toBe(false);
    // 박스는 경계선 래퍼 **안쪽**에 있고, 래퍼(1px)+셀(21px) = 22px 계약 유지.
    expect(boxed!.parentElement!.className).toContain('border-border');
    expect((boxed as HTMLElement).style.height).toBe('21px');
  });

  it('요약 지표를 표시하고, 미수신 값은 대시로 남긴다', () => {
    renderPanel();
    expect(screen.getByText('99.00%')).toBeInTheDocument();   // 체결강도
    expect(screen.getByText('104.42%')).toBeInTheDocument();  // 어제보다
    expect(screen.getByText('4,668만')).toBeInTheDocument();  // 거래량(만 단위 절사)
    expect(screen.getByText('824억')).toBeInTheDocument();    // 거래대금(억 절사)
    // limits 미로드 시 상한가·하한가·250일 3행은 대시(VI 행은 시가 기반 계산값).
    expect(screen.getAllByText('−').length).toBeGreaterThanOrEqual(3);
  });

  it('VI 예상 발동가를 시가 기준으로 계산해 표시한다', () => {
    renderPanel(); // dayOpen 245,500 → ±10% 틱 반올림(절사/올림)
    expect(screen.getByText('270,000')).toBeInTheDocument(); // 270,050 → tick 500 절사
    expect(screen.getByText('221,000')).toBeInTheDocument(); // 220,950 → tick 500 올림
  });

  it('시가 없으면(장전) 기준가(base_price)로 예상가를 계산한다', () => {
    renderPanel({
      summary: EMPTY_TRADE_SUMMARY,
      limits: { base_price: 245_500, upper_limit: null, lower_limit: null, high_250: null, low_250: null },
    });
    expect(screen.getByText('270,000')).toBeInTheDocument();
    expect(screen.getByText('221,000')).toBeInTheDocument();
  });

  const VI_UP_ACTIVE = {
    code: '005930', direction: 'up' as const, kind: 'static' as const,
    trigger_price: 251_900, static_base: 229_000, dynamic_base: null,
    triggered_at: '101512', released_at: null, count: 1, active: true, recv_ms: 1,
  };

  it('VI 발동 중이면 해당 방향 행을 발동가로 강조한다', () => {
    renderPanel({ vi: VI_UP_ACTIVE });
    const active = screen.getByText('251,900 발동');
    expect(active.className).toContain('text-price-up');
    // 반대 방향(하강)은 예상가 유지 — 기준가는 발동가 근사(251,900×0.9=226,710→227,000 (tick 500 올림)).
    expect(screen.getByText('227,000')).toBeInTheDocument();
  });

  it('VI 해제 후엔 발동가를 기준가 근사로 써서 예상가를 갱신한다', () => {
    renderPanel({ vi: { ...VI_UP_ACTIVE, released_at: '101750', active: false } });
    expect(screen.queryByText(/발동/)).toBeNull();
    // 251,900×1.1=277,090 → tick 500 절사 = 277,000.
    expect(screen.getByText('277,000')).toBeInTheDocument();
    expect(screen.getByText('227,000')).toBeInTheDocument();
  });

  it('stock-limits 로 상한가·하한가·250일 최고/최저를 채운다', () => {
    // 골든 값 = 2026-07-21 ka10001 실호출(018260). 방향 색은 기준가 대비 —
    // 상한가는 항상 위(red), 하한가는 항상 아래(blue).
    renderPanel({
      limits: { base_price: 255_000, upper_limit: 331_500, lower_limit: 178_500, high_250: 388_500, low_250: 143_700 },
    });
    const upper = screen.getByText('331,500');
    const lower = screen.getByText('178,500');
    expect(upper.className).toContain('text-price-up');
    expect(lower.className).toContain('text-price-down');
    // 슬래시 양옆 공백 없음 — 6자리 고가 종목의 우측 열 폭 예산(개행 방지).
    expect(screen.getByText('388,500/143,700')).toBeInTheDocument();
  });

  it('250일 이력이 없는 종목(신규상장)은 대시로 남긴다', () => {
    renderPanel({
      limits: { base_price: 255_000, upper_limit: 331_500, lower_limit: 178_500, high_250: null, low_250: null },
    });
    expect(screen.getByText('331,500')).toBeInTheDocument();
    expect(screen.queryByText(/\//)).toBeNull(); // 반쪽짜리 "− / −" 금지
  });

  it('미수신 대시는 dim 톤이다 — 실데이터처럼 풀 대비로 찍히지 않는다', () => {
    renderPanel();
    for (const dash of screen.getAllByText('−')) {
      expect(dash.className).toContain('text-fg-dimmer');
    }
  });

  it('요약 라벨·값은 개행되지 않는다 — 행 높이 계약의 CSS 방어선(NAVER 250일 실사례)', () => {
    renderPanel({
      limits: { base_price: 255_000, upper_limit: 331_500, lower_limit: 178_500, high_250: 304_000, low_250: 181_100 },
    });
    const value = screen.getByText('304,000/181,100');
    expect(value.className).toContain('whitespace-nowrap');
    const label = screen.getByText('250일');
    expect(label.className).toContain('whitespace-nowrap');
  });

  it('체결 리스트는 9행에서 자른다 — 3열 바닥 정렬(좌 22행 = 중앙 22행)', () => {
    const trades = Array.from({ length: 12 }, (_, i) => ({
      price: 251_500, qty: 1_000 + i, side: 1 as const,
    }));
    renderPanel({ trades });
    expect(screen.getByText('1,008')).toBeInTheDocument(); // 9번째(index 8)
    expect(screen.queryByText('1,009')).toBeNull(); // 10번째부터 렌더 금지
  });

  it('요약이 전부 비면 대시만 남고 사다리는 그대로 그린다', () => {
    renderPanel({ summary: EMPTY_TRADE_SUMMARY });
    expect(screen.getByText('256,000')).toBeInTheDocument();
    expect(screen.getAllByText('−').length).toBeGreaterThanOrEqual(9);
  });

  it('총잔량 바는 마스크 시 비율을 숨긴다', () => {
    const { rerender } = renderPanel();
    expect(screen.getByTestId('book-total-fill')).toBeInTheDocument();
    rerender(
      <BookPanel
        snapshot={snap()}
        baselinePrice={PREV_CLOSE}
        summary={SUMMARY}
        trades={[]}
        maskRatio
        lastPrice={null}
      />,
    );
    expect(screen.getByTestId('book-total-masked')).toBeInTheDocument();
  });

  it('빈 상태를 구분해 그린다', () => {
    const { rerender } = render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
      />,
    );
    expect(screen.getByText('호가 데이터 없음')).toBeInTheDocument();
    rerender(
      <BookPanel
        snapshot={undefined}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
      />,
    );
    expect(screen.getByText('커서 위치 불러오는 중…')).toBeInTheDocument();
  });

  it('순간 증감 뱃지(#750)를 각 단 잔량 옆에 그린다', () => {
    // 레이아웃 개편이 이 기능을 지우지 않도록 고정한다 — 십자 배치로 갈아끼우면서
    // 구 sidebar/OrderbookTable(#808 이후 소비처 0 → 삭제)의 deltaBadges 를 이식했다.
    // 그 컴포넌트의 전용 테스트도 함께 지웠으므로 이 케이스가 유일한 회귀 방어선이다.
    renderPanel({
      // key 규약 = `a:${price}` | `b:${price}` (orderbookDeltaBadges).
      deltaBadges: new Map([
        ['a:252000', { delta: 1_200, atMs: 1 }],
        ['b:251000', { delta: -800, atMs: 2 }],
      ]),
    });
    expect(screen.getByText('+1,200')).toBeInTheDocument();
    expect(screen.getByText('−800')).toBeInTheDocument(); // U+2212, 하이픈 아님
  });

  it('증감 뱃지 색 = KRX 컨벤션(증가 빨강 / 감소 파랑)', () => {
    // 차트 오버레이의 teal/fuchsia 와 의도적으로 다르다(DESIGN.md 2026-07-21) —
    // 되돌아가면 이 단언이 잡는다.
    renderPanel({
      deltaBadges: new Map([
        ['a:252000', { delta: 1_200, atMs: 1 }],
        ['b:251000', { delta: -800, atMs: 2 }],
      ]),
    });
    expect(screen.getByText('+1,200').className).toContain('text-price-up');
    expect(screen.getByText('−800').className).toContain('text-price-down');
  });

  it('잔량 숫자 색은 side 별 토큰 — 뱃지의 delta 색과 독립이다', () => {
    // 잔량 숫자 = 등락률과 같은 방향색 2벌(매도 파랑 / 매수 빨강, 토스 실측 근거).
    // 두 색이 같은 토큰으로 합쳐지면(예: 둘 다 text-fg-dim 회귀) 이 단언이 잡는다.
    renderPanel({ deltaBadges: new Map([['b:251000', { delta: -800, atMs: 1 }]]) });
    expect(screen.getByText('109').className).toContain('text-qty-ask'); // 매도 최말단
    expect(screen.getByText('209').className).toContain('text-qty-bid'); // 매수 최말단
    // 같은 행에서 잔량은 매수색(빨강), 뱃지는 감소색(파랑) — 축이 다르므로 정상.
    expect(screen.getByText('200').className).toContain('text-qty-bid');
    expect(screen.getByText('−800').className).toContain('text-price-down');
  });

  it('뱃지가 없으면(스팟 커서) 아무것도 그리지 않는다', () => {
    renderPanel({ deltaBadges: null });
    expect(screen.queryByText('+1,200')).toBeNull();
  });

  it('baselinePrice 가 없으면 등락률을 생략한다(0 나눗셈 방지)', () => {
    renderPanel({ baselinePrice: null });
    expect(screen.getByText('256,000')).toBeInTheDocument();
    expect(screen.queryByText('+0.39%')).toBeNull();
  });

  it('예상체결가·량이 있으면(동시호가) 상단 배너에 풀 라벨로 그린다', () => {
    renderPanel({ snapshot: { ...snap(), exp_price: 265_500, exp_qty: 12_345 } });
    const cell = screen.getByTestId('book-expected-fill');
    expect(cell).toHaveTextContent('예상 체결가');
    expect(cell).toHaveTextContent('265,500원');
    expect(cell).toHaveTextContent('예상 체결량');
    expect(cell).toHaveTextContent('12,345');
  });

  it('평시(예상체결 0/미제공)엔 예상체결 셀을 그리지 않는다', () => {
    renderPanel(); // snap() 은 exp_price/exp_qty 미포함
    expect(screen.queryByTestId('book-expected-fill')).toBeNull();
    // 한쪽만 값이 있어도(반쪽 프레임) 숨긴다.
    renderPanel({ snapshot: { ...snap(), exp_price: 265_500, exp_qty: 0 } });
    expect(screen.queryByTestId('book-expected-fill')).toBeNull();
  });
});
