import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

  it('AskPeakConfig에 askPeakTradedLabelEnabled 토글 — 계열 카드의 세부 설정 안', () => {
    render(<AskPeakConfig />);
    // 라벨 토글은 2026-08-25 부터 **계열마다** 있고 접히는 「세부 설정」 안에 산다.
    fireEvent.click(screen.getByTestId('settings-toggle-askPeakTradedLineEnabled-details'));
    expect(screen.getByTestId('settings-toggle-askPeakTradedLabelEnabled')).toBeTruthy();
  });

  it('AskPeakConfig에 체결된 벽 스타일 컨트롤', () => {
    render(<AskPeakConfig />);
    expect(screen.getByText('체결된 벽')).toBeTruthy();
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    // 미체결 선은 ADR-0156 에서 제거됐다 — 컨트롤이 남아 있으면 죽은 설정을 렌더한다.
    expect(screen.queryByText('미체결된 벽')).toBeNull();
  });

  /**
   * 「보이는 영역 최대벽」(색 강조 + 개수 노브)은 2026-08-23 에 **제거**됐다 — 레전드와
   * 순위 화살표의 ①②③ 이 같은 정보를 순위까지 정확히 나르므로 색 채널이 중복이었다.
   *
   * **막는 방향**: 컨트롤만 되살아나 죽은 설정을 렌더하는 것(매수 쪽이 정확히 그 상태로
   * 한 달 넘게 있었다 — 노브는 있는데 강조 색이 없어 아무 시각 변화도 없었다).
   */
  it('두 Config 모두에서 「보이는 영역 최대벽」 컨트롤이 사라졌다', () => {
    for (const Config of [AskPeakConfig, BidPeakConfig]) {
      cleanup();
      render(<Config />);
      expect(screen.queryByText('보이는 영역 최대벽')).toBeNull();
      expect(screen.queryByText('보이는 영역 최대벽 표시 개수')).toBeNull();
      expect(screen.queryByRole('group', { name: '보이는 영역 최대벽 표시 개수' })).toBeNull();
    }
  });

  it('BidPeakConfig에 bidPeakIntraMax 토글', () => {
    render(<BidPeakConfig />);
    expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
  });

  it('BidPeakConfig에 bidPeakTradedLabelEnabled 토글 — 계열 카드의 세부 설정 안', () => {
    render(<BidPeakConfig />);
    // 라벨 토글은 2026-08-25 부터 **계열마다** 있고 접히는 「세부 설정」 안에 산다.
    fireEvent.click(screen.getByTestId('settings-toggle-bidPeakTradedLineEnabled-details'));
    expect(screen.getByTestId('settings-toggle-bidPeakTradedLabelEnabled')).toBeTruthy();
  });
});
