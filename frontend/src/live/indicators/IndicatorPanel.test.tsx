import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IndicatorPanel from './IndicatorPanel';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';

function renderPanel(props: Partial<ComponentProps<typeof IndicatorPanel>> = {}) {
  const onClose = props.onClose ?? (() => {});
  const timeframe = props.timeframe ?? '1m';
  return render(<IndicatorPanel onClose={onClose} timeframe={timeframe} {...props} />);
}

describe('IndicatorPanel', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('활성 13개 체크박스(비활성 0), 10호가·프로그램·거래원 지표 포함', () => {
    useLivePageStore.setState({
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
    });
    renderPanel();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(15); // 상단 3 + 10호가 8 + 프로그램 1 + 거래원 3
    expect(checkboxes.filter((c) => (c as HTMLButtonElement).disabled)).toHaveLength(0);
    for (const name of ['총잔량', '호가비', '체결강도', '연속체결 매물대 분포', '프로그램 순매수', '당일 최대 매물대']) {
      const cb = screen.getByRole('checkbox', { name }) as HTMLButtonElement;
      expect(cb.disabled).toBe(false);
      expect(cb.getAttribute('aria-checked')).toBe('true'); // 기본 ON
    }
  });

  it('삭제된 placeholder는 더 이상 렌더되지 않는다', () => {
    renderPanel();
    for (const name of ['일목균형표', '볼린저밴드', '슈퍼트렌드', '매물대분석', '엔벨로프', '윌리엄스 프랙탈']) {
      expect(screen.queryByText(name)).toBeNull();
    }
  });

  it('지표 그룹 서브헤더를 렌더', () => {
    renderPanel();
    expect(screen.getAllByText('상단 지표').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10호가 지표').length).toBeGreaterThan(0);
    expect(screen.getAllByText('프로그램 지표').length).toBeGreaterThan(0);
    expect(screen.getAllByText('거래원 지표').length).toBeGreaterThan(0);
  });

  it('uses a flat section layout for indicator settings', () => {
    renderPanel({ capabilities: { hogaPanes: true, investorNet: 'stock', studySave: false } });

    expect(screen.getByRole('dialog')).not.toHaveClass('bg-bg-card');
    expect(screen.getByRole('dialog')).toHaveClass('z-[60]');
    expect(screen.getByTestId('indicator-panel-shell')).toHaveClass('bg-bg-card');
    const nav = screen.getByRole('navigation', { name: '지표 카테고리' });
    expect(nav).toHaveClass('border-r');
    expect(nav.parentElement).toHaveClass('grid-cols-[240px_minmax(0,1fr)]');
    expect(screen.getByText('10호가 지표')).toHaveClass('uppercase');
  });

  it('keeps long category labels on one line in the side nav', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: '연속체결 매물대 분포' })).toHaveClass('whitespace-nowrap');
  });

  it('index capabilities hide every hoga and program indicator category', () => {
    renderPanel({ capabilities: { hogaPanes: false, investorNet: 'market', studySave: false } });
    expect(screen.queryByText('10호가 지표')).toBeNull();
    expect(screen.queryByText('프로그램 지표')).toBeNull();
    expect(screen.getByText('거래원 지표')).toBeTruthy();
    for (const name of ['총잔량', '호가비', '체결강도', '연속체결 매물대 분포', '프로그램 순매수', '당일 최대 매물대', '당일 매도 최대벽', '당일 매수 최대벽']) {
      expect(screen.queryByRole('checkbox', { name })).toBeNull();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('checkbox', { name: '외국인 순매수량' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '기관 순매수량' })).toBeTruthy();
  });

  it('indices without investor support hide investor net categories too', () => {
    renderPanel({ capabilities: { hogaPanes: false, investorNet: 'none', studySave: false } });
    expect(screen.queryByRole('checkbox', { name: '외국인 순매수량' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '기관 순매수량' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: '거래량' })).toBeTruthy();
  });

  it('당일 매도 최대벽은 10호가 지표 그룹(체결강도 뒤)에 위치', () => {
    renderPanel();
    // 네비 라벨 버튼은 CATEGORIES 순서대로 렌더된다(체크박스는 role=checkbox라 제외).
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    const askPeak = labels.indexOf('당일 매도 최대벽');
    const poc = labels.indexOf('당일 최대 매물대');
    const distribution = labels.indexOf('연속체결 매물대 분포');
    const fill = labels.indexOf('체결강도');
    const program = labels.indexOf('프로그램 순매수');
    expect(askPeak).toBeGreaterThan(fill); // 호가 그룹 안, 체결강도 뒤
    expect(distribution).toBeGreaterThan(fill);
    expect(poc).toBeGreaterThan(distribution);
    expect(poc).toBeGreaterThan(fill);
    expect(askPeak).toBeGreaterThan(poc);
    expect(askPeak).toBeLessThan(program);
  });

  it('프로그램 순매수는 거래원 지표 뒤에 위치', () => {
    renderPanel();
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    const bidPeak = labels.indexOf('당일 매수 최대벽');
    const program = labels.indexOf('프로그램 순매수');
    const foreign = labels.indexOf('외국인 순매수량');
    expect(program).toBeGreaterThan(bidPeak);
    expect(foreign).toBeGreaterThan(bidPeak);
    expect(program).toBeGreaterThan(foreign);
  });

  it('총잔량 토글 클릭 → quoteTotalsEnabled 반전', () => {
    useLivePageStore.setState({
      quoteTotalsEnabled: true,
      panePrefsByTimeframe: {},
    });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '총잔량' }));
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.quoteTotalsEnabled).toBe(false);
    expect(useLivePageStore.getState().quoteTotalsEnabled).toBe(true);
  });

  it('프로그램 순매수 토글 클릭 → programTradeEnabled 반전', () => {
    useLivePageStore.setState({
      programTradeEnabled: true,
      panePrefsByTimeframe: {},
    });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '프로그램 순매수' }));
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.programTradeEnabled).toBe(false);
    expect(useLivePageStore.getState().programTradeEnabled).toBe(true);
  });

  it('프로그램 순매수 라벨 클릭 → 설명 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '프로그램 순매수' }));
    expect(screen.getByText(/KIS REST 저장 데이터/)).toBeTruthy();
  });

  it('매도 최대벽 선택 시 스타일 pane과 보이는 최신 봉 기준 토글 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-askPeakVisibleTimeCutoff')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-askPeakLabelEnabled')).toBeTruthy();
  });

  it('매도 최대벽 상세 pane에 체결된/미체결된 벽 표시 개수 controls를 렌더한다', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));

    expect(screen.getByText('체결된 벽 표시 개수')).toBeTruthy();
    expect(screen.getByText('미체결된 벽 표시 개수')).toBeTruthy();
    expect(screen.getByText('보이는 영역 최대벽 표시 개수')).toBeTruthy();

    const groups = screen.getAllByRole('group');
    expect(groups.some((group) => group.getAttribute('aria-label') === '체결된 벽 표시 개수')).toBe(true);
    expect(groups.some((group) => group.getAttribute('aria-label') === '미체결된 벽 표시 개수')).toBe(true);
    expect(groups.some((group) => group.getAttribute('aria-label') === '보이는 영역 최대벽 표시 개수')).toBe(true);

    const visibleMaxGroup = within(screen.getByRole('group', { name: '보이는 영역 최대벽 표시 개수' }));
    for (const name of ['0', '1', '2', '3']) {
      expect(visibleMaxGroup.getByRole('button', { name })).toBeTruthy();
    }

    useChartPrefsStore.setState({
      askPeakAllPriceRankLimit: 2,
      askPeakUntradedRankLimit: 1,
      askPeakVisibleMaxRankLimit: 1,
    });
    fireEvent.click(visibleMaxGroup.getByRole('button', { name: '3' }));
    expect(useChartPrefsStore.getState().askPeakVisibleMaxRankLimit).toBe(3);
    expect(useChartPrefsStore.getState().askPeakAllPriceRankLimit).toBe(2);
    expect(useChartPrefsStore.getState().askPeakUntradedRankLimit).toBe(1);
    fireEvent.click(visibleMaxGroup.getByRole('button', { name: '0' }));
    expect(useChartPrefsStore.getState().askPeakVisibleMaxRankLimit).toBe(0);
  });

  it('호가비 라벨 클릭 → 우측에 RatioConfig(극단값 필터 토글) 노출', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '호가비' }));
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });

  it('renders broker late-entry controls under 거래원 지표', async () => {
    renderPanel();
    await userEvent.click(screen.getByText('신규 거래원 등장'));
    expect(screen.getByText('기준 시각 (HHMM)')).toBeTruthy();
    expect(screen.queryByText(new RegExp(['부재', '시간'].join(' ')))).toBeNull();
    expect(screen.getByText('표시 방향')).toBeTruthy();
    expect(screen.getByRole('button', { name: '둘다' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매수만' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매도만' })).toBeTruthy();
    expect(screen.getByText('매수 색상')).toBeTruthy();
    expect(screen.getByText('매도 색상')).toBeTruthy();
  });

  it('allows entering broker late-entry start time as four HHMM digits', async () => {
    useLivePageStore.setState({ brokerLateEntryStartHHMM: 930 });
    renderPanel();
    await userEvent.click(screen.getByText('신규 거래원 등장'));

    const input = screen.getByRole('textbox', { name: '신규 거래원 등장 기준 시각' }) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '0900');

    expect(input.value).toBe('0900');
    fireEvent.blur(input);
    expect(useLivePageStore.getState().brokerLateEntryStartHHMM).toBe(900);
    expect(input.value).toBe('0900');
  });

  it('clicking 외국인 순매수량 toggles foreignNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({
      foreignNetEnabled: false,
      panePrefsByTimeframe: {},
    });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '외국인 순매수량' }));
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.foreignNetEnabled).toBe(true);
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(false);
  });

  it('clicking 기관 순매수량 toggles institutionNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({
      institutionNetEnabled: false,
      panePrefsByTimeframe: {},
    });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '기관 순매수량' }));
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.institutionNetEnabled).toBe(true);
    expect(useLivePageStore.getState().institutionNetEnabled).toBe(false);
  });

  it('clicking 거래량 toggles volumeEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {},
    });
    renderPanel();
    const vol = screen.getByRole('checkbox', { name: '거래량' }) as HTMLButtonElement;
    // 거래량은 active 카테고리 — 기본 켜짐(default true), 클릭하면 토글.
    expect(vol.disabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBe(true);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('does not render a manual pane profile selector', () => {
    renderPanel({ timeframe: 'D' });

    expect(screen.queryByRole('button', { name: '분봉' })).toBeNull();
    expect(screen.queryByRole('button', { name: '일봉' })).toBeNull();
    expect(screen.queryByRole('button', { name: '주봉' })).toBeNull();
    expect(screen.queryByRole('button', { name: '월봉' })).toBeNull();
    expect(screen.queryByLabelText('시간봉별 pane profile')).toBeNull();
  });

  it('reads pane checkbox state from the current chart timeframe profile', () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {
        D: { volumeEnabled: false },
        W: { volumeEnabled: true },
      },
    });

    const view = renderPanel({ timeframe: 'D' });
    expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'false');

    view.rerender(<IndicatorPanel onClose={() => {}} timeframe="W" />);
    expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes pane category changes to the current chart timeframe profile only', () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {},
    });

    renderPanel({ timeframe: 'D' });

    fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBeUndefined();
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('uses the minute profile for every minute chart timeframe', () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {},
    });

    renderPanel({ timeframe: '3m' });

    fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBeUndefined();
  });

  it('clicking 이동평균선 checkbox toggles movingAverageEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ movingAverageEnabled: true });
    renderPanel();
    const ma = screen.getByRole('checkbox', { name: '이동평균선' });
    fireEvent.click(ma);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
    fireEvent.click(ma);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(true);
  });

  it('renders MovingAverageConfig in the right pane', () => {
    renderPanel();
    expect(screen.getByText('지난 n일 동안 주가 평균값을 이은 선')).toBeTruthy();
  });

  it('clicking a category label navigates the right pane to that indicator detail', () => {
    renderPanel();
    // Default detail is 이동평균선.
    expect(screen.getByText(/지난 n일 동안/)).toBeTruthy();

    // 거래량 → 거래량 detail (MA detail gone). The label is a button; the
    // on/off control is the separate role=checkbox icon.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(screen.getByText(/거래량을 막대로/)).toBeTruthy();
    expect(screen.queryByText(/지난 n일 동안/)).toBeNull();

    // 외국인 순매수량 → its detail.
    fireEvent.click(screen.getByRole('button', { name: '외국인 순매수량' }));
    expect(screen.getByText(/외국인.*순매수 수량/)).toBeTruthy();

    // 기관 순매수량 → its detail.
    fireEvent.click(screen.getByRole('button', { name: '기관 순매수량' }));
    expect(screen.getByText(/기관.*순매수 수량/)).toBeTruthy();
  });

  it('매수 최대벽 선택 시 보이는 최신 봉 기준 토글 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 매수 최대벽' }));
    expect(screen.getByTestId('settings-toggle-bidPeakVisibleTimeCutoff')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakLabelEnabled')).toBeTruthy();
  });

  it('매수 최대벽 상세 pane에 체결된/미체결된 벽 표시 개수 controls를 렌더한다', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 매수 최대벽' }));

    expect(screen.getByText('체결된 벽 표시 개수')).toBeTruthy();
    expect(screen.getByText('미체결된 벽 표시 개수')).toBeTruthy();
    expect(screen.getByText('보이는 영역 최대벽 표시 개수')).toBeTruthy();

    const groups = screen.getAllByRole('group');
    expect(groups.some((group) => group.getAttribute('aria-label') === '체결된 벽 표시 개수')).toBe(true);
    expect(groups.some((group) => group.getAttribute('aria-label') === '미체결된 벽 표시 개수')).toBe(true);
    expect(groups.some((group) => group.getAttribute('aria-label') === '보이는 영역 최대벽 표시 개수')).toBe(true);

    const visibleMaxGroup = within(screen.getByRole('group', { name: '보이는 영역 최대벽 표시 개수' }));
    for (const name of ['0', '1', '2', '3']) {
      expect(visibleMaxGroup.getByRole('button', { name })).toBeTruthy();
    }

    useChartPrefsStore.setState({
      bidPeakAllPriceRankLimit: 2,
      bidPeakUntradedRankLimit: 1,
      bidPeakVisibleMaxRankLimit: 1,
    });
    fireEvent.click(visibleMaxGroup.getByRole('button', { name: '3' }));
    expect(useChartPrefsStore.getState().bidPeakVisibleMaxRankLimit).toBe(3);
    expect(useChartPrefsStore.getState().bidPeakAllPriceRankLimit).toBe(2);
    expect(useChartPrefsStore.getState().bidPeakUntradedRankLimit).toBe(1);
    fireEvent.click(visibleMaxGroup.getByRole('button', { name: '0' }));
    expect(useChartPrefsStore.getState().bidPeakVisibleMaxRankLimit).toBe(0);
  });

  it('거래량 카테고리 이동 후 체결강도 누적 토글이 노출된다', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(screen.getByTestId('settings-toggle-volumeFillStrengthCumulative')).toBeTruthy();
    expect(screen.getByText('거래량 — 체결강도 누적')).toBeTruthy();
  });

  it('navigating to a category does NOT toggle its master switch', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    renderPanel();
    // Clicking the label navigates only — the checkbox is the toggle.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('✕ button calls onClose', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    // Two "닫기" buttons exist: header ✕ (aria-label) and footer text button.
    // Both wire to onClose — clicking either verifies the wire-up.
    const closeBtns = screen.getAllByRole('button', { name: '닫기' });
    expect(closeBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(closeBtns[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('backdrop click calls onClose, inside click does not', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // "이동평균선" appears both as a nav button label and as the MA config h3.
    // The nav button is the first occurrence; click its parent for an inside-content check.
    const navLabel = screen.getAllByText('이동평균선')[0];
    fireEvent.click(navLabel.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('당일 매도 최대벽 카테고리 토글', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '당일 매도 최대벽' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
  });

  it('당일 최대 매물대 카테고리 토글', () => {
    useLivePageStore.setState({ tradeVolumePocEnabled: true });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '당일 최대 매물대' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().tradeVolumePocEnabled).toBe(false);
  });

  it('연속체결 매물대 분포 카테고리 토글', () => {
    useLivePageStore.setState({ volumeDistributionEnabled: true });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '연속체결 매물대 분포' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().volumeDistributionEnabled).toBe(false);
  });

  it('연속체결 매물대 분포 선택 시 범위/색상 설정을 저장한다', () => {
    useLivePageStore.setState({
      volumeDistributionRangeCount: 10,
      volumeDistributionColor: '#64748B',
      volumeDistributionMaxColor: '#EAB308',
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '연속체결 매물대 분포 구간 수' }), {
      target: { value: '18' },
    });
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포 색상 #22C55E' }));
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포 최대 구간 색상 #EF4444' }));
    expect(useLivePageStore.getState().volumeDistributionRangeCount).toBe(18);
    expect(useLivePageStore.getState().volumeDistributionColor).toBe('#22C55E');
    expect(useLivePageStore.getState().volumeDistributionMaxColor).toBe('#EF4444');
  });

  it('toggles hover-cutoff mode for volume distribution', () => {
    useLivePageStore.setState({ volumeDistributionHoverCutoffEnabled: false });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포' }));
    expect(screen.getByTestId('settings-toggle-volumeDistributionHoverCutoff')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: '호버 시점 누적' }));
    expect(useLivePageStore.getState().volumeDistributionHoverCutoffEnabled).toBe(true);
  });

  it('당일 최대 매물대 선택 시 분포 최대 구간 설명 표시', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 18 });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대 매물대' }));
    expect(screen.getAllByText(/연속체결 매물대 분포와 동일한 18개 가격 구간/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '±0.25%' })).toBeNull();
    expect(screen.queryByRole('button', { name: '±0.5%' })).toBeNull();
    expect(screen.queryByRole('button', { name: '±1%' })).toBeNull();
    expect(screen.getByRole('button', { name: '당일 최대 매물대 색상 #22C55E' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: '당일 최대 매물대 투명도' })).toBeTruthy();
    expect(screen.getByText(/동시호가 제외/)).toBeTruthy();
  });

  it('당일 최대 매물대 색상과 투명도를 저장한다', () => {
    useLivePageStore.setState({
      tradeVolumePocColor: '#A855F7',
      tradeVolumePocOpacity: 0.12,
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대 매물대' }));
    fireEvent.click(screen.getByRole('button', { name: '당일 최대 매물대 색상 #22C55E' }));
    fireEvent.change(screen.getByRole('slider', { name: '당일 최대 매물대 투명도' }), {
      target: { value: '28' },
    });
    expect(useLivePageStore.getState().tradeVolumePocColor).toBe('#22C55E');
    expect(useLivePageStore.getState().tradeVolumePocOpacity).toBe(0.28);
  });

  it('매도 최대벽 선택 시 스타일 pane(MAStylePicker) 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
  });

  it('당일 매수 최대벽 카테고리 토글', () => {
    useLivePageStore.setState({ bidPeakEnabled: false });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '당일 매수 최대벽' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
  });

  it('매수 최대벽 선택 시 스타일 pane과 토글 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 매수 최대벽' }));
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakShowAllPrices')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakLabelEnabled')).toBeTruthy();
  });

  it('일봉 이동평균선 체크박스 토글 → dailyMovingAverageEnabled 반전', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ dailyMovingAverageEnabled: false });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '일봉 이동평균선' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(true);
  });

  it('일봉 이동평균선 라벨 클릭 → DailyMovingAverageConfig 노출', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '일봉 이동평균선' }));
    expect(screen.getByText(/일봉 종가 기준 이평선을 분봉 차트에 투영/)).toBeTruthy();
  });

  it('호가 잔량 히트맵 카테고리가 10호가 그룹에 렌더된다', () => {
    render(<IndicatorPanel onClose={() => {}} timeframe="1m" />);
    expect(screen.getByText('호가 잔량 히트맵')).toBeInTheDocument();
  });

  it('호가 잔량 히트맵 카테고리 토글', () => {
    useLivePageStore.setState({ depthHeatmapEnabled: false });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '호가 잔량 히트맵' });
    fireEvent.click(cb);
    expect(useLivePageStore.getState().depthHeatmapEnabled).toBe(true);
  });

  it('호가 잔량 히트맵 라벨 클릭 → 매수/매도 색상 + 불투명도 노출', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '호가 잔량 히트맵' }));
    expect(screen.getByRole('button', { name: '매수 색상 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매도 색상 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('slider')).toBeTruthy();
  });
});
