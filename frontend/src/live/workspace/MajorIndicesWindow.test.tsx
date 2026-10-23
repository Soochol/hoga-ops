import { tooltipQueries } from '../../../tests/tooltipQueries';
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MajorIndicesWindow } from './MajorIndicesWindow';
import { useMajorIndices } from './useMajorIndices';
import { MAJOR_INDICES } from './majorIndicesModel';
import { regularSessionOpenMs as open } from '../liveDateTime';
import { useWorkspaceStore, activationTarget, activeGroupOf, focusedWindowSymbol, snapshotWorkspace } from '../../state/workspace';
vi.mock('./useMajorIndices', () => ({ useMajorIndices: vi.fn() }));
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
const frameProps = { id: 'indices', kind: 'market-indices' as const, group: 1 as const, rect: { x: 0, y: 0, w: 660, h: 215 }, zIndex: 1, focused: true,
  symbolLabel: '삼성전자', symbolCode: '005930', paletteOpen: false, onHandleDown: vi.fn(), onFocus: vi.fn(), onClose: vi.fn(), onTogglePalette: vi.fn(), onPickGroup: vi.fn(), onTogglePin: vi.fn() };
beforeEach(() => {
  vi.mocked(useMajorIndices).mockReturnValue({ date: '20261015', now: open('20261015') + 60_000, status: '장중', label: '장중', loading: false,
    series: MAJOR_INDICES.map((s, i) => ({ ...s, points: [{ tMs: open('20261015'), percent: i }, { tMs: open('20261015') + 60_000, percent: i + .1 }], value: 100 + i, percent: i, observedMs: open('20261015') + 60_000, closed: false, delayed: false })) });
});
describe('major indices window', () => {
  it('renders one pane, three lines and the right percent axis without a group or footer', () => {
    const { container } = render(<MajorIndicesWindow frameProps={frameProps} />);
    expect(screen.getByTestId('major-indices-chart').querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelectorAll('[data-index-series]')).toHaveLength(3);
    expect(screen.getByText('등락률 %')).toHaveAttribute('text-anchor', 'end');
    expect(tooltipQueries().queryByText('링크 그룹 변경')).toBeNull();
    expect(screen.queryByTestId('window-pin-toggle')).toBeNull();
    expect(screen.queryByText('삼성전자')).toBeNull();
    expect(container.querySelector('footer')).toBeNull();
  });
  it('shows all three series at a shared cursor position', () => {
    render(<MajorIndicesWindow frameProps={frameProps} />);
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 5, clientY: 40 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('코스피');
    expect(screen.getByRole('tooltip')).toHaveTextContent('코스닥');
    expect(screen.getByRole('tooltip')).toHaveTextContent('K200');
  });
  it('keeps search, drops, focus and preset restoration independent of this window', () => {
    useWorkspaceStore.setState({ windows: [], zOrder: [], groupSymbols: { 2: { code: '005930', name: '삼성전자' } } });
    const stock = useWorkspaceStore.getState().addWindow('chart');
    useWorkspaceStore.getState().setWindowGroup(stock, 2);
    const indices = useWorkspaceStore.getState().addWindow('market-indices');
    const state = useWorkspaceStore.getState();
    expect(activeGroupOf(state)).toBe(2);
    expect(focusedWindowSymbol(state)?.code).toBe('005930');
    expect(activationTarget(state)).toMatchObject({ kind: 'window', window: { id: stock } });
    state.setWindowSymbol(indices, { code: '000660', name: 'SK하이닉스' });
    expect(useWorkspaceStore.getState().groupSymbols[2]?.code).toBe('005930');
    state.applyWorkspaceSnapshot(snapshotWorkspace());
    expect(useWorkspaceStore.getState().windows.find(w => w.id === indices)?.kind).toBe('market-indices');
  });
});
