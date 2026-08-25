import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IndicatorPanel from './IndicatorPanel';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import {
  WORKSPACE_PANEL_WIDTH_CLASS,
  WORKSPACE_PANEL_HEIGHT_CLASS,
} from '../workspacePanel';

function renderPanel(props: Partial<ComponentProps<typeof IndicatorPanel>> = {}) {
  const onClose = props.onClose ?? (() => {});
  const timeframe = props.timeframe ?? '1m';
  return render(<IndicatorPanel onClose={onClose} timeframe={timeframe} {...props} />);
}

/**
 * 패널의 좌측 목록은 **두 모드**다 — "내 지표"(존재하는 것, 행마다 ✕)와 카탈로그
 * (추가할 수 있는 것, 행마다 ＋). 종전의 단일 체크박스 목록이 아니므로, 꺼져 있는
 * 지표에 닿으려면 카탈로그로 넘어가야 한다. 아래 헬퍼가 그 왕복을 감춘다.
 */

/** 카탈로그로 전환한다(이미 카탈로그면 그대로). */
function openCatalog(): void {
  const toggle = screen.getByTestId('indicator-panel-mode-toggle');
  if (toggle.textContent?.includes('추가')) fireEvent.click(toggle);
}

/** "내 지표" 목록으로 돌아간다. */
function openMine(): void {
  const toggle = screen.getByTestId('indicator-panel-mode-toggle');
  if (toggle.textContent?.includes('내 지표')) fireEvent.click(toggle);
}

/** 카탈로그에서 추가 — 추가는 그 지표의 상세로 이동하고 목록으로 돌아온다. */
function addIndicator(name: string): void {
  openCatalog();
  fireEvent.click(screen.getByRole('button', { name: `${name} 추가` }));
}

/** 그 지표의 상세를 연다. 없으면 먼저 추가한다(대부분의 테스트가 원하는 것은
 *  "설정 화면을 보는 것" 이지 추가 절차 자체가 아니다). */
function openDetail(name: string): void {
  openMine();
  const row = screen.queryByRole('button', { name });
  if (row) { fireEvent.click(row); return; }
  addIndicator(name);
}

/** 존재를 뒤집는다 — 내 지표에 있으면 ✕, 없으면 카탈로그에서 ＋.
 *  종전 체크박스 클릭의 대응물이다. */
function togglePresence(name: string): void {
  openMine();
  const remove = screen.queryByRole('button', { name: `${name} 삭제` });
  if (remove) { fireEvent.click(remove); return; }
  addIndicator(name);
}

