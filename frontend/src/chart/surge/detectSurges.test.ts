import { describe, it, expect } from 'vitest';
import { detectSurges, detectSurgeSide } from './detectSurges';
import type { QuoteRatioPoint } from '../../api/types';

// detectSurges reads only ask_total/bid_total (close); the Intra-Bar Max fields mirror close here.
const P = (t: number, ask: number, bid: number): QuoteRatioPoint => ({
  t, ask_total: ask, bid_total: bid,
  bid_max: bid, ask_max: ask, imb_max_bid: bid, imb_max_ask: ask,
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
