import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RailDestination } from './RailDestination';
import { useWorkspaceStore, type WorkspaceWindow } from '../state/workspace';

const initial = useWorkspaceStore.getState();
afterEach(() => useWorkspaceStore.setState(initial));
const rect = { x: 0, y: 0, w: 0.5, h: 1 };

it('tracks the topmost unpinned destination, linked count, blocked and empty workspaces', () => {
  const windows: WorkspaceWindow[] = [
    { id: 'a', kind: 'chart', group: 2, rect },
    { id: 'b', kind: 'book', group: 2, rect },
    { id: 'c', kind: 'chart', group: 3, rect, pinned: { code: '005930', name: '삼성전자' } },
  ];
  useWorkspaceStore.setState({ windows, zOrder: ['a', 'b', 'c'] });
  render(<RailDestination />);
  expect(screen.getByRole('status')).toHaveTextContent('연결 대상: 그룹 2 · 창 2개');
  act(() => useWorkspaceStore.setState({ windows: [windows[2]], zOrder: ['c'] }));
  expect(screen.getByRole('status')).toHaveTextContent('창 고정을 해제하세요');
  act(() => useWorkspaceStore.setState({ windows: [], zOrder: [] }));
  expect(screen.getByRole('status')).toHaveTextContent('연결 대상: 그룹 1 · 창 추가 후 표시');
});
