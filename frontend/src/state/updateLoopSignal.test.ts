import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, useLayoutEffect } from 'react';
import { render, cleanup } from '@testing-library/react';
import {
  __disarmUpdateLoopSignalForTests,
  armUpdateLoopSignal,
  formatUpdateLoopReport,
  isReactDrivenStack,
  noteStoreWrite,
  readUpdateLoopReport,
  readUpdateLoopReports,
} from './updateLoopSignal';

/** 프레임 경계를 실제로 넘긴다 — 덫의 계수 리셋이 rAF 에 걸려 있다. */
const nextFrame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve());
});

/**
 * **진짜 커밋 안에서** 쓰기를 낸다 — 스택에 실제 react-dom 프레임이 들어간다.
 *
 * 덫이 신고하려면 스택이 React 의 렌더/커밋을 지나야 하므로, 이 파일에서 「신고한다」를
 * 재는 테스트는 전부 이 헬퍼를 통한다. 가짜 이름 shim 이 아니라 실제 렌더를 쓰는 것이
 * 의도다: **설치된 react-dom 의 프레임 이름·경로가 `isReactDrivenStack` 의 토큰과
 * 맞는지**를 같이 증명하고, React 를 올리며 내부 이름이 바뀌면 여기가 빨개진다.
 *
 * `depth` 는 쓰기와 이펙트 본문 사이에 끼우는 앱 헬퍼 겹수다 — react-dom 프레임을
 * 기본 `Error.stackTraceLimit`(10) 밖으로 밀어내는 데 쓴다.
 */
function writeFromReactCommit(store: string, times: number, depth = 0): void {
  function Writer() {
    useLayoutEffect(() => {
      const call = (left: number): void => {
        if (left > 0) { call(left - 1); return; }
        noteStoreWrite(store);
      };
      for (let i = 0; i < times; i += 1) call(depth);
    }, []);
    return null;
  }
  render(createElement(Writer));
}

/** 덫이 콘솔에 남긴 신고만 센다 — React·RTL 의 다른 `console.error` 와 섞이지 않게. */
function loopConsoleCalls(): unknown[][] {
  const spy = console.error as unknown as { mock: { calls: unknown[][] } };
  return spy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('[update-loop]'));
}

