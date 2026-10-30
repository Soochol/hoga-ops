import { tooltipQueries } from '../../../tests/tooltipQueries';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MajorIndicesWindow } from './MajorIndicesWindow';
import { useMajorIndices } from './useMajorIndices';
import { useMajorIndicesStock } from './useMajorIndicesStock';
import { MAJOR_INDICES } from './majorIndicesModel';
import { regularSessionOpenMs as open } from '../liveDateTime';
import { useWorkspaceStore, activationTarget, activeGroupOf, focusedWindowSymbol, snapshotWorkspace } from '../../state/workspace';
import { useWindowSettingsStore } from '../../state/windowSettings';
vi.mock('./useMajorIndices', () => ({ useMajorIndices: vi.fn() }));
vi.mock('./useMajorIndicesStock', () => ({ useMajorIndicesStock: vi.fn() }));
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
const frameProps = { id: 'indices', kind: 'market-indices' as const, group: 1 as const, rect: { x: 0, y: 0, w: 660, h: 215 }, zIndex: 1, focused: true,
  symbolLabel: '삼성전자', symbolCode: '005930', paletteOpen: false, onHandleDown: vi.fn(), onFocus: vi.fn(), onClose: vi.fn(), onTogglePalette: vi.fn(), onPickGroup: vi.fn(), onTogglePin: vi.fn() };
