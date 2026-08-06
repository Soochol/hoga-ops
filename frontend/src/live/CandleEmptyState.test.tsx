import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandleEmptyState } from './CandleEmptyState';
import { registerSettingsModalOpener } from './settingsModalControls';

afterEach(() => {
  // 모듈 채널은 전역 슬롯이라 테스트 간 누수를 막는다.
  registerSettingsModalOpener(() => {})();
});

describe('CandleEmptyState', () => {
  it('상태가 없으면 아무것도 그리지 않는다', () => {
    render(<CandleEmptyState state={null} />);
    expect(screen.queryByTestId('candle-empty-state')).toBeNull();
  });

  it('설명을 표시한다', () => {
    render(<CandleEmptyState state={{ text: '이 구간에 캔들이 없다', action: null }} />);
    expect(screen.getByTestId('candle-empty-state')).toHaveTextContent('이 구간에 캔들이 없다');
  });

  it('행동이 없으면 버튼도 없다 — 누를 것이 없는데 버튼을 보이면 안 된다', () => {
    render(<CandleEmptyState state={{ text: 'x', action: null }} />);
    expect(screen.queryByTestId('candle-empty-action')).toBeNull();
  });

  it('설정 행동은 셸의 모달 채널을 부른다', async () => {
    const open = vi.fn();
    registerSettingsModalOpener(open);
    render(<CandleEmptyState state={{ text: 'x', action: 'settings', actionLabel: '설정 열기' }} />);
    await userEvent.click(screen.getByTestId('candle-empty-action'));
    expect(open).toHaveBeenCalledOnce();
  });

  it('재시도 행동은 콜백을 부른다', async () => {
    const retry = vi.fn();
    render(
      <CandleEmptyState state={{ text: 'x', action: 'retry', actionLabel: '다시 시도' }} onRetry={retry} />,
    );
    await userEvent.click(screen.getByTestId('candle-empty-action'));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('재시도 콜백이 없으면 버튼을 숨긴다 — 죽은 버튼보다 없는 편이 정직하다', () => {
    render(<CandleEmptyState state={{ text: 'x', action: 'retry', actionLabel: '다시 시도' }} />);
    expect(screen.queryByTestId('candle-empty-action')).toBeNull();
  });

  // 캔들이 없어도 차트 팬·크로스헤어는 살아 있어야 한다 — 컨테이너가 전면을 덮으므로
  // 포인터를 통과시키고 버튼만 되살린다.
  it('컨테이너는 포인터를 통과시키고 버튼만 받는다', () => {
    render(<CandleEmptyState state={{ text: 'x', action: 'settings', actionLabel: '설정' }} />);
    expect(screen.getByTestId('candle-empty-state').className).toContain('pointer-events-none');
    expect(screen.getByTestId('candle-empty-action').className).toContain('pointer-events-auto');
  });
});
