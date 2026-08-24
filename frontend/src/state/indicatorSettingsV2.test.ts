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
import { WORKSPACE_STORAGE_KEY } from './workspaceKeys';

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

  it('paneGroups 없는 구 블롭은 paneOrder 의 싱글턴으로 파생한다', () => {
    const v2 = normalizeIndicatorsV2({ paneOrder: ['candle', 'ratio', 'volume'] });
    expect(v2.paneGroups.slice(0, 3)).toEqual([['candle'], ['ratio'], ['volume']]);
    // 투영 일관성: paneOrder = flatten(paneGroups).
    expect(v2.paneGroups.flat()).toEqual(v2.paneOrder);
  });

  it('paneGroups 가 있으면 그것이 원본 — 저장된 paneOrder 는 무시된다', () => {
    const v2 = normalizeIndicatorsV2({
      paneOrder: ['candle', 'volume', 'ratio'],       // groups 와 어긋난 스테일 값
      paneGroups: [['candle'], ['ratio', 'volume']],
    });
    expect(v2.paneGroups[1]).toEqual(['ratio', 'volume']);
    expect(v2.paneOrder.slice(0, 3)).toEqual(['candle', 'ratio', 'volume']);
    expect(v2.paneGroups.flat()).toEqual(v2.paneOrder);
  });

  it('paneGroups 왕복 — 병합 그룹이 저장/로드에서 보존된다', () => {
    const first = normalizeIndicatorsV2({
      paneGroups: [['candle'], ['investor-foreign', 'investor-institution'], ['volume']],
    });
    const roundtripped = normalizeIndicatorsV2(JSON.parse(JSON.stringify(first)));
    expect(roundtripped.paneGroups).toEqual(first.paneGroups);
    expect(roundtripped.paneOrder).toEqual(first.paneOrder);
  });

  it('paneAxisShare — 현재 그룹과 매칭되는 키만 왕복하고 스테일 키는 걷힌다', () => {
    const v2 = normalizeIndicatorsV2({
      paneGroups: [['candle'], ['volume', 'ratio']],
      paneAxisShare: {
        'ratio,volume': true,               // 살아있는 그룹(정렬 키) → 유지
        'fill-strength,quote-totals': true, // 없는 그룹 → 드롭
      },
    });
    expect(v2.paneAxisShare).toEqual({ 'ratio,volume': true });
    const roundtripped = normalizeIndicatorsV2(JSON.parse(JSON.stringify(v2)));
    expect(roundtripped.paneAxisShare).toEqual({ 'ratio,volume': true });
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
    // 창 사본 승격이 탭 저장소를 먼저 보므로 함께 비운다 — 안 그러면 앞 테스트가
    // 심은 워크스페이스가 뒤 테스트의 v2 를 덮는다.
    sessionStorage.clear();
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
    // 아무것도 만지지 않았으면 시드 영속도 없다(마이그레이션 마커는 별개 키).
    expect(localStorage.getItem(INDICATORS_V2_STORAGE_KEY)).toBeNull();
  });

  it('창 사본이 있으면 v2 보다 **먼저** 승격한다 — 순서가 바뀌면 설정이 회귀한다', () => {
    // 그동안 아무도 쓰지 않은 스테일 v2.
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {}, byTimeframe: { minute: { askPeakEnabled: true } },
    }));
    // 사용자가 실제로 보던 창 사본(#712 이후의 진실).
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      schema_version: 2,
      windows: [{
        id: 'w1', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.4, h: 0.9 },
        chart: {
          timeframe: '1m',
          indicators: { paneOrder: [], paneStretch: { volume: 4 }, byTimeframe: { minute: { bidPeakEnabled: true } } },
        },
      }],
      zOrder: ['w1'],
    }));

    const v2 = loadIndicatorsV2Storage();
    expect(v2.byTimeframe).toEqual({ minute: { bidPeakEnabled: true } });
    expect(v2.paneStretch).toMatchObject({ volume: 4 });
    // 승격 결과가 v2 로 즉시 영속돼야 다음 로드(마커가 선 뒤)에 살아남는다.
    const persisted = JSON.parse(localStorage.getItem(INDICATORS_V2_STORAGE_KEY) ?? 'null');
    expect(persisted?.byTimeframe).toEqual({ minute: { bidPeakEnabled: true } });
  });
});

describe('resolveIndicatorSettings — 참조 안정성', () => {
  it('같은 버킷이면 같은 객체를 준다(구독이 헛되이 깨지지 않게)', () => {
    const bucket = { askPeakEnabled: true };
    const a = resolveIndicatorSettings({ minute: bucket }, '1m');
    const b = resolveIndicatorSettings({ minute: bucket }, '5m'); // 같은 프로파일
    expect(a).toBe(b);
  });

  it('다른 봉 버킷만 바뀌면 이 봉의 참조는 그대로다', () => {
    const minute = { askPeakEnabled: true };
    const before = resolveIndicatorSettings({ minute }, '1m');
    // 세터가 만드는 모양: 맵은 새로, 손대지 않은 버킷 참조는 보존.
    const after = resolveIndicatorSettings({ minute, D: { ratioEnabled: true } }, '1m');
    expect(after).toBe(before);
  });

  it('버킷이 없으면 공장값 객체 자체를 준다', () => {
    expect(resolveIndicatorSettings({}, '1m')).toBe(FACTORY_INDICATOR_SETTINGS);
  });
});
