import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'view-ref',
  name: '돌파 복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

const settings = {
  // 백엔드 `ordered_sources` 가 인식하는 실제 토큰. 예전 픽스처는 `'hogaplay_first'` 였는데
  // 그건 백엔드가 못 알아듣고 기본 사다리로 수렴시키는 값이라, 고정을 검증하던 단언이
  // **정반대 동작을 통과시키고 있었다**(2026-08-20).
  sourcePref: 'hogaplay' as const,
  venue: 'KRX' as const,
  askPeakEnabled: true,
  bidPeakEnabled: true,
  brokerLateEntryEnabled: true,
  brokerLateEntryStartHHMM: 1000,
  volumeDistributionEnabled: true,
  tradeVolumePocEnabled: true,
  depthHeatmapEnabled: true,
  volumeDistributionRangeCount: 12,
};

describe('studyReferenceQueryOptions', () => {
  it('builds disk candle (mode=candles, sourcePref 설정 추종) options for minute study views', () => {
    const options = studyReferenceQueryOptions(save, settings);

    expect(options.rangeHoga.enabled).toBe(true);
    expect(options.rangeHoga.queryKey[0]).toBe('range');
    expect(options.rangeHoga.queryKey[14]).toBe('hoga');
    expect(options.rangeSidecars.enabled).toBe(true);
    expect(options.rangeSidecars.queryKey[14]).toBe('sidecar');
    expect(options.rangeSidecars.queryKey).toContain(true);
    expect(options.rangeSidecars.queryKey).toContain(1000);
    // depth_heatmap 지표 활성 → sidecar 요청 queryKey에 반영(index 20, 토글 refetch).
    expect(options.rangeSidecars.queryKey[20]).toBe(true);
    // 캔들: mode=candles + sourcePref 설정 추종 + 저장 타임프레임(5m 버킷).
    expect(options.rangeCandles.enabled).toBe(true);
    expect(options.rangeCandles.queryKey[0]).toBe('range');
    expect(options.rangeCandles.queryKey[1]).toBe('005930');
    expect(options.rangeCandles.queryKey[2]).toBe('20260616');
    expect(options.rangeCandles.queryKey[3]).toBe('20260618');
    expect(options.rangeCandles.queryKey[4]).toBe(300_000);
    expect(options.rangeCandles.queryKey[13]).toBe('hogaplay');
    expect(options.rangeCandles.queryKey[14]).toBe('candles');
    // 스크리너 일봉은 분봉 저장에서 비활성.
    expect(options.screenerDaily.enabled).toBe(false);
  });

  // 이 두 테스트는 **뒤집힌 계약**이다(2026-08-20). 예전엔 "캔들은 store pref 와 무관하게
  // 'hogaplay_first' 고정" 을 지켰는데, 그 토큰을 백엔드가 인식하지 못해 고정이 실제로는
  // **kiwoom_live 우선**으로 동작했다. 지금은 캔들도 호가·사이드카와 같은 설정을 따른다.
  it('캔들 sourcePref 는 호가·사이드카와 같은 설정을 따른다 — 고정하지 않는다', () => {
    const options = studyReferenceQueryOptions(save, { ...settings, sourcePref: 'kiwoom_live' });

    expect(options.rangeHoga.queryKey[13]).toBe('kiwoom_live');
    expect(options.rangeCandles.queryKey[13]).toBe('kiwoom_live');
    // 세 쿼리가 한 축 위에 있어야 소스 배지가 말하는 것과 캔들이 일치한다.
    expect(options.rangeSidecars.queryKey[13]).toBe('kiwoom_live');
  });

  it('설정 로딩 중(sourcePref undefined)이면 캔들도 호가와 함께 비활성이다', () => {
    // 게이트가 캔들에만 빠지면 콜드 마운트마다 기본 pref 로 한 번 조회하고 곧바로
    // 설정 pref 로 다시 조회해 차트가 눈에 띄게 갈아끼워진다(`sourcePreference.ts` 주석).
    const options = studyReferenceQueryOptions(save, { ...settings, sourcePref: undefined });

    expect(options.rangeHoga.enabled).toBe(false);
    expect(options.rangeCandles.enabled).toBe(false);
  });

  it('requests no broker late-entry sidecars when the indicator is disabled', () => {
    const options = studyReferenceQueryOptions(save, {
      ...settings,
      brokerLateEntryEnabled: false,
    });

    expect(options.rangeSidecars.queryKey).toContain(false);
    expect(options.rangeSidecars.queryKey).not.toContain(1000);
  });

  it('캘린더 봉은 스크리너 일봉 **하나만** 요청한다 — 1분봉은 안 받는다', () => {
    const options = studyReferenceQueryOptions({ ...save, timeframe: 'D' }, settings);

    expect(options.rangeHoga.enabled).toBe(false);
    expect(options.rangeSidecars.enabled).toBe(false);
    // ⚠ 이 줄이 이 변경의 전부다. 예전에는 일봉 98개를 그리려고 1분봉 36,000개
    // (3.6MB)를 받아 프론트에서 접고 스크리너로 갭을 채웠다(hogaplay 우선).
    // 그 병합은 **주가 기준이 다른 두 소스를 섞는 것**이라 분할 종목에서 봉이
    // 1/5로 튀었다(`aggregateReferenceCandles` 주석).
    expect(options.rangeCandles.enabled).toBe(false);
    // 스크리너 일봉이 화면 전부다.
    expect(options.screenerDaily.enabled).toBe(true);
    expect(options.screenerDaily.queryKey).toEqual([
      'live', 'screener-daily-candles', '005930', '20260616', '20260618',
    ]);
  });

  // 아래 둘이 재는 것: **플래그를 빠뜨리지 않았는가.** 빠뜨리면 백엔드 `Query(True)`
  // 기본값이 먹어 꺼 둔 지표까지 계산·전송되는데, 그건 타입도 화면도 잡지 못하는
  // **침묵하는 낭비**다(실측: `depth_delta` 하나로 응답 55,272B → 26,258B).
  // 슬롯 인덱스는 `range.depthHeatmap.test.ts` 의 `queryKey[20]` 관례를 따른다 —
  // 그 파일이 같은 슬롯의 **wire 파라미터 이름**까지 못 박고 있어 둘이 짝을 이룬다.
  it('sidecar 요청은 단별 잔량 증감을 **끈다** — /study 는 그 지표를 그리지 않는다', () => {
    const key = studyReferenceQueryOptions(save, settings).rangeSidecars.queryKey;

    expect(key[21]).toBe(false);
  });

  // `bins` 를 null 로 두는 것만으로는 안 꺼진다 — 백엔드 게이트가 `enabled` 이고
  // bins 는 기본값으로 폴백한다. 그래서 **두 값을 함께** 본다.
  it('당일 최대 매물대는 enabled 플래그로 꺼야 실제로 안 계산된다', () => {
    const off = studyReferenceQueryOptions(
      save,
      { ...settings, tradeVolumePocEnabled: false },
    ).rangeSidecars.queryKey;

    expect(off[19]).toBe(false);
  });

  it('최대벽 플래그가 지표 설정을 따른다 — 꺼 두면 계산·전송이 안 나간다', () => {
    const on = studyReferenceQueryOptions(save, settings).rangeSidecars.queryKey;
    const off = studyReferenceQueryOptions(
      save,
      { ...settings, askPeakEnabled: false, bidPeakEnabled: false },
    ).rangeSidecars.queryKey;

    expect([on[16], on[17]]).toEqual([true, true]);
    expect([off[16], off[17]]).toEqual([false, false]);
    // 키가 갈려야 토글 직후 재fetch 가 난다 — 안 갈리면 꺼도 옛 응답을 계속 쓴다.
    expect(off).not.toEqual(on);
  });

  it('분봉 저장은 그대로 1분봉(디스크 캔들)을 받는다 — 이 변경은 캘린더 봉 전용', () => {
    const options = studyReferenceQueryOptions({ ...save, timeframe: '5m' }, settings);

    expect(options.rangeCandles.enabled).toBe(true);
    expect(options.rangeCandles.queryKey[13]).toBe('hogaplay');
    expect(options.rangeCandles.queryKey[14]).toBe('candles');
    expect(options.screenerDaily.enabled).toBe(false);
  });
});
