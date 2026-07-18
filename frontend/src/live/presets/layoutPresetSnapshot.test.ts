import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useLiveLayoutStore, DEFAULT_CARD_WEIGHTS, LIVE_CARD_KEYS } from '../../state/liveLayout';
import {
  applyPresetPayload,
  capturePresetPayload,
  defaultPresetPayload,
} from './layoutPresetSnapshot';
import type { LiveLayoutPresetPayload } from '../../api/liveLayoutPresets';

const CANON_PANES = [
  'candle', 'volume', 'quote-totals', 'ratio',
  'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
];

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  useLiveLayoutStore.setState({
    rightPanelWidthPx: 400,
    rightCardWeights: DEFAULT_CARD_WEIGHTS,
    rightCardOrder: [...LIVE_CARD_KEYS],
    rightCardHidden: {},
    rightCardCollapsed: {},
    detailPanelCollapsed: false,
    lastAppliedPresetId: null,
  });
  // 공장 상태에서 시작 — 투영·버킷·ambient 봉 일관(빈 버킷 ⊕ 공장값 = 투영).
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    paneOrder: [...CANON_PANES] as never,
    indicatorsByTimeframe: {},
    indicatorTimeframe: '1m',
  });
});

describe('capturePresetPayload', () => {
  it('captures pane order, per-bucket enables, and right-panel layout (not symbol/timeframe)', () => {
    // 현재 봉(1m)에서 ratio 끄고, D 버킷엔 volume 끄기 오버라이드를 심는다.
    useLivePageStore.getState().setRatioEnabled(false);            // minute 버킷
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'volumeEnabled', false);
    useLivePageStore.setState({ paneOrder: ['candle', 'ratio', 'volume'] as never });
    useLiveLayoutStore.setState({ rightPanelWidthPx: 460, rightCardHidden: { program: true } });

    const payload = capturePresetPayload();
    expect(payload.pane_order.slice(0, 3)).toEqual(['candle', 'ratio', 'volume']);
    // by_timeframe_enable = 각 버킷의 sparse enable 오버라이드(공장값 diff).
    expect(payload.by_timeframe_enable.minute).toEqual({ ratioEnabled: false });
    expect(payload.by_timeframe_enable.D).toEqual({ volumeEnabled: false });
    expect(payload.right_panel_width_px).toBe(460);
    expect(payload.right_card_hidden).toEqual({ program: true });
    // 종목/타임프레임/뷰포트 키는 존재하지 않는다.
    expect(payload).not.toHaveProperty('code');
    expect(payload).not.toHaveProperty('timeframe');
  });

  it('is timeframe-independent — capture from any ambient 봉 yields the same map', () => {
    useLivePageStore.getState().setRatioEnabled(false);            // minute 버킷
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'volumeEnabled', false);
    const fromMinute = capturePresetPayload().by_timeframe_enable;
    // ambient 를 D 로 옮겨도(투영이 바뀌어도) 버킷 원본에서 읽으므로 동일.
    useLivePageStore.getState().setIndicatorTimeframe('D');
    const fromDaily = capturePresetPayload().by_timeframe_enable;
    expect(fromDaily).toEqual(fromMinute);
  });
});

