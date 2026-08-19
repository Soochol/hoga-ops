import { describe, it, expect } from 'vitest';
import { detectSurges, detectSurgeSide } from './detectSurges';
import type { QuoteRatioPoint } from '../../api/types';

// detectSurges reads only ask_total/bid_total (close); the Intra-Bar Max fields mirror close here.
const P = (t: number, ask: number, bid: number, band = 0): QuoteRatioPoint => ({
  t, ask_total: ask, bid_total: bid,
  bid_max: bid, ask_max: ask, imb_max_bid: bid, imb_max_ask: ask, band_pct: band,
});
const OPTS = { approachRatio: 0.95, rearmRatio: 0.85, isClosingAuction: () => false };
const DAY = 86_400_000;
const D0 = 1_779_062_400_000; // 어느 거래일 09:00 KST (테스트 기준점)

describe('detectSurges (근접 + 히스테리시스)', () => {
  it('직전 고가의 95%까지 재차오르면 발사 (재무장 후)', () => {
    // 100(고가) → 80(<85% 재무장) → 96(≥95% 발사)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0)];
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toEqual([{ t: 3, prevPeak: 100, value: 96, pctOfPeak: expect.closeTo(0.96, 2) }]);
    expect(r.bid).toEqual([]);
  });

  it('quiet-start — 첫 고가가 세워질 땐 무발사(85% 아래로 빠진 적 없음)', () => {
    // 100 → 98: 98은 85%~100% 사이라 재무장도 발사도 없음(아직 한 번도 안 빠짐)
    const pts = [P(1, 100, 0), P(2, 98, 0)];
    expect(detectSurges(pts, OPTS).ask).toEqual([]);
  });

  it('도배 방지 — 85% 아래로 안 빠지고 직전 고가도 안 넘으면 발사 지점 고정', () => {
    // 100 → 80(arm) → 96(발사,disarm) → 97 → 96 → 98 (모두 직전고가 100 미만 & ≥85, 재무장 X)
    // 97·96·98 은 신고가(>100)가 아니므로 마커 이동도 없어야 한다 — 발사 지점 t3/96 에 고정.
    // (잘못된 이동 조건 `v > 발사값`이면 마커가 98로 끌려가며 이 단언이 깨진다.)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 97, 0), P(5, 96, 0), P(6, 98, 0)];
    const r = detectSurges(pts, OPTS).ask;
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe(3);
    expect(r[0].value).toBe(96);
  });

  it('발사 후 재무장 없이 신고가가 계속되면 마커를 마지막 꼭대기로 이동', () => {
    // 100 → 80(arm) → 96(발사 t3) → 110(신고가→이동 t4) → 120(이동 t5) → 100(<85%*120 재무장)
    // 같은 상승 구간이라 동그라미 1개가 그 구간 최종 꼭대기(120, t5)에 자리잡는다.
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 110, 0), P(5, 120, 0), P(6, 100, 0)];
    const r = detectSurges(pts, OPTS).ask;
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe(5);
    expect(r[0].value).toBe(120);
  });

  it('이동 후 85% 아래로 빠졌다 다시 도달하면 새 마커(이동과 재발사 구분)', () => {
    // 100 → 80(arm) → 96(발사 t3) → 110(이동 t4) → 80(<85%*110 재무장) → 105(≥95%*110 재발사 t6)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 110, 0), P(5, 80, 0), P(6, 105, 0)];
    const r = detectSurges(pts, OPTS).ask;
    expect(r).toHaveLength(2);
    expect(r[0].t).toBe(4); // 첫 사이클: 이동된 꼭대기 110
    expect(r[0].value).toBe(110);
    expect(r[1].t).toBe(6); // 둘째 사이클: 재발사
    expect(r[1].value).toBe(105);
  });

  it('재무장 후 재발사 — 85% 아래로 빠졌다 다시 95% 도달', () => {
    // 100 → 80(arm) → 96(발사) → 82(<85 재무장) → 97(재발사)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 82, 0), P(5, 97, 0)];
    expect(detectSurges(pts, OPTS).ask).toHaveLength(2);
  });

  it('신고가 갱신 중에도 발사(≥95%이므로) — pctOfPeak ≥ 1', () => {
    // 100 → 80(arm) → 150(신고가, 150≥95이므로 발사; prevPeak=100)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 150, 0)];
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toEqual([{ t: 3, prevPeak: 100, value: 150, pctOfPeak: expect.closeTo(1.5, 2) }]);
  });

  it('작은 재접근으로 발사 후 폭발적 신고가가 나오면 마커가 그 꼭대기로 이동', () => {
    // 100 → 80(arm) → 96(발사,disarm) → 300(신고가). 예전엔 재무장 전이라 미발사 트레이드오프였으나,
    // 이제 disarm 상태에서 신고가가 나오면 마커를 그 봉으로 이동 → 동그라미가 폭발 꼭대기 300(t4)에 앉는다.
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 300, 0)];
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toHaveLength(1);
    expect(r.ask[0].t).toBe(4);
    expect(r.ask[0].value).toBe(300);
  });

  it('멀티데이 — 거래일(KST) 경계마다 running peak·무장 리셋', () => {
    // 전일: 100(고가)→80(arm)→96(발사). 당일: 95(전일과 무관, 당일 첫 고가라 무발사)
    const pts = [P(D0, 100, 0), P(D0 + 60_000, 80, 0), P(D0 + 120_000, 96, 0), P(D0 + DAY, 95, 0)];
    expect(detectSurges(pts, OPTS).ask).toHaveLength(1); // 전일 1건만, 당일 0건
  });

  it('마감 동시호가 구간은 발사·peak갱신 모두 제외', () => {
    const isClosingAuction = (t: number) => t >= 50 && t < 65; // 60만 동시호가
    // 100 → 80(arm) → 60[동시호가 제외] → 96(발사)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(60, 9999, 0), P(70, 96, 0)];
    const r = detectSurges(pts, { approachRatio: 0.95, rearmRatio: 0.85, isClosingAuction });
    expect(r.ask).toEqual([{ t: 70, prevPeak: 100, value: 96, pctOfPeak: expect.closeTo(0.96, 2) }]);
  });

  it('ask/bid 독립', () => {
    const pts = [P(1, 100, 50), P(2, 80, 50), P(3, 96, 50)];
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toHaveLength(1);
    expect(r.bid).toHaveLength(0);
  });

  it('detectSurgeSide는 한 side만 계산', () => {
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0)];
    expect(detectSurgeSide(pts, 'ask', OPTS)).toHaveLength(1);
    expect(detectSurgeSide(pts, 'bid', OPTS)).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// 호가단위 변화 보정 (widthStepRatio) — 기본 off. 근거·실측은
