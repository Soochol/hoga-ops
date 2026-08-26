import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import PeakWallsConfig from './PeakWallsConfig';

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

  // 최대벽의 intraMax 는 **방향별이되 계열 공용**이라 매트릭스 푸터 행이다(2026-08-26).
  // 두 방향이 나란히 있으므로 한 번의 렌더로 둘 다 잰다 — 종전엔 탭을 오가야 했다.
  it('최대벽 매트릭스 푸터에 방향별 intraMax 토글이 나란히 선다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakIntraMax')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
  });

  it('고른 칸의 세부 존에 그 계열의 라벨 토글이 있다', () => {
    render(<PeakWallsConfig />);
    // 기본 선택(매도 · 체결된 벽)의 것이 바로 보인다 — 펼치는 단계가 없다.
    expect(screen.getByTestId('settings-toggle-askPeakTradedLabelEnabled')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '매수 체결된 벽' }));
    expect(screen.getByTestId('settings-toggle-bidPeakTradedLabelEnabled')).toBeTruthy();
  });

  it('매트릭스 셀에 계열 스타일 컨트롤이 있다', () => {
    render(<PeakWallsConfig />);
    expect(screen.getByRole('button', { name: '매도 체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매수 체결된 벽 스타일 선택' })).toBeTruthy();
    // 미체결 선은 ADR-0156 에서 제거됐다 — 컨트롤이 남아 있으면 죽은 설정을 렌더한다.
    expect(screen.queryByText('미체결된 벽')).toBeNull();
  });

  /**
   * 「보이는 영역 최대벽」(색 강조 + 개수 노브)은 2026-08-23 에 **제거**됐다 — 레전드와
   * 순위 화살표의 ①②③ 이 같은 정보를 순위까지 정확히 나르므로 색 채널이 중복이었다.
   *
   * **막는 방향**: 컨트롤만 되살아나 죽은 설정을 렌더하는 것(매수 쪽이 정확히 그 상태로
   * 한 달 넘게 있었다 — 노브는 있는데 강조 색이 없어 아무 시각 변화도 없었다).
   * 매트릭스는 두 방향을 한 화면에 두므로 한 번의 렌더가 양쪽을 다 덮는다.
   */
  it('「보이는 영역 최대벽」 컨트롤이 두 방향 어디에도 없다', () => {
    render(<PeakWallsConfig />);
    expect(screen.queryByText('보이는 영역 최대벽')).toBeNull();
    expect(screen.queryByText('보이는 영역 최대벽 표시 개수')).toBeNull();
    expect(screen.queryByRole('group', { name: '보이는 영역 최대벽 표시 개수' })).toBeNull();
  });
});
