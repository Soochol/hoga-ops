import { describe, expect, it } from 'vitest';
import { PANE_SPECS, type BoundPaneSpec } from '../chart/paneSpecs';
import {
  foldPanes,
  INITIAL_FOLD_STATE,
  MIN_AUX_PANE_PX,
  type PaneFoldState,
} from './paneFolding';

/** 공장 가중치 그대로 — 저장된 Pane Stretch 가 없을 때의 경로. */
const bySpec = (s: BoundPaneSpec): number => s.stretch;

/** 분봉 전체 ON = 6-pane (캔들 1.4 · 거래량 0.3 · 총잔량 0.4 · 호가비 0.4 ·
 *  체결강도 0.4 · 프로그램 0.35, 합 3.25). */
const SIX = PANE_SPECS;
/** 캔들 + 거래량 — 주/월봉이자 분봉 공장기본. */
const TWO = PANE_SPECS.slice(0, 2);
const names = (r: { specs: readonly BoundPaneSpec[] }): string[] => r.specs.map((s) => s.name);

describe('foldPanes', () => {
  it('높이가 넉넉하면 아무것도 접지 않는다', () => {
    const r = foldPanes(SIX, 800, bySpec);
    expect(r.foldedCount).toBe(0);
    expect(r.specs).toHaveLength(6);
    expect(r.timeAxisVisible).toBe(true);
  });

  it('높이가 줄면 paneOrder 끝(우선순위 낮은 쪽)부터 접는다', () => {
    // 6-pane 에서 가장 작은 보조는 거래량(0.3). 400px 에서는 2개를 접어야 40px 를 넘긴다.
    const r = foldPanes(SIX, 400, bySpec);
    expect(r.foldedCount).toBe(2);
    // 뒤 두 개(체결강도·프로그램)가 빠지고 앞은 그대로.
    expect(names(r)).toEqual(['candle', 'volume', 'quote-totals', 'ratio']);
  });

  it('접고 나면 남은 보조 pane 이 최소 가독 높이를 넘는다', () => {
    for (const h of [800, 600, 500, 420, 380, 300, 240, 200]) {
      const r = foldPanes(SIX, h, bySpec);
      const kept = r.specs;
      if (kept.length < 2) continue; // 캔들만 남은 구간은 이 불변식의 대상이 아니다
      const budget = h - (r.timeAxisVisible ? 28 : 0) - (kept.length - 1);
      const total = kept.reduce((a, s) => a + s.stretch, 0);
      const minAux = Math.min(...kept.slice(1).map((s) => (budget * s.stretch) / total));
      expect(minAux, `height=${h} kept=${kept.length}`).toBeGreaterThanOrEqual(MIN_AUX_PANE_PX);
    }
  });

  it('아무리 작아도 캔들은 접지 않는다', () => {
    const r = foldPanes(SIX, 40, bySpec);
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0].name).toBe('candle');
    expect(r.foldedCount).toBe(5);
  });

  it('아직 측정되지 않은 높이(0)에서는 접지 않는다 — 마운트 직후 접었다 펴는 깜빡임 방지', () => {
    const r = foldPanes(SIX, 0, bySpec, { foldedCount: 3, timeAxisVisible: false });
    expect(r.foldedCount).toBe(0);
    expect(r.specs).toHaveLength(6);
    expect(r.timeAxisVisible).toBe(true);
  });

  describe('히스테리시스', () => {
    // 400px 의 dead band 는 [2, 3] — 접는 기준(40px)으로는 2개, 되살리는 기준(48px)
    // 으로는 3개다. 그 사이에서는 직전 상태를 유지해 깜빡임을 막는다.
    const H = 400;

    it('dead band 안에서는 직전 상태를 그대로 유지한다', () => {
      expect(foldPanes(SIX, H, bySpec, { foldedCount: 2, timeAxisVisible: true }).foldedCount).toBe(2);
      expect(foldPanes(SIX, H, bySpec, { foldedCount: 3, timeAxisVisible: true }).foldedCount).toBe(3);
    });

    it('dead band 아래로 벗어나면 더 접는다', () => {
      expect(foldPanes(SIX, H, bySpec, { foldedCount: 0, timeAxisVisible: true }).foldedCount).toBe(2);
      expect(foldPanes(SIX, H, bySpec, { foldedCount: 1, timeAxisVisible: true }).foldedCount).toBe(2);
    });

    it('dead band 위로 벗어나면 되살린다', () => {
      expect(foldPanes(SIX, H, bySpec, { foldedCount: 5, timeAxisVisible: true }).foldedCount).toBe(3);
    });

    it('같은 높이를 반복 적용해도 값이 흔들리지 않는다(멱등)', () => {
      let st: PaneFoldState = INITIAL_FOLD_STATE;
      const seen: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = foldPanes(SIX, H, bySpec, st);
        st = { foldedCount: r.foldedCount, timeAxisVisible: r.timeAxisVisible };
        seen.push(r.foldedCount);
      }
      expect(new Set(seen).size).toBe(1);
    });

    it('축소→확대 왕복에서 원래 상태로 정확히 돌아온다', () => {
      let st: PaneFoldState = INITIAL_FOLD_STATE;
      const step = (h: number): number => {
        const r = foldPanes(SIX, h, bySpec, st);
        st = { foldedCount: r.foldedCount, timeAxisVisible: r.timeAxisVisible };
        return r.foldedCount;
      };
      for (const h of [800, 600, 500, 400, 300, 200, 140]) step(h);
      expect(st.foldedCount).toBeGreaterThan(0);
      for (const h of [200, 300, 400, 500, 600, 800]) step(h);
      expect(st.foldedCount).toBe(0);
      expect(st.timeAxisVisible).toBe(true);
    });
  });

  describe('시간축', () => {
    it('보조 pane 이 남아있으면 절대 숨기지 않는다', () => {
      const r = foldPanes(SIX, 300, bySpec);
      expect(r.specs.length).toBeGreaterThan(1);
      expect(r.timeAxisVisible).toBe(true);
    });

    it('캔들만 남고 그마저 작아지면 숨긴다', () => {
      const r = foldPanes(SIX, 150, bySpec);
      expect(r.specs).toHaveLength(1);
      expect(r.timeAxisVisible).toBe(false);
    });

    it('복귀 임계는 숨김 임계보다 높다 — 경계에서 깜빡이지 않는다', () => {
      // 숨긴 상태(prev=false)에서 168px 는 아직 복귀 임계(188px) 미만이라 숨김 유지.
      const hidden = { foldedCount: 5, timeAxisVisible: false };
      expect(foldPanes(SIX, 175, bySpec, hidden).timeAxisVisible).toBe(false);
      // 보인 상태(prev=true)에서 같은 175px 는 숨김 임계(168px) 초과라 표시 유지.
      const shown = { foldedCount: 5, timeAxisVisible: true };
      expect(foldPanes(SIX, 175, bySpec, shown).timeAxisVisible).toBe(true);
    });
  });

  describe('pane 목록이 바뀌는 경우', () => {
    // 봉 전환·지표 토글로 specs.length 가 줄면 직전 foldedCount 가 범위를 넘는다.
    it('직전 접힘 수가 새 목록 범위를 넘으면 조여진다', () => {
      const r = foldPanes(TWO, 800, bySpec, { foldedCount: 5, timeAxisVisible: true });
      expect(r.foldedCount).toBe(0);
      expect(r.specs).toHaveLength(2);
    });

    it('공장기본(2-pane)은 창 최소 크기에서 거래량이 접히고 캔들만 남는다', () => {
      // 창 120px → 컨테이너 약 62px.
      const small = foldPanes(TWO, 62, bySpec);
      expect(small.specs).toHaveLength(1);
      expect(small.specs[0].name).toBe('candle');
      // 컨테이너 300px(창 약 358px)에서는 둘 다 유지. 공장 가중치에서 거래량이
      // 40px 를 받는 경계는 컨테이너 약 256px(창 약 314px)다.
      expect(foldPanes(TWO, 300, bySpec).specs).toHaveLength(2);
      expect(foldPanes(TWO, 240, bySpec).specs).toHaveLength(1);
    });
  });

  it('저장된 Pane Stretch 가 접기 임계를 바꾼다', () => {
    // 임계는 하드코딩이 아니라 현재 가중치에서 역산된다 — 거래량 가중치를 키우면
    // 같은 높이에서 접히던 것이 살아남는다. (6-pane 에서 한 pane 만 키우면 나머지
    // 보조가 상대적으로 작아져 상쇄되므로, 보조가 하나뿐인 2-pane 으로 본다.)
    const heavyVolume = (s: BoundPaneSpec): number => (s.name === 'volume' ? 0.8 : s.stretch);
    expect(foldPanes(TWO, 242, bySpec).foldedCount).toBe(1);
    expect(foldPanes(TWO, 242, heavyVolume).foldedCount).toBe(0);
  });
});