// docs/research/2026-08-19-hoga-tick-band-totals-normalization.md
// ---------------------------------------------------------------------------

describe('호가단위 변화 보정 (widthStepRatio)', () => {
  const ON = { ...OPTS, widthStepRatio: 0.25 };

  it('옵션이 없으면 band_pct 가 아무리 튀어도 동작이 그대로다 (기본 off 의 의미)', () => {
    // 폭이 2 → 6 (3배) 로 튀지만 보정이 꺼져 있으므로 100 기준 그대로 → 96 이 발사.
    const pts = [P(1, 100, 0, 2), P(2, 80, 0, 2), P(3, 96, 0, 6)];
    expect(detectSurgeSide(pts, 'ask', OPTS)).toHaveLength(1);
  });

  it('폭이 문턱을 넘게 커지면 최고치를 폭비로 환산해 헛발사를 막는다', () => {
    // 폭 2 → 6 (3배, 문턱 25% 초과) ⇒ 최고치 100 × 3 = 300.
    // 96 은 300 의 32% 라 발사하지 않는다. 보정이 없으면(위 테스트) 발사한다.
    const pts = [P(1, 100, 0, 2), P(2, 80, 0, 2), P(3, 96, 0, 6)];
    expect(detectSurgeSide(pts, 'ask', ON)).toEqual([]);
  });

  it('폭이 줄어들면 반대 방향으로도 환산한다 (양방향)', () => {
    // 폭 6 → 2 (1/3) ⇒ 최고치 300 × (1/3) = 100. 96 은 그 96% 라 발사.
    // 환산이 한쪽 방향만이면 최고치가 300 으로 남아 이 단언이 깨진다.
    const pts = [P(1, 300, 0, 6), P(2, 240, 0, 6), P(3, 96, 0, 2)];
    const r = detectSurgeSide(pts, 'ask', ON);
    expect(r).toHaveLength(1);
    expect(r[0].prevPeak).toBeCloseTo(100, 6);
  });

  it('문턱 안의 폭 흔들림은 무시한다 (빈 호가로 인한 분단위 출렁임)', () => {
    // 폭 2 → 2.4 (20%, 문턱 25% 미만) ⇒ 환산 없음 → 96 이 100 의 96% 로 발사.
    const pts = [P(1, 100, 0, 2), P(2, 80, 0, 2), P(3, 96, 0, 2.4)];
    expect(detectSurgeSide(pts, 'ask', ON)).toHaveLength(1);
  });

  it('band_pct 0 은 "폭 0" 이 아니라 "잴 수 없음" — 건너뛰고 기준도 갱신하지 않는다', () => {
    // 동시호가·3단 붕괴 사다리·합성 갭 점이 0 을 준다. 0 을 폭으로 **받아들이면**
    // 기준이 0 이 되고, 그 뒤 첫 실측 폭에서 w/0 = Infinity 배율이 나와 최고치가
    // NaN 으로 오염돼 그날 남은 발사가 통째로 사라진다.
    //
    // 판별 배치: 폭 2 → 0(못 잼) → 2. 게이트가 있으면 기준은 내내 2 라 환산이 없고
    // 96 이 100 의 96% 로 **발사**한다. 게이트가 없으면 t2 에서 기준이 0 이 되고
    // t3 에서 최고치가 NaN 이 되어 발사가 사라진다.
    // (0 → 6 배치로 쓰면 깨진 구현도 "발사 안 함"이라 구분되지 않는다 — red-check 로 확인.)
    const pts = [P(1, 100, 0, 2), P(2, 80, 0, 0), P(3, 96, 0, 2)];
    expect(detectSurgeSide(pts, 'ask', ON)).toHaveLength(1);
    // 폭이 계속 0 이면 보정이 통째로 비활성 — 보정 없는 결과와 같아야 한다.
    const allZero = [P(1, 100, 0, 0), P(2, 80, 0, 0), P(3, 96, 0, 0)];
    expect(detectSurgeSide(allZero, 'ask', ON)).toEqual(detectSurgeSide(allZero, 'ask', OPTS));
  });

  it('기준 폭은 거래일마다 리셋된다 (Past/Today Split Cache 동일성의 조건)', () => {
    // ⚠ 순진한 배치(D1 의 첫 점이 실측 폭)로는 이 성질을 못 잰다 — 거래일 경계에서
    // runningMax 가 0 으로 리셋되므로 기준 폭이 새어도 `0 × 배율 = 0` 이라 결과가
    // 같다(red-check 로 확인). 기준 폭 누수가 **드러나려면** D1 이 최고치를 먼저
    // 세운 뒤에 첫 실측 폭이 와야 한다.
    //
    // 그래서 D1 의 앞 두 점은 폭을 못 재는 점(0)으로 두어 최고치 100 을 세우고,
    // 세 번째 점에서 폭 6 이 처음 관측되게 한다.
    //   리셋 O → 기준이 null 이라 6 을 기준으로 잡을 뿐, 환산 없음 → 96/100 = 96% 발사
    //   리셋 X → D0 의 기준 2 가 남아 |6/2−1| = 2 > 0.25 → 최고치 100×3 = 300 → 무발사
    const pts = [
      P(D0 + 1, 100, 0, 2), P(D0 + 2, 80, 0, 2), P(D0 + 3, 96, 0, 2),
      P(D0 + DAY + 1, 100, 0, 0), P(D0 + DAY + 2, 80, 0, 0), P(D0 + DAY + 3, 96, 0, 6),
    ];
    const r = detectSurgeSide(pts, 'ask', ON);
    expect(r.map((m) => m.t)).toEqual([D0 + 3, D0 + DAY + 3]);
  });

  it('청크를 갈라 돌려도 결과가 같다 (cachedPast ++ today === all)', () => {
    const past = [P(D0 + 1, 100, 0, 2), P(D0 + 2, 80, 0, 2), P(D0 + 3, 96, 0, 2)];
    const today = [P(D0 + DAY + 1, 100, 0, 0), P(D0 + DAY + 2, 80, 0, 0), P(D0 + DAY + 3, 96, 0, 6)];
    expect([...detectSurgeSide(past, 'ask', ON), ...detectSurgeSide(today, 'ask', ON)])
      .toEqual(detectSurgeSide([...past, ...today], 'ask', ON));
  });
});
