import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

    it('소수 중간값을 표시 경로까지 그대로 낸다 — 저가주에선 상시다', () => {
      // 실측 2026-08-06 KRX 스냅샷 80,199 건 중 4.88% 가 .5 이고, 종목별로는
      // 100130 99.0% · 018880 93.5% · 003530 82.7% 로 **저가주에선 거의 매 틱**이다
      // (호가단위가 1원·5원이라 1틱 스프레드의 합이 홀수). 위 테스트들은 함수만
      // 보는데, 조용히 틀려지는 자리는 `toLocaleString` 이 소수를 자르는 표시 경로다.
      const L = (price: number) => [{ price, qty: 1 }];
      expect(bookMidPrice(L(4_475), L(4_470))).toBe(4_472.5); // 5원 단위(003530 실측)
      expect(bookMidPrice(L(1_000), L(999))).toBe(999.5); // 2,000원 미만 = 1원 단위
      const s = snap();
      renderPanel({
        snapshot: { ...s, ask: [{ price: 4_475, qty: 1 }], bid: [{ price: 4_470, qty: 1 }] },
        baselinePrice: 4_330,
      });
      const mid = screen.getByTestId('book-mid-row');
      expect(mid).toHaveTextContent('4,472.5');
      expect(mid).toHaveTextContent('+3.29%'); // 등락률도 소수 기준으로 계산된다
    });

    it('`중` 뱃지는 레이아웃 밖에 얹는다 — 가격 x 가 호가 행과 어긋나지 않게', () => {
      // 뱃지가 flex 아이템이면 폭(≈15px)+gap 만큼 가격 숫자가 오른쪽으로 밀린다
      // (실측 정수 mid +10.5px). `PriceCell` 의 시/고/저 칩과 같은 규약 — 칩 유무가
      // 가격 위치를 바꾸지 않는다. jsdom 은 레이아웃을 계산하지 않으므로 여기서
      // 지킬 수 있는 건 **구조**뿐이다(픽셀 확인은 실브라우저 몫).
      //
      // ⚠ 단언 앵커가 뱃지 자신 → **뱃지 띠**(`PriceBadges`)로 옮겼다. 시/고/저 칩이
      // 같은 슬롯을 쓰게 되면서 둘을 한 flex 행으로 합쳤기 때문이다(각각 absolute 면
      // 겹친다). 계약은 그대로다 — 띠가 레이아웃 밖이고 기준이 가격 span 이다.
      renderPanel();
      const badge = screen.getByText('중');
      const strip = badge.parentElement!;
      expect(strip).toHaveAttribute('data-price-badges');
      expect(strip).toHaveClass('absolute');
      // 기준 요소(= 가격 span)가 relative 여야 right-full 이 가격 왼쪽에 붙는다.
      expect(strip.parentElement).toHaveClass('relative');
      expect(strip.parentElement).toHaveTextContent('251,250');
    });

    describe('시/고/저 칩 — 중간값도 사다리 행과 같은 규약', () => {
      // 회귀: `중` 행은 ADR-0140 §7.1 로 **나중에 추가**된 행인데 `priceMarkers`
      // 배선이 따라오지 않아, 중간값이 당일 시/고/저와 같아도 칩이 없었다.
      //
      // ⚠ 픽스처는 **갭 안쪽 가격**이어야 한다. lock(매도1 = 매수1)은 반례가 아니다
      // — 그 가격은 매도1·매수1 `PriceCell` 로도 그려져 칩이 오히려 두 번 보인다.
      // 여기서는 매도1 251,500 / 매수1 250,500 → 중간값 251,000 이 유효 호가지만
      // 양쪽 사다리 어디에도 없다(= 이 행이 그 가격을 그리는 유일한 자리).
      function gapSnap(): OrderbookSnapshot {
        const s = snap();
        return { ...s, bid: [{ price: 250_500, qty: 200 }, ...s.bid.slice(1)] };
      }
      const midRow = () => screen.getByTestId('book-mid-row');

      it('중간값이 당일 고가면 `고` 칩이 붙는다', () => {
        renderPanel({ snapshot: gapSnap(), summary: { ...SUMMARY, dayHigh: 251_000 } });
        expect(midRow()).toHaveTextContent('251,000');
        expect(within(midRow()).getByText('고')).toBeInTheDocument();
      });

      it('시가=저가로 겹치면 `저` 하나만 — 고 > 저 > 시 우선순위', () => {
        // 사용자 결정 2026-08-24: 한 가격에 라벨은 하나. 칩 두 개가 쌓이면 그 행만
        // 폭이 튄다. 겹침은 드물지 않다(시가=저가 = 갭하락 후 상승).
        renderPanel({
          snapshot: gapSnap(),
          summary: { ...SUMMARY, dayOpen: 251_000, dayLow: 251_000 },
        });
        expect(within(midRow()).getByText('저')).toBeInTheDocument();
        expect(within(midRow()).queryByText('시')).toBeNull();
      });

      it('시가=고가로 겹치면 `고` 하나만', () => {
        renderPanel({
          snapshot: gapSnap(),
          summary: { ...SUMMARY, dayOpen: 251_000, dayHigh: 251_000 },
        });
        expect(within(midRow()).getByText('고')).toBeInTheDocument();
        expect(within(midRow()).queryByText('시')).toBeNull();
      });

      it('고가=저가(하루 한 가격)면 `고` 가 남는다 — 표 순서가 그 선택이다', () => {
        // 상한가 직행처럼 하루 종일 한 가격에만 체결된 날. 두 값이 같아 어느 쪽을
        // 골라도 가격은 같고, `DAY_MARKERS` 순서가 결정을 이미 못박고 있다.
        renderPanel({
          snapshot: gapSnap(),
          summary: { ...SUMMARY, dayHigh: 251_000, dayLow: 251_000 },
        });
        expect(within(midRow()).getByText('고')).toBeInTheDocument();
        expect(within(midRow()).queryByText('저')).toBeNull();
      });

      it('겹치지 않으면 각 가격이 자기 칩을 그대로 갖는다', () => {
        // 우선순위가 **겹칠 때만** 작동한다는 대조군 — 없으면 위 셋은 "칩이 하나만
        // 뜬다" 를 증명할 뿐 "겹칠 때만 줄인다" 는 증명하지 못한다.
        renderPanel({
          snapshot: gapSnap(),
          summary: { ...SUMMARY, dayHigh: 251_000, dayLow: 246_000, dayOpen: 251_500 },
        });
        expect(within(midRow()).getByText('고')).toBeInTheDocument();
        expect(screen.getByText('저')).toBeInTheDocument();
        expect(screen.getByText('시')).toBeInTheDocument();
      });

      it('`중` 은 칩이 붙어도 숫자에 가장 가깝다 — 칩 유무가 `중` x 를 안 바꾼다', () => {
        renderPanel({ snapshot: gapSnap(), summary: { ...SUMMARY, dayHigh: 251_000 } });
        const strip = within(midRow()).getByText('중').parentElement!;
        // 띠는 right-full 이라 **오른쪽 끝이 숫자에 붙는다** → 마지막 자식이 `중`.
        expect(strip.lastElementChild).toHaveTextContent('중');
        expect(strip.firstElementChild).toHaveTextContent('고');
      });

      it('소수 중간값은 분기 없이 걸러진다 — 정수 시/고/저와 === 가 성립하지 않는다', () => {
        // 저가주에선 `.5` 가 상시다(실측 4.88%). 별도 가드 없이 엄격 비교가 막는다.
        const s = snap();
        const odd = { ...s, bid: [{ price: 250_999, qty: 200 }, ...s.bid.slice(1)] };
        renderPanel({ snapshot: odd, summary: { ...SUMMARY, dayHigh: 251_249 } });
        expect(midRow()).toHaveTextContent('251,249.5');
        expect(within(midRow()).queryByText('고')).toBeNull();
      });

      it('사다리 한쪽이 비어 중간값이 없으면 칩도 없다', () => {
        const s = snap();
        renderPanel({ snapshot: { ...s, bid: [] }, summary: { ...SUMMARY, dayHigh: 251_500 } });
        expect(midRow()).toHaveTextContent('−');
        expect(within(midRow()).queryByText('고')).toBeNull();
      });
    });

    it('현재가가 중간값과 같으면 박스가 붙는다 — 칩과 같은 누락이었다', () => {
      // 형제 결함: `boxed` 도 `MidPriceRow` 에 배선돼 있지 않았다.
      const s = snap();
      const gap = { ...s, bid: [{ price: 250_500, qty: 200 }, ...s.bid.slice(1)] };
      const { container } = renderPanel({ snapshot: gap, lastPrice: 251_000 });
      const boxed = screen.getByTestId('book-mid-row').querySelector('.border-fg-dim');
      expect(boxed).not.toBeNull();
      // 구분선과 박스는 **다른 요소**다 — 한 요소면 박스 윗변만 색이 갈린다.
      expect(boxed!.classList.contains('border-border')).toBe(false);
      // 래퍼(1px) + 셀(21px) = 22px — 22행 정렬 계약 불변.
      expect(container.querySelector('.grid')!.children[1].children).toHaveLength(22);
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

  describe('요약표 시/고/저 칩 — 사다리 밖일 때만 (배타 규칙)', () => {
    // 사다리는 현재가 ±10틱만 덮는다. 일중 변동이 그보다 크면 시·고·저가 밖으로
    // 나가 칩을 붙일 행이 사라진다(실측 2026-08-24 삼성전자 −8.5%: 고가·시가 둘 다
    // 밖). 그때 요약표가 칩을 대신 받는다 — **등장 자체가 신호**다.
    const summaryRow = (label: string) => screen.getByText(label).parentElement!;

    it('고가가 사다리 밖이면 `최고` 행에 칩이 뜬다', () => {
      renderPanel({ summary: { ...SUMMARY, dayHigh: 999_000 } });
      expect(within(summaryRow('최고')).getByText('고')).toBeInTheDocument();
    });

    it('시·저도 같은 규칙이다 — 셋 다 밖이면 셋 다 뜬다', () => {
      // 기본 픽스처가 이미 셋 다 밖이다(시 245,500 · 고 257,500 · 저 238,500 vs
      // 사다리 246,500~256,000).
      renderPanel();
      expect(within(summaryRow('시작')).getByText('시')).toBeInTheDocument();
      expect(within(summaryRow('최고')).getByText('고')).toBeInTheDocument();
      expect(within(summaryRow('최저')).getByText('저')).toBeInTheDocument();
    });

    it('사다리 행에 있으면 요약표엔 안 뜬다 — 칩은 정확히 한쪽에만', () => {
      renderPanel({ summary: { ...SUMMARY, dayHigh: 251_500 } }); // 매도1
      expect(within(summaryRow('최고')).queryByText('고')).toBeNull();
      // 대조군: 사다리 쪽에는 있어야 한다. 없으면 위 단언은 아무것도 증명 못 한다.
      expect(screen.getAllByText('고')).toHaveLength(1);
    });

    it('중간값이 고가여도 요약표엔 안 뜬다 — `중` 행도 가격을 그리는 자리다', () => {
      // 이 판정에서 `중` 을 빼면 사다리와 요약표에 칩이 **동시에** 뜬다.
      renderPanel({ summary: { ...SUMMARY, dayHigh: 251_250 } }); // = 중간값
      expect(within(summaryRow('최고')).queryByText('고')).toBeNull();
      expect(within(screen.getByTestId('book-mid-row')).getByText('고')).toBeInTheDocument();
    });

    it('값이 없으면 칩도 없다 — 대시 행에 색딱지가 붙지 않는다', () => {
      renderPanel({ summary: { ...SUMMARY, dayOpen: null, dayHigh: null, dayLow: null } });
      expect(screen.queryByText('고')).toBeNull();
      expect(screen.queryByText('저')).toBeNull();
      expect(screen.queryByText('시')).toBeNull();
    });

    it('칩이 붙어도 값은 개행되지 않는다 — 행 높이 계약의 CSS 방어선', () => {
      // 실측 폭: 칩 달린 `최고` 111px < 이 열의 제약을 쥔 `250일` 149px 이라
      // 칩이 새 제약이 되지 않는다. jsdom 은 폭을 못 재므로 여기선 계약(클래스)만.
      renderPanel({ summary: { ...SUMMARY, dayHigh: 1_319_000 } });
      const value = within(summaryRow('최고')).getByText('고').parentElement!;
      expect(value.className).toContain('whitespace-nowrap');
    });
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

  it('시간외 총잔량이 오면 그 값으로 갈아끼우고 "시간외" 라벨을 단다', () => {
    // snap() 의 정규장 총잔량(매도 1,045 / 매수 2,045)과 다른 값을 준다 —
    // 라벨만 뜨고 숫자는 그대로면 이 단언이 잡는다.
    renderPanel({ afterHoursTotals: { ask: 7_777, bid: 8_888 } });

    expect(screen.getByTestId('book-total-after-hours')).toHaveTextContent('시간외');
    expect(screen.getByLabelText('시간외 매도총잔량 7,777')).toBeInTheDocument();
    expect(screen.getByLabelText('시간외 매수총잔량 8,888')).toBeInTheDocument();
  });

  it('시간외 값이 없으면 라벨 없이 정규장 총잔량 그대로다', () => {
    // 라벨이 상시로 새면 정규장 화면에 없던 글자가 생긴다 — 조건부임을 고정한다.
    renderPanel();

    expect(screen.queryByTestId('book-total-after-hours')).toBeNull();
    expect(screen.getByLabelText('매도총잔량 1,045')).toBeInTheDocument();
    expect(screen.getByLabelText('매수총잔량 2,045')).toBeInTheDocument();
  });

  it('총잔량 스트립에 **체결량을 그리지 않는다** — 라벨만 (사용자 결정 2026-08-19)', () => {
    // 여기엔 누적 체결량("체결 2,562")이 라벨 아래 두 줄로 쌓여 있었다. 그것을 둔
    // 근거는 "시간외에는 개별 체결 내역이 없어 이 누적이 유일한 체결 신호" 였는데,
    // #1417 이 체결창에 주기별 개별 행을 그리면서 전제가 사라졌다.
    //
    // **이 테스트는 되돌리기 방지용이다.** 총잔량 스트립에 체결량을 다시 얹으면
    // 축이 다른 숫자가 한 줄에 섞인다 — 잔량(지금 쌓여 있는 것)과 체결량(오늘
    // 지나간 것)은 물리량이 다르다.
    renderPanel({
      afterHoursTotals: { ask: 7_777, bid: 8_888 },
      afterHoursLabel: '시간외 단일가',
    });

    const strip = screen.getByTestId('book-total-after-hours');
    expect(strip).toHaveTextContent('시간외 단일가');
    expect(strip.textContent).not.toMatch(/체결/);
    expect(screen.queryByTestId('book-after-hours-volume')).toBeNull();
  });

  it('시간외 총잔량은 사다리를 건드리지 않는다 — 위 10단은 정규장 마지막 값', () => {
    // 0E 에는 단계별 호가가 없다. 사다리까지 갈아끼우면 호가창이 비므로,
    // 스트립만 바뀌고 가격 행은 그대로여야 한다(백엔드 SnapshotKind.AFTER_HOURS 주석).
    renderPanel({ afterHoursTotals: { ask: 7_777, bid: 8_888 } });

    expect(screen.getByText('256,000')).toBeInTheDocument(); // 매도 최말단
    expect(screen.getByText('246,500')).toBeInTheDocument(); // 매수 최말단
  });

  it('사다리가 없어도 시간외 총잔량은 그린다 — 장전 08:30–08:40 (2026-08-19 실측)', () => {
    // 회귀 고정: 0E 를 119 프레임 받는 동안(069500) 0D 가 0 건이라 snapshot 이 null 이었고,
    // 그래서 **수신 중인 총잔량이 화면에서 통째로 사라졌다**. 장후에 안 터진 이유는
    // 그때는 그날 15:30 까지의 사다리가 버퍼에 남아 snapshot 이 non-null 이기 때문이다.
    render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
        afterHoursTotals={{ ask: 22_367, bid: 0 }}
      />,
    );

    expect(screen.queryByText('호가 데이터 없음')).toBeNull();
    expect(screen.getByTestId('book-total-fill')).toBeInTheDocument();
    expect(screen.getByText('22,367')).toBeInTheDocument();
    expect(screen.getByTestId('book-total-after-hours')).toHaveTextContent('시간외');
  });

  it('사다리를 합성하지 않는다 — 0E 에는 단계별 호가가 없다', () => {
    // 10단을 0 으로 채워 그리면 "가짜 호가창" 이 된다(백엔드 test_after_hours_payload_has_no_ladder
    // 와 같은 계약). 제도상으로도 이 구간은 전일종가 단일가라 사다리 개념이 없다.
    render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
        afterHoursTotals={{ ask: 22_367, bid: 0 }}
      />,
    );

    expect(screen.getByText('정규장 호가 없음 (시간외 잔량만 수신 중)')).toBeInTheDocument();
    // `중` 행은 사다리 본문에만 있다 — 존재하지 않는 testid 를 0 으로 세는 단언은
    // 아무것도 증명하지 못하므로, 실제로 렌더되는 요소로 부재를 판정한다.
    expect(screen.queryByTestId('book-mid-row')).toBeNull();
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

/**
 * stale 딤 (2026-08-20).
 *
 * 사다리만 네트워크고 요약·체결강도는 커서에서 즉시 파생되므로, 조회가 비행 중인
 * 동안 한 패널 안에 **두 시점**이 공존한다. 그 사실을 화면이 말하게 하는 장치가
 * 이 딤이고, **어디에 걸리지 않는지가 절반**이다 — 이미 새 시점인 값까지 흐리면
 * "이것도 낡았다" 는 거짓말이 된다.
 */
describe('BookPanel stale 딤', () => {
  const dimOf = (el: Element | null) => el?.className ?? '';

  it('stale 이면 사다리·가격축·총잔량이 흐려진다', () => {
    const { container } = renderPanel({ stale: true });
    const bars = container.querySelectorAll('.relative.flex.items-center');
    expect(bars.length).toBeGreaterThan(0);
    expect(dimOf(bars[0])).toContain('opacity-50'); // 잔량 바
    const grid = container.querySelector('.grid')!;
    expect(dimOf(grid.children[1])).toContain('opacity-50'); // 중앙 가격축 열
    expect(dimOf(screen.getByTestId('book-total-strip'))).toContain('opacity-50');
  });

  it('stale 이 아니면 아무 데도 딤이 없다', () => {
    const { container } = renderPanel({ stale: false });
    expect(container.querySelectorAll('.opacity-50')).toHaveLength(0);
  });

  it('요약 패널과 체결강도는 흐리지 않는다 — 이미 새 시점 값이다', () => {
    const { container } = renderPanel({ stale: true });
    const grid = container.querySelector('.grid')!;
    // 우측 열의 첫 자식 = 요약 11행 래퍼.
    expect(dimOf(grid.children[2].children[0])).not.toContain('opacity-50');
    // 체결강도 행은 좌측 열에 있고 자체 딤이 없어야 한다.
    const strength = screen.getByText('체결강도').parentElement!;
    expect(dimOf(strength)).not.toContain('opacity-50');
  });

  it('딤은 22행 정렬 계약을 건드리지 않는다 — 자식 수가 그대로다', () => {
    // 잔량 바를 래퍼로 묶으면 자식 수가 바뀐다. 딤은 **셀에 직접** 얹어야 한다.
    const trades = Array.from({ length: 9 }, () => ({ price: 251_500, qty: 1, side: 1 as const }));
    const { container } = renderPanel({ trades, stale: true });
    const [left, center, right] = Array.from(container.querySelector('.grid')!.children);
    expect(left.children).toHaveLength(22);
    expect(center.children).toHaveLength(22);
    expect(right.children).toHaveLength(12);
  });

  it('시간외 총잔량은 스팟 경로가 아니라 흐리지 않는다', () => {
    // ⚠ `container.querySelector('.border-t.border-border')` 로 잡으면 **좌측 열의
    // `중` 행 divider** 가 먼저 걸린다 — 그 요소는 애초에 딤 대상이 아니라 스트립
    // 상태와 무관하게 통과하는 vacuous 가드가 된다. testid 로 지목할 것.
    renderPanel({ stale: true, afterHoursTotals: { ask: 10, bid: 20 } });
    expect(dimOf(screen.getByTestId('book-total-strip'))).not.toContain('opacity-50');
  });
});

describe('BookPanel 세션 표시 (10호가 정책)', () => {
  const TOGGLE = {
    kind: 'toggle' as const,
    regularLabel: '정규장',
    afterHoursLabel: '시간외 단일가',
  };

  it('갈래 A — 지금 보고 있는 장의 이름 **하나만** 그린다', () => {
    // 두 라벨을 나란히 두지 않는 것이 규약이다(자리가 총잔량 두 숫자 사이라 좁다).
    renderPanel({ sessionControl: TOGGLE, sessionMode: 'regular' });
    const btn = screen.getByTestId('book-session-toggle');
    expect(btn).toHaveTextContent('정규장');
    expect(screen.queryByText('시간외 단일가')).not.toBeInTheDocument();
  });

  it('갈래 A — 누르면 반대 모드를 통지한다', () => {
    const onSelect = vi.fn();
    renderPanel({
      sessionControl: TOGGLE,
      sessionMode: 'regular',
      onSelectSessionMode: onSelect,
    });
    fireEvent.click(screen.getByTestId('book-session-toggle'));
    expect(onSelect).toHaveBeenCalledWith('afterHours');
  });

  it('갈래 A — 시간외를 보는 중이면 다음 클릭은 정규장이다', () => {
    const onSelect = vi.fn();
    renderPanel({
      sessionControl: TOGGLE,
      sessionMode: 'afterHours',
      onSelectSessionMode: onSelect,
    });
    const btn = screen.getByTestId('book-session-toggle');
    expect(btn).toHaveTextContent('시간외 단일가');
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('regular');
  });

  it('갈래 A — 라벨만으로는 방향을 모르므로 스크린리더에 둘 다 말한다', () => {
    renderPanel({ sessionControl: TOGGLE, sessionMode: 'regular' });
    expect(screen.getByTestId('book-session-toggle')).toHaveAttribute(
      'aria-label',
      '정규장 호가 표시 중 — 누르면 시간외 단일가',
    );
  });

  it('갈래 B(NXT) — 라벨은 버튼이 아니다', () => {
    // 밑줄=누를 수 있다 의 신호를 지킨다. 클릭 안 되는 것에 밑줄을 주면
    // "왜 안 눌리지" 가 된다.
    renderPanel({ sessionControl: { kind: 'label', label: '애프터마켓' } });
    expect(screen.getByTestId('book-session-label')).toHaveTextContent('애프터마켓');
    expect(screen.queryByTestId('book-session-toggle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /애프터마켓/ })).not.toBeInTheDocument();
  });

  it('모름(kind=none) — 종전의 조건부 시간외 출처 표시로 폴백한다', () => {
    // `nxt_enabled` 를 모르는 창은 오늘과 똑같이 동작해야 한다.
    renderPanel({
      sessionControl: { kind: 'none' },
      afterHoursTotals: { ask: 1_000, bid: 2_000 },
      afterHoursLabel: '시간외',
    });
    expect(screen.getByTestId('book-total-after-hours')).toHaveTextContent('시간외');
    expect(screen.queryByTestId('book-session-toggle')).not.toBeInTheDocument();
  });

  it('모름 + 시간외 값도 없으면 중앙은 비어 있다', () => {
    renderPanel({ sessionControl: { kind: 'none' } });
    expect(screen.queryByTestId('book-total-after-hours')).not.toBeInTheDocument();
    expect(screen.queryByTestId('book-session-label')).not.toBeInTheDocument();
  });

  it('시간외 모드에서 사다리가 없으면 "호가 데이터 없음" 이 아니다', () => {
    // 정규장 데이터는 멀쩡히 있다 — 없는 것은 **그 장의** 호가다.
    render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
        sessionControl={TOGGLE}
        sessionMode="afterHours"
      />,
    );
    expect(screen.getByText('시간외 호가 없음')).toBeInTheDocument();
    expect(screen.queryByText('호가 데이터 없음')).not.toBeInTheDocument();
  });

  it('시간외 모드 + 총잔량만 = 사다리 개념이 없는 구간(15:40–16:00)', () => {
    render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
        afterHoursTotals={{ ask: 1_000, bid: 2_000 }}
        sessionControl={TOGGLE}
        sessionMode="afterHours"
      />,
    );
    expect(screen.getByText('시간외 사다리 없음 (총잔량만)')).toBeInTheDocument();
    // 그 상태에서도 토글은 살아 있어야 정규장으로 되돌아갈 수 있다.
    expect(screen.getByTestId('book-session-toggle')).toBeInTheDocument();
  });

  it('정규장 모드에서는 종전 문구를 그대로 쓴다', () => {
    render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
        afterHoursTotals={{ ask: 1_000, bid: 2_000 }}
        sessionControl={TOGGLE}
        sessionMode="regular"
      />,
    );
    expect(screen.getByText('정규장 호가 없음 (시간외 잔량만 수신 중)')).toBeInTheDocument();
  });
});

describe('BookPanel 빈 상태에서도 세션 컨트롤은 산다', () => {
  const TOGGLE = {
    kind: 'toggle' as const,
    regularLabel: '정규장',
    afterHoursLabel: '시간외',
  };

  function renderEmpty(over: Partial<Parameters<typeof BookPanel>[0]> = {}) {
    return render(
      <BookPanel
        snapshot={null}
        baselinePrice={null}
        summary={EMPTY_TRADE_SUMMARY}
        trades={[]}
        maskRatio={false}
        lastPrice={null}
        {...over}
      />,
    );
  }

  it('⚠ 사다리도 총잔량도 없을 때 **되돌아갈 수단이 남아야 한다**', () => {
    // 2026-08-27 실측 회귀: 장 마감 후 시간외 모드에서 토글이 통째로 사라져
    // 정규장으로 돌아갈 방법이 없었다 — 이 기능이 애초에 고치려던 막다른 길이
    // 데이터 없는 상태에서 그대로 재현됐다.
    renderEmpty({ sessionControl: TOGGLE, sessionMode: 'afterHours' });
    expect(screen.getByText('시간외 호가 없음')).toBeInTheDocument();
    expect(screen.getByTestId('book-session-toggle')).toHaveTextContent('시간외');
  });

  it('빈 상태의 토글이 실제로 동작한다', () => {
    const onSelect = vi.fn();
    renderEmpty({
      sessionControl: TOGGLE,
      sessionMode: 'afterHours',
      onSelectSessionMode: onSelect,
    });
    fireEvent.click(screen.getByTestId('book-session-toggle'));
    expect(onSelect).toHaveBeenCalledWith('regular');
  });

  it('갈래 B(NXT)는 빈 상태에서도 라벨만', () => {
    renderEmpty({ sessionControl: { kind: 'label', label: '애프터마켓 · 마지막' } });
    expect(screen.getByTestId('book-session-label')).toBeInTheDocument();
    expect(screen.queryByTestId('book-session-toggle')).not.toBeInTheDocument();
  });

  it('갈래가 없으면 바 자체를 그리지 않는다 — 종전처럼 빈 화면', () => {
    renderEmpty({ sessionControl: { kind: 'none' } });
    expect(screen.getByText('호가 데이터 없음')).toBeInTheDocument();
    expect(screen.queryByTestId('book-session-only-strip')).not.toBeInTheDocument();
  });

  it('총잔량이 있는 빈 상태에서는 종전대로 총잔량 스트립이 그린다', () => {
    // 바가 둘로 겹치지 않는다 — 그쪽 경로는 `TotalQtyStrip` 하나만 쓴다.
    renderEmpty({
      sessionControl: TOGGLE,
      sessionMode: 'afterHours',
      afterHoursTotals: { ask: 1_000, bid: 2_000 },
    });
    expect(screen.getByTestId('book-total-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('book-session-only-strip')).not.toBeInTheDocument();
    expect(screen.getByTestId('book-session-toggle')).toBeInTheDocument();
  });
});
