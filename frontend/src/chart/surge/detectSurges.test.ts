import { describe, it, expect } from 'vitest';
import { detectSurges, detectSurgeSide } from './detectSurges';
import type { QuoteRatioPoint } from '../../api/types';

const P = (t: number, ask: number, bid: number): QuoteRatioPoint => ({ t, ask_total: ask, bid_total: bid });
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

  it('도배 방지 — 85% 아래로 안 빠지면 한 번만', () => {
    // 100 → 80(arm) → 96(발사,disarm) → 97 → 96 → 98 (모두 ≥85, 재무장 X)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 97, 0), P(5, 96, 0), P(6, 98, 0)];
    expect(detectSurges(pts, OPTS).ask).toHaveLength(1);
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

  it('알려진 트레이드오프 — 작은 재접근이 disarm시키면 직후 폭발적 신고가는 재무장 전까지 미발사', () => {
    // 100 → 80(arm) → 96(발사,disarm) → 300(신고가지만 그 사이 85% 아래로 안 빠져 armed=false → 미발사)
    const pts = [P(1, 100, 0), P(2, 80, 0), P(3, 96, 0), P(4, 300, 0)];
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toHaveLength(1);
    expect(r.ask[0].t).toBe(3);
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
