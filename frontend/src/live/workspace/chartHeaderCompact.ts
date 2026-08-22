/**
 * 차트 창 헤더의 접힘 판정 (#762 접힘 정책).
 *
 * 창이 좁아지면 액션 버튼(그리기·보조지표)의 텍스트 라벨을 접고 아이콘만
 * 남긴다. #762 실측: 라벨을 단 헤더는 ~326px 를 쓰고, 그보다 좁아지면
 * `+보조지표` 가 `overflow-hidden` 에 **예고 없이 잘려 사라졌다**(250px 에서
 * 41px 스필). 버튼이 2개뿐이어도 임계는 실재한다.
 *
 * **관측 대상은 헤더 컨테이너 폭이어야 한다.** 내용물 폭(scrollWidth)을 재면
 * `좁음 → 라벨 접기 → 내용물 넓어짐 → 펴기 → 다시 좁음` 으로 진동한다.
 * 컨테이너 폭은 창 크기가 정하므로 접힘이 그것을 되바꾸지 않는다 —
 * `usePaneFolding` 이 컨테이너 *높이* 를 재는 것과 같은 이유다.
 *
 * 순수 판정은 아래 함수로 분리해 테스트가 ResizeObserver 없이 임계·히스테리시스를
 * 직접 검증할 수 있게 한다(훅은 관측만 담당).
 */

/**
 * 아이콘만 남은 액션 버튼의 좌우 여백(px). 기본 `px-2`(8px)는 라벨과 아이콘을
 * 떼어놓기 위한 값이라 라벨이 없으면 순수 낭비다 — 좁히지 않으면 4버튼 완전
 * 접힘이 `MIN_W`(160px)에 들어가지 않는다(실측: 여백 유지 시 181px 필요).
 * 인라인 style 로 적용해야 컴포넌트가 클래스로 들고 있는 `px-2` 를 이긴다.
 */
export const COMPACT_PADDING_INLINE = '4px';

/**
 * `/live` 차트 창 헤더가 각 접힘 단계에서 **실제로 요구하는 폭**(content-box, px).
 *
 * **재실측 2026-08-22** (`/browse` · 다이얼 1.0× · 액션 **6버튼**(hogaplay 소스 추가) ·
 * #905 복제 절차: 헤더를 `width:max-content` 컨테이너에 복제해 자연폭을 읽음.
 * 단계는 east 리사이즈 핸들을 합성 PointerEvent 로 드래그해 재현했다 — 흉내가 아니라
 * 실제 `data-compact*` 속성이 붙은 상태에서 쟀다):
 *
 * | 단계          | 240분 라벨 | 30분 라벨 | 대조군(신규 버튼 제외, 30분) | 종전 상수 |
 * |---------------|------------|-----------|------------------------------|-----------|
 * | full          | **449**    | 442       | 412                          | 412       |
 * | actionsFolded | **286**    | 279       | 257                          | 257       |
 * | bothFolded    | **155**    | 148       | 148 (동일)                   | 148       |
 *
 * **대조군 열이 종전 상수와 정확히 일치한다**(412 / 257 / 148) — 절차가 재현됐다는
 * 뜻이고, 재측정할 때도 이 대조를 남길 것. 신규 버튼 추가분은 하트와 같다:
 * full +30(패딩 `px-2`), 접힌 단계 +22(`COMPACT_PADDING_INLINE`), bothFolded +0.
 *
 * ⚠ **기준 라벨이 30분 → 240분으로 바뀌었다.** 종전 표는 "최장 = 30분" 을 전제했는데
 * `LIVE_TIMEFRAMES` 에는 60·120·240분이 있다(120·240 은 `needsRegularSessionClip` 이
 * 이미 특례로 다루던 그 둘이다). 즉 종전 상수는 240분에서 **이미 7px 모자랐다** —
 * 1단계 임계 414 vs 실요구 419. 무증상이었던 이유는 이 파일이 반복해 경고한 그것이다:
 * 여유가 근거처럼 보였을 뿐이다.
 *
 * ⚠ **측정 규약: 복제본의 raw `max-content` 폭**(컨테이너 `px-1` 8px 을 **포함**).
 * 산문은 한때 content-box 라 적었으나 기록된 숫자는 이쪽이었고(대조군 412 가 그
 * 증거다 — 패딩을 빼면 404), 임계는 padding 을 뺀 `contentRect.width` 와 비교되므로
 * 결과적으로 **8px 보수적으로** 접힌다. 그 편향은 그대로 둔다 — 지금 "고치면"
 * 이 기능과 무관한 모든 창의 접힘 지점이 함께 움직인다.
 *
 * `bothFolded` 에 상태 아이콘이 없는 것은 실수가 아니다 — 그 단계에서는 하트도
 * hogaplay 버튼도 **렌더하지 않는다**(`showsHeaderStateIcons`). 하나만 되살려도
 * 170px 이 필요한데 `MIN_W`(160px) 창의 컨테이너는 158px 이라 12px 넘치고, 넘친 만큼
 * 「수집」이 무성 잘렸다(실측 확인). 둘 다면 192px 로 34px 넘친다.
 *
 * ⚠️ 헤더에 버튼을 더하거나 라벨을 바꾸면 이 값은 **반드시 다시 실측**해야 한다 —
 * 2버튼 시절 값(344)을 그대로 두었다가 71px 부족으로 무성 잘림이 났다(#767).
 * 다이얼(`RENDERED_ROOT_PX`)을 움직일 때도 마찬가지다. **비례 환산으로 때우지 말 것**:
 * 1.125×→1.0× 는 ×0.889 일 것 같지만 실제 비율은 0.905 였다(폰트 폭이 선형이 아니고
 * 아이콘·보더에 고정 px 성분이 섞인다). 환산했다면 6px 틀렸을 값이다.
 */
