import { describe, expect, it } from 'vitest';
import {
  HEADER_FOLD_NONE,
  HEADER_LABEL_MIN_WIDTH_PX,
  HEADER_LABEL_RESTORE_WIDTH_PX,
  HEADER_TIMEFRAME_FOLD_WIDTH_PX,
  HEADER_TIMEFRAME_RESTORE_WIDTH_PX,
  nextHeaderFold,
  LIVE_HEADER_FOLD,
  STUDY_HEADER_FOLD,
  STUDY_HEADER_NEED,
  type HeaderFold,
} from './chartHeaderCompact';
import { MIN_W } from '../../workspace/snapEngine';

const BOTH_FOLDED: HeaderFold = { compactActions: true, compactTimeframe: true };

describe('nextHeaderFold', () => {
  it('keeps everything expanded while the header is wide', () => {
    expect(nextHeaderFold(720, HEADER_FOLD_NONE)).toEqual(HEADER_FOLD_NONE);
    expect(nextHeaderFold(HEADER_LABEL_MIN_WIDTH_PX, HEADER_FOLD_NONE)).toEqual(HEADER_FOLD_NONE);
  });

  // 임계 아래에서 마지막 액션 버튼이 overflow-hidden 에 예고 없이 잘려 사라진다
  // (#762 원 실측: 2버튼 시절 250px 에서 41px 스필). 1단계는 그 무성 손실을 막고,
  // 봉 버튼은 아직 살려둔다 — 300px 는 두 임계 사이(258 ≤ w < 424).
  it('folds action labels first, keeping the timeframe buttons', () => {
    const fold = nextHeaderFold(300, HEADER_FOLD_NONE);
    expect(fold.compactActions).toBe(true);
    expect(fold.compactTimeframe).toBe(false);
  });

  // 액션 4버튼 실측(2026-07-21): 라벨 펼침 414px · 아이콘만 241px · 완전 접힘
  // 141px. 창은 MIN_W=160px 까지 좁아지므로 2단계까지 접어야 잘림이 0 이 된다.
  it('folds the timeframe buttons too once even icons would not fit', () => {
    expect(nextHeaderFold(200, HEADER_FOLD_NONE)).toEqual(BOTH_FOLDED);
    expect(nextHeaderFold(160, HEADER_FOLD_NONE)).toEqual(BOTH_FOLDED);
  });

  // 임계는 버튼 수·라벨 길이에 종속이라 헤더 구성이 바뀌면 함께 움직여야 한다.
  // 2버튼 시절 값(344/232)을 4버튼에 그대로 뒀다가 71px 부족으로 무성 잘림이 났다.
  it('keeps thresholds above the measured requirement for the current button set', () => {
    const MEASURED_LABEL_WIDTH_PX = 414;
    const MEASURED_ICON_WIDTH_PX = 241;
    expect(HEADER_LABEL_MIN_WIDTH_PX).toBeGreaterThanOrEqual(MEASURED_LABEL_WIDTH_PX);
    expect(HEADER_TIMEFRAME_FOLD_WIDTH_PX).toBeGreaterThanOrEqual(MEASURED_ICON_WIDTH_PX);
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
    for (let width = 100; width <= 600; width += 4) {
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
    for (const width of [0, 160, 200, 300, HEADER_LABEL_MIN_WIDTH_PX, 500, 720]) {
      for (const prev of [HEADER_FOLD_NONE, BOTH_FOLDED]) {
        const once = nextHeaderFold(width, prev);
        expect(nextHeaderFold(width, once)).toEqual(once);
      }
    }
  });
});

describe('표면별 임계 (#903 — 정책은 공유, 숫자는 표면마다)', () => {
  // 액션 4버튼(/live) 값을 액션 2버튼(/study)에 그대로 쓰면 ~120px 일찍 접힌다.
  // 반대 방향으로 틀린 전례가 #767 이다(2버튼 값을 4버튼 헤더에 방치 → 무성 잘림).
  it('/study 는 /live 보다 좁은 폭까지 라벨을 유지한다', () => {
    expect(STUDY_HEADER_FOLD.labelMinWidthPx).toBeLessThan(LIVE_HEADER_FOLD.labelMinWidthPx);

    // 두 임계 사이의 폭에서 판정이 갈리는 게 이 분리의 전부다.
    const between = (LIVE_HEADER_FOLD.labelMinWidthPx + STUDY_HEADER_FOLD.labelMinWidthPx) / 2;
    expect(nextHeaderFold(between, HEADER_FOLD_NONE, LIVE_HEADER_FOLD).compactActions).toBe(true);
    expect(nextHeaderFold(between, HEADER_FOLD_NONE, STUDY_HEADER_FOLD).compactActions).toBe(false);
  });

  it('기본 인자는 /live — 인자를 빠뜨린 호출부가 조용히 달라지지 않는다', () => {
    for (const width of [160, 250, 300, 400, 424, 500]) {
      expect(nextHeaderFold(width, HEADER_FOLD_NONE))
        .toEqual(nextHeaderFold(width, HEADER_FOLD_NONE, LIVE_HEADER_FOLD));
    }
  });

  it('히스테리시스는 표면과 무관하게 유지된다', () => {
    const folded = nextHeaderFold(STUDY_HEADER_FOLD.labelMinWidthPx - 1, HEADER_FOLD_NONE, STUDY_HEADER_FOLD);
    expect(folded.compactActions).toBe(true);
    // 접힘 임계를 갓 넘긴 폭에서는 아직 되펴지 않는다(1px 떨림 방지).
    const stillFolded = nextHeaderFold(STUDY_HEADER_FOLD.labelMinWidthPx + 1, folded, STUDY_HEADER_FOLD);
    expect(stillFolded.compactActions).toBe(true);
    const restored = nextHeaderFold(STUDY_HEADER_FOLD.labelRestoreWidthPx, folded, STUDY_HEADER_FOLD);
    expect(restored.compactActions).toBe(false);
  });
});

/**
 * #905 — 임계는 "언제 접을지" 만 정한다. "접은 게 충분히 작은지" 는 별개 불변식이라
 * 따로 못 박는다. #767 이 난 이유가 정확히 이 둘을 한 값으로 착각해서다.
 */
describe('/study 접힘 불변식 (#905 실측 고정)', () => {
  it('각 단계 임계는 그 단계 형태의 요구 폭보다 크다', () => {
    // 라벨을 유지하는 구간의 하한 = 다 펴진 형태가 들어가야 한다.
    expect(STUDY_HEADER_FOLD.labelMinWidthPx).toBeGreaterThan(STUDY_HEADER_NEED.full);
    // 봉 그룹을 유지하는 구간의 하한 = 1단계 형태(아이콘 액션 + 봉 그룹)가 들어가야 한다.
    expect(STUDY_HEADER_FOLD.timeframeFoldWidthPx).toBeGreaterThan(STUDY_HEADER_NEED.actionsFolded);
  });

  it('단계 순서가 뒤집히지 않는다 — 봉은 라벨보다 늦게 접힌다', () => {
    expect(STUDY_HEADER_FOLD.timeframeFoldWidthPx).toBeLessThan(STUDY_HEADER_FOLD.labelMinWidthPx);
    // 되펴기 임계도 같은 순서. 겹치면 두 단계가 같은 폭에서 진동한다.
    expect(STUDY_HEADER_FOLD.timeframeRestoreWidthPx).toBeLessThan(STUDY_HEADER_FOLD.labelMinWidthPx);
  });

  it('완전 접힘이 창 최소 폭(MIN_W)에 들어간다', () => {
    // 창을 MIN_W 까지 좁혀도 헤더가 잘리면 안 된다. 임계로는 보장되지 않는 축이다 —
    // 더 접을 단계가 없으므로 이 여유가 음수면 사용자가 잘림을 그대로 본다.
    // 컨테이너 패딩(px-1 = 0.25rem × 2, 기본 밀도 18px 기준 9px)을 뺀 값과 비교.
    const containerPaddingPx = 9;
    expect(STUDY_HEADER_NEED.bothFolded).toBeLessThanOrEqual(MIN_W - containerPaddingPx);
  });

  it('되펴기 dead band 가 요구 폭을 넘지 않는다 — 되편 직후 잘리면 안 된다', () => {
    // 히스테리시스로 되편 순간의 폭이 그 형태의 요구 폭보다 넓어야 한다.
    expect(STUDY_HEADER_FOLD.labelRestoreWidthPx).toBeGreaterThan(STUDY_HEADER_NEED.full);
    expect(STUDY_HEADER_FOLD.timeframeRestoreWidthPx).toBeGreaterThan(STUDY_HEADER_NEED.actionsFolded);
  });
});
