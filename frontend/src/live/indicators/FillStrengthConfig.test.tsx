import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import FillStrengthConfig from './FillStrengthConfig';

describe('FillStrengthConfig', () => {
  afterEach(cleanup);
  it('제목·범례·누적선 토글을 렌더', () => {
    render(<FillStrengthConfig />);
    expect(screen.getByText('체결강도')).toBeTruthy();
    expect(screen.getByText(/매수 체결 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 체결 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-fillStrengthCumulative')).toBeTruthy();
  });
});
