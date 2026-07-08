import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import ChartErrorBoundary from './ChartErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Value is null');
  return <div data-testid="chart-alive">chart</div>;
}

describe('ChartErrorBoundary', () => {
  beforeEach(() => {
    cleanup();
    // React가 boundary로 잡은 에러도 console.error로 재보고하므로 테스트 출력만 조용히.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('자식 throw를 격리해 폴백을 보여준다 (앱 전체 언마운트 방지)', () => {
    render(
      <div>
        <div data-testid="rest-of-app">sidebar</div>
        <ChartErrorBoundary>
          <Bomb shouldThrow />
        </ChartErrorBoundary>
      </div>,
    );
    expect(screen.getByText('차트 렌더링에 실패했습니다')).toBeTruthy();
    expect(screen.getByText('Value is null')).toBeTruthy();
    // 경계 밖 트리는 살아있다.
    expect(screen.getByTestId('rest-of-app')).toBeTruthy();
    expect(screen.queryByTestId('chart-alive')).toBeNull();
  });

  it('다시 시도가 에러 상태를 지우고 자식을 재마운트한다', () => {
    function Harness() {
      const [armed, setArmed] = useState(true);
      return (
        <div>
          <button data-testid="disarm" onClick={() => setArmed(false)}>disarm</button>
          <ChartErrorBoundary>
            <Bomb shouldThrow={armed} />
          </ChartErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText('차트 렌더링에 실패했습니다')).toBeTruthy();
    // 원인 제거 후 다시 시도 → 자식 정상 마운트.
    fireEvent.click(screen.getByTestId('disarm'));
    fireEvent.click(screen.getByText('다시 시도'));
    expect(screen.getByTestId('chart-alive')).toBeTruthy();
    expect(screen.queryByText('차트 렌더링에 실패했습니다')).toBeNull();
  });
});