/** 카탈로그에서 **추가하지 않고** 미리보기만 연다. */
function previewDetail(name: string): void {
  openCatalog();
  fireEvent.click(screen.getByRole('button', { name }));
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

  // 목록이 두 모드로 갈리면서 "전 카테고리가 한 화면에" 라는 단언은 성립하지 않는다.
  // 대신 **합집합이 15종**임을 못 박는다 — 어느 쪽에도 안 나타나는 지표가 없다는 뜻이고,
  // 그게 이 목록이 지켜야 할 총계다.
  it('내 지표 + 카탈로그의 합집합이 15종이다 (어디에도 안 뜨는 지표는 없다)', () => {
    useLivePageStore.setState({
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      programTradeEnabled: true,
    });
    renderPanel();
    // **nav 안에서만** 센다 — 상세 pane 에도 `슬롯 삭제` 처럼 같은 접미의 버튼이 있다.
    const labelsEndingWith = (suffix: string) => within(screen.getByRole('navigation'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((l): l is string => !!l && l.endsWith(suffix))
      .map((l) => l.slice(0, -suffix.length));
    const mine = labelsEndingWith(' 삭제');
    openCatalog();
    const addable = labelsEndingWith(' 추가');

    expect(new Set([...mine, ...addable]).size).toBe(15);
    // 켜 둔 것은 전부 "내 지표" 쪽이다.
    for (const name of ['총잔량', '호가비', '체결강도', '연속체결 매물대 분포', '프로그램 순매수', '당일 최대 매물대']) {
      expect(mine).toContain(name);
    }
  });

  // 이 패널의 새 계약: **존재(추가·삭제)만 다룬다**. 가시성(숨김)은 레전드 눈이
  // 전담한다 — 한 지표를 두 표면이 서로 다른 말로 조작하던 상태를 끝낸 것이 요점이다.
  it('체크박스가 사라지고 추가·삭제 두 어휘만 남는다', () => {
    renderPanel();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // 공장 상태의 "내 지표" = 이동평균선 + 거래량(그 둘만 공장 ON).
    const nav = within(screen.getByRole('navigation', { name: '내 지표' }));
    expect(nav.getByRole('button', { name: '이동평균선 삭제' })).toBeTruthy();
    expect(nav.getByRole('button', { name: '거래량 삭제' })).toBeTruthy();
  });

  it('추가하면 기본값으로 생기고, 그 지표의 상세로 이동한 뒤 목록으로 돌아온다', () => {
    renderPanel();
    addIndicator('호가비');

    // 생성 — 공장값 그대로(따로 설정할 것이 없다).
    expect(useLivePageStore.getState().ratioEnabled).toBe(true);
    // 상세 이동 — "추가했는데 어디 갔지" 가 되지 않게.
    expect(screen.getByRole('heading', { name: '호가비', level: 2 })).toBeTruthy();
    // 목록 복귀 — 카탈로그에 남아 있으면 방금 추가한 것을 확인하러 한 번 더 눌러야 한다.
    expect(screen.getByRole('navigation', { name: '내 지표' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '호가비 삭제' })).toBeTruthy();
  });

  it('카탈로그의 라벨 클릭은 **미리보기**다 — 추가하지 않는다', () => {
    renderPanel();
    previewDetail('호가벽 급증');

    expect(useLivePageStore.getState().wallSurgeEnabled).toBe(false);
    // 상세는 보이고, 목록은 카탈로그에 남는다(＋ 를 누를지 결정할 수 있게).
    expect(screen.getByRole('heading', { name: '호가벽 급증', level: 2 })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '지표 추가' })).toBeTruthy();
  });

  it('선택한 지표를 삭제하면 상세가 남은 첫 지표로 넘어간다', () => {
    renderPanel();
    // 기본 선택은 이동평균선. 그것을 지우면 거래량만 남는다.
    togglePresence('이동평균선');
    expect(screen.getByRole('heading', { name: '거래량', level: 2 })).toBeTruthy();
  });

  it('내 지표가 비면 안내를 띄운다', () => {
    renderPanel();
    togglePresence('이동평균선');
    togglePresence('거래량');
    expect(screen.getByText('추가한 지표가 없습니다.')).toBeTruthy();
  });

  it('삭제된 placeholder는 더 이상 렌더되지 않는다', () => {
    renderPanel();
    for (const name of ['일목균형표', '볼린저밴드', '슈퍼트렌드', '매물대분석', '엔벨로프', '윌리엄스 프랙탈']) {
      expect(screen.queryByText(name)).toBeNull();
    }
  });

  it('지표 그룹 서브헤더를 렌더(카탈로그)', () => {
    renderPanel();
    openCatalog();
    expect(screen.getAllByText('상단 지표').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10호가 지표').length).toBeGreaterThan(0);
    expect(screen.getAllByText('프로그램 지표').length).toBeGreaterThan(0);
    expect(screen.getAllByText('거래원 지표').length).toBeGreaterThan(0);
  });

  // 2026-08-21 우측 드로어 → 중앙 모달 전환에서 배운 것: 그때 **지표 패널 쪽에는
  // 앵커 가드가 없었다** — 배치를 통째로 바꿨는데 이 파일 72개 테스트가 전부 초록이었고
  // 빨개진 것은 `App.test.tsx`(설정 쪽)뿐이었다. 그 비대칭을 메우는 가드다.
  it('중앙 모달로 뜨고, 폭·높이는 설정 패널과 같은 공용 상수를 쓴다', () => {
    renderPanel();

    // 앵커: 중앙 정렬 백드롭(드로어의 items-stretch/justify-end 가 아니다).
    const backdrop = screen.getByRole('dialog');
    expect(backdrop).toHaveClass('fixed', 'inset-0', 'items-center', 'justify-center');
    expect(backdrop).not.toHaveClass('items-stretch', 'justify-end');

    // 카드: 사방 테두리 + 유한 높이. 폭·높이는 상수 — `App.test.tsx` 가 설정 패널에
    // 대해 **같은 상수**를 단언하므로, 한쪽이 하드코딩으로 이탈하면 두 패널이 어긋난다
    // (그 동기화가 `live/workspacePanel.ts` 가 존재하는 이유다).
    const card = screen.getByTestId('indicator-panel-shell').parentElement!;
    expect(card).toHaveClass('border', 'rounded-lg');
    expect(card).toHaveClass(WORKSPACE_PANEL_WIDTH_CLASS, WORKSPACE_PANEL_HEIGHT_CLASS);
  });

  it('uses a flat section layout for indicator settings', () => {
    renderPanel({ capabilities: { hogaPanes: true, investorNet: 'stock', studySave: false } });

    expect(screen.getByRole('dialog')).not.toHaveClass('bg-bg-card');
    expect(screen.getByRole('dialog')).toHaveClass('z-[60]');
    expect(screen.getByTestId('indicator-panel-shell')).toHaveClass('bg-bg-card');
    const nav = screen.getByRole('navigation', { name: '내 지표' });
    // 좌측 컬럼(nav + 리셋 푸터)을 감싼 래퍼가 border-r 대신 bg-subtle 톤 스텝으로
    // 분리(2026-07-15 borderless 통일). 래퍼의 부모가 2-컬럼 그리드.
    const navColumn = nav.parentElement!;
    expect(navColumn).toHaveClass('bg-bg-subtle');
    expect(nav).not.toHaveClass('border-r');
    expect(navColumn.parentElement).toHaveClass('grid-cols-[240px_minmax(0,1fr)]');
    openCatalog();
    expect(screen.getByText('10호가 지표')).toHaveClass('uppercase');
  });

  it('keeps long category labels on one line in the side nav', () => {
    renderPanel();
    openCatalog();

    expect(screen.getByRole('button', { name: '연속체결 매물대 분포' })).toHaveClass('whitespace-nowrap');
  });

  it('index capabilities hide every hoga and program indicator category', () => {
    renderPanel({ capabilities: { hogaPanes: false, investorNet: 'market', studySave: false } });
    openCatalog();
    expect(screen.queryByText('10호가 지표')).toBeNull();
    expect(screen.queryByText('프로그램 지표')).toBeNull();
    expect(screen.getByText('거래원 지표')).toBeTruthy();
    for (const name of ['총잔량', '호가비', '체결강도', '연속체결 매물대 분포', '프로그램 순매수', '당일 최대 매물대', '당일 최대벽']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
      expect(screen.queryByRole('button', { name: `${name} 추가` })).toBeNull();
    }
    expect(screen.getByRole('button', { name: '외국인 순매수량 추가' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '기관 순매수량 추가' })).toBeTruthy();
  });

  it('indices without investor support hide investor net categories too', () => {
    renderPanel({ capabilities: { hogaPanes: false, investorNet: 'none', studySave: false } });
    openCatalog();
    expect(screen.queryByRole('button', { name: '외국인 순매수량 추가' })).toBeNull();
    expect(screen.queryByRole('button', { name: '기관 순매수량 추가' })).toBeNull();
    // 거래량은 공장값 ON 이라 "내 지표" 쪽에 있다.
    openMine();
    expect(screen.getByRole('button', { name: '거래량 삭제' })).toBeTruthy();
  });

  it('당일 최대벽(매도/매수 병합)은 10호가 지표 그룹(체결강도 뒤)에 위치', () => {
    renderPanel();
    openCatalog();
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
    openCatalog();
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
    togglePresence('총잔량');
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.quoteTotalsEnabled).toBe(false);
    // ambient(1m)와 같은 프로파일이므로 최상위 투영도 함께 뒤집힌다(PR-A).
    expect(useLivePageStore.getState().quoteTotalsEnabled).toBe(false);
  });

  it('프로그램 순매수 토글 클릭 → minute 버킷 기록 + ambient 투영 반전', () => {
    useLivePageStore.setState({ programTradeEnabled: true });
    renderPanel();
    togglePresence('프로그램 순매수');
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.programTradeEnabled).toBe(false);
    expect(useLivePageStore.getState().programTradeEnabled).toBe(false);
  });

  it('프로그램 순매수 라벨 클릭 → 설명 표시', () => {
    renderPanel();
    openDetail('프로그램 순매수');
    expect(screen.getByText(/KIS REST 저장 데이터/)).toBeTruthy();
  });

  /**
   * **축별 4구획**(2026-08-25 재구성)이 화면에 실제로 서는가.
   *
   * 막는 방향: 구획이 사라지거나, 계열 노브가 다시 구획 밖으로 새는 것. 종전엔
   * 「체결된 벽 표시 개수」가 패널 맨 아래에 있어 어느 선 얘긴지 물어야 했다.
   * 못 보는 것: 구획 **순서**(DOM 순서 단언은 리플로우마다 깨져 값이 없다).
   */
  it('매도 최대벽 — 구획 머리와 계열 카드 3장이 선다', () => {
    renderPanel();
    openDetail('당일 최대벽');
    // 카드 밖에 남은 구획은 둘뿐이다 — 「어디에」·「후보 기준」은 계열마다 갈려
    // 각 카드의 「세부 설정」 안으로 들어갔다(2026-08-25).
    for (const head of ['어떤 벽', '계열 공용']) {
      expect(screen.getByText(head)).toBeTruthy();
    }
    expect(screen.queryByText('어디에')).toBeNull();
    // 계열 3형제가 **대칭**이다 — 종전엔 체결된 벽만 토글이 없었다.
    for (const key of [
      'settings-toggle-askPeakTradedLineEnabled',
      'settings-toggle-askPeakUnreachedLineEnabled',
      'settings-toggle-askPeakAllWallLineEnabled',
    ]) {
      expect(screen.getByTestId(key)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    // 「표시 개수」는 체결된 벽 카드 **안**에 있다(패널 맨 아래가 아니라).
    expect(screen.getByRole('group', { name: '체결된 벽 표시 개수' })).toBeTruthy();
  });

  it('매도 최대벽 — 표면 토글 셋은 **계열 카드마다** 자기 벌로 선다', () => {
    renderPanel();
    openDetail('당일 최대벽');
    // 세 카드를 각각 펼쳐 그 카드 안에서 찾는다 — 스코프 없이 찾으면 계열 하나만
    // 배선돼 있어도 통과한다(같은 라벨의 행이 이제 방향당 셋이다).
    for (const family of ['Traded', 'Unreached', 'AllWall'] as const) {
      fireEvent.click(screen.getByTestId(`settings-toggle-askPeak${family}LineEnabled-details`));
      const panel = within(screen.getByTestId(`peak-wall-family-details-ask-${family}`));
      expect(panel.getByTestId(`settings-toggle-askPeak${family}LabelEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-askPeak${family}RankArrowEnabled`)).toBeTruthy();
      expect(panel.getByTestId(`settings-toggle-askPeak${family}LegendCellEnabled`)).toBeTruthy();
      expect(panel.getByText('어디에')).toBeTruthy();
    }
    // 캔들 수평선은 방향별이라 탭 안(상위 페이지)에 남는다.
    expect(screen.getByTestId('settings-toggle-askPeakCandleLine')).toBeTruthy();
  });

  /**
   * **공용 설정은 탭 밖이다** — 이 PR 의 구조적 요점.
   *
   * 「최대벽 강도 pane」은 매도·매수가 상태 하나를 공유하는데 종전엔 방향 탭 안에
   * 있었다. 탭을 바꿔도 **같은 DOM 노드**가 남는 것이 "탭에 속하지 않는다" 의 증거다.
   */
  it('강도 pane 토글은 방향 탭을 바꿔도 같은 노드로 남는다(탭 밖)', () => {
    renderPanel();
    openDetail('당일 최대벽');
    const onAsk = screen.getByTestId('settings-toggle-peakWallPaneEnabled');
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    expect(screen.getByTestId('settings-toggle-peakWallPaneEnabled')).toBe(onAsk);
    // 반면 계열 카드는 탭을 따라 방향이 바뀐다.
    expect(screen.queryByTestId('settings-toggle-askPeakTradedLineEnabled')).toBeNull();
    expect(screen.getByTestId('settings-toggle-bidPeakTradedLineEnabled')).toBeTruthy();
  });


  it('호가비 라벨 클릭 → 우측에 RatioConfig(극단값 필터 토글) 노출', () => {
    renderPanel();
    openDetail('호가비');
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });

  it('renders broker late-entry controls under 거래원 지표', async () => {
    renderPanel();
    openDetail('신규 거래원 등장');
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
    useLivePageStore.setState({ brokerLateEntries: [{ id: 'ble-1', enabled: true, startHHMM: 930, sideMode: 'both' as const, buyColor: '#ef4444', sellColor: '#3b82f6' }] });
    renderPanel();
    openDetail('신규 거래원 등장');

    const input = screen.getByRole('textbox', { name: /기준 시각$/ }) as HTMLInputElement;
    // 저장값 930 → HH:MM 표시.
    expect(input.value).toBe('09:30');

    // 네 자리 HHMM 입력도 계속 허용하되, blur 시 HH:MM으로 정규화.
    await userEvent.clear(input);
    await userEvent.type(input, '0900');
    fireEvent.blur(input);
    expect(useLivePageStore.getState().brokerLateEntries[0].startHHMM).toBe(900);
    expect(input.value).toBe('09:00');

    // 콜론 형식 입력도 동일하게 파싱.
    await userEvent.clear(input);
    await userEvent.type(input, '10:05');
    fireEvent.blur(input);
    expect(useLivePageStore.getState().brokerLateEntries[0].startHHMM).toBe(1005);
    expect(input.value).toBe('10:05');
  });

  it('clicking 외국인 순매수량 toggles foreignNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ foreignNetEnabled: false });
    renderPanel();
    togglePresence('외국인 순매수량');
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.foreignNetEnabled).toBe(true);
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });

  it('clicking 기관 순매수량 toggles institutionNetEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ institutionNetEnabled: false });
    renderPanel();
    togglePresence('기관 순매수량');
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.institutionNetEnabled).toBe(true);
    expect(useLivePageStore.getState().institutionNetEnabled).toBe(true);
  });

  it('clicking 거래량 toggles volumeEnabled', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    renderPanel();
    // 거래량은 공장값 ON — "내 지표" 에 있고 ✕ 로 지운다. 다시 넣는 것은 카탈로그 ＋.
    togglePresence('거래량');
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(false);
    togglePresence('거래량');
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
    // 꺼진 봉에서는 "내 지표" 가 아니라 카탈로그에 있다(존재 = 켜짐).
    expect(screen.queryByRole('button', { name: '거래량 삭제' })).toBeNull();
    openCatalog();
    expect(screen.getByRole('button', { name: '거래량 추가' })).toBeTruthy();

    useLivePageStore.getState().setIndicatorTimeframe('W');
    view.rerender(<IndicatorPanel onClose={() => {}} timeframe="W" />);
    // W 버킷은 켜짐 → "내 지표" 로 옮겨 온다.
    openMine();
    expect(screen.getByRole('button', { name: '거래량 삭제' })).toBeTruthy();
  });

  it('writes pane category changes to the drawer timeframe bucket only', () => {
    useLivePageStore.setState({ volumeEnabled: true });

    renderPanel({ timeframe: 'D' });

    togglePresence('거래량');

    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBeUndefined();
    // ambient(1m)와 다른 프로파일(D)에 쓴 것이므로 최상위 투영은 그대로다.
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('uses the minute profile for every minute chart timeframe', () => {
    useLivePageStore.setState({ volumeEnabled: true });

    renderPanel({ timeframe: '3m' });

    togglePresence('거래량');

    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBeUndefined();
  });

  // 마스터 토글이 슬롯의 `enabled` 로 접혔다 — 체크박스는 "켜진 슬롯이 있는가" 의
  // 파생이고, 누르면 전 슬롯을 함께 켜고 끈다.
  it('clicking 이동평균선 checkbox flips every MA slot together', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.getState().setAllMovingAveragesEnabled(true);
    renderPanel();
    togglePresence('이동평균선');
    expect(useLivePageStore.getState().movingAverages.some((m) => m.enabled)).toBe(false);
    togglePresence('이동평균선');
    expect(useLivePageStore.getState().movingAverages.every((m) => m.enabled)).toBe(true);
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
    openDetail('거래량');
    expect(screen.getByText(/거래량을 막대로/)).toBeTruthy();
    expect(screen.queryByText(/지난 n일 동안/)).toBeNull();

    // 외국인 순매수량 → its detail.
    openDetail('외국인 순매수량');
    expect(screen.getByText(/외국인.*순매수 수량/)).toBeTruthy();

    // 기관 순매수량 → its detail.
    openDetail('기관 순매수량');
    expect(screen.getByText(/기관.*순매수 수량/)).toBeTruthy();
  });

  it('매수 최대벽 — 매도판과 같은 구조 대칭', () => {
    renderPanel();
    openDetail('당일 최대벽');
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    for (const head of ['어떤 벽', '계열 공용']) {
      expect(screen.getByText(head)).toBeTruthy();
    }
    for (const key of [
      'settings-toggle-bidPeakTradedLineEnabled',
      'settings-toggle-bidPeakUnreachedLineEnabled',
      'settings-toggle-bidPeakAllWallLineEnabled',
    ]) {
      expect(screen.getByTestId(key)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('settings-toggle-bidPeakTradedLineEnabled-details'));
    const panel = within(screen.getByTestId('peak-wall-family-details-bid-Traded'));
    expect(panel.getByTestId('settings-toggle-bidPeakTradedLabelEnabled')).toBeTruthy();
    expect(panel.getByTestId('settings-toggle-bidPeakTradedLegendCellEnabled')).toBeTruthy();
  });


  it('거래량 카테고리 이동 후 체결강도 누적 토글이 노출된다', () => {
    renderPanel();
    openDetail('거래량');
    expect(screen.getByTestId('settings-toggle-volumeFillStrengthCumulative')).toBeTruthy();
    expect(screen.getByText('거래량 — 체결강도 누적')).toBeTruthy();
  });

  it('navigating to a category does NOT toggle its master switch', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.setState({ volumeEnabled: true });
    renderPanel();
    // Clicking the label navigates only — the checkbox is the toggle.
    openDetail('거래량');
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  // 헤더의 표시/숨김 스위치는 사라졌다 — 가시성은 레전드 눈이 전담하고 이 패널은
  // 존재(추가·삭제)만 다룬다. 헤더에 남는 것은 지표명과 봉 배지다.
  it('상세 헤더에 지표명을 표시하고 표시/숨김 스위치는 두지 않는다', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: '이동평균선', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '이동평균선 표시' })).toBeNull();
  });

  it('당일 최대벽(병합)은 추가·삭제가 매도·매수를 함께 움직인다', () => {
    useLivePageStore.setState({ askPeakEnabled: false, bidPeakEnabled: false });
    renderPanel();
    // 둘 다 꺼짐 → 카탈로그에 있다. 추가하면 둘 다 켜진다.
    addIndicator('당일 최대벽');
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);

    // 한쪽만 켜져 있어도 "내 지표" 에 남는다(존재 = 어느 한쪽이라도 켜짐).
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: false });
    openMine();
    expect(screen.getByRole('button', { name: '당일 최대벽 삭제' })).toBeTruthy();

    // 삭제하면 둘 다 꺼진다.
    togglePresence('당일 최대벽');
    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(false);
  });

  it('체크박스 클릭은 상세 pane을 전환하지 않는다', () => {
    renderPanel();
    // 기본 상세는 이동평균선. 다른 카테고리 체크박스를 눌러도 이동평균선 상세가 유지된다.
    expect(screen.getByText(/지난 n일 동안/)).toBeTruthy();
    togglePresence('거래량');
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
    openDetail('거래량');
    expect(screen.queryByText(/별 표시$/)).toBeNull();
  });

  it('현재 봉 초기화는 2단계 확인 후 현재 봉의 지표·IM chartPrefs만 되돌린다', () => {
    // 현재 봉(1m) 버킷에 실제 오버라이드를 쓴다(setter 경유).
    useLivePageStore.getState().setAskPeakEnabled(true);
    useLivePageStore.getState().setVolumeDistributionStyle({ color: '#22C55E' });
    useLivePageStore.getState().setAllMovingAveragesEnabled(false);
    useChartPrefsStore.getState().setNumericPref('surgeStartHHMM', 1030);
    useChartPrefsStore.getState().setNumericPref('ratioOutlierThreshold', 500);
    // 차트 전반 flat(⚙️ 설정 항목)은 드로어 리셋이 건드리면 안 된다.
    useChartPrefsStore.getState().setToggle('candleTooltipEnabled', false);
    renderPanel();

    // 1단계: '현재 봉 초기화' → 확인 행 노출(아직 리셋 안 됨).
    openDetail('현재 봉 초기화');
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
    expect(screen.getByText('분봉 초기화?')).toBeTruthy();

    // 취소는 되돌리지 않는다.
    openDetail('취소');
    expect(screen.queryByText('분봉 초기화?')).toBeNull();
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);

    // 2단계: 다시 열고 '초기화' → 실제 리셋.
    openDetail('현재 봉 초기화');
    openDetail('초기화');
    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeDistributionColor).toBe('#64748B');
    // 리셋은 공장값 복귀 — 현재봉 MA 공장 슬롯은 전부 켜져 있다.
    expect(useLivePageStore.getState().movingAverages.every((m) => m.enabled)).toBe(true);
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
    openDetail('현재 봉 초기화');
    openDetail('초기화');
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute).toBeUndefined();
    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBe(false);
  });

  it('현재 봉 초기화는 pane 배열 순서(레이아웃)를 보존한다', () => {
    const customOrder = ['candle', 'ratio', 'volume'] as unknown as never;
    useLivePageStore.setState({ paneOrder: customOrder });
    useLivePageStore.getState().setVolumeDistributionStyle({ color: '#22C55E' });
    renderPanel();
    openDetail('현재 봉 초기화');
    openDetail('초기화');
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

  it('backdrop press calls onClose, inside press does not', () => {
    // ModalShell 백드롭 닫힘은 mousedown 기준(드래그 오작동 방지 계약).
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // "이동평균선" appears both as a nav button label and as the MA config h3.
    // The nav button is the first occurrence; click its parent for an inside-content check.
    const navLabel = screen.getAllByText('이동평균선')[0];
    fireEvent.mouseDown(navLabel.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('당일 최대벽 매도 서브탭의 표시 토글로 askPeakEnabled 반전', () => {
    useLivePageStore.setState({ askPeakEnabled: false });
    renderPanel();
    // 추가는 매도·매수를 함께 켜므로(병합 카테고리) 여기서는 **미리보기**로 연다 —
    // 재려는 것은 서브탭 스위치 하나이지 추가 흐름이 아니다.
    previewDetail('당일 최대벽');
    // 기본 서브탭은 매도.
    fireEvent.click(screen.getByRole('switch', { name: '매도 최대벽 표시' }));
    expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
  });

  it('당일 최대 매물대 카테고리 토글', () => {
    useLivePageStore.setState({ tradeVolumePocEnabled: true });
    renderPanel();
    togglePresence('당일 최대 매물대');
    expect(useLivePageStore.getState().tradeVolumePocEnabled).toBe(false);
  });

  it('연속체결 매물대 분포 카테고리 토글', () => {
    useLivePageStore.setState({ volumeDistributionEnabled: true });
    renderPanel();
    togglePresence('연속체결 매물대 분포');
    expect(useLivePageStore.getState().volumeDistributionEnabled).toBe(false);
  });

  it('연속체결 매물대 분포 선택 시 범위/색상 설정을 저장한다', () => {
    useLivePageStore.setState({
      volumeDistributionRangeCount: 10,
      volumeDistributionColor: '#64748B',
      volumeDistributionMaxColor: '#EAB308',
    });
    renderPanel();
    openDetail('연속체결 매물대 분포');
    fireEvent.change(screen.getByRole('spinbutton', { name: '연속체결 매물대 분포 구간 수' }), {
      target: { value: '18' },
    });
    // 색상은 이제 스와치 trigger→팝오버 패턴(ColorSwatchPicker). 팝오버를 먼저 연다.
    openDetail('연속체결 매물대 분포 색상 선택');
    openDetail('연속체결 매물대 분포 색상 #22C55E');
    openDetail('연속체결 매물대 분포 최대 구간 색상 선택');
    openDetail('연속체결 매물대 분포 최대 구간 색상 #EF4444');
    expect(useLivePageStore.getState().volumeDistributionRangeCount).toBe(18);
    expect(useLivePageStore.getState().volumeDistributionColor).toBe('#22C55E');
    expect(useLivePageStore.getState().volumeDistributionMaxColor).toBe('#EF4444');
  });

  it('toggles hover-cutoff mode for volume distribution', () => {
    useLivePageStore.setState({ volumeDistributionHoverCutoffEnabled: false });
    renderPanel();
    openDetail('연속체결 매물대 분포');
    expect(screen.getByTestId('settings-toggle-volumeDistributionHoverCutoff')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: '호버 시점 누적' }));
    expect(useLivePageStore.getState().volumeDistributionHoverCutoffEnabled).toBe(true);
  });

  it('당일 최대 매물대 선택 시 분포 최대 구간 설명 표시', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 18 });
    renderPanel();
    openDetail('당일 최대 매물대');
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
    openDetail('당일 최대 매물대');
    openDetail('당일 최대 매물대 색상 선택');
    openDetail('당일 최대 매물대 색상 #22C55E');
    fireEvent.change(screen.getByRole('slider', { name: '당일 최대 매물대 투명도' }), {
      target: { value: '28' },
    });
    expect(useLivePageStore.getState().tradeVolumePocColor).toBe('#22C55E');
    expect(useLivePageStore.getState().tradeVolumePocOpacity).toBe(0.28);
  });

  it('매도 최대벽 선택 시 스타일 pane(MAStylePicker) 표시', () => {
    renderPanel();
    openDetail('당일 최대벽');
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    // 「보이는 영역 최대벽」 스타일 컨트롤은 2026-08-23 제거(레전드·화살표의 ①②③ 과 중복).
    expect(screen.queryByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeNull();
  });

  it('당일 최대벽 매수 서브탭의 표시 토글로 bidPeakEnabled 반전', () => {
    useLivePageStore.setState({ bidPeakEnabled: false });
    renderPanel();
    previewDetail('당일 최대벽');
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    fireEvent.click(screen.getByRole('switch', { name: '매수 최대벽 표시' }));
    expect(useLivePageStore.getState().bidPeakEnabled).toBe(true);
  });

  it('매수 최대벽 선택 시 스타일 pane과 토글 표시', () => {
    renderPanel();
    openDetail('당일 최대벽');
    fireEvent.click(screen.getByRole('tab', { name: '매수' }));
    expect(screen.getByRole('button', { name: '체결된 벽 스타일 선택' })).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-bidPeakIntraMax')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-toggle-bidPeakTradedLineEnabled-details'));
    expect(screen.getByTestId('settings-toggle-bidPeakTradedLabelEnabled')).toBeTruthy();
  });

  it('일봉 이동평균선 체크박스 토글 → 전 슬롯 반전', async () => {
    const { useLivePageStore } = await import('../../state/livePage');
    useLivePageStore.getState().setAllDailyMovingAveragesEnabled(false);
    renderPanel();
    togglePresence('일봉 이동평균선');
    expect(useLivePageStore.getState().dailyMovingAverages.every((m) => m.enabled)).toBe(true);
  });

  it('일봉 이동평균선 라벨 클릭 → DailyMovingAverageConfig 노출', () => {
    renderPanel();
    openDetail('일봉 이동평균선');
    expect(screen.getByText(/일봉 종가 기준 이평선을 분봉 차트에 투영/)).toBeTruthy();
  });

  it('호가벽 급증 카테고리가 10호가 그룹에 렌더된다', () => {
    renderPanel();
    openCatalog();
    expect(screen.getByRole('button', { name: '호가벽 급증' })).toBeInTheDocument();
  });

  it('호가벽 급증 토글이 지표 슬라이스를 바꾼다 (chartPrefs 가 아니다)', () => {
    renderPanel();
    togglePresence('호가벽 급증');
    expect(useLivePageStore.getState().wallSurgeEnabled).toBe(true);
  });

  it('호가벽 급증 상세에 라벨 토글이 뜬다 — 등록만으로는 안 뜨므로 렌더로 확인', () => {
    renderPanel();
    openDetail('호가벽 급증');
    expect(screen.getByText('급증 마커 잔량 라벨')).toBeInTheDocument();
  });

  it('호가 잔량 히트맵 카테고리가 10호가 그룹에 렌더된다', () => {
    render(<IndicatorPanel onClose={() => {}} timeframe="1m" />);
    openCatalog();
    expect(screen.getByRole('button', { name: '호가 잔량 히트맵' })).toBeInTheDocument();
  });

  it('호가 잔량 히트맵 카테고리 토글', () => {
    useLivePageStore.setState({ depthHeatmapEnabled: false });
    renderPanel();
    togglePresence('호가 잔량 히트맵');
    expect(useLivePageStore.getState().depthHeatmapEnabled).toBe(true);
  });

  it('호가 잔량 히트맵 라벨 클릭 → 매수/매도 색상 + 불투명도 노출', () => {
    renderPanel();
    openDetail('호가 잔량 히트맵');
    expect(screen.getByRole('button', { name: '매수 색상 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '매도 색상 스타일 선택' })).toBeTruthy();
    expect(screen.getByRole('slider')).toBeTruthy();
  });

  // `hiddenCategories` 는 `capabilities` 와 **다른 축**이다: 저쪽은 "이 종목에 그
  // 데이터가 있는가", 이쪽은 "이 화면이 그 지표를 그리는가". 그 지표를 렌더하지 않는
  // 화면이 토글만 보여 주던 것을 없애기 위한 것이다.
  describe('hiddenCategories', () => {
    it('숨긴 지표는 목록에서 사라진다', () => {
      const { unmount } = renderPanel();
      openCatalog();
      expect(screen.queryByRole('button', { name: '당일 최대 매물대' })).toBeTruthy();
      unmount();

      renderPanel({ hiddenCategories: ['trade-volume-poc'] });
      openCatalog();
      expect(screen.queryByRole('button', { name: '당일 최대 매물대' })).toBeNull();
    });

    it('다른 지표는 그대로 남는다 — 필터가 과하게 걷어내지 않는다', () => {
      renderPanel({ hiddenCategories: ['trade-volume-poc'] });
      openCatalog();

      expect(screen.queryByRole('button', { name: '호가 잔량 히트맵' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '당일 최대벽' })).toBeTruthy();
    });
  });

});