export const LIVE_HEADER_NEED = {
  /** 다 펴진 상태: 봉 그룹 + 라벨 단 액션 4개 + 상태 아이콘 2개(hogaplay·하트). */
  full: 449,
  /** 1단계: 액션 라벨 접힘(아이콘 4개) + 상태 아이콘 2개 + 봉 그룹. */
  actionsFolded: 286,
  /** 2단계: 봉 드롭다운 + 아이콘 4개. 상태 아이콘 2개는 이 단계에서 빠진다. */
  bothFolded: 155,
} as const;

/** 라벨을 유지할 수 있는 헤더 최소 폭(px) = `full` 요구폭 + 여유 2. */
export const HEADER_LABEL_MIN_WIDTH_PX = LIVE_HEADER_NEED.full + 2;

/** 되펴기 임계 — 접힘/펴짐 경계에서 1px 떨림에 깜빡이지 않도록 dead band 를 둔다.
 *  `usePaneFolding` 의 히스테리시스와 같은 취지. */
export const HEADER_LABEL_RESTORE_WIDTH_PX = HEADER_LABEL_MIN_WIDTH_PX + 24;

/**
 * 봉 컨트롤(일·주·월 버튼)까지 접어야 하는 폭. 라벨을 접어도 헤더는 여전히 폭을
 * 요구하는데 창은 `MIN_W = 160px` 까지 좁아진다 — 그 사이에서 액션 버튼이 다시
 * 조용히 잘렸다. 2단계에서는 일·주·월을 분봉 드롭다운 안으로 합쳐(#762 B 변형이
 * 검증한 모양) 필요 폭을 더 낮춘다.
 *
 * 임계 = `actionsFolded` 요구폭(286, 위 표) + 여유 5 = **291**.
 *
 * ⚠️ **종전 주석의 "213px" 는 2버튼 시절 값이었다**(git 확정: 213 을 쓴 #763 이
 * 저장·수집 버튼을 더한 #767 의 조상). #767 은 1단계 임계만 344→424 로 재측정하고
 * **이 2단계 값은 안 고쳤다** — 바로 그 실수를 경고하는 문장을 같은 파일에 쓰면서.
 * 무증상이었던 이유: 종전 임계 258 이 4버튼 실제 요구폭 254.25(1.125×) 위 3.75px
 * 여유로 **우연히** 살아 있었다. 여유가 근거처럼 보였을 뿐 근거가 아니었다.
 */
