import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';

describe('QuoteTotalsConfig', () => {
  afterEach(cleanup);
  it('제목·범례·급증 마커 토글을 렌더', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByText('총잔량')).toBeTruthy();
    expect(screen.getByText(/매수 총잔량 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 총잔량 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).toBeTruthy();
  });
});
