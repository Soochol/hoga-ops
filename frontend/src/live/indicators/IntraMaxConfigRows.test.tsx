import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import AskPeakConfig from './AskPeakConfig';

describe('호가 Config Intra-Bar Max 토글 행', () => {
  afterEach(cleanup);

  it('QuoteTotalsConfig에 quoteTotalsIntraMax 토글', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByTestId('settings-toggle-quoteTotalsIntraMax')).toBeTruthy();
  });

  it('RatioConfig에 ratioIntraMax 토글', () => {
    render(<RatioConfig />);
    expect(screen.getByTestId('settings-toggle-ratioIntraMax')).toBeTruthy();
  });

  it('AskPeakConfig에 askPeakIntraMax 토글', () => {
    render(<AskPeakConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakIntraMax')).toBeTruthy();
  });

  it('AskPeakConfig에 askPeakShowAllPrices 토글', () => {
    render(<AskPeakConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakShowAllPrices')).toBeTruthy();
  });

  it('AskPeakConfig에 두 매도 최대벽 스타일 컨트롤', () => {
    render(<AskPeakConfig />);
    expect(screen.getByText('체결가격 기준 최대벽')).toBeTruthy();
    expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByText('미체결 포함 최대벽')).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
  });
});
