import { describe, expect, it } from 'vitest';
import { RENDERED_ROOT_PX } from '../../styles/design-tokens';
import {
  HEADER_FOLD_NONE,
  HEADER_LABEL_MIN_WIDTH_PX,
  HEADER_LABEL_RESTORE_WIDTH_PX,
  HEADER_TIMEFRAME_FOLD_WIDTH_PX,
  HEADER_TIMEFRAME_RESTORE_WIDTH_PX,
  nextHeaderFold,
  LIVE_HEADER_FOLD,
  LIVE_HEADER_NEED,
  HEART_FOLDED_WIDTH_PX,
  HOGAPLAY_SOURCE_FOLDED_WIDTH_PX,
  showsHeaderStateIcons,
  showsWatchlistHeart,
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
  // 봉 버튼은 아직 살려둔다 — 300px 는 두 임계 사이(262 ≤ w < 414).
  it('folds action labels first, keeping the timeframe buttons', () => {
    const fold = nextHeaderFold(300, HEADER_FOLD_NONE);
    expect(fold.compactActions).toBe(true);
    expect(fold.compactTimeframe).toBe(false);
  });

  // 액션 5버튼 실측(2026-08-14, 다이얼 1.0×): 라벨 펼침 412px · 아이콘만 257px.
  // 창은 MIN_W=160px 까지 좁아지므로 2단계까지 접어야 잘림이 0 이 된다.
  // (하트 없던 4버튼 시절: 382 / 235 · 2026-07-21 1.125× 시절: 414 / 241 / 141.)
  it('folds the timeframe buttons too once even icons would not fit', () => {
    expect(nextHeaderFold(200, HEADER_FOLD_NONE)).toEqual(BOTH_FOLDED);
    expect(nextHeaderFold(160, HEADER_FOLD_NONE)).toEqual(BOTH_FOLDED);
  });

  // 임계는 버튼 수·라벨 길이 **그리고 밀도 다이얼**에 종속이라 어느 하나가 바뀌면 함께
  // 움직여야 한다. 2버튼 시절 값(344/232)을 4버튼에 그대로 뒀다가 71px 부족으로 무성
  // 잘림이 났고(#767), 같은 PR 이 2단계 need 주석(213)은 안 고쳐 2026-08-07 까지
  // 남아 있었다 — 임계 258 이 실요구 254.25 위 3.75px 여유로 우연히 살아 있어서
  // 무증상이었다. **여유가 근거처럼 보이는 것이 이 계열 버그의 공통 서명이다.**
  it('keeps thresholds above the measured requirement for the current button set', () => {
    // 2026-08-22 재실측 @1.0× · **240분 라벨(진짜 최장)** · 액션 6버튼
    // (hogaplay 소스 추가). 다이얼이나 버튼 구성이 바뀌면 `LIVE_HEADER_NEED` 를
    // 재측정한다. 같은 실측의 대조군(신규 버튼 제외·30분)은 종전 상수 412/257/148 을
    // 정확히 재현했다 — 그 대조가 절차의 유효성 증거다(파일 도크스트링의 표).
    const MEASURED_LABEL_WIDTH_PX = 449;
    const MEASURED_ICON_WIDTH_PX = 286;
    expect(LIVE_HEADER_NEED.full).toBe(MEASURED_LABEL_WIDTH_PX);
    expect(LIVE_HEADER_NEED.actionsFolded).toBe(MEASURED_ICON_WIDTH_PX);
    expect(HEADER_LABEL_MIN_WIDTH_PX).toBeGreaterThanOrEqual(MEASURED_LABEL_WIDTH_PX);
    expect(HEADER_TIMEFRAME_FOLD_WIDTH_PX).toBeGreaterThanOrEqual(MEASURED_ICON_WIDTH_PX);
  });

  // 접힘의 마지막 단계는 **더 접을 것이 없으므로** 그 자체로 `MIN_W` 창에 들어가야
  // 한다 — 여기서 넘치면 임계를 어떻게 잡아도 오른쪽 끝 버튼이 무성 잘린다.
  // 두 번째 단언이 하트를 그 단계에서 내리는 이유다: 되살리면 예산을 넘는다.
  it('fits the fully folded header inside the narrowest window, state icons excluded', () => {
    // 창 rect 는 좌우 GAP/2 를 패딩으로 쓰므로 헤더 컨테이너는 MIN_W - 2.
    const container = MIN_W - 2;
    expect(LIVE_HEADER_NEED.bothFolded).toBeLessThanOrEqual(container);
    // 상태 아이콘은 **하나만 되살려도** 예산을 넘는다 — 둘을 각각 재는 것이 요점이다.
    // 하나로 묶어 두면 "하트만 남기면 되지 않나" 를 이 테스트가 답할 수 없다.
    expect(LIVE_HEADER_NEED.bothFolded + HEART_FOLDED_WIDTH_PX).toBeGreaterThan(container);
    expect(LIVE_HEADER_NEED.bothFolded + HOGAPLAY_SOURCE_FOLDED_WIDTH_PX).toBeGreaterThan(container);
    expect(showsWatchlistHeart({ compactActions: true, compactTimeframe: true })).toBe(false);
    expect(showsHeaderStateIcons({ compactActions: true, compactTimeframe: true })).toBe(false);
  });

  // 하트가 사라지는 것은 **마지막 단계에서만** 이다 — 1단계(라벨만 접힘)는 예산이
  // 남으므로(257 ≤ 임계 262) 하트를 유지한다. 두 단계를 같이 지우면 임계 384~262
  // 구간에서 이유 없이 기능이 사라진다.
  it('keeps the heart while only the action labels are folded', () => {
    expect(showsWatchlistHeart(HEADER_FOLD_NONE)).toBe(true);
    expect(showsWatchlistHeart({ compactActions: true, compactTimeframe: false })).toBe(true);
    expect(showsHeaderStateIcons(HEADER_FOLD_NONE)).toBe(true);
    expect(showsHeaderStateIcons({ compactActions: true, compactTimeframe: false })).toBe(true);
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
    // 컨테이너 패딩(px-1 = 0.25rem × 2)을 뺀 값과 비교. rem 이라 다이얼을 따라가므로
    // 마법수로 두지 않고 다이얼에서 유도한다 — 2026-08-07 다이얼 1.125×→1.0× 에서
    // 9px→8px 로 움직였고, 이 단언은 `≤` 라 **틀린 값이어도 더 관대해질 뿐 실패하지
    // 않는다**(즉 마법수였다면 조용히 부정확해졌을 자리다).
    const containerPaddingPx = 0.25 * 2 * RENDERED_ROOT_PX;
    expect(STUDY_HEADER_NEED.bothFolded).toBeLessThanOrEqual(MIN_W - containerPaddingPx);
  });

  it('되펴기 dead band 가 요구 폭을 넘지 않는다 — 되편 직후 잘리면 안 된다', () => {
    // 히스테리시스로 되편 순간의 폭이 그 형태의 요구 폭보다 넓어야 한다.
    expect(STUDY_HEADER_FOLD.labelRestoreWidthPx).toBeGreaterThan(STUDY_HEADER_NEED.full);
    expect(STUDY_HEADER_FOLD.timeframeRestoreWidthPx).toBeGreaterThan(STUDY_HEADER_NEED.actionsFolded);
  });
});
