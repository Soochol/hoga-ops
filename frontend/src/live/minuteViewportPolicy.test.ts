import { describe, expect, it } from 'vitest';

import {
  MINUTE_RIGHT_LABEL_GUTTER_PX,
  maxRenderableSpan,
  minuteRestoreGeometry,
  minuteRightOffsetBars,
} from './minuteViewportPolicy';

describe('minuteRightOffsetBars', () => {
  it('오른쪽 거터 180px를 봉 수로 환산한다', () => {
    // 750px 폭, 1000봉 → 거터가 차지할 봉 = 180*1000/(750-180)
    expect(minuteRightOffsetBars(1000, 750)).toBe(Math.ceil((180 * 1000) / 570));
  });

  it('플롯이 거터보다 좁으면 설정값으로 후퇴한다', () => {
    expect(minuteRightOffsetBars(1000, MINUTE_RIGHT_LABEL_GUTTER_PX)).toBeGreaterThan(0);
  });
});

describe('maxRenderableSpan', () => {
  it('minBarSpacing이 한 화면 봉 수의 상한을 정한다', () => {
    expect(maxRenderableSpan(750, 0.5)).toBe(1500);
  });
});

describe('minuteRestoreGeometry', () => {
  it('저장 span이 그릴 수 있는 범위면 그대로 쓴다', () => {
    const g = minuteRestoreGeometry(400, 750, 0.5);
    expect(g.barSpan).toBe(400);
    expect(g.rightOffset).toBe(minuteRightOffsetBars(400, 750));
    expect(g.barSpan + g.rightOffset).toBeLessThanOrEqual(maxRenderableSpan(750, 0.5));
  });

  it('저장 span이 상한을 넘으면 접고, 여백이 데이터를 밀어내지 않는다', () => {
    // 회귀: 넓은 /live(≈1600px)에서 저장한 3235봉을 750px /study 에서 복원하면
    // 여백이 1022봉으로 잡히고 전체 span은 1500으로 잘려, 캔들이 478봉만 남고
    // 화면 오른쪽 2/3가 빈 공간이 됐다.
    const width = 750;
    const max = maxRenderableSpan(width, 0.5);
    const g = minuteRestoreGeometry(3235, width, 0.5);

    expect(g.barSpan + g.rightOffset).toBeLessThanOrEqual(max);
    // 여백은 거터 비율(180/750 = 24%)만 가져간다 — 예전엔 68%였다.
    expect(g.rightOffset).toBeLessThanOrEqual(Math.ceil(max * (180 / width)));
    // 데이터가 화면 대부분을 차지한다.
    expect(g.barSpan).toBeGreaterThan(g.rightOffset * 2);
    expect(g.barSpan).toBeGreaterThan(1000);
  });

  it('접힌 뒤에도 항상 상한을 지킨다 (여러 폭·span 조합)', () => {
    for (const width of [320, 750, 1280, 1920]) {
      for (const saved of [50, 400, 1500, 3235, 12000]) {
        const max = maxRenderableSpan(width, 0.5);
        const g = minuteRestoreGeometry(saved, width, 0.5);
        expect(g.barSpan).toBeGreaterThanOrEqual(1);
        expect(g.rightOffset).toBeGreaterThanOrEqual(0);
        expect(g.barSpan + g.rightOffset).toBeLessThanOrEqual(max);
      }
    }
  });
});