export const HEADER_TIMEFRAME_FOLD_WIDTH_PX = LIVE_HEADER_NEED.actionsFolded + 5;
export const HEADER_TIMEFRAME_RESTORE_WIDTH_PX = HEADER_TIMEFRAME_FOLD_WIDTH_PX + 24;

export type HeaderFold = {
  /** 액션 버튼의 텍스트 라벨을 접는다(아이콘만). */
  compactActions: boolean;
  /** 일·주·월을 분봉 드롭다운 안으로 합친다. */
  compactTimeframe: boolean;
};

export const HEADER_FOLD_NONE: HeaderFold = { compactActions: false, compactTimeframe: false };

/**
 * 접힌 단계에서 관심 하트가 더하는 폭(px) — 2026-08-14 실측 Δ(아이콘 12 +
 * `COMPACT_PADDING_INLINE` 4×2 + 부모 `gap-0.5` 2). 펼친 단계에서는 패딩이 `px-2`
 * 라 +30 이다. 여기 있는 것은 **2단계 예산 계산에 쓰이는 값**이라 접힌 쪽이다.
 */
export const HEART_FOLDED_WIDTH_PX = 22;

/**
 * 접힌 단계에서 hogaplay 소스 버튼이 더하는 폭(px) — 2026-08-22 실측 Δ.
 *
 * **하트와 같은 값인 것은 우연이 아니다**: 둘 다 12px 아이콘 + `COMPACT_PADDING_INLINE`
 * 4×2 + 부모 `gap-0.5` 2 인 아이콘 전용 버튼이다. 그래도 상수를 따로 두는 이유는
 * 2단계 예산 계산이 **둘을 각각** 되살렸을 때를 재기 때문이다 — 하나로 묶어 두면
 * "둘 중 하나만 남기면 들어가나" 를 테스트가 물을 수 없다(답은 아니오다: 155+22=177).
 */
export const HOGAPLAY_SOURCE_FOLDED_WIDTH_PX = 22;

/**
 * 이 접힘 단계에서 관심 하트를 렌더하는가(`/live` 차트 창 헤더).
 *
 * **막는 방향**: 2단계 접힘(`compactTimeframe`)에서 하트를 내려, `MIN_W`(160px) 창의
 * 헤더 컨테이너(158px)에 요구폭이 들어가게 한다. 하트를 포함하면 170px 이라 12px
 * 넘치고 오른쪽 끝 「수집」이 overflow-hidden 에 무성 잘린다(#767 과 같은 실패 모드).
 *
 * **못 보는 것**: 이 함수는 폭 예산만 판정한다. 헤더에 **다른** 버튼이 추가되어
 * 예산이 다시 깨지는 것은 막지 못한다 — 그건 `LIVE_HEADER_NEED` 재실측의 몫이다.
 *
 * 판정을 컴포넌트 밖 순수 함수로 두는 이유는 테스트다. `ChartWindow` 는 차트 데이터
 * 파이프라인 전체를 끌고 와서 단위 렌더가 어렵고, 정작 검사하고 싶은 것은 "단계 ↔
 * 폭 예산" 이라는 산술 하나다.
 */
export function showsWatchlistHeart(fold: HeaderFold): boolean {
  return showsHeaderStateIcons(fold);
}

/**
 * 액션 행의 **상태 아이콘**(hogaplay 소스 · 관심 하트)을 이 단계에서 렌더하는가.
 *
 * 둘은 한 예산을 나눠 쓴다 — 하나만 내리면 남은 하나가 `bothFolded` 를 그대로
 * 넘긴다. 그래서 판정을 하나로 두고 `showsWatchlistHeart` 가 여기에 위임한다
 * (그 이름은 호출부 가독성 때문에 남긴다).
 *
 * **막는 방향**: 2단계 접힘(`compactTimeframe`)에서 상태 아이콘을 내려, `MIN_W`
 * (160px) 창의 헤더 컨테이너(158px)에 요구폭이 들어가게 한다. 하트 하나만 포함해도
 * 170px 이라 12px 넘치고 오른쪽 끝 「수집」이 overflow-hidden 에 무성 잘렸다
 * (#767 과 같은 실패 모드). 두 아이콘이면 192px 로 34px 넘친다.
 *
 * **못 보는 것**: 이 함수는 폭 예산만 판정한다. 헤더에 **다른** 버튼이 추가되어
 * 예산이 다시 깨지는 것은 막지 못한다 — 그건 `LIVE_HEADER_NEED` 재실측의 몫이다.
 *
 * 판정을 컴포넌트 밖 순수 함수로 두는 이유는 테스트다. `ChartWindow` 는 차트 데이터
 * 파이프라인 전체를 끌고 와서 단위 렌더가 어렵고, 정작 검사하고 싶은 것은 "단계 ↔
 * 폭 예산" 이라는 산술 하나다.
 */
