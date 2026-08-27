import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MinuteJumpChip } from './MinuteJumpChip';
import type { MinuteJumpState } from '../useTimeframeJump';

afterEach(cleanup);

const chip = () => screen.getByTestId('live-minute-jump-chip');
const show = (state: MinuteJumpState, onClear = vi.fn()) => {
  render(<MinuteJumpChip state={state} onClear={onClear} />);
  return { onClear };
};

describe('MinuteJumpChip', () => {
  it('불러오는 중이라고 말한다 — 기다리면 온다', () => {
    show({ date: '20260821', status: 'seeking' });
    expect(chip().textContent).toContain('불러오는 중');
  });

  // 「받아 봤는데 없다」를 `seeking` 에 뭉치면 칩이 영원히 "불러오는 중" 을 표시한다.
  // 그 상태에서 사용자가 할 일은 기다리는 것이 **아니라** 다른 날을 고르거나 푸는 것이다.
  it('봉이 없으면 그렇게 말한다 — 기다리라고 하지 않는다', () => {
    show({ date: '20260821', status: 'no-data' });
    expect(chip().textContent).toContain('봉 없음');
    expect(chip().textContent).not.toContain('불러오는 중');
    expect(chip().getAttribute('title')).toContain('봉이 없습니다');
  });

  // 봉이 없는 것은 시장의 사실이지 이 창의 고장이 아니다 — 경고색은 사용자가 뭔가
  // 다르게 할 수 있는 `out-of-retention` 에만 쓴다.
  it('경고 톤은 하한 밖에만 쓴다', () => {
    show({ date: '20260821', status: 'no-data' });
    expect(chip().getAttribute('style')).not.toContain('--warn');
    cleanup();
    show({ date: '20250101', status: 'out-of-retention', floorDate: '20251217' });
    expect(chip().getAttribute('style')).toContain('--warn');
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
