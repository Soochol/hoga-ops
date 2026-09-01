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

  it('컴포넌트 스택을 상자에 싣는다 — 콘솔을 열지 않아도 범인이 보인다', () => {
    render(
      <ChartErrorBoundary>
        <Bomb shouldThrow />
      </ChartErrorBoundary>,
    );
    // 스택은 `componentDidCatch` 로만 온다(`getDerivedStateFromError` 는 error 뿐).
    // 그래서 이 단언은 "잡았다" 가 아니라 **두 번째 훅까지 배선됐다** 를 잰다.
    const stack = screen.getByTestId('chart-error-component-stack');
    expect(stack.textContent).toContain('Bomb');
  });

  it('오류 복사가 메시지와 컴포넌트 스택을 함께 싣는다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom 엔 clipboard 가 없다 — 없는 채로 눌러도 안 터지는 것은 아래 테스트가 잰다.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    });
    render(
      <ChartErrorBoundary>
        <Bomb shouldThrow />
      </ChartErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId('chart-error-copy'));
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0] as string;
    // 상자에 보이는 것은 앞 12줄뿐이라, 붙여넣기 값은 **메시지 + 스택**이어야 한다.
    expect(payload).toContain('Value is null');
    expect(payload).toContain('Bomb');
    expect(await screen.findByText('복사됨')).toBeTruthy();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('clipboard 가 없는 환경에서도 복사 버튼이 상자를 깨뜨리지 않는다', () => {
    // 비-secure origin 이면 `navigator.clipboard` 가 아예 없어 호출이 undefined 다.
    // 거기에 `.then` 을 걸던 판이 폴백 상자를 스스로 터뜨렸다(red-check 대상).
    render(
      <ChartErrorBoundary>
        <Bomb shouldThrow />
      </ChartErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId('chart-error-copy'));
    expect(screen.getByText('차트 렌더링에 실패했습니다')).toBeTruthy();
    expect(screen.getByText('오류 복사')).toBeTruthy();
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
