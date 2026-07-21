import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useDrawerAutoCollapse } from './useDrawerAutoCollapse';
import { useRightRailStore } from '../state/rightRail';

// jsdom 은 스타일시트를 안 읽으므로 토큰을 :root 인라인으로 심는다. 이 셋업이
// 없으면 훅이 threshold=0 으로 계산돼 **조용히 아무 일도 안 하고** 테스트는
// 통과한다 — 이 파일의 존재 이유가 그 거짓 통과를 막는 것이다.
const FLOOR_REM = 57;
const DRAWER_REM = 17.5;
const ROOT_PX = 18;
/** 임계 = (57 + 17.5) * 18 = 1341px */
const THRESHOLD = (FLOOR_REM + DRAWER_REM) * ROOT_PX;

function Probe() {
  useDrawerAutoCollapse();
  return null;
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

function fireResize() {
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe('useDrawerAutoCollapse', () => {
  beforeEach(() => {
    const root = document.documentElement;
    root.style.fontSize = `${ROOT_PX}px`;
    root.style.setProperty('--app-floor-min-w', `${FLOOR_REM}rem`);
    root.style.setProperty('--watchlist-panel-w', `${DRAWER_REM}rem`);
    useRightRailStore.setState({ activePanel: 'watchlist', lastPanel: 'watchlist' });
    setViewport(1600);
  });

  afterEach(() => {
    const root = document.documentElement;
    root.style.removeProperty('font-size');
    root.style.removeProperty('--app-floor-min-w');
    root.style.removeProperty('--watchlist-panel-w');
    localStorage.clear();
  });

  it('reads the threshold from tokens rather than a hardcoded px value', () => {
    // 토큰이 실제로 읽히는지 — 이게 0 이면 아래 단언들이 전부 무의미해진다.
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue('--app-floor-min-w').trim()).toBe(`${FLOOR_REM}rem`);
    expect(THRESHOLD).toBe(1341);
  });

  it('keeps the drawer open above the threshold', () => {
    setViewport(THRESHOLD);
    render(<Probe />);
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
  });

  it('closes the drawer once when the viewport drops below the threshold', () => {
    render(<Probe />);
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');

    setViewport(THRESHOLD - 1);
    fireResize();

    expect(useRightRailStore.getState().activePanel).toBeNull();
    // 재열기 대상은 보존한다 — 셰브런이 같은 패널을 되연다.
    expect(useRightRailStore.getState().lastPanel).toBe('watchlist');
  });

  it('closes on mount when the viewport is already below the threshold', () => {
    setViewport(1100);
    render(<Probe />);
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });

  it('respects a user re-opening the drawer at the same narrow width (one-time yield)', () => {
    render(<Probe />);
    setViewport(1100);
    fireResize();
    expect(useRightRailStore.getState().activePanel).toBeNull();

    // 사용자가 좁은 폭에서 직접 다시 연다 → 그 폭에 머무는 한 다시 닫지 않는다.
    act(() => useRightRailStore.getState().setActivePanel('screener'));
    setViewport(1050);
    fireResize();
    expect(useRightRailStore.getState().activePanel).toBe('screener');
  });

  it('re-arms the yield after the viewport goes back above the threshold', () => {
    render(<Probe />);
    setViewport(1100);
    fireResize();
    act(() => useRightRailStore.getState().setActivePanel('watchlist'));

    // 넓어졌다가(양보 플래그 해제) 다시 좁아지면 한 번 더 양보한다.
    setViewport(1600);
    fireResize();
    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    setViewport(1100);
    fireResize();
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });

  it('never re-opens the drawer on its own when the viewport widens', () => {
    render(<Probe />);
    setViewport(1100);
    fireResize();
    expect(useRightRailStore.getState().activePanel).toBeNull();

    setViewport(1600);
    fireResize();
    expect(useRightRailStore.getState().activePanel).toBeNull();
  });
});
