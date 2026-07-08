import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScreenerUpdateProgress } from './ScreenerUpdateProgress';

describe('ScreenerUpdateProgress', () => {
  it('updating 이 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(<ScreenerUpdateProgress updating={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('진행 칩에 done/total 과 퍼센트 바를 그린다', () => {
    render(<ScreenerUpdateProgress updating={{ done: 1200, total: 3561, started_ms: 1 }} />);
    const chip = screen.getByTestId('screener-update-progress');
    expect(chip.textContent).toContain('갱신 중 1,200/3,561');
    const bar = chip.querySelector('span[aria-hidden] > span') as HTMLElement;
    expect(bar.style.width).toBe('34%'); // round(1200/3561*100)
  });
});
