import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceStore, type WorkspaceWindow } from './workspace';
import { useWindowSettingsStore } from './windowSettings';
import { useLivePageStore } from './livePage';
import { useChartPrefsStore } from './chartPrefs';
import { captureIndicatorPayloadForWindow } from './indicatorScopeGc';
import { readLastWindowPreferences, rememberWindowPreferences } from './windowPreferenceMemory';
import { windowScopeKey } from '../live/workspace/windowViewContext';
import { applyPresetPayload, capturePresetPayload } from '../live/presets/layoutPresetSnapshot';

const workspace = () => useWorkspaceStore.getState();
const scope = (id: string, index = false) => ({ windowKey: windowScopeKey(id, index ? 'index' : 'stock') });
const win = (id: string) => workspace().windows.find(w => w.id === id)!;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useWorkspaceStore.setState({ windows: [], zOrder: [], groupSymbols: {}, chartRuntime: {} });
  useWindowSettingsStore.setState({ byWindow: {} });
  useLivePageStore.setState({ indicatorsByWindow: {}, indicatorsByTimeframe: {} });
  useChartPrefsStore.setState({ indicatorModalByWindow: {}, indicatorModalByTimeframe: {} });
});

it('모든 차트를 닫아도 봉·표시·주식/지수 지표의 각 봉 설정을 함께 복원한다', () => {
  const first = workspace().addWindow('chart');
  workspace().setChartTimeframe(first, '5m');
  workspace().setChartRegularSessionOnly(first, true);
  useWindowSettingsStore.getState().patch(first, 'chart', { candleLogScale: true, highLowLabelsEnabled: false });
  useLivePageStore.getState().patchIndicatorsScoped(scope(first), '5m', { volumeEnabled: false });
  useLivePageStore.getState().patchIndicatorsScoped(scope(first), 'D', { tradeValueEnabled: true });
  useLivePageStore.getState().patchIndicatorsScoped(scope(first, true), 'D', { volumeEnabled: false });
  useChartPrefsStore.getState().setPrefScoped(scope(first, true), 'D', 'surgeMarkerEnabled', false);
  useChartPrefsStore.getState().setPrefScoped(scope(first), '5m', 'surgeMarkerEnabled', true);
  const indicators = captureIndicatorPayloadForWindow(first);
  const display = useWindowSettingsStore.getState().byWindow[first];
  useWorkspaceStore.setState({ chartRuntime: { [first]: { historicalFromDate: '20260101',
    lastMinuteHistoricalFromDate: '20260101', lastMinuteHistoricalTimeframe: '5m', hogaplaySource: true } } });
  workspace().closeWindow(first);
  sessionStorage.clear();
  const reopened = workspace().addWindow('chart');
  expect(win(reopened).chart).toMatchObject({ timeframe: '5m', regularSessionOnly: true });
  expect(captureIndicatorPayloadForWindow(reopened)).toEqual(indicators);
  expect(useWindowSettingsStore.getState().byWindow[reopened]).toEqual(display);
  expect(workspace().chartRuntime[reopened]).toBeUndefined();
  expect(readLastWindowPreferences('chart')).not.toHaveProperty('chartRuntime');
});

it('열린 차트 복사가 마지막 기억보다 우선하고 닫는 순서는 마지막 편집값을 바꾸지 않는다', () => {
  const first = workspace().addWindow('chart');
  workspace().setChartTimeframe(first, 'D');
  const second = workspace().addWindow('chart');
  workspace().setChartTimeframe(second, 'W');
  useWindowSettingsStore.getState().patch(second, 'chart', { candleLogScale: true });
  workspace().focusWindow(first);
  const copied = workspace().addWindow('chart');
  expect(win(copied).chart?.timeframe).toBe('D');
  expect(useWindowSettingsStore.getState().byWindow[copied].chart?.candleLogScale).toBe(false);
  for (const id of [second, copied, first]) workspace().closeWindow(id);
  const reopened = workspace().addWindow('chart');
  expect(win(reopened).chart?.timeframe).toBe('W');
  expect(useWindowSettingsStore.getState().byWindow[reopened].chart?.candleLogScale).toBe(true);
});

it('프리셋은 기억된 값보다 우선하며 복원·시드는 마지막 편집값을 덮어쓰지 않는다', () => {
  const first = workspace().addWindow('chart');
  workspace().setChartTimeframe(first, 'D');
  const preset = capturePresetPayload();
  workspace().setChartTimeframe(first, 'W');
  useWindowSettingsStore.getState().patch(first, 'chart', { candleLogScale: true });
  const remembered = readLastWindowPreferences('chart');
  applyPresetPayload(preset, null);
  expect(win(first).chart?.timeframe).toBe('D');
  expect(useWindowSettingsStore.getState().byWindow[first].chart?.candleLogScale).toBe(false);
  expect(readLastWindowPreferences('chart')).toEqual(remembered);
  workspace().closeWindow(first);
  expect(win(workspace().addWindow('chart')).chart?.timeframe).toBe('W');
});