describe('updateLoopSignal', () => {
  beforeEach(() => {
    __disarmUpdateLoopSignalForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    __disarmUpdateLoopSignalForTests();
    vi.restoreAllMocks();
  });

  it('무장 전에는 아무것도 하지 않는다 — 프로덕션·테스트에서 비용 0', () => {
    writeFromReactCommit('workspace', 100);
    expect(readUpdateLoopReport()).toBeNull();
  });

  it('한 프레임에 한계를 넘기면 스토어 이름·횟수·스택을 신고한다', () => {
    armUpdateLoopSignal();
    writeFromReactCommit('livePage', 20);
    const report = readUpdateLoopReport();
    expect(report?.store).toBe('livePage');
    expect(report?.writes).toBe(20);
    // 스택은 **쓴 쪽**의 프레임을 담아야 한다 — 알림이 setState 안에서 동기적으로
    // 돌기 때문에 성립하는 성질이고, 이 테스트에서는 호출자가 이 파일이다.
    expect(report?.stack).toContain('updateLoopSignal.test');
  });

  it('프레임이 바뀌면 계수가 0 으로 — 정상 활동(팬·틱)은 걸리지 않는다', async () => {
    armUpdateLoopSignal();
    writeFromReactCommit('liveCursor', 19);
    await nextFrame();
    writeFromReactCommit('liveCursor', 19);
    await nextFrame();
    expect(readUpdateLoopReport()).toBeNull();
  });

  it('게이트에 걸린 스토어도 히스토그램에는 남는다 — 그 프레임의 동승자를 본다', () => {
    armUpdateLoopSignal();
    // 비-React 배치라 신고는 안 되지만 계수는 된다.
    for (let i = 0; i < 25; i += 1) noteStoreWrite('livePromotion');
    writeFromReactCommit('workspace', 20);
    const report = readUpdateLoopReport();
    expect(report?.store).toBe('workspace');
    expect(report?.frameHistogram).toEqual([['livePromotion', 25], ['workspace', 20]]);
  });

  it('비-React 콜백의 키 분산 배치는 신고하지 않는다 — WS 승격 20종목', () => {
    // 실측 위양성(#1713): `promotion_completed` 는 종목마다 오므로 한 배치에 20종목이면
    // 서로 다른 키의 진짜 상태 변경 20건이다. 스택에 React 프레임이 없다는 것이
    // 「React 가 몰지 않았다 = 이 예외를 던질 수 없다」의 지문이다.
    armUpdateLoopSignal();
    for (let i = 0; i < 40; i += 1) noteStoreWrite('livePromotion');
    expect(readUpdateLoopReport()).toBeNull();
    expect(loopConsoleCalls()).toHaveLength(0);
  });

  it('앱 프레임이 깊어도 react-dom 을 찾아낸다 — 기본 stackTraceLimit(10)은 부족하다', () => {
    // 헬퍼 8겹이면 react-dom 이 11번째 밖으로 밀린다. `captureStack` 이 한계를 올리지
    // 않으면 스택이 잘려 게이트가 표적을 통째로 놓친다(머리말의 실측).
    armUpdateLoopSignal();
    writeFromReactCommit('viewport', 20, 8);
    expect(readUpdateLoopReport()?.store).toBe('viewport');
  });

  it('스토어마다 첫 신고만 — 같은 스택 반복은 접고, 다른 스토어는 새 사실로 받는다', () => {
    armUpdateLoopSignal();
    writeFromReactCommit('chartPrefs', 40);
    writeFromReactCommit('chartPrefs', 40);
    expect(loopConsoleCalls()).toHaveLength(1);
    writeFromReactCommit('themePrefs', 40);
    expect(loopConsoleCalls()).toHaveLength(2);
    // 헤드라인은 첫 신고 그대로, 붙여넣기용 목록에는 둘 다.
    expect(readUpdateLoopReport()?.store).toBe('chartPrefs');
    expect(readUpdateLoopReports().map((r) => r.store)).toEqual(['chartPrefs', 'themePrefs']);
  });

  it('한 스토어의 위양성이 다른 스토어의 관측을 막지 않는다 — 래치는 스토어별', () => {
    // 전역 래치였을 때의 피해가 이것이다: WS 배치 하나가 걸리면 그 세션 내내 덫이
    // 눈을 감아, 정작 잡으려던 폭주가 안 보였다.
    armUpdateLoopSignal();
    for (let i = 0; i < 20; i += 1) noteStoreWrite('livePromotion');
    writeFromReactCommit('viewport', 20);
    expect(readUpdateLoopReport()?.store).toBe('viewport');
  });

  it('포맷은 스토어·횟수·히스토그램·스택을 한 덩어리로 싣는다', () => {
    armUpdateLoopSignal();
    writeFromReactCommit('viewport', 20);
    const text = formatUpdateLoopReport(readUpdateLoopReport()!);
    expect(text).toContain('store=viewport');
    expect(text).toContain('writes-in-one-frame=20');
    expect(text).toContain('viewport×20');
  });
});

/** 매처 자체의 회귀 테스트 — 문자열은 실측 스택에서 잘라 왔다. 매처가 덜 읽으면
 *  「위양성이 아직 남았다」로 위장하므로 판별식을 따로 고정한다. */
describe('isReactDrivenStack', () => {
  it('커밋 안의 쓰기를 알아본다 — 모듈 경로와 내부 함수명 양쪽으로', () => {
    const viaPath = [
      'Error: update-loop',
      '    at noteStoreWrite (/app/frontend/src/state/updateLoopSignal.ts:180:17)',
      '    at commitHookEffectListMount (/app/frontend/node_modules/react-dom/cjs/react-dom.development.js:23189:26)',
    ].join('\n');
    // 번들러가 react-dom 을 이름 없는 청크로 합쳐 경로 토큰이 죽어도 이름은 남는다.
    const viaName = viaPath.replace(/react-dom[^)]*/, 'chunk-A1B2C3.js:9:9');
    expect(viaPath).toContain('react-dom');
    expect(viaName).not.toContain('react-dom');
    expect(isReactDrivenStack(viaPath)).toBe(true);
    expect(isReactDrivenStack(viaName)).toBe(true);
  });

  it('외부 콜백의 쓰기는 알아보지 않는다 — WS·zustand·러너 프레임뿐', () => {
    const wsStack = [
      'Error: update-loop',
      '    at noteStoreWrite (/app/frontend/src/state/updateLoopSignal.ts:180:17)',
      '    at /app/frontend/node_modules/zustand/esm/vanilla.mjs:9:39',
      '    at Object.markPromotion (/app/frontend/src/state/livePromotion.ts:6:5)',
      '    at /app/frontend/src/api/eventStream.ts:91:9',
      '    at /app/frontend/src/api/ws.ts:21:44',
    ].join('\n');
    expect(isReactDrivenStack(wsStack)).toBe(false);
  });
});
