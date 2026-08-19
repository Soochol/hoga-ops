import { describe, it, expect } from 'vitest';
import { detectSurges, detectSurgeSide } from './detectSurges';
import type { QuoteRatioPoint } from '../../api/types';

// detectSurges reads only ask_total/bid_total (close); the Intra-Bar Max fields mirror close here.
const P = (t: number, ask: number, bid: number, tick = 0, band = 99): QuoteRatioPoint => ({
  t, ask_total: ask, bid_total: bid,
  bid_max: bid, ask_max: ask, imb_max_bid: bid, imb_max_ask: ask,
  // 폭 기본값 99 는 "확인 게이트를 통과시키는 아무 값" — 틱이 바뀌는 시점에만 쓰인다.
  band_pct: band, tick,
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
// 호가단위 변화 보정 — 표 트리거 + 폭 확인 게이트. 기본 off.
// 근거·실측: docs/research/2026-08-19-... · ADR-0151 Amendment 2
// ---------------------------------------------------------------------------

describe('호가단위 변화 보정 (tickConfirmRatio)', () => {
  const ON = { ...OPTS, tickConfirmRatio: 0.10 };
  /** t, ask, 틱(원), 폭(%) */
  const Q = (t: number, ask: number, tick: number, band: number) => P(t, ask, 0, tick, band);

  it('옵션이 없으면 틱이 바뀌어도 동작이 그대로다 (기본 off 의 의미)', () => {
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 50, 2), Q(3, 96, 100, 4)];
    expect(detectSurgeSide(pts, 'ask', OPTS)).toHaveLength(1);
  });

  it('틱이 바뀌고 폭도 움직였으면 최고치를 틱 비율로 환산한다', () => {
    // 틱 50 → 100 (2배) & 폭 2% → 4% (100% 변화, 확인 통과) ⇒ 최고치 100 × 2 = 200.
    // 96 은 200 의 48% 라 발사하지 않는다. 보정이 없으면(위 테스트) 발사한다.
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 50, 2), Q(3, 96, 100, 4)];
    expect(detectSurgeSide(pts, 'ask', ON)).toEqual([]);
  });

  it('틱이 줄면 반대 방향으로도 환산한다 (양방향)', () => {
    // 틱 100 → 50 (1/2) & 폭 4% → 2% ⇒ 최고치 200 × 0.5 = 100 → 96 은 96% 라 발사.
    const pts = [Q(1, 200, 100, 4), Q(2, 160, 100, 4), Q(3, 96, 50, 2)];
    const r = detectSurgeSide(pts, 'ask', ON);
    expect(r).toHaveLength(1);
    expect(r[0].prevPeak).toBeCloseTo(100, 6);
  });

  it('배율은 **틱 비율**이지 폭 비율이 아니다', () => {
    // 틱 50 → 100 (2배) 인데 폭은 2% → 6% (3배) — 빈 호가 배수가 함께 바뀐 경우다.
    // 틱 비율로 환산하면 최고치 200, 폭 비율이면 300. 190 은 전자의 95%(발사) ·
    // 후자의 63%(무발사) 라 두 설계가 갈린다.
    //
    // 폭이 아니라 틱을 쓰는 이유: 폭에는 빈 호가 잡음이 곱해져 있어 배율까지 잡음을
    // 탄다. 틱은 가격의 결정론적 함수다(ADR-0151 Amendment 2).
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 50, 2), Q(3, 190, 100, 6)];
    const r = detectSurgeSide(pts, 'ask', ON);
    expect(r).toHaveLength(1);
    expect(r[0].prevPeak).toBeCloseTo(200, 6);
  });

  it('⭐ 확인 게이트 — 틱이 바뀌었다 해도 폭이 안 움직였으면 환산하지 않는다', () => {
    // ETF 는 호가단위가 5원 고정이라 가격이 표의 경계를 넘어도 사다리 폭이 그대로다.
    // 표만 믿고 환산하면 헛교정이 난다. 폭 2% → 2.05%(2.5%, 문턱 10% 미만) ⇒ 거부.
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 50, 2), Q(3, 96, 100, 2.05)];
    expect(detectSurgeSide(pts, 'ask', ON)).toHaveLength(1);
  });

  it('확인 게이트는 **거부권만** 갖는다 — 폭만 흔들려서는 환산이 일어나지 않는다', () => {
    // 폭이 2% → 9% 로 4.5배 흔들려도 틱이 그대로면 아무 일도 없어야 한다.
    // 구안(폭 문턱)이 실패한 지점이 정확히 여기다 — 빈 호가 잡음이 환산을 일으켰다.
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 50, 9), Q(3, 96, 50, 2)];
    expect(detectSurgeSide(pts, 'ask', ON)).toEqual(detectSurgeSide(pts, 'ask', OPTS));
  });

  it('tick 0 은 "틱 0" 이 아니라 "모름" — 건너뛰고 기준도 갱신하지 않는다', () => {
    // 동시호가·합성 갭 점이 0 을 준다. 0 을 기준으로 받으면 다음 실측에서 배율이
    // tk/0 = Infinity 가 되어 최고치가 오염되고 그날 남은 발사가 통째로 사라진다.
    //
    // ⚠ 판별 배치가 중요하다. t2 의 폭까지 0 으로 두면 확인 게이트가 어차피 막아서
    // 게이트를 지워도 결과가 같다(red-check 로 확인). **폭은 멀쩡한데 틱만 모르는**
    // 점을 놓아야 tick>0 가드가 단독으로 붙잡힌다.
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 0, 9), Q(3, 96, 50, 2)];
    expect(detectSurgeSide(pts, 'ask', ON)).toHaveLength(1);
  });

  it('기준 갱신은 양방향이다 — 틱이 내려가도 기준이 따라가야 한다', () => {
    // 틱 100 →(내림) 50 →(다시) 100. 기준이 내림에서 안 따라가면 마지막 100 이
    // "변화 없음"으로 읽혀 환산이 빠지고, 최고치가 좁은 자에 남은 채 비교된다.
    const pts = [
      Q(1, 200, 100, 4), Q(2, 160, 100, 4), Q(3, 96, 50, 2),
      Q(4, 60, 50, 2), Q(5, 190, 100, 4),
    ];
    // t3 에서 200 → 100 으로 환산되고 96 발사. t5 에서 100 → 200 으로 되돌아가므로
    // 190 은 200 의 95% 라 다시 발사한다(기준이 안 따라가면 190 이 100 의 190% 라
    // 이미 신고가 취급되어 마커 위치·개수가 달라진다).
    expect(detectSurgeSide(pts, 'ask', ON).map((m) => m.t)).toEqual([3, 5]);
  });

  it('폭을 못 재면(0) 확인할 방법이 없으므로 환산하지 않는다', () => {
    // 틱은 바뀌었지만 폭이 0(붕괴 사다리)이라 확인 불가 → 모르면 건드리지 않는 쪽.
    const pts = [Q(1, 100, 50, 2), Q(2, 80, 50, 2), Q(3, 96, 100, 0)];
    expect(detectSurgeSide(pts, 'ask', ON)).toHaveLength(1);
  });

  it('기준은 거래일마다 리셋된다 (Past/Today Split Cache 동일성의 조건)', () => {
    // D1 은 앞 두 점의 틱이 0(모름)이라 최고치를 먼저 세우고, 세 번째 점에서 틱 100 이
    // 처음 관측된다. 리셋되면 그것이 D1 의 기준이 될 뿐 환산이 없어 발사한다.
    // 리셋 안 되면 D0 의 기준 50 이 남아 |100/50| 환산이 일어나 발사가 사라진다.
    const pts = [
      Q(D0 + 1, 100, 50, 2), Q(D0 + 2, 80, 50, 2), Q(D0 + 3, 96, 50, 2),
      Q(D0 + DAY + 1, 100, 0, 0), Q(D0 + DAY + 2, 80, 0, 0), Q(D0 + DAY + 3, 96, 100, 9),
    ];
    expect(detectSurgeSide(pts, 'ask', ON).map((m) => m.t)).toEqual([D0 + 3, D0 + DAY + 3]);
  });

  it('청크를 갈라 돌려도 결과가 같다 (cachedPast ++ today === all)', () => {
    const past = [Q(D0 + 1, 100, 50, 2), Q(D0 + 2, 80, 50, 2), Q(D0 + 3, 96, 50, 2)];
    const today = [Q(D0 + DAY + 1, 100, 0, 0), Q(D0 + DAY + 2, 80, 0, 0), Q(D0 + DAY + 3, 96, 100, 9)];
    expect([...detectSurgeSide(past, 'ask', ON), ...detectSurgeSide(today, 'ask', ON)])
      .toEqual(detectSurgeSide([...past, ...today], 'ask', ON));
  });
});
