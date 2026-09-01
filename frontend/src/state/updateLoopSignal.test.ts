import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __disarmUpdateLoopSignalForTests,
  armUpdateLoopSignal,
  formatUpdateLoopReport,
  noteStoreWrite,
  readUpdateLoopReport,
} from './updateLoopSignal';

/** 프레임 경계를 실제로 넘긴다 — 덫의 계수 리셋이 rAF 에 걸려 있다. */
const nextFrame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve());
});

describe('updateLoopSignal', () => {
  beforeEach(() => {
    __disarmUpdateLoopSignalForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    __disarmUpdateLoopSignalForTests();
    vi.restoreAllMocks();
  });

  it('무장 전에는 아무것도 하지 않는다 — 프로덕션·테스트에서 비용 0', () => {
    for (let i = 0; i < 100; i += 1) noteStoreWrite('workspace');
    expect(readUpdateLoopReport()).toBeNull();
  });

  it('한 프레임에 한계를 넘기면 스토어 이름·횟수·스택을 신고한다', () => {
    armUpdateLoopSignal();
    for (let i = 0; i < 20; i += 1) noteStoreWrite('livePage');
    const report = readUpdateLoopReport();
    expect(report?.store).toBe('livePage');
    expect(report?.writes).toBe(20);
    // 스택은 **쓴 쪽**의 프레임을 담아야 한다 — 알림이 setState 안에서 동기적으로
    // 돌기 때문에 성립하는 성질이고, 이 테스트에서는 호출자가 이 파일이다.
    expect(report?.stack).toContain('updateLoopSignal.test');
  });

  it('프레임이 바뀌면 계수가 0 으로 — 정상 활동(팬·틱)은 걸리지 않는다', async () => {
    armUpdateLoopSignal();
    for (let i = 0; i < 19; i += 1) noteStoreWrite('liveCursor');
    await nextFrame();
    for (let i = 0; i < 19; i += 1) noteStoreWrite('liveCursor');
    await nextFrame();
    expect(readUpdateLoopReport()).toBeNull();
  });

  it('같은 프레임의 다른 스토어도 히스토그램에 함께 남는다 — 루프 참가자를 본다', () => {
    armUpdateLoopSignal();
    for (let i = 0; i < 3; i += 1) noteStoreWrite('drawings');
    for (let i = 0; i < 20; i += 1) noteStoreWrite('workspace');
    const report = readUpdateLoopReport();
    expect(report?.store).toBe('workspace');
    expect(report?.frameHistogram).toEqual([['workspace', 20], ['drawings', 3]]);
  });

  it('첫 신고만 남긴다 — 폭주 중 같은 스택 수백 개로 콘솔을 덮지 않는다', () => {
    armUpdateLoopSignal();
    for (let i = 0; i < 20; i += 1) noteStoreWrite('chartPrefs');
    for (let i = 0; i < 40; i += 1) noteStoreWrite('themePrefs');
    expect(readUpdateLoopReport()?.store).toBe('chartPrefs');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('포맷은 스토어·횟수·히스토그램·스택을 한 덩어리로 싣는다', () => {
    armUpdateLoopSignal();
    for (let i = 0; i < 20; i += 1) noteStoreWrite('viewport');
    const text = formatUpdateLoopReport(readUpdateLoopReport()!);
    expect(text).toContain('store=viewport');
    expect(text).toContain('writes-in-one-frame=20');
    expect(text).toContain('viewport×20');
  });
});
