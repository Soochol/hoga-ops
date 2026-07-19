import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  __resetGroupChartLinksForTests,
  clearGroupChartLink,
  publishGroupChartLink,
  useGroupChartLink,
  type GroupChartLink,
} from './groupChartLinkSource';

function link(windowId: string, group: number): GroupChartLink {
  return {
    windowId,
    group,
    code: '005930',
    timeframe: '1m',
    bundle: null,
    todayKst: '20260720',
    vdist: { rangeCount: 10, color: '#64748B', maxColor: '#EAB308', hoverCutoffEnabled: false },
  };
}

describe('groupChartLinkSource — 그룹 차트 링크 발행 채널 (ADR-0119 PR-D)', () => {
  beforeEach(() => {
    __resetGroupChartLinksForTests();
  });

  it('발행 → 같은 그룹 구독자만 본다 (다른 그룹·null 그룹은 null)', () => {
    const g1 = renderHook(() => useGroupChartLink(1));
    const g2 = renderHook(() => useGroupChartLink(2));
    const gn = renderHook(() => useGroupChartLink(null));
    act(() => publishGroupChartLink(link('w1', 1)));
    expect(g1.result.current?.windowId).toBe('w1');
    expect(g2.result.current).toBeNull();
    expect(gn.result.current).toBeNull();
  });

  it('그룹별 발행은 독립 — 그룹 2 발행이 그룹 1 을 덮지 않는다', () => {
    const g1 = renderHook(() => useGroupChartLink(1));
    act(() => publishGroupChartLink(link('w1', 1)));
    act(() => publishGroupChartLink(link('w2', 2)));
    expect(g1.result.current?.windowId).toBe('w1');
  });

  it('clear 는 자기 발행일 때만 걷는다 — 게이트 교체 직후 이전 창 cleanup 무해', () => {
    const g1 = renderHook(() => useGroupChartLink(1));
    act(() => publishGroupChartLink(link('w1', 1)));
    act(() => publishGroupChartLink(link('w2', 1))); // 게이트 이동: w2 가 교체 발행
    act(() => clearGroupChartLink(1, 'w1')); // w1 의 늦은 cleanup
    expect(g1.result.current?.windowId).toBe('w2');
    act(() => clearGroupChartLink(1, 'w2'));
    expect(g1.result.current).toBeNull();
  });
});
