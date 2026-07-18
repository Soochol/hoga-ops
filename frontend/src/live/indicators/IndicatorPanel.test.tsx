import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IndicatorPanel from './IndicatorPanel';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';

function renderPanel(props: Partial<ComponentProps<typeof IndicatorPanel>> = {}) {
  const onClose = props.onClose ?? (() => {});
  const timeframe = props.timeframe ?? '1m';
  return render(<IndicatorPanel onClose={onClose} timeframe={timeframe} {...props} />);
}

describe('IndicatorPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    // 지표 슬라이스를 공장 상태로 되돌린다 — 최상위 투영·버킷·ambient 봉 모두.
    useLivePageStore.setState({
      ...FACTORY_INDICATOR_SETTINGS,
      indicatorsByTimeframe: {},
      indicatorTimeframe: '1m',
    });
    useChartPrefsStore.getState().resetToDefaults();
    // chartPrefs 의 ambient 봉도 '1m' 으로 — resetToDefaults 는 투영 pointer 를
    // 건드리지 않으므로 명시 초기화(테스트 격리).
    useChartPrefsStore.getState().setIndicatorModalTimeframe('1m');
  });

  it('활성 13개 체크박스(비활성 0), 10호가·프로그램·거래원 지표 포함', () => {
    useLivePageStore.setState({
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      programTradeEnabled: true,
    });
    renderPanel();
    const checkboxes = screen.getAllByRole('checkbox');
    // 상단 3 + 10호가 7(매도/매수 최대벽 병합) + 프로그램 1 + 거래원 3
    expect(checkboxes).toHaveLength(14);
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
    // 좌측 컬럼(nav + 리셋 푸터)을 감싼 래퍼가 border-r 대신 bg-subtle 톤 스텝으로
    // 분리(2026-07-15 borderless 통일). 래퍼의 부모가 2-컬럼 그리드.
    const navColumn = nav.parentElement!;
    expect(navColumn).toHaveClass('bg-bg-subtle');
    expect(nav).not.toHaveClass('border-r');
    expect(navColumn.parentElement).toHaveClass('grid-cols-[240px_minmax(0,1fr)]');
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
    for (const name of ['총잔량', '호가비', '체결강도', '연속체결 매물대 분포', '프로그램 순매수', '당일 최대 매물대', '당일 최대벽']) {
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

  it('당일 최대벽(매도/매수 병합)은 10호가 지표 그룹(체결강도 뒤)에 위치', () => {
    renderPanel();
    // 네비 라벨 버튼은 CATEGORIES 순서대로 렌더된다(체크박스는 role=checkbox라 제외).
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    const peakWalls = labels.indexOf('당일 최대벽');
    const poc = labels.indexOf('당일 최대 매물대');
    const distribution = labels.indexOf('연속체결 매물대 분포');
    const fill = labels.indexOf('체결강도');
    const program = labels.indexOf('프로그램 순매수');
    expect(peakWalls).toBeGreaterThan(fill); // 호가 그룹 안, 체결강도 뒤
    expect(distribution).toBeGreaterThan(fill);
    expect(poc).toBeGreaterThan(distribution);
    expect(poc).toBeGreaterThan(fill);
    expect(peakWalls).toBeGreaterThan(poc);
    expect(peakWalls).toBeLessThan(program);
  });

  it('프로그램 순매수는 거래원 지표 뒤에 위치', () => {
    renderPanel();
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    const peakWalls = labels.indexOf('당일 최대벽');
    const program = labels.indexOf('프로그램 순매수');
    const foreign = labels.indexOf('외국인 순매수량');
    expect(program).toBeGreaterThan(peakWalls);
    expect(foreign).toBeGreaterThan(peakWalls);
    expect(program).toBeGreaterThan(foreign);
  });

  it('총잔량 토글 클릭 → minute 버킷 기록 + ambient 투영 반전', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: true });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '총잔량' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.quoteTotalsEnabled).toBe(false);
    // ambient(1m)와 같은 프로파일이므로 최상위 투영도 함께 뒤집힌다(PR-A).
    expect(useLivePageStore.getState().quoteTotalsEnabled).toBe(false);
  });

  it('프로그램 순매수 토글 클릭 → minute 버킷 기록 + ambient 투영 반전', () => {
    useLivePageStore.setState({ programTradeEnabled: true });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '프로그램 순매수' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.programTradeEnabled).toBe(false);
    expect(useLivePageStore.getState().programTradeEnabled).toBe(false);
  });

  it('프로그램 순매수 라벨 클릭 → 설명 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '프로그램 순매수' }));
    expect(screen.getByText(/KIS REST 저장 데이터/)).toBeTruthy();
  });

  it('매도 최대벽 선택 시 스타일 pane과 보이는 최신 봉 기준 토글 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-askPeakVisibleTimeCutoff')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-askPeakLabelEnabled')).toBeTruthy();
  });

  it('매도 최대벽 상세 pane에 체결된/미체결된 벽 표시 개수 controls를 렌더한다', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));

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
    expect(screen.getByText('기준 시각')).toBeTruthy();
    expect(screen.queryByText(new RegExp(['부재', '시간'].join(' ')))).toBeNull();
    expect(screen.getByText('표시 방향')).toBeTruthy();
    expect(screen.getByRole('button', { name: '둘다' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매수만' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매도만' })).toBeTruthy();
    expect(screen.getByText('매수 색상')).toBeTruthy();
    expect(screen.getByText('매도 색상')).toBeTruthy();
  });

  it('신규 거래원 등장 기준 시각을 HH:MM으로 표시하고 HHMM 입력을 정규화한다', async () => {
    useLivePageStore.setState({ brokerLateEntryStartHHMM: 930 });
    renderPanel();
    await userEvent.click(screen.getByText('신규 거래원 등장'));

    const input = screen.getByRole('textbox', { name: '신규 거래원 등장 기준 시각' }) as HTMLInputElement;
    // 저장값 930 → HH:MM 표시.
    expect(input.value).toBe('09:30');

    // 네 자리 HHMM 입력도 계속 허용하되, blur 시 HH:MM으로 정규화.
    await userEvent.clear(input);
    await userEvent.type(input, '0900');
    fireEvent.blur(input);
    expect(useLivePageStore.getState().brokerLateEntryStartHHMM).toBe(900);
    expect(input.value).toBe('09:00');

    // 콜론 형식 입력도 동일하게 파싱.
    await userEvent.clear(input);
    await userEvent.type(input, '10:05');
    fireEvent.blur(input);
    expect(useLivePageStore.getState().brokerLateEntryStartHHMM).toBe(1005);
    expect(input.value).toBe('10:05');
  });

  it('clicking 외국인 순매수량 toggles foreignNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ foreignNetEnabled: false });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '외국인 순매수량' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.foreignNetEnabled).toBe(true);
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });

  it('clicking 기관 순매수량 toggles institutionNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ institutionNetEnabled: false });
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: '기관 순매수량' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.institutionNetEnabled).toBe(true);
    expect(useLivePageStore.getState().institutionNetEnabled).toBe(true);
  });

  it('clicking 거래량 toggles volumeEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    renderPanel();
    const vol = screen.getByRole('checkbox', { name: '거래량' }) as HTMLButtonElement;
    // 거래량은 active 카테고리 — 기본 켜짐(공장값 true), 클릭하면 토글.
    expect(vol.disabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(false);
    fireEvent.click(vol);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBe(true);
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

  it('reads pane checkbox state from the ambient timeframe bucket', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: {
        D: { volumeEnabled: false },
        W: { volumeEnabled: true },
      },
    });
    // 페이지가 ambient 봉을 공급하면 store 가 그 봉으로 투영한다(PR-A).
    useLivePageStore.getState().setIndicatorTimeframe('D');

    const view = renderPanel({ timeframe: 'D' });
    expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'false');

    useLivePageStore.getState().setIndicatorTimeframe('W');
    view.rerender(<IndicatorPanel onClose={() => {}} timeframe="W" />);
    expect(screen.getByRole('checkbox', { name: '거래량' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes pane category changes to the drawer timeframe bucket only', () => {
    useLivePageStore.setState({ volumeEnabled: true });

    renderPanel({ timeframe: 'D' });

    fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBeUndefined();
    // ambient(1m)와 다른 프로파일(D)에 쓴 것이므로 최상위 투영은 그대로다.
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('uses the minute profile for every minute chart timeframe', () => {
    useLivePageStore.setState({ volumeEnabled: true });

    renderPanel({ timeframe: '3m' });

    fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBeUndefined();
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
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    expect(screen.getByTestId('settings-toggle-bidPeakVisibleTimeCutoff')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakLabelEnabled')).toBeTruthy();
  });

  it('매수 최대벽 상세 pane에 체결된/미체결된 벽 표시 개수 controls를 렌더한다', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));

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

  it('상세 헤더에 지표명과 마스터 토글을 표시한다', () => {
    useLivePageStore.setState({ movingAverageEnabled: true });
    renderPanel();
    // 헤더 h2가 그룹명이 아니라 선택된 지표명을 보여준다.
    expect(screen.getByRole('heading', { name: '이동평균선', level: 2 })).toBeTruthy();
    // 헤더 마스터 토글(switch)은 nav 체크박스와 같은 상태를 미러링한다.
    const masterSwitch = screen.getByRole('switch', { name: '이동평균선 표시' });
    expect(masterSwitch.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(masterSwitch);
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
    expect(masterSwitch.getAttribute('aria-checked')).toBe('false');
  });

  it('헤더 마스터 토글과 nav 체크박스가 같은 상태를 공유한다', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    renderPanel();
    // 이동평균선 상세로 이동(기본 선택이지만 명시).
    fireEvent.click(screen.getByRole('button', { name: '이동평균선' }));
    const masterSwitch = screen.getByRole('switch', { name: '이동평균선 표시' });
    expect(masterSwitch.getAttribute('aria-checked')).toBe('false');
    // nav 체크박스로 켜면 헤더 토글도 즉시 켜진 상태로 반영된다.
    fireEvent.click(screen.getByRole('checkbox', { name: '이동평균선' }));
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(true);
    expect(masterSwitch.getAttribute('aria-checked')).toBe('true');
  });

  it('당일 최대벽 nav 체크박스(병합 마스터)는 매도·매수를 함께 토글한다', () => {
    useLivePageStore.setState({ askPeakEnabled: false, bidPeakEnabled: false });
    renderPanel();
    const cb = screen.getByRole('checkbox', { name: '당일 최대벽' });
    expect(cb.getAttribute('aria-checked')).toBe('false');
    // 둘 다 꺼짐 → 클릭 시 둘 다 켜짐.
    fireEvent.click(cb);
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
    expect(cb.getAttribute('aria-checked')).toBe('true');
    // 한쪽만 켜져 있어도 checked=true, 클릭 시 둘 다 꺼짐.
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: false });
    expect(cb.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(cb);
    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(false);
  });

  it('체크박스 클릭은 상세 pane을 전환하지 않는다', () => {
    renderPanel();
    // 기본 상세는 이동평균선. 다른 카테고리 체크박스를 눌러도 이동평균선 상세가 유지된다.
    expect(screen.getByText(/지난 n일 동안/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));
    expect(screen.getByText(/지난 n일 동안/)).toBeTruthy();
    expect(screen.queryByText(/거래량을 막대로/)).toBeNull();
  });

  it('헤더에 현재 봉 배지를 표시하고 봉에 따라 갱신한다', () => {
    const view = renderPanel({ timeframe: 'D' });
    expect(screen.getByText('현재: 일봉')).toBeTruthy();
    view.rerender(<IndicatorPanel onClose={() => {}} timeframe="1m" />);
    expect(screen.getByText('현재: 분봉')).toBeTruthy();
  });

  it('카테고리별 스코프 칩은 더 이상 렌더하지 않는다', () => {
    renderPanel({ timeframe: 'D' });
    // 이동평균선(구 전역)·거래량(구 pane 스코프) 어느 쪽도 칩 없음 — 배지 하나로 통일.
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    expect(screen.queryByText(/별 표시$/)).toBeNull();
  });

  it('현재 봉 초기화는 2단계 확인 후 현재 봉의 지표·IM chartPrefs만 되돌린다', () => {
    // 현재 봉(1m) 버킷에 실제 오버라이드를 쓴다(setter 경유).
    useLivePageStore.getState().setAskPeakEnabled(true);
    useLivePageStore.getState().setVolumeDistributionStyle({ color: '#22C55E' });
    useLivePageStore.getState().setMovingAverageEnabled(false);
    useChartPrefsStore.getState().setNumericPref('surgeStartHHMM', 1030);
    useChartPrefsStore.getState().setNumericPref('ratioOutlierThreshold', 500);
    // 차트 전반 flat(⚙️ 설정 항목)은 드로어 리셋이 건드리면 안 된다.
    useChartPrefsStore.getState().setToggle('candleTooltipEnabled', false);
    renderPanel();

    // 1단계: '현재 봉 초기화' → 확인 행 노출(아직 리셋 안 됨).
    fireEvent.click(screen.getByRole('button', { name: '현재 봉 초기화' }));
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
    expect(screen.getByText('분봉 초기화?')).toBeTruthy();

    // 취소는 되돌리지 않는다.
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText('분봉 초기화?')).toBeNull();
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);

    // 2단계: 다시 열고 '초기화' → 실제 리셋.
    fireEvent.click(screen.getByRole('button', { name: '현재 봉 초기화' }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeDistributionColor).toBe('#64748B');
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(true);
    expect(useChartPrefsStore.getState().surgeStartHHMM).toBe(900);
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(100);
    // 차트 전반 flat 은 초기화되지 않는다(#699 — 리셋은 현재 봉 버킷만).
    expect(useChartPrefsStore.getState().candleTooltipEnabled).toBe(false);
  });

  it('현재 봉 초기화는 다른 봉 버킷을 건드리지 않는다', () => {
    // D 버킷에 오버라이드를 심고, 1m(현재 봉)에서 초기화한다.
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'volumeEnabled', false);
    useLivePageStore.getState().setAskPeakEnabled(true); // minute 버킷
    renderPanel({ timeframe: '1m' });
    fireEvent.click(screen.getByRole('button', { name: '현재 봉 초기화' }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute).toBeUndefined();
    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBe(false);
  });

  it('현재 봉 초기화는 pane 배열 순서(레이아웃)를 보존한다', () => {
    const customOrder = ['candle', 'ratio', 'volume'] as unknown as never;
    useLivePageStore.setState({ paneOrder: customOrder });
    useLivePageStore.getState().setVolumeDistributionStyle({ color: '#22C55E' });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '현재 봉 초기화' }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    // 색은 기본값으로, paneOrder는 그대로.
    expect(useLivePageStore.getState().volumeDistributionColor).toBe('#64748B');
    expect(useLivePageStore.getState().paneOrder).toEqual(['candle', 'ratio', 'volume']);
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
    // 콘텐츠 헤더의 ✕ (aria-label 닫기)가 유일한 닫기 버튼(2026-07-15 크롬 통일로 푸터 제거).
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

  it('당일 최대벽 매도 서브탭의 표시 토글로 askPeakEnabled 반전', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    // 기본 서브탭은 매도.
    fireEvent.click(screen.getByRole('switch', { name: '매도 최대벽 표시' }));
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
    // 색상은 이제 스와치 trigger→팝오버 패턴(ColorSwatchPicker). 팝오버를 먼저 연다.
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포 색상 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포 색상 #22C55E' }));
    fireEvent.click(screen.getByRole('button', { name: '연속체결 매물대 분포 최대 구간 색상 선택' }));
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
    expect(screen.getByRole('button', { name: '당일 최대 매물대 색상 선택' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '당일 최대 매물대 색상 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '당일 최대 매물대 색상 #22C55E' }));
    fireEvent.change(screen.getByRole('slider', { name: '당일 최대 매물대 투명도' }), {
      target: { value: '28' },
    });
    expect(useLivePageStore.getState().tradeVolumePocColor).toBe('#22C55E');
    expect(useLivePageStore.getState().tradeVolumePocOpacity).toBe(0.28);
  });

  it('매도 최대벽 선택 시 스타일 pane(MAStylePicker) 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '미체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
  });

  it('당일 최대벽 매수 서브탭의 표시 토글로 bidPeakEnabled 반전', () => {
    useLivePageStore.setState({ bidPeakEnabled: false });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    fireEvent.click(screen.getByRole('switch', { name: '매수 최대벽 표시' }));
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
  });

  it('매수 최대벽 선택 시 스타일 pane과 토글 표시', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '당일 최대벽' }));
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
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
