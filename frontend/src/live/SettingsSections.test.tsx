import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsSections from './SettingsSections';
import { useLiveVenueStore } from '../state/liveVenue';
import {
  CHART_TOGGLES,
  CHART_DISPLAY_GROUP_IDS,
  categoryOf,
  gatedByOf,
  groupOf,
  useChartPrefsStore,
} from '../state/chartPrefs';
import * as apiClientApi from '../api/client';
import * as liveSettingsApi from '../api/liveSettings';
import * as signalAlertsApi from '../api/signalAlerts';

// 단일 스크롤 전환으로 정보 섹션(알림·데이터소스·테마·Symbol Master·앱 정보)이
// **항상 마운트**된다 — 각 섹션의 쿼리 함수를 파일 스코프에서 막아 모든 테스트가
// 네트워크 없이 조용히 돈다. 부분 mock: 오버라이드하지 않은 export 는 원본 유지.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiCall: vi.fn().mockResolvedValue({ status: 'ok', version: '0.0.0' }),
}));
vi.mock('../api/symbols', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/symbols')>()),
  getSymbolMasterInfo: vi.fn().mockResolvedValue({ count: 0, fetched_at_ms: null, status: 'ok' }),
}));
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  loadConfig: vi.fn().mockResolvedValue({ api_url: 'http://test' }),
}));

