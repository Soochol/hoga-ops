import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DayVolumeDistribution } from '../api/types';
import { VolumeDistributionCard } from './VolumeDistributionCard';

const sessionOpenMs = Date.UTC(2026, 5, 25, 0, 0, 0);
const sessionCloseMs = Date.UTC(2026, 5, 25, 6, 30, 0);
const cursorMs = Date.UTC(2026, 5, 25, 1, 0, 0);

const profile: DayVolumeDistribution = {
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: sessionOpenMs,
  session_close_ms: sessionCloseMs,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 30 },
  ],
};

describe('VolumeDistributionCard', () => {
  it('renders distribution rows with labeled axes and highlights the max bin', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={cursorMs}
        closePoints={[
          { t_ms: sessionOpenMs, close: 100 },
          { t_ms: cursorMs, close: 110 },
          { t_ms: Date.UTC(2026, 5, 25, 2, 0, 0), close: 120 },
        ]}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    const rows = screen.getAllByTestId('volume-distribution-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('volume-distribution-track')).toHaveLength(2);
    expect(rows[0]).not.toHaveTextContent('110-120');
    // 시간축: 세션 시작 ~ 마지막 종가(11:00 KST)까지, 중간 눈금 포함.
    const timeAxis = screen.getByTestId('volume-distribution-time-axis');
    expect(timeAxis).toHaveTextContent('09:00');
    expect(timeAxis).toHaveTextContent('10:00');
    expect(timeAxis).toHaveTextContent('11:00');
    // 가격축: max/mid/min 눈금 + POC(최대 매물대 bin 중앙값) 라벨.
    const priceAxis = screen.getByTestId('volume-distribution-price-axis');
    expect(priceAxis).toHaveTextContent('120');
    expect(priceAxis).toHaveTextContent('110');
    expect(priceAxis).toHaveTextContent('100');
    expect(screen.getByTestId('volume-distribution-poc-label')).toHaveTextContent('115');
    expect(screen.getByTestId('volume-distribution-max-bar')).toBeInTheDocument();
    expect(screen.getByTestId('volume-distribution-close-graph')).toBeInTheDocument();
    expect(screen.getByTestId('volume-distribution-close-dot')).toBeInTheDocument();
  });

  it('shows the cursor marker only inside the session bounds', () => {
    const { rerender } = render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getByTestId('volume-distribution-cursor-marker')).toBeInTheDocument();

    rerender(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={Date.UTC(2026, 5, 25, 8, 0, 0)}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.queryByTestId('volume-distribution-cursor-marker')).toBeNull();
  });

  it('hides the close graph when close points are outside the profile price range', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={cursorMs}
        closePoints={[
          { t_ms: sessionOpenMs, close: 99 },
          { t_ms: cursorMs, close: 98 },
        ]}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.queryByTestId('volume-distribution-close-graph')).toBeNull();
  });

  it('positions the cursor marker against the latest trade time when available', () => {
    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          last_trade_ms: Date.UTC(2026, 5, 25, 2, 0, 0),
        }}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getByTestId('volume-distribution-cursor-marker')).toHaveStyle({ left: '50%' });
  });

  it('keeps the close graph axis through the final close point for cutoff profiles', () => {
    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          last_trade_ms: cursorMs,
        }}
        cursorMs={cursorMs}
        closePoints={[
          { t_ms: sessionOpenMs, close: 100 },
          { t_ms: cursorMs, close: 110 },
          { t_ms: Date.UTC(2026, 5, 25, 2, 0, 0), close: 120 },
        ]}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getByTestId('volume-distribution-close-graph').querySelector('path')).toHaveAttribute(
      'd',
      'M 0.00 100.00 L 50.00 50.00 L 100.00 0.00',
    );
  });

  it('does not emit duplicate-key warnings for single-price profiles', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          price_min: 100,
          price_max: 100,
          bins: [
            { price_low: 100, price_high: 100, qty: 10 },
            { price_low: 100, price_high: 100, qty: 5 },
          ],
        }}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Encountered two children with the same key'),
      expect.anything(),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('renders a visible track for zero-volume bins', () => {
    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          range_count: 10,
          bins: Array.from({ length: 10 }, (_, index) => ({
            price_low: 100 + index,
            price_high: 101 + index,
            qty: index === 0 ? 10 : 0,
          })),
        }}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(10);
    expect(screen.getAllByTestId('volume-distribution-track')).toHaveLength(10);
  });

  // bar 가 고정 높이(8px+gap) 스택이던 시절엔 컨테이너가 커질수록 상단으로 몰려
  // 종가 라인·가격축과 어긋났다. 행은 백분율 좌표에만 놓여야 한다.
  it('places bar rows on the same percentage price axis as the close line', () => {
    const binCount = 10;
    render(
      <VolumeDistributionCard
        profile={{
          ...profile,
          range_count: binCount,
          // 100~120 을 10등분. index 7(=110~112) 이 최대 → POC.
          bins: Array.from({ length: binCount }, (_, index) => ({
            price_low: 100 + index * 2,
            price_high: 102 + index * 2,
            qty: index === 7 ? 99 : 1,
          })),
        }}
        cursorMs={cursorMs}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    const rows = screen.getAllByTestId('volume-distribution-row');
    const centersPct = rows.map((row) => {
      const el = row as HTMLElement;
      const top = parsePct(el.style.top);
      const height = parsePct(el.style.height);
      return top + height / 2;
    });
    // 행 i 의 중심 = (i + 0.5) / N — buildCloseCoords 가 bin 중간가에 대해 내는 y 와 같다.
    centersPct.forEach((center, index) => {
      expect(center).toBeCloseTo(((index + 0.5) / binCount) * 100, 6);
    });
    // 최상단 행이 price_max, 최하단 행이 price_min 쪽(가격 내림차순).
    expect(centersPct[0]).toBeLessThan(centersPct[binCount - 1]);

    // POC 라벨과 최대 bar 행이 같은 높이에 있어야 한다(어긋남의 눈에 보이던 증상).
    const maxRowIndex = rows.findIndex((row) =>
      row.querySelector('[data-testid="volume-distribution-max-bar"]') !== null,
    );
    expect(maxRowIndex).toBeGreaterThanOrEqual(0);
    const pocLabel = screen.getByTestId('volume-distribution-poc-label') as HTMLElement;
    expect(centersPct[maxRowIndex]).toBeCloseTo(parsePct(pocLabel.style.top), 6);
  });
});

