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

  it('done 이 total 을 넘어도 100% 를 넘겨 그리지 않는다', () => {
    // 백엔드 재시도 패스가 같은 종목을 다시 세면 done 이 total 을 넘을 수 있다.
    // #1720 이 백엔드에서 클램프했지만 그 방어는 **저쪽에만** 있다 — 여기 없으면
    // 미래의 카운터 변경이 곧장 "갱신 중 4,400/4,335" 로 새어 나온다.
    render(<ScreenerUpdateProgress updating={{ done: 4400, total: 4335, started_ms: 1 }} />);
    const chip = screen.getByTestId('screener-update-progress');
    expect(chip.textContent).toContain('갱신 중 4,335/4,335');
    const bar = chip.querySelector('span[aria-hidden] > span') as HTMLElement;
    expect(bar.style.width).toBe('100%');
  });

  it('total 이 0 이면 0% — 0 나눗셈으로 NaN 폭을 만들지 않는다', () => {
    render(<ScreenerUpdateProgress updating={{ done: 0, total: 0, started_ms: 1 }} />);
    const bar = screen.getByTestId('screener-update-progress')
      .querySelector('span[aria-hidden] > span') as HTMLElement;
    expect(bar.style.width).toBe('0%');
  });
});

it('shows preparation phase without a misleading 0/0 count', () => {
  render(<ScreenerUpdateProgress updating={{ done: 0, total: 0, started_ms: 1, phase: '종목 목록 확인 중' }} />);
  expect(screen.getByTestId('screener-update-progress')).toHaveTextContent('종목 목록 확인 중');
  expect(screen.getByTestId('screener-update-progress')).not.toHaveTextContent('0/0');
});

it('shows daily provisional and quarantine counts without polling or implying all data is confirmed', () => {
  render(<ScreenerUpdateProgress updating={null} daily={{ attempts_today: 1, provisional: 30,
    confirmed: 20, quarantined: 12, legacy: 50, checked_on: '2026-10-24', last_trading_day: '20261023',
    last_attempt_at: '2026-10-24T22:00:00+09:00', failed_codes: 2, errors: {}, codes: 40,
    unavailable_codes: 3, unavailable: {}, excluded_codes: 2, excluded_dates: 7,
    retryable_unavailable_codes: 1, retired_codes: 2, retired: {}, skipped_codes: 0,
    sample_count: 40, provider_pages: 40, reused_samples: 0, elapsed_ms: 500, commit_pending: true }} />);
  expect(screen.getByRole('status')).toHaveTextContent('확정 20건 · 잠정 30건 · 충돌 격리 12건');
  expect(screen.getByRole('status')).toHaveTextContent('확인 실패 2종목 · 공급자 미제공 3종목 · 수집 대상 외 7일봉');
  expect(screen.getByRole('status')).toHaveTextContent('종료 확인 2종목 · 미제공 재시도 1종목 · 저장 재시도 대기');
});
