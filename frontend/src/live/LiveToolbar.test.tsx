import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TimeframeControl } from './TimeframeControl';
import { WorkspaceLiveToolbar } from './workspace/WorkspaceLiveToolbar';
import { useWorkspaceStore, type WorkspaceWindow } from '../state/workspace';

/**
 * 멀티창 플립(ADR-0119 C2c-2d) 후 봉 컨트롤은 각 차트 창 상단에 창별로 배선된다.
 * 이 스위트는 ChartWindow 의 배선을 그대로 미러한 하네스로 TimeframeControl 의
 * 동작(분봉 메뉴·기억·달력 전환)을 창 상태 기준으로 고정하고, 액션 버튼은
 * WorkspaceLiveToolbar 로 검증한다(구 LiveToolbar 는 폐지 — LiveChartActionButtons 만 존속).
 */

const WIN = 'tf-win';

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

function chart() {
  const c = useWorkspaceStore.getState().windows.find((w) => w.id === WIN)?.chart;
  if (!c) throw new Error('no chart window');
  return c;
}

/** ChartWindow 의 봉 컨트롤 배선 미러(창 tf·창별 분봉 기억·setChartTimeframe). */
function WindowTimeframeHarness() {
  const win = useWorkspaceStore((s) => s.windows.find((w) => w.id === WIN));
  const setChartTimeframe = useWorkspaceStore((s) => s.setChartTimeframe);
  if (!win?.chart) return null;
  return (
    <TimeframeControl
      timeframe={win.chart.timeframe}
      rememberedMinute={win.chart.lastMinuteTimeframe ?? '1m'}
      onChange={(tf) => setChartTimeframe(WIN, tf)}
    />
  );
}

