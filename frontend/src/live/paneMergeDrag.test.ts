import { describe, expect, it } from 'vitest';
import {
  boundaryDropLabel,
  classifyPaneDropTarget,
  fullBoundaryIndex,
  mergeDropHint,
  PANE_BOUNDARY_BAND_PX,
} from './paneMergeDrag';
import { paneGroupSpecsForTimeframe } from './paneGroupSpecs';
import { mergePaneIntoGroup, normalizePaneGroups } from '../chart/paneGroups';
import type { PaneToggles } from './paneSpecsForTimeframe';

const ALL_ON: PaneToggles = { foreignNet: true, institutionNet: true };

// 분봉 전체 게이트 통과: [candle][volume][quote-totals][ratio][fill-strength][program-trade]
const GROUPS = paneGroupSpecsForTimeframe('1m', ALL_ON, normalizePaneGroups(undefined));
// pane 6개, 각 100px: tops 0..500.
const TOPS = [0, 100, 200, 300, 400, 500];
const HEIGHTS = [100, 100, 100, 100, 100, 100];

const classify = (yPx: number, draggedPane: Parameters<typeof classifyPaneDropTarget>[0]['draggedPane']) =>
  classifyPaneDropTarget({ yPx, paneTops: TOPS, paneHeights: HEIGHTS, groups: GROUPS, draggedPane });

describe('classifyPaneDropTarget', () => {
  it('pane 본체 한가운데 = 그 pane 으로 병합', () => {
    expect(classify(250, 'volume')).toEqual({ kind: 'merge', targetPane: 'quote-totals', paneIndex: 2 });
  });

  it('candle 본체와 자기 pane 본체는 타겟이 아니다', () => {
    expect(classify(50, 'volume')).toBeNull();
    expect(classify(150, 'volume')).toBeNull();
  });

  it('경계 밴드 안 = 경계 드롭, candle 위 경계(0)는 없다', () => {
    // volume(1)/quote-totals(2) 사이 = 경계 2 (y=200). ratio 를 끌 때.
    expect(classify(200 + PANE_BOUNDARY_BAND_PX, 'ratio'))
      .toEqual({ kind: 'boundary', boundaryIndex: 2, yPx: 200 });
    // candle 상단(경계 0)은 후보에 없다 — y=0 근처는 candle 본체 → null.
    expect(classify(3, 'ratio')).toBeNull();
    // 맨 아래 경계 = n(6), y=600.
    expect(classify(600 - 2, 'ratio')).toEqual({ kind: 'boundary', boundaryIndex: 6, yPx: 600 });
  });

  it('싱글턴이 자기 위/아래 경계로 가는 무의미 이동은 타겟 없음', () => {
    // volume(idx1)의 위 경계 1(y=100)·아래 경계 2(y=200).
    expect(classify(100, 'volume')).toBeNull();
    expect(classify(200, 'volume')).toBeNull();
    // 남의 경계는 유효.
    expect(classify(300, 'volume')).toEqual({ kind: 'boundary', boundaryIndex: 3, yPx: 300 });
  });

  it('병합 그룹 멤버는 자기 pane 인접 경계도 유효(분리)', () => {
    const merged = paneGroupSpecsForTimeframe(
      '1m', ALL_ON, mergePaneIntoGroup(normalizePaneGroups(undefined), 'ratio', 'volume'),
    );
    // [candle][volume,ratio][quote-totals][fill-strength][program-trade] — 5 pane
    const tops = [0, 100, 200, 300, 400];
    const heights = [100, 100, 100, 100, 100];
    const out = classifyPaneDropTarget({
      yPx: 200, paneTops: tops, paneHeights: heights, groups: merged, draggedPane: 'ratio',
    });
    expect(out).toEqual({ kind: 'boundary', boundaryIndex: 2, yPx: 200 });
  });
});

describe('fullBoundaryIndex', () => {
  it('게이트로 안 보이는 그룹이 있어도 보이는 이웃 앞으로 매핑된다', () => {
    // 전체: [candle][volume][quote-totals][ratio][fill-strength][program-trade][inv-f][inv-i]
    const paneGroups = normalizePaneGroups(undefined);
    // D 뷰: 호가 3종 탈락 → 보이는 것 [candle][volume][investor-foreign][investor-institution]
    const dailyVisible = paneGroupSpecsForTimeframe('D', ALL_ON, paneGroups);
    expect(dailyVisible.map((g) => g[0].name))
      .toEqual(['candle', 'volume', 'investor-foreign', 'investor-institution']);
    // 보이는 경계 2 = investor-foreign 앞 = 전체 인덱스 6.
    expect(fullBoundaryIndex(paneGroups, dailyVisible, 2)).toBe(6);
    // 맨 아래 = 마지막 보이는 그룹 뒤 = 8.
    expect(fullBoundaryIndex(paneGroups, dailyVisible, 4)).toBe(8);
  });
});

describe('mergeDropHint', () => {
  it('외국인+기관 = 축 공유 예고', () => {
    const hint = mergeDropHint('investor-institution', ['investor-foreign']);
    expect(hint.title).toContain('기관 순매수량');
    expect(hint.hint).toContain('y축을 공유');
    expect(hint.warning).toBe(false);
  });

  it('단위가 달라도 병합은 되고 — 격리 스케일 예고', () => {
    const hint = mergeDropHint('program-trade', ['volume']);
    expect(hint.hint).toContain('각자 스케일');
    expect(hint.warning).toBe(false);
  });

  it('분봉 전용 + D 전용 조합은 게이트 경고', () => {
    const hint = mergeDropHint('ratio', ['investor-foreign']);
    expect(hint.hint).toContain('함께 표시되지 않습니다');
    expect(hint.warning).toBe(true);
  });

  it('거래량은 양쪽 게이트에 다 있어 어느 조합도 경고가 아니다', () => {
    expect(mergeDropHint('volume', ['investor-foreign']).warning).toBe(false);
    expect(mergeDropHint('volume', ['ratio']).warning).toBe(false);
  });

  it('을/를 받침 처리', () => {
    expect(mergeDropHint('volume', ['ratio']).title).toContain('『거래량』을');
    expect(mergeDropHint('ratio', ['volume']).title).toContain('『호가비』를');
  });
});

describe('boundaryDropLabel', () => {
  it('병합 그룹에서 끌면 「분리」, 싱글턴이면 「이동」', () => {
    expect(boundaryDropLabel(true)).toContain('분리');
    expect(boundaryDropLabel(false)).toContain('이동');
  });
});
