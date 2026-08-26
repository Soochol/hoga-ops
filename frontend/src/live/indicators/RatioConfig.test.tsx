import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RatioConfig from './RatioConfig';

describe('RatioConfig', () => {
  afterEach(cleanup);
  // 제목은 더 이상 이 컴포넌트의 것이 아니다 — 카테고리 표가 패널 헤더에서 그린다.
  it('범례·극단값 필터 토글을 렌더', () => {
    render(<RatioConfig />);
    expect(screen.getByText(/매수 우위 빨강/)).toBeTruthy();
    expect(screen.getByText(/매도 우위 파랑/)).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });
});
