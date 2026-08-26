import { describe, expect, it } from 'vitest';

import {
  MINUTE_RIGHT_LABEL_GUTTER_PX,
  maxRenderableSpan,
  minuteRestoreGeometry,
  minuteRightOffsetBars,
  pickSwapAnchor,
  sourceSwapReseatRange,
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

describe('sourceSwapReseatRange', () => {
  // 2026-08-24 실측(462350, 10분봉): 벤더 195봉 → 디스크 122봉, 화면 span 234.
  // lwc 는 마지막 봉 기준 오프셋만 보존해 `[-73, 161]` 에 착지했다 — 왼쪽 73봉이 빈다.
  const LATEST = 121;

  it('live edge: span 을 데이터 크기로 접어 왼쪽 여백을 없앤다', () => {
    const r = sourceSwapReseatRange({
      atLiveEdge: true,
      spanBars: 234,
      totalBars: 122,
      latestIdx: LATEST,
      anchorIdx: LATEST,
      initialVisibleBars: 300,
      rightOffsetBars: 40,
    });
    // 데이터가 300봉보다 적으므로 화면이 데이터 전체(122봉)를 담는다.
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST + 1 + 40);
    // 회귀의 지문: 왼쪽이 음수면 그만큼이 빈 공간이 된다.
    expect(r.from).toBeGreaterThanOrEqual(0);
  });

  it('live edge: 화면에 떠 있던 오른쪽 여백을 그대로 쓴다(정책 재계산이 아니라)', () => {
    // 2026-08-24 사용자 보고: 라이브 엣지에서 토글했더니 여백이 67 → 80 바로 늘어
    // 캔들이 왼쪽으로 밀리고 오른쪽이 비었다. 화면 값은 초기 배치 이후 SSE 성장·
    // 리사이즈·lwc 클램프를 거친 것이라 정책 재계산과 일치하지 않는다.
    const r = sourceSwapReseatRange({
      atLiveEdge: true,
      spanBars: 262,
      totalBars: 193,
      latestIdx: 192,
      anchorIdx: 192,
      initialVisibleBars: 300,
      rightOffsetBars: 80,        // 정책 재계산값 — 이걸 쓰면 캔들이 밀린다
      savedRightPaddingBars: 67,  // 화면에 떠 있던 값
    });
    expect(r.to).toBe(193 + 67);
    expect(r.from).toBe(0);
  });

  it('live edge: 여백을 못 재면 정책값으로 폴백한다', () => {
    const r = sourceSwapReseatRange({
      atLiveEdge: true,
      spanBars: 262,
      totalBars: 193,
      latestIdx: 192,
      anchorIdx: 192,
      initialVisibleBars: 300,
      rightOffsetBars: 80,
      savedRightPaddingBars: null,
    });
    expect(r.to).toBe(193 + 80);
  });

  it('live edge: 병적 여백은 계승하지 않고 정책값으로 폴백한다', () => {
    // 2026-08-25 실측(000660, 5분봉, 장중): 좌초된 뷰포트(데이터 우측 ~3,400바 밖)의
    // 여백이 lwc scrollPosition 으로 고착된 뒤, 재착석의 여백 계승이 그 값(3,534바)을
    // '화면에 떠 있던 여백'으로 오인해 토글 양방향에서 충실히 복제했다 — 눌러도 눌러도
    // 빈 화면. 계승 계약("재계산하면 캔들이 밀린다")은 정책값 근처의 값에만 성립한다:
    // 어떤 정상 상태에서도 여백이 화면에 보일 데이터(visibleBars)를 넘을 수 없으므로,
    // 그 밖의 값은 오염으로 보고 정책값으로 폴백한다.
    const r = sourceSwapReseatRange({
      atLiveEdge: true,
      spanBars: 3535,
      totalBars: 3725,
      latestIdx: 3724,
      anchorIdx: 3724,
      initialVisibleBars: 300,
      rightOffsetBars: 80,
      savedRightPaddingBars: 3534, // 좌초가 만든 값 — 여백일 수 없는 크기
    });
    expect(r.to).toBe(3725 + 80);
    expect(r.from).toBe(3725 - 300);
  });

  it('live edge: 계승 상한은 max(정책 여백, visibleBars) — 경계는 계승, 그 위는 폴백', () => {
    const base = {
      atLiveEdge: true,
      spanBars: 262,
      totalBars: 193, // visibleBars = min(193, 300) = 193 > 정책 80 → 상한 193
      latestIdx: 192,
      anchorIdx: 192,
      initialVisibleBars: 300,
      rightOffsetBars: 80,
    };
    // 경계값(=193)은 화면 값으로 인정 — 계승.
    expect(sourceSwapReseatRange({ ...base, savedRightPaddingBars: 193 }).to).toBe(193 + 193);
    // 경계 초과(194)는 오염 — 정책값 폴백.
    expect(sourceSwapReseatRange({ ...base, savedRightPaddingBars: 194 }).to).toBe(193 + 80);
  });

  it('live edge: 데이터가 목표보다 많으면 초기 목표 봉 수를 지킨다', () => {
    const r = sourceSwapReseatRange({
      atLiveEdge: true,
      spanBars: 234,
      totalBars: 1000,
      latestIdx: 999,
      anchorIdx: 999,
      initialVisibleBars: 300,
      rightOffsetBars: 40,
    });
    expect(r.from).toBe(1000 - 300);
    expect(r.to).toBe(1000 + 40);
  });

  it('panned: 앵커를 오른쪽 끝에 두고 span 만 데이터로 클램프한다', () => {
    const r = sourceSwapReseatRange({
      atLiveEdge: false,
      spanBars: 234,
      totalBars: 500,
      latestIdx: 499,
      anchorIdx: 300,
      initialVisibleBars: 300,
      rightOffsetBars: 40,
    });
    expect(r.to).toBe(300);
    expect(r.to - r.from).toBe(234);
  });

  it('panned: 앵커가 span 보다 왼쪽이어도 from 이 음수로 내려가지 않는다', () => {
    const r = sourceSwapReseatRange({
      atLiveEdge: false,
      spanBars: 234,
      totalBars: 500,
      latestIdx: 499,
      anchorIdx: 10,
      initialVisibleBars: 300,
      rightOffsetBars: 40,
    });
    expect(r.from).toBe(0);
    expect(r.to).toBe(234);
  });

  it('앵커를 못 구하면 라이브 엣지 배치로 폴백한다', () => {
    const r = sourceSwapReseatRange({
      atLiveEdge: false,
      spanBars: 234,
      totalBars: 122,
      latestIdx: LATEST,
      anchorIdx: null,
      initialVisibleBars: 300,
      rightOffsetBars: 40,
    });
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST + 1 + 40);
  });
});

