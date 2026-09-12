import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyViewSaveToastHost, useStudySaveNotice } from './StudyViewSaveToastHost';

const notice = { id: 'view-1', groupId: 'group-1', label: '관심 그룹' };
beforeEach(() => {
  vi.useFakeTimers();
  useStudySaveNotice.setState({ notice });
});
afterEach(() => {
  cleanup();
  useStudySaveNotice.setState({ notice: null });
  vi.useRealTimers();
});
describe('StudyViewSaveToastHost', () => {
  it('dismisses successful saves after six seconds', () => {
    render(<StudyViewSaveToastHost />);
    act(() => vi.advanceTimersByTime(5999));
    expect(screen.getByText('관심 그룹에 저장했습니다')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('gives a subsequent save its own full duration', () => {
    render(<StudyViewSaveToastHost />);
    act(() => vi.advanceTimersByTime(5000));
    act(() => useStudySaveNotice.setState({ notice: { ...notice, id: 'view-2', label: '새 그룹' } }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('새 그룹에 저장했습니다')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('keeps failed captures available for retry and manual dismissal', () => {
    const retryCapture = vi.fn();
    useStudySaveNotice.setState({ notice: { ...notice, retryCapture } });
    render(<StudyViewSaveToastHost />);
    act(() => vi.advanceTimersByTime(10000));
    fireEvent.click(screen.getByText('수집 다시 시도'));
    expect(retryCapture).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('닫기'));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