beforeEach(() => {
  useWindowSettingsStore.setState({ byWindow: {} });
  vi.mocked(useMajorIndicesStock).mockReturnValue({ points: [], loading: false, failed: false });
  vi.mocked(useMajorIndices).mockReturnValue({ date: '20261015', now: open('20261015') + 60_000, status: '장중', label: '장중', loading: false,
    series: MAJOR_INDICES.map((s, i) => ({ ...s, points: [{ tMs: open('20261015'), percent: i }, { tMs: open('20261015') + 60_000, percent: i + .1 }], value: 100 + i, percent: i, observedMs: open('20261015') + 60_000, closed: false, delayed: false })) });
});
describe('major indices window', () => {
  it('renders one pane, three index lines, a group number and no stock axis or footer', () => {
    const { container } = render(<MajorIndicesWindow frameProps={frameProps} />);
    expect(screen.getByTestId('major-indices-chart').querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelectorAll('[data-index-series]')).toHaveLength(3);
    expect(screen.getByText('등락률 %')).toHaveAttribute('text-anchor', 'end');
    expect(tooltipQueries().queryByText('링크 그룹 변경')).toBeNull();
    expect(screen.getByRole('button', { name: '링크 그룹 1 변경' })).toHaveTextContent('1');
    expect(screen.queryByTestId('window-pin-toggle')).toBeNull();
    expect(within(screen.getByRole('list', { name: '표시 항목' })).getByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주요 지수 설정' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/별도\s?배율|독립\s?배율/);
    expect(within(container.querySelector('[data-handle="move"]') as HTMLElement).getByRole('button', { name: '주요 지수 창 닫기' }).querySelector('svg')).not.toBeNull();
    expect(container.querySelector('[data-handle="move"]')).toHaveTextContent('주요 지수');
    expect(container.querySelector('[data-handle="move"]')!.textContent).not.toMatch(/코스피|코스닥|K200|장중|%|⠿/);
    expect(container.querySelector('footer')).toBeNull();
  });
  it('applies selection to the legend, tooltip and axis, and preserves at least one index', () => {
    const current = vi.mocked(useMajorIndices)();
    vi.mocked(useMajorIndices).mockImplementation((indices = ['KOSPI', 'KOSDAQ', 'KOSPI200']) => ({ ...current,
      series: current.series.filter(series => indices.includes(series.id)),
    }));
    const { container } = render(<MajorIndicesWindow frameProps={frameProps} />);
    const axisBefore = screen.getByTestId('major-indices-axis-labels').textContent;
    fireEvent.click(screen.getByRole('button', { name: '주요 지수 설정' }));
    const settings = screen.getByRole('dialog', { name: '주요 지수 설정' });
    fireEvent.click(within(settings).getByRole('checkbox', { name: 'K200' }));
    fireEvent.click(within(settings).getByRole('checkbox', { name: '코스닥' }));
    expect(within(settings).getByRole('checkbox', { name: '코스피' })).toBeDisabled();
    expect(container.querySelectorAll('[data-index-series]')).toHaveLength(1);
    const legend = screen.getByRole('list', { name: '표시 항목' });
    expect(legend).toHaveTextContent('코스피삼성전자');
    expect(legend).not.toHaveTextContent(/코스닥|K200/);
    expect(screen.getByTestId('major-indices-axis-labels').textContent).not.toBe(axisBefore);
    fireEvent.keyDown(settings, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '주요 지수 설정' })).toHaveFocus();
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 5, clientY: 40 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('코스피');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(/코스닥|K200/);
  });
  it('disables the linked stock source, legend, notices and tooltip when stock display is OFF', () => {
    const { rerender, container } = render(<MajorIndicesWindow frameProps={frameProps} />);
    fireEvent.click(screen.getByRole('button', { name: '주요 지수 설정' }));
    fireEvent.click(screen.getByRole('switch', { name: '그룹 종목 표시' }));
    expect(useMajorIndicesStock).toHaveBeenLastCalledWith(null, '20261015');
    expect(screen.getByRole('list', { name: '표시 항목' })).not.toHaveTextContent('삼성전자');
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[data-stock-series]')).toBeNull();
    rerender(<MajorIndicesWindow frameProps={{ ...frameProps, symbolCode: '000660', symbolLabel: 'SK하이닉스' }} />);
    expect(useMajorIndicesStock).toHaveBeenLastCalledWith(null, '20261015');
    fireEvent.click(screen.getByRole('switch', { name: '그룹 종목 표시' }));
    expect(useMajorIndicesStock).toHaveBeenLastCalledWith('000660', '20261015');
    expect(screen.getByRole('list', { name: '표시 항목' })).toHaveTextContent('SK하이닉스');
  });
  it('shows all three series at a shared cursor position', () => {
    render(<MajorIndicesWindow frameProps={frameProps} />);
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 5, clientY: 40 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('코스피');
    expect(screen.getByRole('tooltip')).toHaveTextContent('코스닥');
    expect(screen.getByRole('tooltip')).toHaveTextContent('K200');
  });
  it('draws the stock with a hidden independent scale and includes its close at the shared cursor', () => {
    const view = render(<MajorIndicesWindow frameProps={frameProps} />);
    const axis = screen.getByTestId('major-indices-axis-labels').textContent;
    vi.mocked(useMajorIndicesStock).mockReturnValue({ points: [
      { tMs: open('20261015'), close: 100_000 }, { tMs: open('20261015') + 60_000, close: 200_000 },
    ], loading: false, failed: false });
    view.rerender(<MajorIndicesWindow frameProps={frameProps} />);
    expect(view.container.querySelector('[data-stock-series] path')).not.toBeNull();
    expect(screen.getByTestId('major-indices-axis-labels').textContent).toBe(axis);
    expect(screen.queryByText('100,000원')).toBeNull();
    const path = view.container.querySelector('[data-stock-series] path')!.getAttribute('d')!;
    expect(path).not.toMatch(/NaN|Infinity/);
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 5, clientY: 40 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('삼성전자100,000원');
    fireEvent.pointerLeave(screen.getByRole('img'));
    vi.mocked(useMajorIndicesStock).mockReturnValue({ points: [], loading: true, failed: false });
    view.rerender(<MajorIndicesWindow frameProps={{ ...frameProps, symbolLabel: 'SK하이닉스', symbolCode: '000660' }} />);
    expect(view.container.querySelector('[data-stock-series]')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(view.container.querySelectorAll('[data-index-series]')).toHaveLength(3);
    expect(screen.getByRole('status')).toHaveTextContent('SK하이닉스 불러오는 중');
  });
  it.each([3, -5])('fits the Y axis to actual changes without forcing zero (starting at %s%%)', first => {
    const current = vi.mocked(useMajorIndices)();
    vi.mocked(useMajorIndices).mockReturnValue({ ...current,
      series: current.series.map((s, i) => ({ ...s, points: s.points.map(p => ({ ...p, percent: first + i })) })),
    });
    const { container } = render(<MajorIndicesWindow frameProps={frameProps} />);
    const values = Array.from(screen.getByTestId('major-indices-axis-labels').querySelectorAll('text'), node => parseFloat(node.textContent!));
    expect(values.length).toBeGreaterThan(1);
    expect(Math.min(...values)).toBeLessThanOrEqual(first);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(first + 2);
    expect(values.every(value => first > 0 ? value > 0 : value < 0)).toBe(true);
    expect(container.querySelector('.major-indices-zero')).toBeNull();
  });
  it('shows zero when the actual range crosses it and handles empty or flat data', () => {
    const current = vi.mocked(useMajorIndices)();
    const { container, rerender } = render(<MajorIndicesWindow frameProps={frameProps} />);
    for (const points of [[-1, 1], [0], [3], []]) {
      vi.mocked(useMajorIndices).mockReturnValue({ ...current,
        series: current.series.map(s => ({ ...s, points: points.map((percent, i) => ({ tMs: open('20261015') + i * 60_000, percent })) })),
      });
      rerender(<MajorIndicesWindow frameProps={frameProps} />);
      expect(container.querySelector('svg')!.outerHTML).not.toMatch(/NaN|Infinity/);
      if (points.includes(-1) || points.includes(0)) expect(container.querySelector('.major-indices-zero')).not.toBeNull();
    }
  });
  it('expands the axis with time while delayed series stop at the last observation', () => {
    const current = vi.mocked(useMajorIndices)();
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, now: open('20261015') + 100 * 60_000 });
    const { container, rerender } = render(<MajorIndicesWindow frameProps={frameProps} />);
    const axis = screen.getByTestId('major-indices-time-axis');
    expect(within(axis).getByText('10:40')).toBeInTheDocument();
    expect(within(axis).queryByText('15:30')).toBeNull();
    const endpoint = container.querySelector('[data-index-series] circle')!;
    const before = Number(endpoint.getAttribute('cx'));
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, now: open('20261015') + 101 * 60_000 });
    rerender(<MajorIndicesWindow frameProps={frameProps} />);
    expect(within(axis).getByText('10:41')).toBeInTheDocument();
    expect(Number(endpoint.getAttribute('cx'))).toBeLessThan(before);
  });
  it('keeps a pinned timestamp through clock updates and resize, and clears it on a different day', () => {
    const current = vi.mocked(useMajorIndices)();
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, now: open('20261015') + 100 * 60_000 });
    const { rerender } = render(<MajorIndicesWindow frameProps={frameProps} />);
    fireEvent.click(screen.getByRole('img'), { clientX: 276.5, clientY: 40 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('09:50');
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, now: open('20261015') + 120 * 60_000 });
    rerender(<MajorIndicesWindow frameProps={{ ...frameProps, rect: { ...frameProps.rect, w: 400 } }} />);
    fireEvent.pointerLeave(screen.getByRole('img'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('09:50');
    fireEvent.click(screen.getByRole('img'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByRole('img'), { clientX: 276.5, clientY: 40 });
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, date: '20261016', now: open('20261016') + 120 * 60_000 });
    rerender(<MajorIndicesWindow frameProps={frameProps} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('renders finite geometry at 09:00 and the full axis for an earlier day', () => {
    const current = vi.mocked(useMajorIndices)();
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, now: open('20261015'), series: current.series.map(s => ({ ...s, points: s.points.slice(0, 1) })) });
    const { container, rerender } = render(<MajorIndicesWindow frameProps={frameProps} />);
    expect(screen.getByTestId('major-indices-time-axis')).toHaveTextContent('09:00');
    expect(container.querySelector('svg')!.outerHTML).not.toMatch(/NaN|Infinity/);
    vi.mocked(useMajorIndices).mockReturnValue({ ...current, now: open('20261016') - 60_000 });
    rerender(<MajorIndicesWindow frameProps={frameProps} />);
    expect(within(screen.getByTestId('major-indices-time-axis')).getByText('15:30')).toBeInTheDocument();
  });
  it('links focus, search, drops and presets to its group while keeping pinning disabled', () => {
    useWorkspaceStore.setState({ windows: [], zOrder: [], groupSymbols: { 2: { code: '005930', name: '삼성전자' } } });
    const stock = useWorkspaceStore.getState().addWindow('chart');
    useWorkspaceStore.getState().setWindowGroup(stock, 2);
    const indices = useWorkspaceStore.getState().addWindow('market-indices');
    const state = useWorkspaceStore.getState();
    expect(activeGroupOf(state)).toBe(2);
    expect(focusedWindowSymbol(state)?.code).toBe('005930');
    expect(activationTarget(state)).toMatchObject({ kind: 'window', window: { id: indices } });
    state.setWindowSymbol(indices, { code: '000660', name: 'SK하이닉스' });
    expect(useWorkspaceStore.getState().groupSymbols[2]?.code).toBe('000660');
    state.toggleWindowPin(indices);
    state.pinWindows([indices]);
    state.pinWindowToSymbol(indices, { code: '005930', name: '삼성전자' });
    expect(useWorkspaceStore.getState().windows.find(w => w.id === indices)?.pinned).toBeUndefined();
    state.setWindowGroup(indices, 3);
    state.setGroupSymbol(3, { code: '035420', name: 'NAVER' });
    expect(activeGroupOf(useWorkspaceStore.getState())).toBe(3);
    expect(focusedWindowSymbol(useWorkspaceStore.getState())?.code).toBe('035420');
    state.applyWorkspaceSnapshot(snapshotWorkspace());
    expect(useWorkspaceStore.getState().windows.find(w => w.id === indices)).toMatchObject({ kind: 'market-indices', group: 3 });
  });
});
