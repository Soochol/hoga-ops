import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import LiveSettingsSections from './LiveSettingsSections';

describe('LiveSettingsSections (2단 nav+detail)', () => {
  afterEach(cleanup);

  it('카테고리 nav를 렌더 (차트·데이터소스만 — 보조지표·총잔량 급증은 지표 모달로 이동)', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-nav-chart')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
    expect(screen.queryByTestId('settings-nav-indicators')).toBeNull();
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
  });

  it('기본 선택은 차트 — 동시호가 마스킹 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });

  it('차트 설정에 날짜 구분선 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-dayBoundaryEnabled')).toBeTruthy();
  });

  it('차트 설정에 날짜 구분선 스타일 선택 버튼이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByRole('button', { name: '날짜 구분선 스타일 선택' })).toBeTruthy();
  });

  it('날짜 구분선 스타일 팔레트에서 기본 색상을 다시 선택할 수 있다', () => {
    render(<LiveSettingsSections />);
    fireEvent.click(screen.getByRole('button', { name: '날짜 구분선 스타일 선택' }));

    expect(screen.getByRole('button', { name: '날짜 구분선 색상 #64748B' })).toBeTruthy();
  });

  it('날짜 구분선 스타일 선택 버튼은 날짜 구분선 토글 다음, 캔들 툴팁 토글 전에 보인다', () => {
    render(<LiveSettingsSections />);

    const dayBoundaryToggle = screen.getByTestId('settings-toggle-dayBoundaryEnabled');
    const styleButton = screen.getByRole('button', { name: '날짜 구분선 스타일 선택' });
    const candleTooltipToggle = screen.getByTestId('settings-toggle-candleTooltipEnabled');

    expect(
      dayBoundaryToggle.compareDocumentPosition(styleButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      styleButton.compareDocumentPosition(candleTooltipToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('이동된 토글은 설정 모달에 없다 (급증·누적·극단값필터)', () => {
    render(<LiveSettingsSections />);
    expect(screen.queryByTestId('settings-toggle-surgeMarkerEnabled')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-fillStrengthCumulative')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeNull();
  });
});
