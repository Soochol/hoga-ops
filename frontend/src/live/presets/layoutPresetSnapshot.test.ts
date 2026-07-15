import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
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
  useLivePageStore.setState({
    paneOrder: [...CANON_PANES] as never,
    panePrefsByTimeframe: {},
    volumeEnabled: true,
    ratioEnabled: true,
    movingAverageEnabled: true,
    askPeakEnabled: false,
  });
});

describe('capturePresetPayload', () => {
  it('captures pane order, flags, and right-panel layout (not symbol/timeframe)', () => {
    useLivePageStore.setState({ paneOrder: ['candle', 'ratio', 'volume'] as never, ratioEnabled: false });
    useLiveLayoutStore.setState({ rightPanelWidthPx: 460, rightCardHidden: { program: true } });

    const payload = capturePresetPayload();
    expect(payload.pane_order.slice(0, 3)).toEqual(['candle', 'ratio', 'volume']);
    expect(payload.indicator_flags.ratioEnabled).toBe(false);
    expect(payload.indicator_flags.volumeEnabled).toBe(true);
    expect(payload.right_panel_width_px).toBe(460);
    expect(payload.right_card_hidden).toEqual({ program: true });
    // 종목/타임프레임/뷰포트 키는 존재하지 않는다.
    expect(payload).not.toHaveProperty('code');
    expect(payload).not.toHaveProperty('timeframe');
  });
});

describe('applyPresetPayload', () => {
  const basePayload = (over: Partial<LiveLayoutPresetPayload> = {}): LiveLayoutPresetPayload => ({
    pane_order: [...CANON_PANES],
    pane_prefs_by_timeframe: {},
    indicator_flags: {},
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

  it('overwrites both the flat pane flags and the timeframe pref map', () => {
    // stale flat: ratioEnabled=false 로 시작.
    useLivePageStore.setState({ ratioEnabled: false });
    applyPresetPayload(basePayload({
      indicator_flags: { ratioEnabled: true, volumeEnabled: false },
      pane_prefs_by_timeframe: { minute: { fillStrengthEnabled: false } },
    }), null);

    expect(useLivePageStore.getState().ratioEnabled).toBe(true); // flat 덮어씀
    expect(useLivePageStore.getState().volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().panePrefsByTimeframe).toEqual({
      minute: { fillStrengthEnabled: false },
    });
  });

  it('persists the applied state to both storage keys', () => {
    applyPresetPayload(basePayload({
      pane_order: ['candle', 'ratio', 'volume'],
      right_panel_width_px: 455,
    }), 'p2');

    const indicators = JSON.parse(localStorage.getItem('live.indicators.v1') ?? '{}');
    expect(indicators.paneOrder.slice(0, 3)).toEqual(['candle', 'ratio', 'volume']);

    const layout = JSON.parse(localStorage.getItem('live.layout.v1') ?? '{}');
    expect(layout.rightPanelWidthPx).toBe(455);
    expect(layout.lastAppliedPresetId).toBe('p2');
  });
});

describe('defaultPresetPayload', () => {
  it('produces canonical defaults for reset-to-default', () => {
    const payload = defaultPresetPayload();
    expect(payload.pane_order).toEqual(CANON_PANES);
    expect(payload.right_card_order).toEqual([...LIVE_CARD_KEYS]);
    expect(payload.right_card_hidden).toEqual({});
    expect(payload.right_card_weights).toEqual(DEFAULT_CARD_WEIGHTS);
    expect(payload.pane_prefs_by_timeframe).toEqual({});
  });
});
