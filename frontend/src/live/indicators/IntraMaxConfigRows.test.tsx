import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import AskPeakConfig from './AskPeakConfig';
import BidPeakConfig from './BidPeakConfig';

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

  it('AskPeakConfig에 askPeakLabelEnabled 토글', () => {
    render(<AskPeakConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakLabelEnabled')).toBeTruthy();
  });

  it('AskPeakConfig에 보이는 영역 최대벽 표시 개수 옵션', () => {
    render(<AskPeakConfig />);
    expect(screen.getByText('보이는 영역 최대벽 표시 개수')).toBeTruthy();
    const group = within(screen.getByRole('group', { name: '보이는 영역 최대벽 표시 개수' }));
    expect(group.getByRole('button', { name: '0' })).toBeTruthy();
    expect(group.getByRole('button', { name: '1' })).toBeTruthy();
    expect(group.getByRole('button', { name: '2' })).toBeTruthy();
    expect(group.getByRole('button', { name: '3' })).toBeTruthy();
  });

  it('AskPeakConfig에 두 매도 최대벽 스타일 컨트롤', () => {
    render(<AskPeakConfig />);
    expect(screen.getByText('체결된 벽')).toBeTruthy();
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByText('보이는 영역 최대벽')).toBeTruthy();
    expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
    // 미체결 선은 ADR-0156 에서 제거됐다 — 컨트롤이 남아 있으면 죽은 설정을 렌더한다.
    expect(screen.queryByText('미체결된 벽')).toBeNull();
  });

  it('BidPeakConfig에 bidPeakIntraMax 토글', () => {
    render(<BidPeakConfig />);
    expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
  });

  it('BidPeakConfig에 bidPeakLabelEnabled 토글', () => {
    render(<BidPeakConfig />);
    expect(screen.getByTestId('settings-toggle-bidPeakLabelEnabled')).toBeTruthy();
  });
});
