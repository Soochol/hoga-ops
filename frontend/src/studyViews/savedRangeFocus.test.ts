import { describe, expect, it } from 'vitest';
import { savedRangeAppliesTo } from './savedRangeFocus';
import type { SavedRangeFocus } from '../state/livePage';

const focus = (extra: Partial<SavedRangeFocus> = {}): SavedRangeFocus => ({
  viewId: 'v1', code: '005930', label: '삼성전자',
  fromMs: 1, toMs: 2, fromDate: '20240301', toDate: '20240305',
  savedTimeframe: 'D', savedBarSpan: 40, ...extra,
});

describe('savedRangeAppliesTo — freeze · venue 고정 · 기간 칩이 공유하는 술어', () => {
  it('슬롯이 없거나 다른 종목이면 대상이 아니다', () => {
    expect(savedRangeAppliesTo(null, '005930', 'D')).toBe(false);
    expect(savedRangeAppliesTo(focus(), '000660', 'D')).toBe(false);
  });

  it('저장뷰 구간은 분봉에서도 산다 — 「일봉 밴드와 분봉 벽은 같은 슬롯의 두 표현」', () => {
    expect(savedRangeAppliesTo(focus(), '005930', 'D')).toBe(true);
    expect(savedRangeAppliesTo(focus(), '005930', '1m')).toBe(true);
  });

  it('일봉 전용 구간은 **분봉에서 존재하지 않는다** — 그 날의 분봉이 디스크에 없다', () => {
    const f = focus({ dailyOnly: true });
    expect(savedRangeAppliesTo(f, '005930', 'D')).toBe(true);
    expect(savedRangeAppliesTo(f, '005930', 'W')).toBe(true);
    // 분봉 창은 freeze 도 venue 고정도 칩도 받지 않는다 — 셋이 이 한 줄에 달려 있다.
    expect(savedRangeAppliesTo(f, '005930', '1m')).toBe(false);
    expect(savedRangeAppliesTo(f, '005930', '60m')).toBe(false);
  });
});
