import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FoldedPaneNotice } from './FoldedPaneNotice';

describe('FoldedPaneNotice', () => {
  it('접힌 게 없으면 아무것도 그리지 않는다', () => {
    render(<FoldedPaneNotice count={0} />);
    expect(screen.queryByTestId('folded-pane-notice')).toBeNull();
  });

  it('접힌 개수와 즉시 복원 동작을 표시한다', async () => {
    const onShowAll = vi.fn();
    render(<FoldedPaneNotice count={3} onShowAll={onShowAll} />);
    const notice = screen.getByRole('button', { name: /지표 3개/ });
    expect(notice).toHaveTextContent('지표 3 숨김');
    expect(notice).toHaveTextContent('모두 표시');
    await userEvent.click(notice);
    expect(onShowAll).toHaveBeenCalledOnce();
  });

  // 이 알림의 존재 이유 — 사용자가 "지표가 꺼졌다"고 오해하고 드로어를 다시 만지는 것을
  // 막는 게 목적이라, 되돌리는 방법(창 키우기)까지 접근성 라벨에 담는다.
  it('왜 숨겨졌고 어떻게 되돌리는지 접근성 라벨로 알린다', () => {
    render(<FoldedPaneNotice count={2} />);
    const label = screen.getByTestId('folded-pane-notice').getAttribute('aria-label') ?? '';
    expect(label).toContain('창이 작아');
    expect(label).toContain('창을 키우면');
  });

  it('복원 버튼만 포인터 이벤트를 받는다', () => {
    render(<FoldedPaneNotice count={1} onShowAll={() => {}} />);
    expect(screen.getByTestId('folded-pane-notice')).toHaveStyle({ pointerEvents: 'auto' });
  });

  // 시간축이 보이는데 바닥에 붙이면 눈금 라벨을 덮는다. 글랜스 티어에서 축이 숨으면
  // 그 자리를 되찾는다.
  it('시간축이 보이면 그 위로, 숨으면 바닥으로 붙는다', () => {
    const { rerender } = render(<FoldedPaneNotice count={1} timeAxisVisible />);
    const withAxis = screen.getByTestId('folded-pane-notice').style.bottom;
    rerender(<FoldedPaneNotice count={1} timeAxisVisible={false} />);
    const withoutAxis = screen.getByTestId('folded-pane-notice').style.bottom;
    expect(withAxis).toContain('28px');
    expect(withoutAxis).not.toContain('28px');
  });
});
