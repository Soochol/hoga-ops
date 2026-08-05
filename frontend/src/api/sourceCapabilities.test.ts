import { describe, expect, it } from 'vitest';
import {
  SOURCE_CAPABILITIES,
  SOURCE_PREFERENCE_OPTIONS,
  SOURCE_PREFERENCE_PRIMARY_SOURCE,
  getOrderflowSourcePreferenceLabel,
  getSourcePreferenceLabel,
} from './sourceCapabilities';

describe('sourceCapabilities', () => {
  it('defines a display label for every read source', () => {
    // 리뷰 C2: 백엔드 SourceName에 kiwoom_live 추가 시 프론트 표기 누락이 렌더 크래시로
    // 이어졌다. `Record<SourceName, _>` 가 컴파일 타임에 전수를 강제하고, 이 단언이
    // 라벨 문구까지 고정한다.
    //
    // `kis_live` 는 빠졌다 — ADR-0118 이 KIS WS 계층을 삭제했고 잔존 데이터도
    // `_archive/kis_live/` 로 이관됐다. `kis_api` 는 **유지**된다: 이름은 KIS 지만
    // 생산자는 이미 키움이고(ADR-0109 복구 캔들, #1046 칼 컷오버) 경로가 동결이다.
    expect(SOURCE_CAPABILITIES).toEqual({
      hogaplay: expect.objectContaining({ label: 'hogaplay' }),
      kiwoom_live: expect.objectContaining({ label: '키움 WS' }),
      kis_api: expect.objectContaining({ label: 'KIS API' }),
      screener_daily: expect.objectContaining({ label: '스크리너' }),
    });
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
      kis_ws_first: 'kiwoom_live',
      // 완결성 동급이면 WS 타이브레이크라 대표 소스도 kiwoom_live.
      completeness_first: 'kiwoom_live',
    });
  });

  it('derives orderflow labels', () => {
    expect(getOrderflowSourcePreferenceLabel('hogaplay_first')).toBe('hogaplay 우선');
    // 종목별 KIS·키움 자동 선택이라 'KIS WS 우선'이 아닌 '실시간 WS 우선'.
    expect(getOrderflowSourcePreferenceLabel('kis_ws_first')).toBe('실시간 WS 우선');
    expect(getSourcePreferenceLabel('kis_ws_first')).toBe('실시간 WS 우선');
    expect(getOrderflowSourcePreferenceLabel('completeness_first')).toBe('완결성 우선');
  });
});