describe('VolumeDistributionCard 확장축', () => {
  // venue=UN 은 표시창이 08:00~20:00 이지만 bar 는 정규장 연속체결만 담는다.
  // 막대는 집계 창에 갇히고, 종가 라인은 NXT 시간대까지 이어져야 한다.
  const axisStartMs = sessionOpenMs - 60 * 60 * 1000;        // 08:00
  const lastCloseMs = sessionOpenMs + 10.5 * 3600 * 1000;    // 19:30
  const axisSpanMs = lastCloseMs - axisStartMs;

  function renderExtended() {
    return render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={null}
        closePoints={[
          { t_ms: axisStartMs, close: 100 },
          { t_ms: sessionCloseMs, close: 110 },
          { t_ms: lastCloseMs, close: 120 },
        ]}
        color="#64748B"
        maxColor="#EAB308"
        axisStartMs={axisStartMs}
      />,
    );
  }

  it('confines bars to the binning window', () => {
    renderExtended();

    const barWindow = screen.getByTestId('volume-distribution-bar-window') as HTMLElement;
    // 09:00 에서 시작해 15:30 에서 끝난다 — 축(08:00~19:30)의 부분구간.
    expect(parsePct(barWindow.style.left))
      .toBeCloseTo(((sessionOpenMs - axisStartMs) / axisSpanMs) * 100, 6);
    expect(parsePct(barWindow.style.right))
      .toBeCloseTo(100 - ((sessionCloseMs - axisStartMs) / axisSpanMs) * 100, 6);
  });

  it('marks both edges of the binning window', () => {
    renderExtended();

    const edges = screen.getAllByTestId('volume-distribution-bin-window-edge') as HTMLElement[];
    expect(edges).toHaveLength(2);
    const barWindow = screen.getByTestId('volume-distribution-bar-window') as HTMLElement;
    // 경계선은 막대 구간의 시작·끝과 같은 자리에 선다.
    expect(parsePct(edges[0].style.left)).toBeCloseTo(parsePct(barWindow.style.left), 6);
    expect(parsePct(edges[1].style.left)).toBeCloseTo(100 - parsePct(barWindow.style.right), 6);
  });

  it('draws no edge line when the window fills the axis', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={null}
        closePoints={[
          { t_ms: sessionOpenMs, close: 100 },
          { t_ms: sessionCloseMs, close: 120 },
        ]}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    expect(screen.queryAllByTestId('volume-distribution-bin-window-edge')).toHaveLength(0);
  });

  it('keeps the close line and time axis on the full extended span', () => {
    renderExtended();

    // 라인은 축 시작(08:00)에서 끝(19:30)까지 — 잘리지 않는다.
    const path = screen.getByTestId('volume-distribution-close-graph').querySelector('path');
    const d = path?.getAttribute('d') ?? '';
    expect(d.startsWith('M 0.00')).toBe(true);
    expect(d.endsWith('100.00 0.00')).toBe(true);

    const timeAxis = screen.getByTestId('volume-distribution-time-axis');
    expect(timeAxis).toHaveTextContent('08:00');
    expect(timeAxis).toHaveTextContent('19:30');
  });

  it('spans the full width when the axis matches the binning window', () => {
    render(
      <VolumeDistributionCard
        profile={profile}
        cursorMs={null}
        closePoints={[
          { t_ms: sessionOpenMs, close: 100 },
          { t_ms: sessionCloseMs, close: 120 },
        ]}
        color="#64748B"
        maxColor="#EAB308"
      />,
    );

    const barWindow = screen.getByTestId('volume-distribution-bar-window') as HTMLElement;
    expect(parsePct(barWindow.style.left)).toBe(0);
    expect(parsePct(barWindow.style.right)).toBe(0);
  });
});

function parsePct(value: string): number {
  const parsed = Number.parseFloat(value);
  expect(value.endsWith('%')).toBe(true);
  expect(Number.isFinite(parsed)).toBe(true);
  return parsed;
}
