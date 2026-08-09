import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import StudySavedRangeBand from './StudySavedRangeBand';
import type { VirtualAxis } from '../util/virtualAxis';
import type { StudySavedRangeMarks } from './studyDailyContext';

const FROM_MS = 1_780_000_000_000;
const TO_MS = 1_781_000_000_000;

/** `axis.toVirtual` 는 항등, `timeToCoordinate` 는 virtual초 → px 로 준 표를 본다. */
function makeChart(coords: Map<number, number | null>, barSpacing = 8) {
  const timeScale = {
    width: () => 500,
    options: () => ({ barSpacing }),
    timeToCoordinate: vi.fn((t: number) => coords.get(t) ?? null),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  return { timeScale: () => timeScale };
}

const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;

const marks: StudySavedRangeMarks = {
  fromMs: FROM_MS,
  toMs: TO_MS,
  barCount: 12,
  label: '저장 구간 · 06/01–06/12 · 10분봉',
};

function renderBand(coords: Map<number, number | null>, barSpacing?: number) {
  return render(
    <StudySavedRangeBand chart={makeChart(coords, barSpacing) as never} axis={axis} marks={marks} />,
  );
}

describe('StudySavedRangeBand', () => {
  afterEach(cleanup);

  it('경계를 캔들 좌표에서 바 폭 절반씩 바깥으로 넓혀 그린다', () => {
    renderBand(new Map([[FROM_MS / 1000, 100], [TO_MS / 1000, 300]]), 8);

    // half = 4 → 96px ~ 304px
    expect(screen.getByTestId('study-saved-range-edge-from').style.left).toBe('96px');
    expect(screen.getByTestId('study-saved-range-edge-to').style.left).toBe('304px');
    const fill = screen.getByTestId('study-saved-range-fill');
    expect(fill.style.left).toBe('96px');
    expect(fill.style.width).toBe('208px');
  });

  it('저장 봉이 적힌 라벨을 레전드 아래에 둔다', () => {
    renderBand(new Map([[FROM_MS / 1000, 100], [TO_MS / 1000, 300]]));

    expect(screen.getByText('저장 구간 · 06/01–06/12 · 10분봉')).toBeTruthy();
  });

  it('좌표를 못 얻으면(축 미준비·화면 밖) 아무것도 그리지 않는다', () => {
    // null 을 0 으로 접으면 밴드가 차트 좌단에 눌어붙는다 — 그 회귀를 막는다.
    renderBand(new Map([[FROM_MS / 1000, null], [TO_MS / 1000, 300]]));

    expect(screen.queryByTestId('study-saved-range-band')).toBeNull();
  });

  it('캔버스(z-index:1) 위에 올라가야 한다 — z-0 이면 캔들 뒤로 숨는다 (#1238)', () => {
    renderBand(new Map([[FROM_MS / 1000, 100], [TO_MS / 1000, 300]]));

    expect(screen.getByTestId('study-saved-range-band').className).toContain('z-10');
  });
});