function renderSettings(props: Parameters<typeof SettingsSections>[0] = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<SettingsSections {...props} />, {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  return { ...view, queryClient: qc };
}

describe('SettingsSections (단일 스크롤 + 목차)', () => {
  beforeEach(() => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    useLiveVenueStore.setState({ venue: 'KRX' });
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('실제로 변경한 전역 설정만 되돌리고 다른 설정은 보존한다', async () => {
    renderSettings();
    const row = screen.getByTestId('settings-toggle-cursorSyncCrossSymbol');
    const old = useChartPrefsStore.getState().cursorSyncCrossSymbol;
    fireEvent.click(row.querySelector('button')!);
    const undo = screen.getByRole('button', { name: '되돌리기' });
    await waitFor(() => expect(undo).toBeEnabled());
    act(() => useLiveVenueStore.getState().setVenue('UN'));
    fireEvent.click(undo);
    await waitFor(() => expect(useChartPrefsStore.getState().cursorSyncCrossSymbol).toBe(old));
    expect(useLiveVenueStore.getState().venue).toBe('UN');
    expect(undo).toBeDisabled();
  });
  it('외부에서 같은 설정이 변경되면 오래된 되돌리기를 비활성화한다', async () => {
    renderSettings();
    const old = useChartPrefsStore.getState().cursorSyncCrossSymbol;
    fireEvent.click(screen.getByTestId('settings-toggle-cursorSyncCrossSymbol').querySelector('button')!);
    const undo = screen.getByRole('button', { name: '되돌리기' });
    await waitFor(() => expect(undo).toBeEnabled());
    act(() => useChartPrefsStore.getState().setToggle('cursorSyncCrossSymbol', old));
    expect(undo).toBeDisabled();
  });
  it('서버 설정 저장 성공 후 되돌리기는 바뀐 필드만 다시 PATCH한다', async () => {
    const initial = { schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: false };
    const patches: unknown[] = [];
    let server = initial;
    vi.mocked(apiClientApi.apiCall).mockImplementation(async (url, options) => {
      if (url === '/api/live/settings') {
        if (options?.method === 'PATCH') { const patch = JSON.parse(String(options.body)); patches.push(patch); server = { ...server, ...patch }; }
        return server as never;
      }
      return {} as never;
    });
    const { queryClient } = renderSettings();
    await waitFor(() => expect(queryClient.getQueryData(liveSettingsApi.LIVE_SETTINGS_KEY)).toEqual(initial));
    fireEvent.click(screen.getByRole('switch', { name: '저장 데이터로 캔들 보기' }));
    const undo = screen.getByRole('button', { name: '되돌리기' });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);
    await waitFor(() => expect(patches.at(-1)).toEqual({ rest_bypass_enabled: false }));
    await waitFor(() => expect(undo).toBeDisabled());
    expect(patches[0]).toEqual({ rest_bypass_enabled: true });
    expect(queryClient.getQueryData(liveSettingsApi.LIVE_SETTINGS_KEY)).toEqual(initial);
  });
  it('서버 알림 설정도 저장 이후 이전 규칙으로 되돌린다', async () => {
    const rule = { enabled: true, start_hhmm: 1100, threshold_pct: 100, use_intra_minute_max: true };
    const patches: unknown[] = [];
    let server = { schema_version: 1, sell_total_renewal: rule };
    vi.mocked(apiClientApi.apiCall).mockImplementation(async (url, options) => {
      if (url === '/api/signal-alerts/settings') {
        if (options?.method === 'PATCH') { const patch = JSON.parse(String(options.body)); patches.push(patch); server = { ...server, ...patch }; }
        return server as never;
      }
      return {} as never;
    });
    const { queryClient } = renderSettings();
    await waitFor(() => expect(queryClient.getQueryData(signalAlertsApi.SIGNAL_ALERT_SETTINGS_KEY)).toEqual({ schema_version: 1, sell_total_renewal: rule }));
    fireEvent.click(screen.getByRole('switch', { name: '알림 사용' }));
    const undo = screen.getByRole('button', { name: '되돌리기' });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);
    await waitFor(() => expect(patches.at(-1)).toEqual({ sell_total_renewal: rule }));
    await waitFor(() => expect(undo).toBeDisabled());
  });

  it('통합 목차 8개를 렌더한다 — 차트·체결창·알림 + 앱 스코프 5개', () => {
    renderSettings();
    for (const id of [
      'chart', 'trade-window', 'alerts', 'data-source', 'theme', 'symbols', 'general', 'roadmap',
    ]) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeTruthy();
    }
    // 「저장뷰」 nav 는 #1326 에서 사라졌다 — 저장뷰가 차트 봉을 정하지 않게 되면서
    // 그 섹션이 정할 것이 없어졌다.
    expect(screen.queryByTestId('settings-nav-study-views')).toBeNull();
    expect(screen.queryByTestId('settings-nav-indicators')).toBeNull();
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
    // 「데이터 수집」 은 토글 1개짜리 섹션이라 데이터소스의 「캡처 저장」 으로 흡수됐다.
    expect(screen.queryByTestId('settings-nav-data')).toBeNull();
  });

  it('단일 스크롤 — 모든 섹션이 클릭 없이 동시에 문서에 있다', () => {
    renderSettings();
    for (const name of ['차트', '체결창', '알림', '데이터소스', '테마', '종목 목록', '앱 정보', '로드맵']) {
      expect(screen.getByRole('region', { name })).toBeTruthy();
    }
  });

  it('복기뷰(study)는 체결창만 빠지고 나머지는 같다 — 목차와 본문 섹션이 함께 사라진다', () => {
    // `variant` 가 가르는 **유일한** 항목이다. 데이터소스가 쓰던 분기는 삭제됐다 —
    // 값이 전역인데 화면마다 숨기면 어느 문으로 들어왔는지에 답이 달라진다.
    renderSettings({ variant: 'study' });
    for (const id of ['chart', 'alerts', 'data-source', 'theme', 'symbols', 'general', 'roadmap']) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('settings-nav-trade-window')).toBeNull();
    expect(screen.queryByRole('region', { name: '체결창' })).toBeNull();
  });

  it('레지스트리 가드 — 앱 설정 토글은 한 번 렌더되고 캔들 헤더 전용 그룹은 제외된다', () => {
    // `SettingsSections` 는 그룹 순회로만 렌더하므로 group 없는 최상위 토글은
    // **조용히 사라진다** — 이 가드가 그 누락을 빨갛게 만든다(막는 방향: 토글 추가
    // 시 group 누락. 못 보는 것: 잘못된 그룹에 넣는 것 — 그건 육안 몫이다).
    renderSettings();
    const topLevel = CHART_TOGGLES.filter((t) => {
      const cat = categoryOf(t);
      return (cat === 'chart' || cat === 'trade-window') && gatedByOf(t) === undefined;
    });
    expect(topLevel.length).toBeGreaterThan(0);
    for (const t of topLevel) {
      const group = groupOf(t);
      expect(group, `${t.key} 에 group 이 없다`).toBeDefined();
      if (group && CHART_DISPLAY_GROUP_IDS.includes(group)) {
        expect(screen.queryByTestId(`settings-toggle-${t.key}`)).toBeNull();
        continue;
      }
      expect(screen.getAllByTestId(`settings-toggle-${t.key}`)).toHaveLength(1);
    }
  });

  it('차트 섹션에 동기화·가격 표시와 체결창의 강조 소그룹만 남는다', () => {
    renderSettings();
    for (const label of ['창 간 동기화', '가격 표시', '체결 강조']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText('캔들 · 지표')).toBeNull();
    expect(screen.queryByText('격자 · 구분선')).toBeNull();
  });

  it('체결창 — 토글·기준 금액·배경색 피커가 문서에 보인다', () => {
    renderSettings();
    expect(screen.getByTestId('settings-toggle-tradeHighlightEnabled')).toBeTruthy();
    expect(screen.getByText('기준 금액 (만원)')).toBeTruthy();
    expect(screen.getByLabelText('대량 체결 강조 배경색 선택')).toBeTruthy();
  });

  it('하위 토글(극값 가격선)은 부모 아래 **한 번만** 렌더된다', () => {
    // 소그룹 렌더는 최상위 토글만 순회한다(`gatedByOf` 있는 것 제외). 하위 토글을
    // 빼지 않으면 같은 행이 두 번(부모 아래 + 자기 차례) 나온다.
    renderSettings();
    for (const key of [
      'highLowHighLineEnabled', 'highLowLowLineEnabled',
      'highLowPriorHighLineEnabled', 'highLowPriorLowLineEnabled',
    ]) {
      expect(screen.getAllByTestId(`settings-toggle-${key}`)).toHaveLength(1);
    }
    // 색·두께 행도 각 선 아래 한 번씩.
    for (const key of [
      'highLowHighLine', 'highLowLowLine', 'highLowPriorHighLine', 'highLowPriorLowLine',
    ]) {
      expect(screen.getAllByTestId(`settings-linestyle-${key}`)).toHaveLength(1);
    }
  });

  it('uses a flat section surface for the document', () => {
    renderSettings();

    // nav는 border-r 대신 bg-subtle 톤 스텝으로 분리(2026-07-15 borderless 통일).
    expect(screen.getByRole('navigation', { name: '설정 카테고리' }).closest('.settings-editor-sidebar')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '설정 카테고리' })).not.toHaveClass('border-r');
    expect(screen.getByRole('region', { name: '차트' })).not.toHaveClass('bg-bg-card');
  });

  it('이동·제거된 토글은 설정 모달에 없다 (급증·누적·극단값필터·날짜 구분선)', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-toggle-surgeMarkerEnabled')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-fillStrengthCumulative')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeNull();
    // 날짜 구분선은 **이동이 아니라 제거**다(2026-08-27) — 색은 테마 토큰, 두께는
    // 1px 상수, 표시는 분봉이면 항상. 스타일 피커도 같이 사라졌다.
    expect(screen.queryByTestId('settings-toggle-dayBoundaryEnabled')).toBeNull();
    expect(screen.queryByRole('button', { name: '날짜 구분선 스타일 선택' })).toBeNull();
  });

  it('토글 클릭이 chartPrefs 스토어에 반영된다', () => {
    renderSettings();
    expect(useChartPrefsStore.getState().cursorSyncCrossSymbol).toBe(true);
    // ToggleRow 는 testId 를 **바깥 wrapper** 에 단다 — 핸들러는 안쪽 role="switch"
    // 버튼에 있으므로 파고들어 눌러야 한다(누르는 시늉만 하면 조용히 통과한다).
    const row = screen.getByTestId('settings-toggle-cursorSyncCrossSymbol');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().cursorSyncCrossSymbol).toBe(false);
  });

  it.each(['live', 'study'] as const)('%s 앱 설정에서 이전한 6개 항목은 검색해도 나오지 않고 저장값은 유지한다', variant => {
    const labels = ['캔들 기준 Y축', '캔들이 항상 위', '동시호가 구간 지표 숨김', '캔들 정보 툴팁', '가로 구분선', '세로 구분선'];
    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', true);
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    renderSettings({ variant });
    for (const label of labels) {
      expect(screen.queryByRole('switch', { name: label })).toBeNull();
      fireEvent.change(screen.getByLabelText('설정 필터'), { target: { value: label } });
      expect(screen.getByText(/에 맞는 설정이 없습니다/)).toBeTruthy();
      expect(screen.queryByRole('switch', { name: label })).toBeNull();
    }
    expect(useChartPrefsStore.getState().candlePaneCandleOnlyScale).toBe(true);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  // ── 목차(스크롤 스파이) ───────────────────────────────────────────────
  // 스파이의 스크롤 추적 절반은 jsdom 에서 잴 수 없다(모든 rect 가 0) — 여기서는
  // 클릭 경로의 동기 절반(aria-current + scrollIntoView 호출)만 못 박고, 실제
  // 스크롤 추적은 /browse 실화면으로 검증한다.

  it('목차 클릭 → aria-current 이동 + 해당 섹션으로 scrollIntoView', () => {
    // jsdom 에는 scrollIntoView 가 없다 — 컴포넌트는 옵셔널 호출로 살아남고,
    // 호출 여부를 재려면 프로토타입에 스텁을 심는다.
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      renderSettings();
      expect(screen.getByTestId('settings-nav-chart')).toHaveAttribute('aria-current', 'true');

      fireEvent.click(screen.getByTestId('settings-nav-theme'));

      expect(screen.getByTestId('settings-nav-theme')).toHaveAttribute('aria-current', 'true');
      expect(screen.getByTestId('settings-nav-chart')).not.toHaveAttribute('aria-current');
      expect(scrollSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  // ── 인라인 필터 ───────────────────────────────────────────────────────

  it('필터 — 일치하는 행만 남고 정보 섹션·소그룹 헤더는 숨는다', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('설정 필터'), { target: { value: '동기화' } });

    expect(screen.getByTestId('settings-toggle-cursorSyncCrossSymbol')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-rangeSyncEnabled')).toBeTruthy();
    expect(screen.queryByTestId('settings-toggle-auctionWindowMask')).toBeNull();
    expect(screen.queryByRole('region', { name: '알림' })).toBeNull();
    // 필터 중에는 소그룹 헤더를 걷는다 — 남은 행이 곧 답이라 층위가 소음이 된다.
    expect(screen.queryByText('창 간 동기화')).toBeNull();
  });

  it('필터 — 라벨의 일치 구간이 표시된다', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('설정 필터'), { target: { value: '기간 동기화' } });

    const row = screen.getByTestId('settings-toggle-rangeSyncEnabled');
    expect(row.querySelector('mark')?.textContent).toBe('기간 동기화');
  });

  it('필터는 유닛 단위다 — 하위 행이 걸리면 부모째 남는다', () => {
    // 렌더러가 부모+하위를 한 덩어리로 그리므로(부모 없는 하위는 맥락을 잃는다),
    // 하위 토글 라벨로 검색해도 부모 토글이 함께 보이는 것이 계약이다.
    renderSettings();
    fireEvent.change(screen.getByLabelText('설정 필터'), { target: { value: '이전일 고가선' } });

    expect(screen.getByTestId('settings-toggle-highLowLabelsEnabled')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-highLowPriorHighLineEnabled')).toBeTruthy();
    expect(screen.queryByTestId('settings-toggle-horizontalGridLinesEnabled')).toBeNull();
  });

  it('필터 — 아무것도 안 걸리면 빈 상태가 검색 경계를 말한다', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('설정 필터'), { target: { value: '존재하지않는설정' } });

    expect(screen.getByText(/에 맞는 설정이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '차트' })).toBeNull();
  });

  it('Escape 사다리 — 검색어가 있으면 지우기만 한다', () => {
    renderSettings();
    const input = screen.getByLabelText('설정 필터') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '격자' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('');
    // 행이 돌아온다 — 필터가 실제로 해제됐다.
    expect(screen.getByTestId('settings-toggle-cursorSyncCrossSymbol')).toBeTruthy();
  });

  it('필터 중 목차 클릭 → 필터를 해제하고 그 섹션으로 간다', () => {
    renderSettings();
    const input = screen.getByLabelText('설정 필터') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '격자' } });

    fireEvent.click(screen.getByTestId('settings-nav-theme'));

    expect(input.value).toBe('');
    expect(screen.getByTestId('settings-nav-theme')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('region', { name: '테마' })).toBeTruthy();
  });

  it('복기뷰(study)도 같은 데이터소스 상세가 문서에 있다 — 복기 안내는 동반 문구로 남는다', () => {
    renderSettings({ variant: 'study' });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));
    expect(screen.getByTestId('study-candle-source-note')).toBeTruthy();
    expect(screen.getByText('호가·체결 데이터 기준')).toBeTruthy();
    expect(screen.getByText('표시 소스')).toBeTruthy();
    expect(screen.getByText('캡처 저장')).toBeTruthy();
  });

  // 데이터소스 상세 콘텐츠 테스트는 DataSourceDetail.test.tsx로 이관(추출·재사용).

  it('알림 섹션에서 시그널 알림 설정을 수정한다', async () => {
    const mutate = vi.fn().mockResolvedValue({ schema_version: 1, sell_total_renewal: { enabled: true, start_hhmm: 1100, threshold_pct: 100, use_intra_minute_max: true } });
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: mutate,
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    renderSettings();

    expect(await screen.findByRole('switch', { name: '알림 사용' })).toHaveAttribute('aria-checked', 'true');
    const startTime = screen.getByLabelText('기준 시각');
    const threshold = screen.getByLabelText('기준 최대값 대비 문턱 (%)');

    fireEvent.change(startTime, { target: { value: '11:15' } });
    fireEvent.blur(startTime);
    fireEvent.change(threshold, { target: { value: '95' } });
    fireEvent.blur(threshold);
    fireEvent.click(screen.getByRole('switch', { name: '분봉 내 최대 매도 총잔량으로 판정' }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        sell_total_renewal: {
          enabled: true,
          start_hhmm: 1115,
          threshold_pct: 95,
          use_intra_minute_max: false,
        },
      });
    });
  });

  it('알림 기준 시각은 네 자리 HHMM 입력을 HH:MM으로 해석해 저장한다', async () => {
    const mutate = vi.fn().mockResolvedValue({ schema_version: 1, sell_total_renewal: { enabled: true, start_hhmm: 1100, threshold_pct: 100, use_intra_minute_max: true } });
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: mutate,
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    renderSettings();
    const startTime = await screen.findByLabelText('기준 시각') as HTMLInputElement;

    fireEvent.change(startTime, { target: { value: '1000' } });
    fireEvent.blur(startTime);
    expect(startTime.value).toBe('10:00');
    expect(mutate).toHaveBeenLastCalledWith({
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1000,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });

    fireEvent.change(startTime, { target: { value: '1500' } });
    fireEvent.blur(startTime);
    expect(startTime.value).toBe('15:00');
    expect(mutate).toHaveBeenLastCalledWith({
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1500,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
  });
});
