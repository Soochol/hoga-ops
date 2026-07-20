import { describe, it, expect, beforeEach } from 'vitest';
import {
  FACTORY_INDICATOR_SETTINGS,
  diffIndicatorSettingsFromFactory,
  loadIndicatorsV2Storage,
  normalizeIndicatorsV2,
  resolveIndicatorSettings,
  seedV2FromV1,
  INDICATORS_V2_STORAGE_KEY,
} from './indicatorSettingsV2';
import { DEFAULT_LIVE_MAS } from './liveIndicatorsPersistence';
import { CANONICAL_PANE_ORDER } from '../chart/paneOrder';

const DEFAULT_PANE_ORDER = [...CANONICAL_PANE_ORDER];

const V1_KEY = 'live.indicators.v1';

describe('FACTORY_INDICATOR_SETTINGS', () => {
  it('turns on only volume + moving averages (#697 보충 정정)', () => {
    const f = FACTORY_INDICATOR_SETTINGS;
    expect(f.volumeEnabled).toBe(true);
    expect(f.movingAverageEnabled).toBe(true);
    expect(f.movingAverages).toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
    // 나머지 마스터 토글은 전부 off.
    expect(f.quoteTotalsEnabled).toBe(false);
    expect(f.ratioEnabled).toBe(false);
    expect(f.fillStrengthEnabled).toBe(false);
    expect(f.programTradeEnabled).toBe(false);
    expect(f.tradeVolumePocEnabled).toBe(false);
    expect(f.volumeDistributionEnabled).toBe(false);
    expect(f.askPeakEnabled).toBe(false);
    expect(f.bidPeakEnabled).toBe(false);
    expect(f.depthHeatmapEnabled).toBe(false);
    expect(f.depthDeltaEnabled).toBe(false);
    expect(f.brokerLateEntryEnabled).toBe(false);
    expect(f.dailyMovingAverageEnabled).toBe(false);
    expect(f.foreignNetEnabled).toBe(false);
    expect(f.institutionNetEnabled).toBe(false);
    // 하위 파라미터 기본값은 유지 — 켜는 순간 기존 기본 구성이 나온다.
    expect(f.askPeakColor).toBe('#1D4ED8');
    expect(f.tradeVolumePocBandPct).toBe(0.005);
    expect(f.volumeDistributionRangeCount).toBe(10);
  });

  it('has no per-timeframe or layout fields', () => {
    expect('panePrefsByTimeframe' in FACTORY_INDICATOR_SETTINGS).toBe(false);
    expect('paneOrder' in FACTORY_INDICATOR_SETTINGS).toBe(false);
  });
});

describe('resolveIndicatorSettings', () => {
  it('returns factory settings for any timeframe when byTimeframe is empty', () => {
    expect(resolveIndicatorSettings({}, '5m')).toEqual(FACTORY_INDICATOR_SETTINGS);
    expect(resolveIndicatorSettings({}, 'D')).toEqual(FACTORY_INDICATOR_SETTINGS);
  });

  it('applies only the matching bucket (1m~30m share the minute bucket)', () => {
    const byTimeframe = {
      minute: { askPeakEnabled: true },
      D: { quoteTotalsEnabled: true, movingAverageEnabled: false },
    };
    expect(resolveIndicatorSettings(byTimeframe, '1m').askPeakEnabled).toBe(true);
    expect(resolveIndicatorSettings(byTimeframe, '30m').askPeakEnabled).toBe(true);
    expect(resolveIndicatorSettings(byTimeframe, '1m').quoteTotalsEnabled).toBe(false);
    expect(resolveIndicatorSettings(byTimeframe, 'D').quoteTotalsEnabled).toBe(true);
    expect(resolveIndicatorSettings(byTimeframe, 'D').movingAverageEnabled).toBe(false);
    expect(resolveIndicatorSettings(byTimeframe, 'W')).toEqual(FACTORY_INDICATOR_SETTINGS);
  });
});

describe('diffIndicatorSettingsFromFactory', () => {
  it('keeps only fields that differ from factory (arrays by deep equality)', () => {
    const diff = diffIndicatorSettingsFromFactory({
      ...FACTORY_INDICATOR_SETTINGS,
      askPeakEnabled: true,
      askPeakColor: '#123456',
      movingAverages: [{ id: 'ma-1', enabled: true, period: 7, color: '#EC4899', lineWidth: 1, source: 'close' }],
    });
    expect(diff).toEqual({
      askPeakEnabled: true,
      askPeakColor: '#123456',
      movingAverages: [{ id: 'ma-1', enabled: true, period: 7, color: '#EC4899', lineWidth: 1, source: 'close' }],
    });
  });

  it('returns an empty object for factory settings', () => {
    expect(diffIndicatorSettingsFromFactory({ ...FACTORY_INDICATOR_SETTINGS })).toEqual({});
  });
});