it('지표 초기화도 마지막 설정이며 빈 버킷을 이전 페이지 설정으로 되돌리지 않는다', () => {
  const first = workspace().addWindow('chart');
  useLivePageStore.getState().patchIndicatorsScoped(scope(first), '1m', { volumeEnabled: false });
  useChartPrefsStore.getState().setPrefScoped(scope(first), '1m', 'surgeMarkerEnabled', true);
  useLivePageStore.getState().resetIndicatorsScoped(scope(first), '1m');
  useChartPrefsStore.getState().resetIndicatorModalBucketScoped(scope(first), '1m');
  workspace().closeWindow(first);
  useLivePageStore.setState({ indicatorsByTimeframe: { minute: { volumeEnabled: false } } });
  const next = workspace().addWindow('chart');
  expect(captureIndicatorPayloadForWindow(next)).toEqual({ indicators: {}, indicatorModal: {} });
});

it('체결·뉴스는 마지막 필터를 복사하고 기존 창과 프리셋은 독립적이다', () => {
  const trade = workspace().addWindow('trade');
  const news = workspace().addWindow('news');
  workspace().setTradeMinAmountManwon(trade, 3000);
  workspace().setNewsLinkedOnly(news, false);
  const nextTrade = workspace().addWindow('trade');
  const nextNews = workspace().addWindow('news');
  expect(win(nextTrade).tradeMinAmountManwon).toBe(3000);
  expect(win(nextNews).newsLinkedOnly).toBe(false);
  const preset = capturePresetPayload();
  workspace().setTradeMinAmountManwon(nextTrade, 0);
  workspace().setNewsLinkedOnly(nextNews, true);
  expect(win(trade).tradeMinAmountManwon).toBe(3000);
  expect(win(news).newsLinkedOnly).toBe(false);
  applyPresetPayload(preset, null);
  expect(win(nextTrade).tradeMinAmountManwon).toBe(3000);
  expect(win(nextNews).newsLinkedOnly).toBe(false);
  for (const id of [nextTrade, nextNews, trade, news]) workspace().closeWindow(id);
  sessionStorage.clear();
  expect(win(workspace().addWindow('trade')).tradeMinAmountManwon).toBe(0);
  expect(win(workspace().addWindow('news')).newsLinkedOnly).toBe(true);
});

it('기존 창을 편집 없이 닫아도 한 번 기억하며 잘못된 저장값은 검증한다', () => {
  const legacy: WorkspaceWindow = { id: 'old', kind: 'trade', group: 1,
    rect: { x: 0, y: 0, w: .5, h: .5 }, tradeMinAmountManwon: 5000 };
  useWorkspaceStore.setState({ windows: [legacy], zOrder: ['old'] });
  workspace().closeWindow('old');
  expect(win(workspace().addWindow('trade')).tradeMinAmountManwon).toBe(5000);
  rememberWindowPreferences('trade', { minAmountManwon: -1 });
  rememberWindowPreferences('news', { linkedOnly: 'false' });
  rememberWindowPreferences('chart', { chart: { timeframe: 'broken' },
    windowSettings: { chart: { candleLogScale: 'yes' } }, indicators: 'broken' });
  expect(win(workspace().addWindow('trade')).tradeMinAmountManwon).toBeUndefined();
  expect(win(workspace().addWindow('news')).newsLinkedOnly).toBeUndefined();
  const chart = workspace().addWindow('chart');
  expect(win(chart).chart?.timeframe).toBe('1m');
  expect(useWindowSettingsStore.getState().byWindow[chart].chart?.candleLogScale).toBe(false);
});

it('빈 작업공간은 브라우저 재시작 후에도 비어 있고 새 차트에 마지막 설정을 복원한다', async () => {
  const chart = workspace().addWindow('chart');
  workspace().setChartTimeframe(chart, 'W');
  useWindowSettingsStore.getState().patch(chart, 'chart', { candleLogScale: true });
  workspace().closeWindow(chart);
  sessionStorage.clear();
  vi.resetModules();
  const { useWorkspaceStore: restarted } = await import('./workspace');
  const { useWindowSettingsStore: settings } = await import('./windowSettings');
  expect(restarted.getState().windows).toEqual([]);
  const next = restarted.getState().addWindow('chart');
  expect(restarted.getState().windows.find(w => w.id === next)?.chart?.timeframe).toBe('W');
  expect(settings.getState().byWindow[next].chart?.candleLogScale).toBe(true);
});
