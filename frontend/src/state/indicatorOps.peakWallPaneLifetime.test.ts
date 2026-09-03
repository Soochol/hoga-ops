import { describe, it, expect } from 'vitest';
import { INDICATOR_OPS, peakWallPaneHasContent } from './indicatorOps';
import { FACTORY_INDICATOR_SETTINGS } from './indicatorSettingsV2';

/**
 * 「최대벽 지표를 껐는데 강도 pane 이 남는다」의 가드.
 *
 * ## 왜 이 술어가 필요한가
 *
 * pane 의 마운트 게이트는 오랫동안 `peakWallPaneEnabled` **하나만** 봤다
 * (`paneSpecsForTimeframe`). 그런데 그 안에 그려지는 계단은 `usePeakWallRender` 에서
 * 방향(`{side}PeakEnabled`)과 슬롯 키로 **한 번 더** 게이트된다. 두 게이트가 서로 다른
 * 질문에 답하고 있었고, 그래서 지표를 끄면 계단만 사라지고 **빈 pane 이 남았다**.
 *
 * 처방은 마스터를 쓰기 시점에 닫는 것이 **아니다** — 그러면 「왜 닫혔는지」를 잊어
 * 되켤 때 돌아올 수 없다(사용자가 요구한 것이 그 대칭이다). 마스터는 opt-in 의사로
 * 두고 마운트 게이트가 렌더 게이트와 **같은 곱**을 보게 한다.
 *
 * ## 이 파일이 막는 방향
 *
 * 곱의 어느 항이 빠지는 것. 특히 **방향의 OR × 슬롯의 OR** 로 접히는 것 — 그러면
 * 「매도 슬롯만 켠 채 매도를 끄고 매수를 켠」 조합에서 빈 pane 이 남는다.
 *
 * ## 못 보는 것
 *
 * 이 술어가 실제로 게이트까지 흘러가는가는 여기서 재지 않는다 —
 * `indicatorPaneProfiles.test.ts`(곱 접기)와 `LiveChartRoot.paneToggles.test.tsx`
 * (마운트 집합)가 그 층이다.
 */

/** 마스터가 열려 있고 양방향 오버레이·체결된 벽 슬롯이 켜진, pane 이 그려지는 상태. */
const paneLive = {
  ...FACTORY_INDICATOR_SETTINGS,
  askPeakEnabled: true,
  bidPeakEnabled: true,
  peakWallPaneEnabled: true,
  askPeakTradedPaneEnabled: true,
  bidPeakTradedPaneEnabled: true,
};

describe('peakWallPaneHasContent — 강도 pane 에 그릴 것이 있는가', () => {
  it('마스터 · 방향 · 슬롯이 모두 서면 내용이 있다', () => {
    expect(peakWallPaneHasContent(paneLive)).toBe(true);
  });

  it('마스터가 닫히면 나머지가 무엇이든 없다 (opt-in 은 그대로다)', () => {
    expect(peakWallPaneHasContent({ ...paneLive, peakWallPaneEnabled: false })).toBe(false);
  });

  /** 사용자 신고의 핵심 — 지표를 끄면 계단이 사라지므로 pane 도 없어야 한다. */
  it('두 방향을 다 끄면 슬롯이 켜져 있어도 없다', () => {
    expect(peakWallPaneHasContent({
      ...paneLive, askPeakEnabled: false, bidPeakEnabled: false,
    })).toBe(false);
  });

  /** pane 은 매도·매수가 공유하는 하나다 — 한쪽이 살아 있으면 그 안에 계단이 있다. */
  it('한 방향만 살아 있어도 있다', () => {
    expect(peakWallPaneHasContent({ ...paneLive, askPeakEnabled: false })).toBe(true);
  });

  it('여섯 칸이 다 꺼지면 방향이 켜져 있어도 없다', () => {
    expect(peakWallPaneHasContent({
      ...paneLive, askPeakTradedPaneEnabled: false, bidPeakTradedPaneEnabled: false,
    })).toBe(false);
  });

  /**
   * **판정은 방향별 곱의 OR 이다** — 「방향의 OR × 슬롯의 OR」로 접으면 이 조합이
   * 통과해 빈 pane 이 남는다(매도 슬롯만 켰는데 살아 있는 방향은 매수다).
   *
   * **막는 방향**: 술어가 두 축을 독립적으로 접는 것.
   */
  it('살아 있는 방향에 켜진 칸이 없으면 없다 (축을 따로 접으면 통과한다)', () => {
    expect(peakWallPaneHasContent({
      ...paneLive,
      askPeakEnabled: false,
      bidPeakTradedPaneEnabled: false,  // 매수는 켜져 있지만 칸이 하나도 없다
    })).toBe(false);
  });

  /**
   * `hidden` 은 보지 않는다 — 렌더 게이트(`usePeakWallRender`)가 `enabled` 만 읽어
   * 오버레이를 눈으로 숨겨도 계단은 그려지기 때문이다. 여기서 곱하면 두 게이트가
   * 다시 갈린다.
   */
  it('눈으로 숨긴 것은 내용을 없애지 않는다', () => {
    expect(peakWallPaneHasContent({
      ...paneLive, askPeakHidden: true, bidPeakHidden: true,
    })).toBe(true);
  });
});