describe('applyPresetPayload', () => {
  const basePayload = (over: Partial<LiveLayoutPresetPayload> = {}): LiveLayoutPresetPayload => ({
    pane_order: [...CANON_PANES],
    by_timeframe_enable: {},
    right_panel_width_px: 420,
    right_card_order: [...LIVE_CARD_KEYS],
    right_card_hidden: {},
    right_card_collapsed: {},
    right_card_weights: { ...DEFAULT_CARD_WEIGHTS },
    ...over,
  });

  it('normalizes unknown pane/card keys and appends missing ones on apply', () => {
    applyPresetPayload(basePayload({
      pane_order: ['candle', 'brand-new-pane', 'ratio'],
      right_card_order: ['program', 'future-card', 'orderbook'],
    }), 'preset-1');

    // pane: unknown 드롭 + 누락 canonical append + candle 선두.
    expect(useLivePageStore.getState().paneOrder[0]).toBe('candle');
    expect(useLivePageStore.getState().paneOrder).not.toContain('brand-new-pane');
    expect(useLivePageStore.getState().paneOrder).toHaveLength(8);
    // card: unknown 드롭 + 누락 append.
    expect(useLiveLayoutStore.getState().rightCardOrder).toEqual([
      'program', 'orderbook', 'brokers', 'volumeDistribution', 'investor',
    ]);
    expect(useLiveLayoutStore.getState().lastAppliedPresetId).toBe('preset-1');
  });

  it('replaces each bucket enable overrides deterministically, preserving params', () => {
    // 기존 상태: minute 에 stale enable(askPeak on) + 파라미터(색) 오버라이드.
    useLivePageStore.getState().setAskPeakEnabled(true);
    useLivePageStore.getState().setAskPeakStyle({ color: '#123456' });
    applyPresetPayload(basePayload({
      by_timeframe_enable: { minute: { ratioEnabled: false }, D: { volumeEnabled: false } },
    }), null);

    const byTimeframe = useLivePageStore.getState().indicatorsByTimeframe;
    // enable 은 프리셋으로 통째 교체 — stale askPeakEnabled 오버라이드는 제거됨.
    expect(byTimeframe.minute?.askPeakEnabled).toBeUndefined();
    expect(byTimeframe.minute?.ratioEnabled).toBe(false);
    // 파라미터(색) 오버라이드는 프리셋 범위 밖이라 보존.
    expect(byTimeframe.minute?.askPeakColor).toBe('#123456');
    // 프리셋에 없는 봉의 enable 은 공장값 복귀(오버라이드 없음).
    expect(byTimeframe.D).toEqual({ volumeEnabled: false });
    expect(byTimeframe.W).toBeUndefined();
    // ambient(minute) 투영 반영.
    expect(useLivePageStore.getState().ratioEnabled).toBe(false);
    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
  });

  it('capture→apply is identity (PR-D 회귀: 캡처가 timeframe-무관)', () => {
    // 서로 다른 봉에 서로 다른 enable 을 심는다. overlay enable(askPeak)은
    // ambient 를 그 봉으로 옮겨 setter 로 기록한다(pane 세터는 pane 7종 전용).
    useLivePageStore.getState().setRatioEnabled(false);              // minute (ambient=1m)
    useLivePageStore.getState().setIndicatorTimeframe('D');
    useLivePageStore.getState().setVolumeEnabled(false);             // D pane
    useLivePageStore.getState().setAskPeakEnabled(true);             // D overlay
    useLivePageStore.getState().setIndicatorTimeframe('1m');
    const snapshot = JSON.parse(JSON.stringify(useLivePageStore.getState().indicatorsByTimeframe));

    const payload = capturePresetPayload();
    // 다른 상태로 흩뜨린 뒤 되적용해도 원상 복구되는지.
    useLivePageStore.getState().resetIndicators();
    useLivePageStore.getState().setIndicatorTimeframe('W');
    useLivePageStore.getState().setVolumeEnabled(false);
    useLivePageStore.getState().setIndicatorTimeframe('1m');
    applyPresetPayload(payload, null);

    expect(useLivePageStore.getState().indicatorsByTimeframe).toEqual(snapshot);
  });

  it('persists the applied state to both storage keys', () => {
    applyPresetPayload(basePayload({
      pane_order: ['candle', 'ratio', 'volume'],
      right_panel_width_px: 455,
    }), 'p2');

    const indicators = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    expect(indicators.paneOrder.slice(0, 3)).toEqual(['candle', 'ratio', 'volume']);

    const layout = JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}');
    expect(layout.rightPanelWidthPx).toBe(455);
    expect(layout.lastAppliedPresetId).toBe('p2');
  });
});

describe('defaultPresetPayload', () => {
  it('produces canonical defaults for reset-to-default (empty enable map = 공장값)', () => {
    const payload = defaultPresetPayload();
    expect(payload.pane_order).toEqual(CANON_PANES);
    expect(payload.right_card_order).toEqual([...LIVE_CARD_KEYS]);
    expect(payload.right_card_hidden).toEqual({});
    expect(payload.right_card_weights).toEqual(DEFAULT_CARD_WEIGHTS);
    expect(payload.by_timeframe_enable).toEqual({});
  });
});