describe('창별 TimeframeControl (ChartWindow 배선 미러)', () => {
  beforeEach(() => {
    localStorage.clear();
    seedChartWindow();
  });

  it('renders compact minute selector plus day/week/month controls and no year control', () => {
    render(<WindowTimeframeHarness />);

    expect(screen.getByRole('button', { name: '분봉 선택 열기: 1분' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '일' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '월' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '년' })).toBeNull();
    expect(screen.queryByText('1m')).toBeNull();
    expect(screen.queryByText('D')).toBeNull();
  });

  it('opens minute list on minute timeframe and selecting a minute switches the window timeframe', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    const menu = screen.getByRole('menu', { name: '분봉 목록' });
    ['1분', '3분', '5분', '10분', '15분', '30분'].forEach((minuteOption) => {
      expect(within(menu).getByRole('menuitemradio', { name: minuteOption })).toBeInTheDocument();
    });
    expect(within(menu).getByRole('menuitemradio', { name: '3분' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '3분' }));

    expect(chart().timeframe).toBe('3m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 3분' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('renders the minute list in a body portal so chart layers cannot cover it', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));

    expect(screen.getByRole('menu', { name: '분봉 목록' }).parentElement).toBe(document.body);
  });

  it('clicking the active minute selector again closes the minute list', () => {
    render(<WindowTimeframeHarness />);

    const minuteSelector = screen.getByRole('button', { name: '분봉 선택 열기: 1분' });
    fireEvent.click(minuteSelector);
    expect(screen.getByRole('menu', { name: '분봉 목록' })).toBeInTheDocument();

    fireEvent.click(minuteSelector);

    expect(chart().timeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('from calendar timeframe, minute selector immediately switches to the remembered minute', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '5분' }));
    fireEvent.click(screen.getByRole('button', { name: '일' }));
    expect(chart().timeframe).toBe('D');

    fireEvent.click(screen.getByRole('button', { name: '분봉으로 전환: 5분' }));

    expect(chart().timeframe).toBe('5m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 5분' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('from calendar timeframe, minute selector uses the window lastMinuteTimeframe', () => {
    seedChartWindow();
    useWorkspaceStore.getState().setChartTimeframe(WIN, '10m');
    useWorkspaceStore.getState().setChartTimeframe(WIN, 'D');
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉으로 전환: 10분' }));

    expect(chart().timeframe).toBe('10m');
    expect(chart().lastMinuteTimeframe).toBe('10m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('selecting a minute option updates the window lastMinuteTimeframe', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '15분' }));

    expect(chart().timeframe).toBe('15m');
    expect(chart().lastMinuteTimeframe).toBe('15m');
  });

  it('calendar buttons switch timeframe and close an open minute menu', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    expect(screen.getByRole('menu', { name: '분봉 목록' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '주' }));

    expect(chart().timeframe).toBe('W');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('month button switches to monthly timeframe', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '월' }));

    expect(chart().timeframe).toBe('M');
    expect(screen.getByRole('button', { name: '월' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Escape closes the minute list without changing timeframe', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(chart().timeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });

  it('outside mousedown closes the minute list without changing timeframe', () => {
    render(<WindowTimeframeHarness />);

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 1분' }));
    fireEvent.mouseDown(document.body);

    expect(chart().timeframe).toBe('1m');
    expect(screen.queryByRole('menu', { name: '분봉 목록' })).toBeNull();
  });
});

function renderToolbar(props: Partial<Parameters<typeof WorkspaceLiveToolbar>[0]> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceLiveToolbar onOpenSettings={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

describe('WorkspaceLiveToolbar 액션 버튼', () => {
  beforeEach(() => {
    localStorage.clear();
    seedChartWindow();
  });

  it('renders settings button and calls onOpenSettings on click', () => {
    const onOpenSettings = vi.fn();
    renderToolbar({ onOpenSettings });
    const btn = screen.getByTestId('live-settings-button');
    expect(btn).toHaveClass('bg-transparent');
    expect(btn).toHaveClass('text-fg-dim');
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  // 보조지표는 차트 창 헤더로 이관됐다(#758·#759) — 창의 것이라 창이 연다.
  // 여기 남아 있으면 "어느 창을 편집하나" 를 다시 추론해야 하므로 부재가 계약이다.
  // #712 의 "차트 창 0개면 no-op" 가드도 함께 사라졌다: 헤더 버튼은 차트 창에만
  // 존재하므로 그 전제가 자명하게 참이다.
  it('does not render the indicators button — it moved to the chart window header', () => {
    renderToolbar();
    expect(screen.queryByTestId('live-indicators-button')).toBeNull();
  });

  // 저장뷰·수집도 차트 창 헤더로 이관됐다 — 저장뷰는 "이 창의 지금 화면",
  // 수집은 "이 창이 보는 종목" 이라 둘 다 창이 대상을 결정한다. 부재가 계약이다:
  // 여기 남아 있으면 전역 툴바가 다시 대상을 추론해야 한다.
  it('renders neither the study-save nor the collect button — both moved to the window header', () => {
    renderToolbar();

    expect(screen.queryByTestId('live-study-save-button')).toBeNull();
    expect(screen.queryByTestId('live-collect-button')).toBeNull();
    expect(screen.queryByRole('button', { name: '그리기' })).toBeNull();
  });

  it('renders the layout preset menu button and window-add / tidy controls', () => {
    renderToolbar();
    expect(screen.getByTestId('layout-preset-button')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tidy')).toBeInTheDocument();

    // 창 추가는 종류별 버튼에서 단일 드롭다운으로 접혔다 — 열어야 종류가 보인다.
    expect(screen.queryByTestId('workspace-add-chart')).toBeNull();
    fireEvent.click(screen.getByTestId('workspace-add-menu-button'));
    expect(screen.getByTestId('workspace-add-chart')).toBeInTheDocument();
  });

  // 남는 것은 워크스페이스 관리(창 추가·정리·프리셋) + 앱 설정뿐 —
  // "어느 창/그룹에 걸리나" 를 추론해야 하는 항목이 하나도 없다.
  it('keeps only workspace-management and app-settings controls', () => {
    renderToolbar();

    expect(screen.getByTestId('workspace-add-menu-button')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tidy')).toBeInTheDocument();
    expect(screen.getByTestId('layout-preset-button')).toBeInTheDocument();
    expect(screen.getByTestId('live-settings-button')).toBeInTheDocument();
  });
});
