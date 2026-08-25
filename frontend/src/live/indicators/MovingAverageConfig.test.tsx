import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MovingAverageConfig from './MovingAverageConfig';
import { useLivePageStore, DEFAULT_LIVE_MAS, MA_SLOT_LIMIT } from '../../state/livePage';

describe('MovingAverageConfig', () => {
  beforeEach(() => {
    useLivePageStore.setState({ movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })) });
  });

  it('renders one row per slot', () => {
    render(<MovingAverageConfig />);
    // Per-slot toggle was removed; count rows by the period spinbutton
    // which is exactly-one-per-slot.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(DEFAULT_LIVE_MAS.length);
  });

  it('"기간 추가" button appends a slot', () => {
    render(<MovingAverageConfig />);
    const addBtn = screen.getByRole('button', { name: /기간 추가/ });
    fireEvent.click(addBtn);
    expect(useLivePageStore.getState().movingAverages).toHaveLength(DEFAULT_LIVE_MAS.length + 1);
  });

  it('"기간 추가" is disabled when MA_SLOT_LIMIT reached', () => {
    while (useLivePageStore.getState().movingAverages.length < MA_SLOT_LIMIT) {
      useLivePageStore.getState().addMovingAverage();
    }
    render(<MovingAverageConfig />);
    const addBtn = screen.getByRole('button', { name: /기간 추가/ }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  // 마지막 슬롯도 지울 수 있다 — 레전드 칩 ✕ 가 인스턴스 단위 삭제라 0개가 도달
  // 가능한 유효 상태이고, 그 규칙을 설정 패널도 같이 따른다.
  it('remove button stays on the last slot (0 slots is a valid state)', () => {
    const ids = useLivePageStore.getState().movingAverages.map((m) => m.id);
    for (const id of ids.slice(1)) useLivePageStore.getState().removeMovingAverage(id);
    render(<MovingAverageConfig />);
    fireEvent.click(screen.getByRole('button', { name: '슬롯 삭제' }));
    expect(useLivePageStore.getState().movingAverages).toEqual([]);
  });

  it('header shows 지표명 + tooltip-helper', () => {
    render(<MovingAverageConfig />);
    expect(screen.getByText('이동평균선')).toBeTruthy();
    expect(screen.getByText(/지난 n일 동안 주가 평균값/)).toBeTruthy();
  });
});
