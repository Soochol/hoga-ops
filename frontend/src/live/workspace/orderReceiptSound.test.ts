import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let sound: typeof import('./orderReceiptSound');
const oscillator = {
  type: '', frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
  connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null,
};
const gain = {
  gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
  connect: vi.fn(), disconnect: vi.fn(),
};
const created: FakeAudioContext[] = [];
class FakeAudioContext {
  state = 'suspended';
  currentTime = 10;
  destination = {};
  resume = vi.fn(async () => { this.state = 'running'; });
  createOscillator = vi.fn(() => oscillator);
  createGain = vi.fn(() => gain);
  constructor() { created.push(this); }
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); created.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  sound = await import('./orderReceiptSound');
});
afterEach(() => vi.unstubAllGlobals());

describe('주문접수 단음', () => {
  it('사용자 동작에서 미리 준비하고 미리듣기·접수음에 같은 컨텍스트를 사용한다', async () => {
    sound.prepareOrderReceiptSound();
    expect(created).toHaveLength(1);
    expect(created[0].resume).toHaveBeenCalledOnce();
    expect(oscillator.start).not.toHaveBeenCalled();
    expect(await sound.playOrderReceiptSound()).toBe(true);
    expect(created).toHaveLength(1);
    expect(oscillator.start).toHaveBeenCalledExactlyOnceWith(10);
    expect(oscillator.stop).toHaveBeenCalledExactlyOnceWith(10.15);
    oscillator.onended?.();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
  });
  it('같은 계좌·명령은 창을 바꿔 다시 확인해도 한 번만 재생한다', async () => {
    sound.notifyOrderReceiptAccepted(1, 'command-a');
    sound.notifyOrderReceiptAccepted(1, 'command-a');
    await vi.waitFor(() => expect(oscillator.start).toHaveBeenCalledOnce());
    sound.notifyOrderReceiptAccepted(1, 'command-b');
    sound.notifyOrderReceiptAccepted(2, 'command-a');
    await vi.waitFor(() => expect(oscillator.start).toHaveBeenCalledTimes(3));
  });
  it('오디오 미지원·초기화 실패는 주문 경로로 예외를 보내지 않는다', async () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(await sound.playOrderReceiptSound()).toBe(false);
    sound.prepareOrderReceiptSound();
    sound.notifyOrderReceiptAccepted(1, 'unsupported');
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('blocked'); } });
    expect(await sound.playOrderReceiptSound()).toBe(false);
    sound.prepareOrderReceiptSound();
    sound.notifyOrderReceiptAccepted(1, 'blocked');
    await Promise.resolve();
    expect(oscillator.start).not.toHaveBeenCalled();
  });
  it('resume 거절이나 계속 중단된 상태에서는 재생하지 않는다', async () => {
    sound.prepareOrderReceiptSound();
    await Promise.resolve();
    created[0].state = 'suspended';
    created[0].resume.mockRejectedValueOnce(new Error('not allowed'));
    expect(await sound.playOrderReceiptSound()).toBe(false);
    created[0].resume.mockImplementationOnce(async () => {});
    expect(await sound.playOrderReceiptSound()).toBe(false);
    expect(oscillator.start).not.toHaveBeenCalled();
  });
});
