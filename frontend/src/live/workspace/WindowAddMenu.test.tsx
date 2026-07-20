import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowAddMenu } from './WindowAddMenu';
import { useWorkspaceStore, WINDOW_KINDS, type WorkspaceWindow } from '../../state/workspace';

/**
 * 창 추가 드롭다운(A안) — 구 `+차트 +호가 …` 7버튼을 접은 단일 메뉴.
 *
 * 고정하는 계약: (1) 닫힌 동안 종류가 노출되지 않는다(툴바 폭이 창 종류 수와
 * 무관해진 것이 이 변경의 요점), (2) 열면 모든 WindowKind 가 빠짐없이 나온다,
 * (3) 선택 시 창이 실제로 추가되고 메뉴가 닫힌다, (4) 지수 전용 창은 주식
 * 그룹에서 클릭 전에 태그로 제약을 알리되 막지는 않는다.
 */

const WIN = 'add-menu-win';

function seedChartWindow(): void {
  const win: WorkspaceWindow = {
    id: WIN,
    kind: 'chart',
    group: 1,
    rect: { x: 0, y: 0, w: 800, h: 600 },
    chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
  };
  useWorkspaceStore.setState({ windows: [win], zOrder: [WIN], groupSymbols: {}, chartRuntime: {} });
}

const openMenu = () => fireEvent.click(screen.getByTestId('workspace-add-menu-button'));

describe('WindowAddMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    seedChartWindow();
  });

  it('keeps every window kind collapsed behind a single trigger until opened', () => {
    render(<WindowAddMenu />);

    expect(screen.getByTestId('workspace-add-menu-button')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull();
    for (const kind of WINDOW_KINDS) {
      expect(screen.queryByTestId(`workspace-add-${kind}`)).toBeNull();
    }
  });

  it('lists every WindowKind once opened', () => {
    render(<WindowAddMenu />);
    openMenu();

    expect(screen.getByTestId('workspace-add-menu')).toBeInTheDocument();
    for (const kind of WINDOW_KINDS) {
      expect(screen.getByTestId(`workspace-add-${kind}`)).toBeInTheDocument();
    }
    // 리스트는 버튼 라벨이 담지 못하던 설명을 싣는다.
    expect(screen.getByText('캔들 + 보조지표 스택')).toBeInTheDocument();
  });

  it('adds the picked window kind and closes the menu', () => {
    render(<WindowAddMenu />);
    openMenu();
    fireEvent.click(screen.getByTestId('workspace-add-book'));

    const { windows } = useWorkspaceStore.getState();
    expect(windows).toHaveLength(2);
    expect(windows.some((w) => w.kind === 'book')).toBe(true);
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull();
  });

  it('closes on Escape without adding a window', () => {
    render(<WindowAddMenu />);
    openMenu();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('workspace-add-menu')).toBeNull();
    expect(useWorkspaceStore.getState().windows).toHaveLength(1);
  });

  it('flags the index-only window on a stock group but still allows adding it', () => {
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });
    render(<WindowAddMenu />);
    openMenu();

    const item = screen.getByTestId('workspace-add-sector-ranking');
    expect(item).toHaveTextContent('지수 전용');
    // 창을 먼저 만들고 그룹을 지수로 바꾸는 흐름이 정상 — 비활성화하지 않는다.
    fireEvent.click(item);
    expect(useWorkspaceStore.getState().windows.some((w) => w.kind === 'sector-ranking')).toBe(true);
  });

  it('drops the index-only flag when the active group holds an index', () => {
    useWorkspaceStore.setState({
      groupSymbols: { 1: { code: 'KOSPI', name: '코스피', kind: 'index' } },
    });
    render(<WindowAddMenu />);
    openMenu();

    expect(screen.getByTestId('workspace-add-sector-ranking')).not.toHaveTextContent('지수 전용');
  });

  it('focuses the first item on open and wraps arrow-key navigation', () => {
    render(<WindowAddMenu />);
    openMenu();

    const first = screen.getByTestId(`workspace-add-${WINDOW_KINDS[0]}`);
    const last = screen.getByTestId(`workspace-add-${WINDOW_KINDS[WINDOW_KINDS.length - 1]}`);
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
  });
});
