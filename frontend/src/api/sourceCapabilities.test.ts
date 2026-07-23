import { describe, expect, it } from 'vitest';
import {
  SOURCE_CAPABILITIES,
  SOURCE_PREFERENCE_OPTIONS,
  SOURCE_PREFERENCE_PRIMARY_SOURCE,
  getSourceCapability,
  getOrderflowSourcePreferenceLabel,
  getSourcePreferenceLabel,
} from './sourceCapabilities';

describe('sourceCapabilities', () => {
  it('defines UI capabilities for every read source', () => {
    expect(SOURCE_CAPABILITIES).toEqual({
      hogaplay: expect.objectContaining({ label: 'hogaplay', resolutionLabel: 'tick', cssTokenName: 'hogaplay' }),
      kis_live: expect.objectContaining({ label: 'KIS WS', resolutionLabel: '10s', cssTokenName: 'kis-live' }),
      kis_api: expect.objectContaining({ label: 'KIS API', resolutionLabel: '30s', cssTokenName: 'kis-api' }),
      // 리뷰 C2: 백엔드 SourceName에 kiwoom_live 추가 시 프론트 capability 누락이 SourceChip
      // 크래시로 이어졌다. 이 소스가 SOURCE_CAPABILITIES에 존재해야 한다.
      kiwoom_live: expect.objectContaining({ label: '키움 WS', resolutionLabel: 'tick', cssTokenName: 'kiwoom-live' }),
      screener_daily: expect.objectContaining({ label: '스크리너', resolutionLabel: '1D', cssTokenName: 'screener-daily' }),
    });
  });

  it('kiwoom_live가 capability를 가져 SourceChip이 크래시하지 않는다 (리뷰 C2 회귀)', () => {
    const cap = getSourceCapability('kiwoom_live');
    expect(cap.cssTokenName).toBe('kiwoom-live');
    expect(cap.label).toBe('키움 WS');
  });

  it('미지 소스 문자열은 폴백 capability를 반환한다 (백엔드 드리프트 방어)', () => {
    // 백엔드가 프론트 유니온 밖 소스를 보내도 undefined 접근 크래시 없이 폴백.
    const cap = getSourceCapability('some_future_broker' as never);
    expect(cap.cssTokenName).toBe('unknown');
    expect(cap.label).toBe('some_future_broker');
    expect(cap.resolutionLabel).toBe('');
  });

  it('keeps display preference options in backend policy order (kis_api_first 제거)', () => {
    // 2026-07-17 정책: 호가·체결은 KIS REST로 받지 않는다 — kis_api_first 옵션 폐지.
    expect(SOURCE_PREFERENCE_OPTIONS).toEqual([
      'hogaplay_first',
      'kis_ws_first',
      'completeness_first',
    ]);
    expect(SOURCE_PREFERENCE_PRIMARY_SOURCE).toEqual({
      hogaplay_first: 'hogaplay',
      kis_ws_first: 'kis_live',
      // 완결성 동급이면 WS 타이브레이크라 대표 소스도 kis_live.
      completeness_first: 'kis_live',
    });
  });

  it('derives orderflow labels', () => {
    // kis_api capability 자체는 유지(복구 캔들 배지/칩이 소스명을 표시).
    expect(getSourceCapability('kis_api').resolutionLabel).toBe('30s');
    expect(getOrderflowSourcePreferenceLabel('hogaplay_first')).toBe('hogaplay 우선');
    // 종목별 KIS·키움 자동 선택이라 'KIS WS 우선'이 아닌 '실시간 WS 우선'.
    expect(getOrderflowSourcePreferenceLabel('kis_ws_first')).toBe('실시간 WS 우선');
    expect(getSourcePreferenceLabel('kis_ws_first')).toBe('실시간 WS 우선');
    expect(getOrderflowSourcePreferenceLabel('completeness_first')).toBe('완결성 우선');
  });
});
