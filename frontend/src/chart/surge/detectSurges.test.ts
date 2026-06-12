import { describe, it, expect } from 'vitest';
import { detectSurges } from './detectSurges';
import type { QuoteRatioPoint } from '../../api/types';

const P = (t: number, ask: number, bid: number): QuoteRatioPoint => ({ t, ask_total: ask, bid_total: bid });
const OPTS = { margin: 0.5, sessionOpens: [0], isClosingAuction: () => false };

describe('detectSurges', () => {
  it('직전 고가를 +50% 초과하면 발사(ask)', () => {
    const pts = [P(1, 100, 0), P(2, 160, 0)]; // 160 = 100×1.6 > 1.5
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toEqual([{ t: 2, prevPeak: 100, value: 160, pctOver: expect.closeTo(0.6, 2) }]);
    expect(r.bid).toEqual([]);
  });

  it('마진 미달이면 무발사', () => {
    const pts = [P(1, 100, 0), P(2, 140, 0)];
    expect(detectSurges(pts, OPTS).ask).toEqual([]);
  });

  it('래칫 디바운스 — 발사 후 더 높은 고가를 또 초과해야', () => {
    const pts = [P(1, 100, 0), P(2, 170, 0), P(3, 200, 0)];
    expect(detectSurges(pts, OPTS).ask).toHaveLength(1);
  });

  it('연속 에스컬레이션 — 각자 직전 고가 +50% 초과 시 2회', () => {
    const pts = [P(1, 100, 0), P(2, 160, 0), P(3, 250, 0)];
    expect(detectSurges(pts, OPTS).ask).toHaveLength(2);
  });

  it('세션 첫 관측은 비교 대상 없어 무발사(워밍업 불필요)', () => {
    const pts = [P(1, 999, 0), P(2, 1000, 0)];
    expect(detectSurges(pts, OPTS).ask).toEqual([]);
  });

  it('멀티데이 — 세션 경계마다 running peak 리셋', () => {
    const pts = [P(1, 300, 0), P(101, 200, 0)];
    const r = detectSurges(pts, { margin: 0.5, sessionOpens: [0, 100], isClosingAuction: () => false });
    expect(r.ask).toEqual([]);
  });

  it('마감 동시호가 구간은 발사·peak갱신 모두 제외', () => {
    const isClosingAuction = (t: number) => t >= 50 && t < 65; // 60만 동시호가
    const pts = [P(1, 100, 0), P(60, 1000, 0), P(70, 160, 0)];
    const r = detectSurges(pts, { margin: 0.5, sessionOpens: [0], isClosingAuction });
    expect(r.ask).toEqual([{ t: 70, prevPeak: 100, value: 160, pctOver: expect.closeTo(0.6, 2) }]);
  });

  it('ask/bid 독립', () => {
    const pts = [P(1, 100, 100), P(2, 160, 100)];
    const r = detectSurges(pts, OPTS);
    expect(r.ask).toHaveLength(1);
    expect(r.bid).toHaveLength(0);
  });
});
