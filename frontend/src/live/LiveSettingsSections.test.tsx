import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import LiveSettingsSections from './LiveSettingsSections';

describe('LiveSettingsSections (2단 nav+detail)', () => {
  afterEach(cleanup);

  it('카테고리 nav를 렌더 (보조지표·총잔량 급증·차트·데이터소스)', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-nav-indicators')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-surge')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-chart')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
  });

  it('기본 선택은 보조지표 — 해당 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-fillStrengthCumulative')).toBeTruthy();
  });

  it('총잔량 급증 nav 클릭 → 급증 마커 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    fireEvent.click(screen.getByTestId('settings-nav-surge'));
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });

  it('차트 nav 클릭 → 차트 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });
});
