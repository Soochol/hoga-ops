import { describe, it, expect } from 'vitest';
import { hogaCoverageGapDates, hogaCoverageGapTitle } from './hogaCoverageGap';
import type { RangeSegment } from '../api/types';

function seg(date: string): RangeSegment {
  return { date, session_open_ms: 0, session_close_ms: 1, source: 'kis_live' };
}

describe('hogaCoverageGapDates', () => {
  const TODAY = '20260708';

  it('캔들에는 있고 hoga에는 없는 과거 날짜만 반환한다', () => {
    const chart = [seg('20260702'), seg('20260703'), seg('20260707'), seg(TODAY)];
    const hoga = [seg('20260707'), seg(TODAY)];
    expect(hogaCoverageGapDates(chart, hoga, TODAY)).toEqual(['20260702', '20260703']);
  });

  it('오늘은 hoga 세그먼트가 없어도 갭에서 제외한다 (CollectionDot 소관)', () => {
    const chart = [seg('20260707'), seg(TODAY)];
    const hoga = [seg('20260707')];
    expect(hogaCoverageGapDates(chart, hoga, TODAY)).toEqual([]);
  });

  it('hoga 번들 미로드(null/undefined) 시 판정을 유보하고 빈 배열을 반환한다', () => {
    const chart = [seg('20260702'), seg(TODAY)];
    expect(hogaCoverageGapDates(chart, null, TODAY)).toEqual([]);
    expect(hogaCoverageGapDates(chart, undefined, TODAY)).toEqual([]);
  });

  it('hoga 번들이 로드됐지만 세그먼트가 0개면 모든 과거 캔들 날짜가 갭이다', () => {
    const chart = [seg('20260702'), seg('20260703'), seg(TODAY)];
    expect(hogaCoverageGapDates(chart, [], TODAY)).toEqual(['20260702', '20260703']);
  });

  it('전 날짜 커버 시 빈 배열', () => {
    const chart = [seg('20260702'), seg(TODAY)];
    const hoga = [seg('20260702'), seg(TODAY)];
    expect(hogaCoverageGapDates(chart, hoga, TODAY)).toEqual([]);
  });

  it('결과는 날짜 오름차순', () => {
    const chart = [seg('20260707'), seg('20260702'), seg(TODAY)];
    expect(hogaCoverageGapDates(chart, [], TODAY)).toEqual(['20260702', '20260707']);
  });
});

describe('hogaCoverageGapTitle', () => {
  it('빈 목록은 빈 문자열', () => {
    expect(hogaCoverageGapTitle([])).toBe('');
  });

  it('6일 이하는 날짜를 나열한다', () => {
    expect(hogaCoverageGapTitle(['20260702', '20260703'])).toContain('07/02·07/03');
  });

  it('7일 이상은 범위로 압축한다', () => {
    const dates = ['20260626', '20260629', '20260630', '20260701', '20260702', '20260703', '20260706'];
    const title = hogaCoverageGapTitle(dates);
    expect(title).toContain('06/26–07/06 7일');
    expect(title).not.toContain('06/29·');
  });
});
