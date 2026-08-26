import { describe, it, expect } from 'vitest';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import { dotColorsFor, INDICATOR_DOT_LIMIT } from './indicatorDotColors';
import { CATEGORIES } from './IndicatorPanel';

const base = (patch: Partial<IndicatorSettings> = {}): IndicatorSettings => ({
  ...FACTORY_INDICATOR_SETTINGS,
  ...patch,
});

describe('dotColorsFor', () => {
  it('이동평균은 켜진 슬롯의 색만, 그 순서대로 준다', () => {
    const ind = base({
      movingAverages: [
        { id: 'a', enabled: true, period: 5, color: '#111111', lineWidth: 1, source: 'close' },
        { id: 'b', enabled: false, period: 20, color: '#222222', lineWidth: 1, source: 'close' },
        { id: 'c', enabled: true, period: 60, color: '#333333', lineWidth: 1, source: 'close' },
      ],
    });
    expect(dotColorsFor('moving-average', ind)).toEqual(['#111111', '#333333']);
  });

  it('점 개수를 캡한다 — 240px nav 에서 라벨을 밀어내지 않게', () => {
    const ind = base({
      movingAverages: Array.from({ length: 8 }, (_, i) => ({
        id: `ma-${i}`, enabled: true, period: 5 + i, color: '#123456', lineWidth: 1 as const, source: 'close' as const,
      })),
    });
    expect(dotColorsFor('moving-average', ind)).toHaveLength(INDICATOR_DOT_LIMIT);
  });

  // 방향 마스터가 꺼져 있으면 그 방향은 아무것도 안 그려진다 — 계열 토글이 켜져
  // 있어도 색을 세면 안 된다. 이 분기가 없으면 꺼 둔 방향의 색이 행에 남는다.
  it('최대벽은 방향 마스터가 켜진 쪽의, 켜진 계열 색만 센다', () => {
    const both = base({
      askPeakEnabled: true,
      bidPeakEnabled: true,
      askPeakTradedLineEnabled: true,
      askPeakUnreachedLineEnabled: false,
      askPeakAllWallLineEnabled: false,
      bidPeakTradedLineEnabled: true,
      bidPeakUnreachedLineEnabled: false,
      bidPeakAllWallLineEnabled: false,
    });
    expect(dotColorsFor('peak-walls', both)).toEqual([both.askPeakColor, both.bidPeakColor]);

    const askOnly = base({ ...both, bidPeakEnabled: false });
    expect(dotColorsFor('peak-walls', askOnly)).toEqual([both.askPeakColor]);
  });

  it('거래원 세트는 sideMode 가 실제로 그리는 쪽의 색만 준다', () => {
    const entry = FACTORY_INDICATOR_SETTINGS.brokerLateEntries[0];
    const buyOnly = base({
      brokerLateEntries: [{ ...entry, enabled: true, sideMode: 'buy' }],
    });
    expect(dotColorsFor('broker-late-entry', buyOnly)).toEqual([entry.buyColor]);

    const both = base({
      brokerLateEntries: [{ ...entry, enabled: true, sideMode: 'both' }],
    });
    expect(dotColorsFor('broker-late-entry', both)).toEqual([entry.buyColor, entry.sellColor]);
  });

  // 사용자가 고르는 색이 없는 지표는 **점이 없는 것이 정답**이다 — 지어낸 색은
  // 차트와 어긋나는 순간 거짓말이 된다.
  it('사용자 색이 없는 일곱 지표는 점을 갖지 않는다', () => {
    const ind = base();
    for (const id of [
      'volume', 'quote-totals', 'ratio', 'fill-strength',
      'program-trade', 'foreign-net', 'institution-net',
    ] as const) {
      expect(dotColorsFor(id, ind)).toEqual([]);
    }
  });

  // 카테고리가 늘어날 때 이 표를 같이 보게 하는 총계 가드. 색이 있는 쪽/없는 쪽
  // 어느 편에 넣을지는 판단이지만, **판단했다는 사실**은 여기서 강제된다.
  it('14종 전부가 색 축에서 한쪽에 속한다', () => {
    const ind = base();
    const withDots = CATEGORIES.filter((c) => dotColorsFor(c.id, ind).length > 0);
    const withoutDots = CATEGORIES.filter((c) => dotColorsFor(c.id, ind).length === 0);
    expect(withDots.length + withoutDots.length).toBe(14);
  });
});
