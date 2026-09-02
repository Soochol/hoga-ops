import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, useLayoutEffect } from 'react';
import { render, cleanup } from '@testing-library/react';
import { useRightRailStore } from './rightRail';
import { useWorkspaceStore } from './workspace';
import { __disarmUpdateLoopSignalForTests, readUpdateLoopReport } from './updateLoopSignal';
import { installUpdateLoopWatch, uninstallUpdateLoopWatch, watchedStoreNames } from './updateLoopWatch';

/** 실제 커밋 안에서 쓰기를 낸다 — 덫은 스택이 React 의 렌더/커밋을 지나야 신고한다
 *  (`updateLoopSignal.ts` 의 react-dom 게이트). 외부 콜백의 배치는 그 예외를 던질 수
 *  없으므로 표적이 아니고, 그래서 여기서도 «진짜 커밋» 이 재현 조건이다. */
function inReactCommit(fn: () => void): void {
  function Writer() {
    useLayoutEffect(fn, []);
    return null;
  }
  render(createElement(Writer));
}

describe('updateLoopWatch', () => {
  beforeEach(() => {
    __disarmUpdateLoopSignalForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    uninstallUpdateLoopWatch();
    __disarmUpdateLoopSignalForTests();
    vi.restoreAllMocks();
  });

  it('설치하면 실제 스토어 쓰기가 이름과 함께 잡힌다', () => {
    installUpdateLoopWatch();
    // `setState({})` 는 항상 새 상태 객체를 만들어 구독을 깨운다 — 액션의 부수효과
    // 없이 «쓰기» 만 재현하는 가장 얇은 방법이다.
    inReactCommit(() => { for (let i = 0; i < 20; i += 1) useRightRailStore.setState({}); });
    expect(readUpdateLoopReport()?.store).toBe('rightRail');
  });

  it('구독은 액션의 내부 쓰기도 본다 — `setState` 를 감싸지 않는 이유', () => {
    installUpdateLoopWatch();
    // 액션은 스토어 생성 시 받은 내부 `set` 클로저로 쓴다. `api.setState` 를 갈아끼우는
    // 방식이었다면 이 경로가 통째로 새어 나간다.
    inReactCommit(() => {
      for (let i = 0; i < 20; i += 1) useWorkspaceStore.getState().addWindow('chart');
    });
    expect(readUpdateLoopReport()?.store).toBe('workspace');
  });

  it('해제하면 더 이상 세지 않는다 — HMR 재설치가 구독을 겹쳐 쌓지 않는다', () => {
    installUpdateLoopWatch();
    installUpdateLoopWatch();
    uninstallUpdateLoopWatch();
    inReactCommit(() => { for (let i = 0; i < 40; i += 1) useRightRailStore.setState({}); });
    expect(readUpdateLoopReport()).toBeNull();
  });

  it('감시 목록이 비어 있지 않고 이름이 중복되지 않는다', () => {
    const names = watchedStoreNames();
    expect(names.length).toBeGreaterThan(10);
    expect(new Set(names).size).toBe(names.length);
  });
});