/**
 * 방향을 끄는 op 은 **마스터를 건드리지 않는다**. 이것이 되켜기 대칭의 전제다 —
 * 마스터가 사용자의 opt-in 의사로 남아 있어야 방향이 돌아올 때 pane 도 함께 돌아온다.
 *
 * **막는 방향**: 쓰기 시점 캐스케이드(마지막 방향을 끌 때 마스터도 닫기)가 되살아나
 * 대칭이 조용히 깨지는 것. 그 판을 한 번 만들었다가 이 이유로 되돌렸다(2026-09-03).
 */
describe('방향 op 은 마스터를 보존한다 (되켜기 대칭의 전제)', () => {
  it('마지막 방향을 꺼도 마스터는 그대로다', () => {
    const cur = { ...paneLive, bidPeakEnabled: false };
    const patch = INDICATOR_OPS.setAskPeakEnabled(cur, false);
    expect(patch).toEqual({ askPeakEnabled: false });
    expect('peakWallPaneEnabled' in (patch ?? {})).toBe(false);
  });

  it('끈 방향을 되켜면 pane 의 내용이 돌아온다', () => {
    const off = { ...paneLive, askPeakEnabled: false, bidPeakEnabled: false };
    expect(peakWallPaneHasContent(off)).toBe(false);
    const patch = INDICATOR_OPS.setAskPeakEnabled(off, true);
    expect(peakWallPaneHasContent({ ...off, ...patch })).toBe(true);
  });
});

/**
 * pane 슬롯 스위치는 **그 방향도 켠다**. 그렇지 않으면 방향이 꺼진 채 슬롯·마스터만
 * 열려 「켰는데 아무 일도 안 일어나는」 스위치가 된다 — 계단이 방향으로도 게이트되기
 * 때문이다.
 *
 * **막는 방향**: 결합이 빠져 스위치가 죽는 것. **못 보는 것**: 그 클릭으로 캔들
 * 오버레이 선이 함께 나타나는 것이 옳은가(설계 판단, PR 본문에 적었다).
 */
describe('pane 슬롯을 켜면 그 방향도 열린다', () => {
  it('방향이 꺼져 있어도 한 번의 클릭으로 pane 에 내용이 생긴다', () => {
    const off = {
      ...FACTORY_INDICATOR_SETTINGS,
      askPeakEnabled: false,
      bidPeakEnabled: false,
      peakWallPaneEnabled: false,
    };
    const patch = INDICATOR_OPS.setPeakWallPaneSlotEnabled(off, 'ask', 'Unreached', true);
    const next = { ...off, ...patch };
    expect(next.askPeakEnabled).toBe(true);
    expect(next.askPeakHidden).toBe(false);
    expect(peakWallPaneHasContent(next)).toBe(true);
    // 여는 클릭은 여전히 **그 칸 하나만** 넣는다(마스터-닫힘의 기존 규칙).
    expect(next.askPeakUnreachedPaneEnabled).toBe(true);
    expect(next.askPeakTradedPaneEnabled).toBe(false);
  });

  it('반대 방향은 건드리지 않는다', () => {
    const patch = INDICATOR_OPS.setPeakWallPaneSlotEnabled(
      { ...FACTORY_INDICATOR_SETTINGS, bidPeakEnabled: false }, 'ask', 'Traded', true,
    );
    expect('bidPeakEnabled' in (patch ?? {})).toBe(false);
  });
});
