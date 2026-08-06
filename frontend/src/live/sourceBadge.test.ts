import { describe, expect, it } from 'vitest';
import { deriveSourceBadge } from './sourceBadge';
import type { RangeSegment } from '../api/types';

const seg = (date: string, source?: string): RangeSegment => ({
  date,
  session_open_ms: 1,
  session_close_ms: 2,
  ...(source ? { source: source as RangeSegment['source'] } : {}),
});

describe('deriveSourceBadge', () => {
  it('기본 소스만이면 침묵한다 — 항상 띄우면 정보가 아니라 배경이 된다', () => {
    expect(deriveSourceBadge([seg('20260806', 'kiwoom_live')])).toBeNull();
    expect(deriveSourceBadge([seg('1', 'kiwoom_live'), seg('2', 'kiwoom_live')])).toBeNull();
  });

  it('세그먼트가 없으면 말할 것이 없다', () => {
    expect(deriveSourceBadge([])).toBeNull();
    expect(deriveSourceBadge(undefined)).toBeNull();
  });

  it('기본이 아닌 소스를 알린다', () => {
    expect(deriveSourceBadge([seg('20260701', 'hogaplay')])).toBe('hogaplay');
  });

  it('섞이면 기본이 아닌 것만 나열한다 — 팬으로 과거가 붙는 흔한 경우', () => {
    // 전부 나열하면 줄이 길어져 차트를 가린다. 눈여겨볼 대상은 기본이 아닌 쪽이다.
    const badge = deriveSourceBadge([
      seg('20260701', 'hogaplay'),
      seg('20260806', 'kiwoom_live'),
    ]);
    expect(badge).toBe('hogaplay');
  });

  it('같은 소스가 여러 날 있어도 한 번만 나온다', () => {
    expect(deriveSourceBadge([seg('1', 'hogaplay'), seg('2', 'hogaplay')])).toBe('hogaplay');
  });

  // ⚠ 이 폴백이 없으면 백엔드 SourceName 드리프트가 `undefined.label` 크래시가 되고,
  // 그 크래시가 차트 전체를 언마운트시킨 전례가 있다(리뷰 C2 · #975 주석).
  it('모르는 소스도 크래시하지 않고 원문을 보여준다', () => {
    expect(deriveSourceBadge([seg('1', 'brand_new_source')])).toBe('brand_new_source');
  });

  it('source 가 없는 구버전 세그먼트는 무시한다', () => {
    expect(deriveSourceBadge([seg('1')])).toBeNull();
  });
});
