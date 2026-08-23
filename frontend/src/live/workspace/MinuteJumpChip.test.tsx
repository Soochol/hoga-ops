import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MinuteJumpChip } from './MinuteJumpChip';
import type { MinuteJumpState } from '../useTimeframeJump';

afterEach(cleanup);

const chip = () => screen.getByTestId('live-minute-jump-chip');
const show = (state: MinuteJumpState, onRetry = vi.fn(), onClear = vi.fn()) => {
  render(<MinuteJumpChip state={state} onClear={onClear} onRetry={onRetry} />);
  return { onRetry, onClear };
};

describe('MinuteJumpChip', () => {
  it('불러오는 중에는 재시도를 권하지 않는다 — 기다리면 온다', () => {
    show({ date: '20260821', status: 'seeking' });
    expect(chip().textContent).toContain('불러오는 중');
    expect(screen.queryByLabelText('기간 점프 다시 시도')).toBeNull();
  });

  // 종전엔 중단이 `landed` 에 뭉쳐 있어 칩이 아무 말도 못 했다 — 창이 움직인 적 없는데
  // "이동했다" 고 하면 거짓이기 때문이다. 갈라 놓으니 되돌릴 문도 화면에 둘 수 있다.
  it('중단은 그렇게 말하고 **다시 보낼 문**을 준다', () => {
    const { onRetry } = show({ date: '20260821', status: 'aborted' });
    expect(chip().textContent).toContain('중단됨');
    fireEvent.click(screen.getByLabelText('기간 점프 다시 시도'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('착지에는 "이동했습니다" 를 쓰지 않는다 — 그 뒤 사용자가 팬했을 수 있다', () => {
    show({ date: '20260821', status: 'landed' });
    expect(chip().getAttribute('title')).toContain('점프 대상 20260821');
    expect(chip().getAttribute('title')).not.toContain('이동했');
  });

  // 종전 문구는 「보유 기간(13개월)」 상수였고 **이중으로 틀렸다** — 판정에 쓰이는
  // 벤더 벽은 250일이고, 디스크 모드에는 벽 자체가 없다.
  it('갈 수 없을 때 **그 창의 실제 하한 날짜**를 말한다 — 상수를 적지 않는다', () => {
    show({ date: '20250101', status: 'out-of-retention', floorDate: '20251217' });
    const detail = chip().getAttribute('title') ?? '';
    expect(detail).toContain('20251217');
    expect(detail).not.toContain('13개월');
    expect(detail).toContain('일봉으로 보거나');
  });

  it('하한을 모르면 기간 문장을 **아예 뺀다** — 모르는 것을 지어내지 않는다', () => {
    show({ date: '20250101', status: 'out-of-retention' });
    const detail = chip().getAttribute('title') ?? '';
    expect(detail).not.toContain('가장 이른 날');
    expect(detail).toContain('일봉으로 보거나');
  });

  it('× 는 어느 상태에서나 이 창을 점프에서 푼다', () => {
    const { onClear } = show({ date: '20260821', status: 'landed' });
    fireEvent.click(screen.getByLabelText('기간 점프 해제'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