describe('normalizeIndicatorsV2', () => {
  it('returns empty state for garbage input', () => {
    for (const raw of [undefined, null, 42, 'x', [], { byTimeframe: 7 }]) {
      const v2 = normalizeIndicatorsV2(raw);
      expect(v2.byTimeframe).toEqual({});
      expect(v2.paneOrder).toEqual(DEFAULT_PANE_ORDER);
    }
  });

  it('keeps valid overrides, drops invalid values / unknown keys / factory-equal entries', () => {
    const v2 = normalizeIndicatorsV2({
      paneOrder: ['volume', 'candle'],
      byTimeframe: {
        D: {
          askPeakEnabled: true,
          askPeakColor: 'not-a-color',        // invalid → drop
          volumeEnabled: true,                 // factory와 동일 → drop (sparse=diff 정의)
          unknownField: 123,                   // unknown → drop
        },
        minute: { tradeVolumePocEnabled: true },
        bogus: { askPeakEnabled: true },       // unknown profile → drop
      },
    });
    expect(v2.byTimeframe).toEqual({
      D: { askPeakEnabled: true },
      minute: { tradeVolumePocEnabled: true },
    });
    // candle은 항상 index 0으로 정규화(ADR-0114 §3).
    expect(v2.paneOrder[0]).toBe('candle');
  });

  it('drops type-mismatched garbage instead of promoting it to a v1-default override', () => {
    // 코어서의 boolean 폴백(quoteTotalsEnabled → v1 기본 true)이 새 공장값(false)과
    // 달라도, 타입 불일치 쓰레기는 오버라이드로 승격되지 않아야 한다(코드 리뷰).
    const v2 = normalizeIndicatorsV2({
      byTimeframe: {
        D: { quoteTotalsEnabled: 'garbage', fillStrengthEnabled: 1 },
      },
    });
    expect(v2.byTimeframe).toEqual({});
  });
});

describe('seedV2FromV1', () => {
  it('seeds the minute bucket with the v1 minute view diffed against the new factory', () => {
    const v2 = seedV2FromV1({
      movingAverages: [
        { id: 'ma-1', enabled: true, period: 9, color: '#EC4899', lineWidth: 2, source: 'close' },
      ],
      askPeakEnabled: true,
      panePrefsByTimeframe: {
        minute: { ratioEnabled: false },
        D: { volumeEnabled: false },          // D/W/M 오버라이드는 폐기(#697 변경)
      },
      paneOrder: ['volume', 'candle'],
    });
    const minute = v2.byTimeframe.minute ?? {};
    // 직접 커스텀한 값.
    expect(minute.movingAverages).toEqual([
      { id: 'ma-1', enabled: true, period: 9, color: '#EC4899', lineWidth: 2, source: 'close' },
    ]);
    expect(minute.askPeakEnabled).toBe(true);
    // 구 기본값 TRUE였던 pane들은 새 공장값 FALSE와 달라 diff에 포함 → 분봉 외양 무변화.
    expect(minute.quoteTotalsEnabled).toBe(true);
    expect(minute.fillStrengthEnabled).toBe(true);
    expect(minute.programTradeEnabled).toBe(true);
    expect(minute.tradeVolumePocEnabled).toBe(true);
    expect(minute.volumeDistributionEnabled).toBe(true);
    // 구 minute pane 오버라이드(ratio off)는 시드에 반영, factory도 off라 diff에서 빠짐.
    expect(minute.ratioEnabled).toBeUndefined();
    // D/W/M 버킷은 시드 없음.
    expect(v2.byTimeframe.D).toBeUndefined();
    expect(v2.byTimeframe.W).toBeUndefined();
    expect(v2.byTimeframe.M).toBeUndefined();
    // paneOrder는 이관(정규화 포함).
    expect(v2.paneOrder[0]).toBe('candle');
    expect(v2.paneOrder).toContain('volume');
  });

  it('seeds nothing beyond old-default drift for a pristine v1 blob', () => {
    const v2 = seedV2FromV1({});
    // v1 공장 상태와 새 공장값의 차이 = 구 기본값 TRUE였던 5개 pane/지표뿐.
    expect(v2.byTimeframe.minute).toEqual({
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      programTradeEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
    });
  });
});

describe('loadIndicatorsV2Storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads the v2 key when present (v1 ignored)', () => {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      byTimeframe: { D: { askPeakEnabled: true } },
      paneOrder: DEFAULT_PANE_ORDER,
    }));
    localStorage.setItem(V1_KEY, JSON.stringify({ bidPeakEnabled: true }));
    const v2 = loadIndicatorsV2Storage();
    expect(v2.byTimeframe).toEqual({ D: { askPeakEnabled: true } });
  });

  it('seeds from v1 once when v2 is absent, and persists the seed', () => {
    localStorage.setItem(V1_KEY, JSON.stringify({ askPeakEnabled: true }));
    const v2 = loadIndicatorsV2Storage();
    expect(v2.byTimeframe.minute?.askPeakEnabled).toBe(true);
    // 시드 결과가 v2 키로 영속돼 다음 로드부터는 v1을 보지 않는다.
    const persisted = JSON.parse(localStorage.getItem(INDICATORS_V2_STORAGE_KEY) ?? 'null');
    expect(persisted?.byTimeframe?.minute?.askPeakEnabled).toBe(true);
  });

  it('starts factory-clean when neither key exists', () => {
    const v2 = loadIndicatorsV2Storage();
    expect(v2.byTimeframe).toEqual({});
    expect(v2.paneOrder).toEqual(DEFAULT_PANE_ORDER);
    // 아무것도 만지지 않았으면 시드 영속도 없다.
    expect(localStorage.getItem(INDICATORS_V2_STORAGE_KEY)).toBeNull();
  });
});
