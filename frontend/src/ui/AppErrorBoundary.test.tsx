import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import AppErrorBoundary from './AppErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Cannot read properties of undefined');
  return <div data-testid="app-alive">app</div>;
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    cleanup();
    // React re-reports boundary-caught errors through console.error — silence
    // it so the suite output stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('루트 밖 throw를 잡아 흰 화면 대신 폴백을 보여준다', () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('화면을 표시하지 못했습니다')).toBeTruthy();
    expect(screen.queryByTestId('app-alive')).toBeNull();
  });

  it('에러 메시지를 화면에 남긴다 — 프론트엔드에는 영구 로그가 없다', () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow />
      </AppErrorBoundary>,
    );
    expect(
      screen.getByText('Cannot read properties of undefined'),
    ).toBeTruthy();
  });

  it('컴포넌트 스택을 details로 제공한다 (버그 리포트용)', () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('컴포넌트 스택')).toBeTruthy();
  });

  it('원인이 사라지면 다시 시도가 자식을 재마운트한다', () => {
    function Harness() {
      const [armed, setArmed] = useState(true);
      return (
        <div>
          <button data-testid="disarm" onClick={() => setArmed(false)}>
            disarm
          </button>
          <AppErrorBoundary>
            <Bomb shouldThrow={armed} />
          </AppErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText('화면을 표시하지 못했습니다')).toBeTruthy();
    fireEvent.click(screen.getByTestId('disarm'));
    fireEvent.click(screen.getByText('다시 시도'));
    expect(screen.getByTestId('app-alive')).toBeTruthy();
    expect(screen.queryByText('화면을 표시하지 못했습니다')).toBeNull();
  });

  it('새로고침 버튼이 문서를 다시 로드한다', () => {
    // A root-level throw is often caused by module-level or persisted state
    // that re-mounting does not clear, so retry alone can dead-end. The reload
    // escape hatch is the part that has to work in that case.
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(
        <AppErrorBoundary>
          <Bomb shouldThrow />
        </AppErrorBoundary>,
      );
      fireEvent.click(screen.getByText('새로고침'));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });

  it('정상 트리는 그대로 통과시킨다', () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('app-alive')).toBeTruthy();
    expect(screen.queryByText('화면을 표시하지 못했습니다')).toBeNull();
  });
});

describe('배포로 청크가 갈린 경우', () => {
  function Boom({ message }: { message: string }): never {
    throw new Error(message);
  }

  // 브라우저별 실제 문구. 하나만 잡으면 나머지 브라우저 사용자는 죽은 버튼을 본다.
  const MESSAGES = [
    'Failed to fetch dynamically imported module: http://x/assets/Settings-abc.js',
    'error loading dynamically imported module: http://x/assets/Settings-abc.js',
    'Importing a module script failed.',
  ];

  it.each(MESSAGES)('%s → 새 버전 안내로 바뀐다', (message) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Boom message={message} />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('새 버전이 배포되었습니다')).toBeTruthy();
    // '다시 시도' 는 같은 404 를 다시 부르므로 반드시 실패한다 — 내려야 한다.
    expect(screen.queryByText('다시 시도')).toBeNull();
    expect(screen.getByText('새로고침')).toBeTruthy();
    spy.mockRestore();
  });

  it('평범한 렌더 오류는 두 출구를 그대로 유지한다', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Boom message="Cannot read properties of undefined" />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('화면을 표시하지 못했습니다')).toBeTruthy();
    expect(screen.getByText('다시 시도')).toBeTruthy();
    expect(screen.getByText('새로고침')).toBeTruthy();
    spy.mockRestore();
  });
});
