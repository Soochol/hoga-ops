import { describe, expect, it } from 'vitest';
import {
  HEADER_FOLD_NONE,
  HEADER_LABEL_MIN_WIDTH_PX,
  HEADER_LABEL_RESTORE_WIDTH_PX,
  HEADER_TIMEFRAME_FOLD_WIDTH_PX,
  HEADER_TIMEFRAME_RESTORE_WIDTH_PX,
  nextHeaderFold,
  type HeaderFold,
} from './chartHeaderCompact';

const BOTH_FOLDED: HeaderFold = { compactActions: true, compactTimeframe: true };

describe('nextHeaderFold', () => {
  it('keeps everything expanded while the header is wide', () => {
    expect(nextHeaderFold(720, HEADER_FOLD_NONE)).toEqual(HEADER_FOLD_NONE);
    expect(nextHeaderFold(HEADER_LABEL_MIN_WIDTH_PX, HEADER_FOLD_NONE)).toEqual(HEADER_FOLD_NONE);
  });

  // #762 실측: 임계 아래에서 `+보조지표` 가 overflow-hidden 에 예고 없이 잘려
  // 사라졌다(250px 에서 41px 스필). 1단계는 그 무성 손실을 막는다.
  it('folds action labels first, keeping the timeframe buttons', () => {
    const fold = nextHeaderFold(250, HEADER_FOLD_NONE);
    expect(fold.compactActions).toBe(true);
    expect(fold.compactTimeframe).toBe(false);
  });

  // 라벨을 접어도 헤더는 213px 를 요구하는데 창은 MIN_W=160px 까지 좁아진다 —
  // 2단계가 없으면 그 구간에서 액션 버튼이 다시 잘린다.
  it('folds the timeframe buttons too once even icons would not fit', () => {
    expect(nextHeaderFold(180, HEADER_FOLD_NONE)).toEqual(BOTH_FOLDED);
    expect(nextHeaderFold(160, HEADER_FOLD_NONE)).toEqual(BOTH_FOLDED);
  });

  // 임계 하나만 쓰면 경계에서 1px 떨림에 라벨이 깜빡인다.
  it('holds each stage inside its dead band instead of flapping', () => {
    const betweenActions = HEADER_LABEL_MIN_WIDTH_PX + 1;
    expect(betweenActions).toBeLessThan(HEADER_LABEL_RESTORE_WIDTH_PX);
    expect(nextHeaderFold(betweenActions, BOTH_FOLDED).compactActions).toBe(true);
    expect(nextHeaderFold(betweenActions, HEADER_FOLD_NONE).compactActions).toBe(false);

    const betweenTf = HEADER_TIMEFRAME_FOLD_WIDTH_PX + 1;
    expect(betweenTf).toBeLessThan(HEADER_TIMEFRAME_RESTORE_WIDTH_PX);
    expect(nextHeaderFold(betweenTf, BOTH_FOLDED).compactTimeframe).toBe(true);
    expect(nextHeaderFold(betweenTf, HEADER_FOLD_NONE).compactTimeframe).toBe(false);
  });

  it('restores each stage past its restore threshold', () => {
    expect(nextHeaderFold(HEADER_TIMEFRAME_RESTORE_WIDTH_PX, BOTH_FOLDED).compactTimeframe).toBe(false);
    expect(nextHeaderFold(HEADER_LABEL_RESTORE_WIDTH_PX, BOTH_FOLDED).compactActions).toBe(false);
  });

  // 단계 순서가 뒤집히면 안 된다 — 봉이 접혔는데 액션 라벨이 남아 있으면
  // 폭 예산이 어긋난다.
  it('never folds the timeframe while action labels are still expanded', () => {
    for (let width = 100; width <= 500; width += 4) {
      const fold = nextHeaderFold(width, HEADER_FOLD_NONE);
      if (fold.compactTimeframe) expect(fold.compactActions).toBe(true);
    }
  });

  // 폭 0 = 아직 측정 전(마운트 직후·display:none). 접으면 첫 프레임에 라벨이
  // 깜빡 사라졌다 나타난다.
  it('treats an unmeasured width as "no change"', () => {
    expect(nextHeaderFold(0, HEADER_FOLD_NONE)).toEqual(HEADER_FOLD_NONE);
    expect(nextHeaderFold(0, BOTH_FOLDED)).toEqual(BOTH_FOLDED);
  });

  // dead band 안에서 멱등 — StrictMode 이중 렌더에서도 수렴한다.
  it('is idempotent for the same input and prior state', () => {
    for (const width of [0, 160, 200, HEADER_LABEL_MIN_WIDTH_PX, 400, 720]) {
      for (const prev of [HEADER_FOLD_NONE, BOTH_FOLDED]) {
        const once = nextHeaderFold(width, prev);
        expect(nextHeaderFold(width, once)).toEqual(once);
      }
    }
  });
});
