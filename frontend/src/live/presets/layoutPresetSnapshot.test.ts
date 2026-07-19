import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../state/workspace';
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
  // 멀티창 플립(C2c-2d): 차트 창이 있으면 캡처/적용이 포커스 창을 향한다.
  // 이 스위트의 기존 케이스는 전역 폴백 계약을 검증하므로 창을 비운다(차트 창
  // 없음 → 전역). 포커스 창 계약은 아래 전용 케이스가 검증한다.
  useWorkspaceStore.setState({ windows: [], zOrder: [], groupSymbols: {}, chartRuntime: {} });
  // 공장 상태에서 시작 — 투영·버킷·ambient 봉 일관(빈 버킷 ⊕ 공장값 = 투영).
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    paneOrder: [...CANON_PANES] as never,
    paneStretch: {},
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

    useLivePageStore.setState({ paneStretch: { candle: 2.2, volume: 0.2 } });

    const payload = capturePresetPayload();
    expect(payload.pane_order.slice(0, 3)).toEqual(['candle', 'ratio', 'volume']);
    expect(payload.pane_stretch).toEqual({ candle: 2.2, volume: 0.2 });
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

  it('applies pane_stretch and resets it when the field is absent (legacy preset)', () => {
    applyPresetPayload(basePayload({ pane_stretch: { candle: 2.2, 'not-a-pane': 3 } }), null);
    expect(useLivePageStore.getState().paneStretch).toEqual({ candle: 2.2 });

    // 필드 도입 전 저장된 프리셋(pane_stretch 부재) 적용 = 스펙 기본 크기로 리셋.
    applyPresetPayload(basePayload(), null);
    expect(useLivePageStore.getState().paneStretch).toEqual({});
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
    expect(payload.pane_stretch).toEqual({});
  });
});


describe('멀티창(C2c-2d) — 포커스 차트 창 스코프', () => {
  const WIN = 'preset-win';
  beforeEach(() => {
    useWorkspaceStore.setState({
      windows: [{
        id: WIN,
        kind: 'chart',
        group: 1,
        rect: { x: 0, y: 0, w: 600, h: 400 },
        chart: {
          timeframe: '1m',
          indicators: { paneOrder: [], paneStretch: {}, byTimeframe: { minute: { ratioEnabled: true } } },
        },
      }],
      zOrder: [WIN],
      groupSymbols: {},
      chartRuntime: {},
    });
  });

  it('capture 는 포커스 창의 버킷을, apply 는 포커스 창에 쓴다 — 전역 불침', () => {
    const captured = capturePresetPayload();
    expect(captured.by_timeframe_enable).toMatchObject({ minute: { ratioEnabled: true } });

    applyPresetPayload({
      ...defaultPresetPayload(),
      by_timeframe_enable: { minute: { volumeEnabled: false } },
    }, null);
    const win = useWorkspaceStore.getState().windows[0];
    expect(win.chart?.indicators.byTimeframe.minute?.volumeEnabled).toBe(false);
    // 전역 스토어 버킷은 건드리지 않는다(#712 창 소유).
    expect(useLivePageStore.getState().indicatorsByTimeframe).toEqual({});
  });
});
