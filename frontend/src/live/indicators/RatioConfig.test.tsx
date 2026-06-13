import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RatioConfig from './RatioConfig';

describe('RatioConfig', () => {
  afterEach(cleanup);
  it('제목·범례·극단값 필터 토글을 렌더', () => {
    render(<RatioConfig />);
    expect(screen.getByText('호가비')).toBeTruthy();
    expect(screen.getByText(/매수 우위 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 우위 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });
});
