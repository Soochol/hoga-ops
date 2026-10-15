import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let sound: typeof import('./orderReceiptSound');
interface FakeSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}
const created: FakeAudioContext[] = [];
class FakeAudioContext {
  state = 'suspended';
  currentTime = 10;
  sampleRate = 48000;
  destination = {};
  sources: FakeSource[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => {
    const samples = new Float32Array(length);
    return { duration: length / sampleRate, sampleRate, getChannelData: () => samples } as unknown as AudioBuffer;
  });
  createBufferSource = vi.fn(() => {
    const source: FakeSource = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), onended: null };
    this.sources.push(source);
    return source;
  });
  constructor() { created.push(this); }
}

beforeEach(async () => {
  vi.resetModules(); created.length = 0;
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('AudioContext', FakeAudioContext);
  sound = await import('./orderReceiptSound');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function initialized() {
  sound.prepareOrderReceiptSound();
  await vi.advanceTimersByTimeAsync(0);
  return created[0];
}

describe('주문접수 딩동과 복구', () => {
  it.each([44100, 48000])('%iHz에서 더 큰 330ms 2음을 캐시하고 한 소스로 재생한다', async sampleRate => {
    const audio = await initialized();
    audio.sampleRate = sampleRate;
    expect(audio.resume).toHaveBeenCalledOnce();
    expect(audio.sources).toHaveLength(0);
    expect(await sound.playOrderReceiptSound()).toBe(true);
    const first = audio.sources[0];
    expect(first.start).toHaveBeenCalledExactlyOnceWith(10.02);
    expect(first.buffer!.duration).toBeCloseTo(0.33, 4);
    const samples = first.buffer!.getChannelData(0);
    const peak = (start: number, end: number) => Math.max(...samples.slice(Math.ceil(start * sampleRate), Math.floor(end * sampleRate)).map(Math.abs));
    expect(peak(0, 0.16)).toBeGreaterThan(0.35);
    expect(peak(0.17, 0.33)).toBeGreaterThan(0.35);
    expect(peak(0.16, 0.17)).toBe(0);
    expect(peak(0, 0.33)).toBeLessThanOrEqual(0.45);
    expect(await sound.playOrderReceiptSound()).toBe(true);
    expect(audio.sources[1].buffer).toBe(first.buffer);
    expect(audio.createBuffer).toHaveBeenCalledOnce();
    first.onended?.();
    expect(first.disconnect).toHaveBeenCalledOnce();
  });
  it.each(['suspended', 'interrupted'])('%s 상태를 재개하고 소리를 시작한다', async state => {
    const audio = await initialized(); audio.state = state; audio.resume.mockClear();
    expect(await sound.playOrderReceiptSound()).toBe(true);
    expect(audio.resume).toHaveBeenCalledOnce();
    expect(audio.sources[0].start).toHaveBeenCalledOnce();
  });
  it('동시에 같은 계좌·명령을 확인해도 한 번만 재생하고 성공한 명령만 기억한다', async () => {
    const first = sound.notifyOrderReceiptAccepted(1, 'command-a');
    const concurrent = sound.notifyOrderReceiptAccepted(1, 'command-a');
    expect(concurrent).toBe(first);
    expect(await first).toBe(true);
    expect(await sound.notifyOrderReceiptAccepted(1, 'command-a')).toBe(true);
    expect(created[0].sources).toHaveLength(1);
    expect(await sound.notifyOrderReceiptAccepted(1, 'command-b')).toBe(true);
    expect(await sound.notifyOrderReceiptAccepted(2, 'command-a')).toBe(true);
    expect(created[0].sources).toHaveLength(3);
  });
  it('재개 거절은 한 번 재시도하고 복구되면 한 번만 시작한다', async () => {
    const audio = await initialized(); audio.state = 'suspended';
    audio.resume.mockRejectedValueOnce(new Error('blocked'));
    const playback = sound.notifyOrderReceiptAccepted(1, 'command-a');
    await vi.advanceTimersByTimeAsync(79);
    expect(audio.sources).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await playback).toBe(true);
    expect(audio.sources).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it('계속 실패한 명령은 알림 완료로 기록하지 않아 복구 후 같은 ID로 재생할 수 있다', async () => {
    const audio = await initialized(); audio.state = 'interrupted';
    audio.resume.mockRejectedValue(new Error('blocked'));
    const failure = sound.notifyOrderReceiptAccepted(1, 'command-a');
    await vi.advanceTimersByTimeAsync(80);
    expect(await failure).toBe(false);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(audio.sources).toHaveLength(0);
    expect(sound.getOrderReceiptSoundDiagnostics().at(-1)).toMatchObject({ event: 'prepare-failed', state: 'interrupted', error: 'Error: blocked' });
    audio.resume.mockImplementation(async () => { audio.state = 'running'; });
    expect(await sound.notifyOrderReceiptAccepted(1, 'command-a')).toBe(true);
    expect(audio.sources).toHaveLength(1);
  });
  it('끝나지 않는 resume은 제한 시간 후 실패하며 나중에 풀려도 지난 접수음을 재생하지 않는다', async () => {
    const audio = await initialized(); audio.state = 'suspended';
    let resume!: () => void;
    audio.resume.mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
    const playback = sound.notifyOrderReceiptAccepted(1, 'stale-command');
    await vi.advanceTimersByTimeAsync(600);
    expect(await playback).toBe(false);
    expect(audio.resume).toHaveBeenCalledTimes(3); // Initial preparation and two playback attempts.
    audio.state = 'running'; resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.sources).toHaveLength(0);
  });
  it('복귀 준비의 resume이 막혀 있어도 다음 사용자 동작에서 새로 resume한다', async () => {
    const audio = await initialized(); audio.state = 'suspended';
    audio.resume.mockImplementationOnce(() => new Promise<void>(() => {}));
    sound.prepareOrderReceiptSound();
    expect(await sound.playOrderReceiptSound()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(audio.sources).toHaveLength(1);
  });
  it('이벤트 루프가 오래 멈추면 제한 시간을 지난 접수음을 시작하지 않는다', async () => {
    const audio = await initialized(); audio.state = 'suspended';
    let resume!: () => void;
    audio.resume.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; }));
    const playback = sound.playOrderReceiptSound();
    vi.setSystemTime(Date.now() + 1000);
    audio.state = 'running'; resume();
    expect(await playback).toBe(false);
    expect(audio.sources).toHaveLength(0);
  });
  it('오디오 미지원·생성 실패를 반환하고 진단은 최근 30건만 유지한다', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const unavailable = sound.playOrderReceiptSound();
    await vi.advanceTimersByTimeAsync(80);
    expect(await unavailable).toBe(false);
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('create-failed'); } });
    const blocked = sound.playOrderReceiptSound();
    await vi.advanceTimersByTimeAsync(80);
    expect(await blocked).toBe(false);
    for (let i = 0; i < 35; i++) sound.prepareOrderReceiptSound();
    const entries = sound.getOrderReceiptSoundDiagnostics();
    expect(entries).toHaveLength(30);
    expect(entries.at(-1)).toMatchObject({ event: 'prepare-failed', error: 'Error: create-failed' });
  });
  it('복구 리스너는 창들 사이에 공유하고 마지막 창을 끌 때 해제하며 음을 재생하지 않는다', async () => {
    const audio = await initialized(); audio.resume.mockClear();
    const first = sound.subscribeOrderReceiptSoundRecovery();
    const second = sound.subscribeOrderReceiptSoundRecovery();
    audio.state = 'interrupted';
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.resume).toHaveBeenCalledOnce();
    first(); audio.state = 'suspended';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.resume).toHaveBeenCalledTimes(2);
    second(); audio.state = 'suspended';
    window.dispatchEvent(new Event('focus'));
    expect(audio.resume).toHaveBeenCalledTimes(2);
    expect(audio.sources).toHaveLength(0);
  });
});