export function showsHeaderStateIcons(fold: HeaderFold): boolean {
  return !fold.compactTimeframe;
}

/**
 * 한 헤더 표면의 접힘 임계 묶음.
 *
 * **정책은 공유하고 숫자는 표면마다 잰다.** 임계는 그 헤더가 실제로 들고 있는
 * 버튼 수·라벨 길이의 함수라, 액션 4개인 `/live` 값을 액션 2개인 `/study` 에
 * 그대로 쓰면 ~120px 일찍 접힌다. 반대 방향 사고의 전례가 #767 이다 — 2버튼
 * 시절 값(344)을 4버튼 헤더에 방치해 71px 부족으로 `+보조지표` 가 무성 잘렸다.
 */
export type HeaderFoldThresholds = {
  labelMinWidthPx: number;
  labelRestoreWidthPx: number;
  timeframeFoldWidthPx: number;
  timeframeRestoreWidthPx: number;
};

/** `/live` 차트 창 헤더 — 액션 4버튼(그리기·보조지표·저장뷰·수집) 실측. */
export const LIVE_HEADER_FOLD: HeaderFoldThresholds = {
  labelMinWidthPx: HEADER_LABEL_MIN_WIDTH_PX,
  labelRestoreWidthPx: HEADER_LABEL_RESTORE_WIDTH_PX,
  timeframeFoldWidthPx: HEADER_TIMEFRAME_FOLD_WIDTH_PX,
  timeframeRestoreWidthPx: HEADER_TIMEFRAME_RESTORE_WIDTH_PX,
};

/**
 * `/study` 차트 창 헤더가 각 접힘 단계에서 **실제로 요구하는 폭**(content-box, px).
 *
 * 실측 방법(#905, 2026-07-29 최초 · 2026-08-07 재측정): `/browse` 로 실제 저장뷰를
 * 열고 헤더를 자유 폭 컨테이너에 복제해 `max-content` 폭을 잰 뒤 컨테이너 패딩을
 * 뺐다. 창 폭을 0.72 → 0.13(=`MIN_W`)까지 좁혀 가며 단계별로 반복.
 *
 * 불변 확인: **두 테마(obsidian·ledger) 동일**(DESIGN.md 의 "테마는 색만" 과 일치),
 * **최장 분봉 라벨(30분)에서도 동일**(봉 라벨이 `tnum` 이라 자릿수 폭이 같다).
 *
 * ⚠️ 관측값은 `ResizeObserver` 의 `contentRect.width`(**content-box**)라 컨테이너
 * 좌우 패딩(`px-1` = 0.25rem×2 → 1.0× 다이얼에서 8px; 1.125× 시절 9px)을 이미 뺀
 * 값이다 — `clientWidth` 로 비교하면 어긋난다.
 *
 * **재측정 2026-08-07** (다이얼 1.125×→1.0× 변경에 맞춰. 30분 라벨 기준, content-box):
 *
 * | 단계          | 1.0× (현행) | 1.125× (종전) | 종전 상수 |
 * |---------------|-------------|---------------|-----------|
 * | full          | **272**     | 300.75        | 303       |
 * | actionsFolded | **185**     | 201.75        | 202       |
 * | bothFolded    | **98**      | 104.25        | 104       |
 *
 * 오른쪽 두 열이 1~2px 안에서 맞는 것이 **절차가 재현됐다는 증거**다 — 재측정할 때도
 * 옛 밀도를 함께 재서 이 대조를 남길 것. 다이얼만 바꾸고 이 표를 안 고치면 임계가
 * 필요보다 이르게 접는 쪽으로 치우친다(무성 회귀: 라벨이 들어갈 폭에서도 접힌다).
 * **비례 환산으로 때우지 말 것** — 실측 비율은 0.904 였고 ×0.889 로 계산했다면
 * full 에서 4px 틀렸다. 이 파일이 이미 두 번 경고한 대로 3px 차이가 무성 잘림을 냈다.
 */
