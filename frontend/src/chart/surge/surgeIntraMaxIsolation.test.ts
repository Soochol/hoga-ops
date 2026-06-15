import { describe, it, expect } from 'vitest';
import type { QuoteRatioPoint } from '../../api/types';
import { detectSurgeSide } from './detectSurges';

const OPTS = { approachRatio: 0.95, rearmRatio: 0.85, isClosingAuction: () => false };

const Q = (
  t: number,
  askTotal: number,
  bidTotal: number,
  askMax: number,
  bidMax: number,
): QuoteRatioPoint => ({
  t,
  ask_total: askTotal,
  bid_total: bidTotal,
  ask_max: askMax,
  bid_max: bidMax,
  imb_max_bid: 0,
  imb_max_ask: 0,
});

describe('Surge 격리 (Q4) — detectSurgeSide는 종가만 읽고 Intra-Bar Max를 무시', () => {
  const ptsAsk = [Q(1, 100, 0, 100, 0), Q(2, 80, 0, 100, 0), Q(3, 96, 0, 100, 0)];

  it('ask: 종가 기준으로만 발사(1건) — ask_max를 읽지 않음', () => {
    const r = detectSurgeSide(ptsAsk, 'ask', OPTS);
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe(3);
    expect(r[0].value).toBe(96);
  });

  it('bid 대칭: bid_total=[100,80,96], bid_max=[100,100,100] → 1건 t=3', () => {
    const ptsBid = [Q(1, 0, 100, 0, 100), Q(2, 0, 80, 0, 100), Q(3, 0, 96, 0, 100)];
    const r = detectSurgeSide(ptsBid, 'bid', OPTS);
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe(3);
    expect(r[0].value).toBe(96);
  });

  it('max 시퀀스가 달라도 결과 동일 — max가 감지에 새지 않음(격리)', () => {
    const sameClose = [Q(1, 100, 0, 130, 0), Q(2, 80, 0, 999, 0), Q(3, 96, 0, 101, 0)];
    expect(detectSurgeSide(sameClose, 'ask', OPTS)).toEqual(detectSurgeSide(ptsAsk, 'ask', OPTS));
  });
});
