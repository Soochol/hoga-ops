import { describe, it, expect } from 'vitest';
import { CATEGORIES } from './IndicatorPanel';
import { PANE_DISPLAY_NAME } from '../../chart/paneOrder';
import type { PaneId } from '../../chart/drawing/types';

// pane 이름을 부르는 표가 둘이다 — 보조지표 패널의 `CATEGORIES` 와 차트 레전드의
// `PANE_DISPLAY_NAME`. 손 미러라 **값 드리프트는 타입이 원리적으로 못 잡는다**
// (#1183 이 그 사고였다: 라벨 표가 1년 가까이 스테일이었다). 여기서 대조한다.
//
// 카테고리 id 와 PaneId 는 대부분 같지만 투자자 pane 만 이름이 다르다. 캔들은 끌 수
// 없는 고정 pane 이라 패널에 항목이 없다 — 그래서 전수가 아니라 **겹치는 것만** 잰다.
const CATEGORY_TO_PANE: Record<string, PaneId> = {
  volume: 'volume',
  'quote-totals': 'quote-totals',
  ratio: 'ratio',
  'fill-strength': 'fill-strength',
  'program-trade': 'program-trade',
  'foreign-net': 'investor-foreign',
  'institution-net': 'investor-institution',
};

/**
 * 자체 nav 항목이 **의도적으로 없는** pane. 이 가드의 요구("pane 을 늘렸으면 설정
 * 항목도 만들어라")는 독립 지표에만 성립한다 — `peak-wall` 은 독립 지표가 아니라
 * 기존 「당일 최대벽」의 시간축 표현이라(구현 계획 §0), 설정도 그 지표의 페이지
 * (`PeakWallsConfig`) 안 토글로 들어간다. 새 nav 항목을 만들면 P1-8 이 매도·매수를
 * 한 항목으로 합친 결정을 되돌리는 셈이다.
 */
const DEPENDENT_PANES = new Set<PaneId>(['peak-wall']);

describe('pane 표시 이름 — 설정 패널 ↔ 차트 레전드', () => {
  it('겹치는 pane 의 라벨이 두 표에서 같다', () => {
    const pairs = CATEGORIES.filter((c) => CATEGORY_TO_PANE[c.id]).map((c) => ({
      id: c.id,
      panel: c.label,
      pane: PANE_DISPLAY_NAME[CATEGORY_TO_PANE[c.id]],
    }));
    // 매핑이 통째로 빗나가 0건을 대조하는 상태(그러면 어떤 드리프트도 통과한다)를 막는다.
    expect(pairs).toHaveLength(Object.keys(CATEGORY_TO_PANE).length);
    for (const p of pairs) expect(p.pane, `카테고리 ${p.id}`).toBe(p.panel);
  });

  it('캔들을 뺀 모든 pane 이 설정 패널에 대응 항목을 갖는다', () => {
    const covered = new Set(Object.values(CATEGORY_TO_PANE));
    const missing = (Object.keys(PANE_DISPLAY_NAME) as PaneId[]).filter(
      (id) => id !== 'candle' && !covered.has(id) && !DEPENDENT_PANES.has(id),
    );
    // PaneId 를 늘리면 tsc 가 `PANE_DISPLAY_NAME` 을 요구하지만, 위 매핑에 넣는 것까지는
    // 강제하지 못한다 — 빠뜨리면 그 pane 이 대조에서 조용히 빠지므로 여기서 막는다.
    expect(missing).toEqual([]);
  });
});
