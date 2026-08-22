import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HogaplaySourceChip, hogaplayPeriodLabel } from './HogaplaySourceChip';

describe('hogaplayPeriodLabel', () => {
  it('같은 날은 하루만 적는다', () => {
    expect(hogaplayPeriodLabel('20260821', '20260821')).toBe('08-21');
  });

  it('같은 해 안이면 연도를 접는다', () => {
    expect(hogaplayPeriodLabel('20260811', '20260821')).toBe('08-11~08-21');
  });

  // **해를 걸치면 접지 않는다.** 접으면 `08-20~07-09` 가 되어 끝이 시작보다 앞선
  // 것처럼 읽힌다 — `SavedRangeChip` 이 실측으로 발견한 것과 같은 함정.
  it('해를 걸치면 연도를 유지한다', () => {
    expect(hogaplayPeriodLabel('20250820', '20260709')).toBe('25-08-20~26-07-09');
  });
});

describe('HogaplaySourceChip', () => {
  it('실린 구간을 적고 × 로 해제한다', () => {
    const onClear = vi.fn();
    render(<HogaplaySourceChip range={{ fromDate: '20260811', toDate: '20260821' }} onClear={onClear} />);

    expect(screen.getByTestId('live-hogaplay-source-chip')).toHaveTextContent('hogaplay 08-11~08-21');
    fireEvent.click(screen.getByRole('button', { name: 'hogaplay 저장 데이터 해제' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  // 켜자마자 디스크 쿼리가 아직 안 왔을 때 `undefined~undefined` 가 뜨지 않아야 한다.
  it('아직 캔들이 없으면 날짜 없이 불러오는 중으로 뜬다', () => {
    render(<HogaplaySourceChip range={null} onClear={vi.fn()} />);
    const chip = screen.getByTestId('live-hogaplay-source-chip');
    expect(chip).toHaveTextContent('hogaplay 불러오는 중');
    expect(chip.textContent).not.toContain('undefined');
  });
});