export const STUDY_HEADER_NEED = {
  /** 다 펴진 상태: 봉 그룹 + 라벨 단 액션 2개. */
  full: 272,
  /** 1단계: 액션 라벨만 접음(아이콘 2개) + 봉 그룹 유지. */
  actionsFolded: 185,
  /** 2단계: 봉 드롭다운 + 아이콘 2개. 이보다 좁아지면 더 접을 게 없다. */
  bothFolded: 98,
} as const;

/** 되펴기 dead band 와 별개인 접힘 여유 — 폰트 렌더 편차·소수 픽셀 반올림 몫. */
const STUDY_FOLD_MARGIN_PX = 16;

/**
 * `/study` 차트 창 헤더 — 액션 **2버튼**(그리기·보조지표). 저장뷰 저장·수집은
 * `/study` 에 없다(지도 #900 Out of scope).
 *
 * 임계를 실측값에서 **파생**시킨다. 재측정하면 위 숫자 하나만 고치면 되고,
 * "임계가 그 단계의 요구 폭보다 큰가" 를 테스트가 기계적으로 검사할 수 있다.
 *
 * `/live` 값을 그대로 쓰면 **양방향으로 틀린다**(2026-08-07 실측 기준):
 * - 1단계 384 는 너무 커서 라벨이 **96px 일찍** 사라지고(`/study` 는 288 이면 된다),
 * - 2단계 240 은 너무 커서 일·주·월이 **39px 일찍** 사라진다(1단계 형태는 201 이면 된다).
 *
 * 어림도 못 미덥다 — "액션 2개는 4개의 절반" 으로 잡은 잠정값 300 은 당시 실측 303 보다
 * **3px 모자랐다**. 그대로 뒀으면 경계 폭에서 `보조지표` 가 무성 잘리는 #767 의
 * 재현이다. 반대 방향 전례도 같은 파일이 경고하고 있었다.
 */
export const STUDY_HEADER_FOLD: HeaderFoldThresholds = {
  labelMinWidthPx: STUDY_HEADER_NEED.full + STUDY_FOLD_MARGIN_PX,
  labelRestoreWidthPx: STUDY_HEADER_NEED.full + STUDY_FOLD_MARGIN_PX + 24,
  timeframeFoldWidthPx: STUDY_HEADER_NEED.actionsFolded + STUDY_FOLD_MARGIN_PX,
  timeframeRestoreWidthPx: STUDY_HEADER_NEED.actionsFolded + STUDY_FOLD_MARGIN_PX + 24,
};

/**
 * 폭과 직전 상태로 다음 접힘 단계를 정한다. 각 단계는 자기 dead band 안에서
 * 직전 상태를 유지하므로 같은 입력·같은 직전 상태에 대해 멱등이다
 * (StrictMode 이중 렌더 안전).
 *
 * 폭 0 은 "아직 측정 전"(마운트 직후·display:none)이라 접지 않는다 — 첫 프레임에
 * 라벨이 깜빡 사라졌다 나타나는 것을 막는다.
 */
export function nextHeaderFold(
  widthPx: number,
  prev: HeaderFold,
  thresholds: HeaderFoldThresholds = LIVE_HEADER_FOLD,
): HeaderFold {
  if (widthPx <= 0) return prev;
  return {
    compactActions: prev.compactActions
      ? widthPx < thresholds.labelRestoreWidthPx
      : widthPx < thresholds.labelMinWidthPx,
    compactTimeframe: prev.compactTimeframe
      ? widthPx < thresholds.timeframeRestoreWidthPx
      : widthPx < thresholds.timeframeFoldWidthPx,
  };
}