describe('pickSwapAnchor — 강제 이동은 사용자의 앵커를 잃게 하지 않는다', () => {
  const base = { hasForced: true, freshAtLiveEdge: false, freshIdx: 100, landedIdx: 100, spanBars: 300 };

  it('보관된 앵커가 없으면 fresh — 평시 스왑은 종전 동작 그대로다', () => {
    expect(pickSwapAnchor({ ...base, hasForced: false })).toBe('fresh');
  });

  it('착지점에서 안 움직였으면 forced — 왕복이 원위치로 돌아오는 경로', () => {
    expect(pickSwapAnchor({ ...base, freshIdx: 120, landedIdx: 100 })).toBe('forced');
  });

  it('허용 반경은 화면 폭 — 딱 span 이내면 아직 「안 움직임」이다', () => {
    expect(pickSwapAnchor({ ...base, freshIdx: 400, landedIdx: 100, spanBars: 300 })).toBe('forced');
    expect(pickSwapAnchor({ ...base, freshIdx: 401, landedIdx: 100, spanBars: 300 })).toBe('fresh');
  });

  it('한 화면 넘게 움직였으면 fresh — 새 의도가 복원을 이긴다', () => {
    expect(pickSwapAnchor({ ...base, freshIdx: 900, landedIdx: 100 })).toBe('fresh');
  });

  it('라이브 엣지는 명시적 의도라 휴리스틱보다 먼저다 — 거리와 무관하게 fresh', () => {
    expect(pickSwapAnchor({ ...base, freshAtLiveEdge: true, freshIdx: 100, landedIdx: 100 })).toBe('fresh');
  });

  it('재투영 실패(null)는 검증 불가 → 보수적으로 fresh (잘못된 복원 > 복원 없음)', () => {
    expect(pickSwapAnchor({ ...base, freshIdx: null })).toBe('fresh');
    expect(pickSwapAnchor({ ...base, landedIdx: null })).toBe('fresh');
  });
});

