/** 시장 종합 그리기 조각 — 목업이 감추던 "없음" 의 처리를 고정한다 (#1102). */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdvanceDeclineBar, PctText, Sparkline } from './marketBits';
import { fmtSigned, wonToJo } from './marketFormat';

describe('PctText', () => {
  it('값이 없으면 0 이 아니라 —', () => {
    render(<PctText pct={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('부호와 방향색을 함께 준다 (색약 보조 2중)', () => {
    const { container } = render(<PctText pct={1.61} />);
    expect(screen.getByText('+1.61%')).toBeInTheDocument();
    expect(container.querySelector('.text-price-up')).not.toBeNull();
  });
});

describe('AdvanceDeclineBar', () => {
  it('종합지수면 그린다', () => {
    const { container } = render(<AdvanceDeclineBar rising={742} falling={141} flat={31} />);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('지수 상품은 **부재가 정상**이라 아무것도 그리지 않는다 (#1100)', () => {
    const { container } = render(<AdvanceDeclineBar rising={null} falling={null} flat={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('포맷터', () => {
  it('fmtSigned 는 null 을 0 으로 채우지 않는다', () => {
    expect(fmtSigned(null)).toBe('—');
    expect(fmtSigned(1234)).toBe('+1,234');
    expect(fmtSigned(-1234)).toBe('-1,234');
  });

  it('wonToJo 는 원(raw)을 조로 — KOFIA 는 원으로 준다 (#1098)', () => {
    expect(wonToJo(102825552619394)).toBeCloseTo(102.83, 1);
    expect(wonToJo(null)).toBeNull();
  });
});

describe('Sparkline', () => {
  it('점이 2개 미만이면 그리지 않는다 — 한 점짜리 선은 거짓 정보다', () => {
    const { container: c0 } = render(<Sparkline points={[]} />);
    const { container: c1 } = render(<Sparkline points={[100]} />);
    expect(c0.firstChild).toBeNull();
    expect(c1.firstChild).toBeNull();
  });

  it('시작→끝 방향으로 색이 갈린다', () => {
    const { container: up } = render(<Sparkline points={[100, 110]} />);
    const { container: down } = render(<Sparkline points={[110, 100]} />);
    expect(up.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-up)');
    expect(down.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-down)');
  });
});

describe('Sparkline 색 기준 (DESIGN.md CandleGlyph 규칙)', () => {
  it('baseline(당일 시가) 기준이라 큰 숫자와 색이 갈릴 수 있다 — 그게 의도다', () => {
    // 시가 120 → 현재 110: 장중은 하락(파랑). 전일 종가가 100 이었다면 숫자는 상승(빨강).
    const { container } = render(<Sparkline points={[118, 110]} baseline={120} />);
    expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-down)');
  });

  it('baseline 이 없으면 첫 점을 쓴다', () => {
    const { container } = render(<Sparkline points={[100, 110]} />);
    expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-up)');
  });
});

describe('stockSeriesDiffs (자금 차트 절벽 버그의 고정)', () => {
  it('선행 null 구간에서 첫 실값이 0→값 절벽을 만들지 않는다', async () => {
    const { stockSeriesDiffs } = await import('./marketFormat');
    // CMA 실사례: 83일 null 뒤 104조 — 이전 코드는 여기서 +104조 점프를 그렸다.
    const got = stockSeriesDiffs([null, null, 104, 105, null, 107]);
    expect(got).toEqual([0, 0, 0, 1, 0, 2]);  // 첫 실값 d=0 · null 건너뛴 차는 실값 간 차
  });

  it('전부 실값이면 평범한 인접 차', async () => {
    const { stockSeriesDiffs } = await import('./marketFormat');
    expect(stockSeriesDiffs([100, 101, 99])).toEqual([0, 1, -2]);
  });
});

describe('SessionLinesChart (세션 시간 비례 x축)', () => {
  it('부분 커버리지는 부분 선이다 — 표본을 전폭으로 늘리지 않는다', async () => {
    const { SessionLinesChart } = await import('./marketBits');
    // 14:28~14:29 표본 2개 (실화면에서 전폭을 채우던 사례)
    const sec = (h: number, m: number) => h * 3600 + m * 60;
    const { container } = render(
      <SessionLinesChart
        series={[{ color: 'red', points: [
          { sec: sec(14, 28), v: 10 },
          { sec: sec(14, 29), v: 12 },
        ] }]}
      />,
    );
    const d = container.querySelector('path[stroke="red"]')?.getAttribute('d') ?? '';
    const xs = [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    // 세션(09:00–15:30) 중 14:28 은 약 84% 지점 — viewBox 300 기준 250 근처여야 한다.
    expect(xs[0]).toBeGreaterThan(240);
    expect(xs[1] - xs[0]).toBeLessThan(3); // 1분 = 전폭이 아니라 ~0.77px
  });

  it('null 값은 선을 이어 그리지 않고 건너뛴다', async () => {
    const { SessionLinesChart } = await import('./marketBits');
    const { container } = render(
      <SessionLinesChart
        series={[{ color: 'red', points: [
          { sec: 9 * 3600, v: 1 },
          { sec: 10 * 3600, v: null },
          { sec: 11 * 3600, v: 3 },
        ] }]}
      />,
    );
    const d = container.querySelector('path[stroke="red"]')?.getAttribute('d') ?? '';
    expect((d.match(/[ML]/g) ?? []).length).toBe(2); // null 은 점 자체가 없다
  });

  it('유효 점이 2개 미만이면 그리지 않는다', async () => {
    const { SessionLinesChart } = await import('./marketBits');
    const { container } = render(
      <SessionLinesChart series={[{ color: 'red', points: [{ sec: 9 * 3600, v: 1 }] }]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
