import { describe, expect, it } from 'vitest';
import type { BrokerLateEntryEvent } from '../../api/types';
import { unixMsToKSTHhmm } from '../../util/time';
import { TRADING_TIME_MIN_HHMM } from '../../util/tradingTime';

/**
 * 이 PR 의 **하중을 받는 가정**: 최소 임계로 한 번 조회한 결과를 클라이언트에서
 * `t_ms >= T` 로 거르면, 임계 T 로 조회한 결과와 **정확히 같다**.
 *
 * 그 근거는 백엔드 알고리즘의 성질이다(`hoga/tables/brokers.py`
 * `query_late_entry_events`): 타임스탬프를 오름차순으로 훑으며 임계 이전의
 * (거래원, 방향)은 `seen` 에 넣고, 임계 이후에 처음 보는 것만 이벤트로 낸다.
 * 따라서 이벤트의 `t_ms` 는 그 (거래원, 방향)의 **첫 등장 시각**이고, 임계는
 * "첫 등장이 임계 이전인 것을 뺀다" 와 같다.
 *
 * 여기서는 그 알고리즘을 **그대로 옮겨 놓고** 두 경로의 출력이 같은지 본다 —
 * 프론트가 못 부르는 파이썬 함수의 계약을 프론트 쪽에 고정하는 오라클이다.
 * 백엔드가 이 성질을 깨면(예: 임계 이후 재등장도 이벤트로 내기 시작하면) 이
 * 테스트는 **안 깨진다** — 그건 이 오라클이 못 보는 것이고, 그때는 마커가 조용히
 * 늘어난다. 그래서 백엔드 쪽 알고리즘을 손대면 여기 도크스트링을 먼저 읽을 것.
 */

type Appearance = { hhmm: number; broker: string; side: 'buy' | 'sell' };

/** 백엔드 `query_late_entry_events` 의 오라클 — 주어진 임계에서의 이벤트 목록. */
function backendEvents(
  appearances: readonly Appearance[],
  threshold: number,
): BrokerLateEntryEvent[] {
  const seen = new Set<string>();
  const out: BrokerLateEntryEvent[] = [];
  // 시각 오름차순 — 백엔드의 `for ts_ms in sorted(by_ts)` 와 같은 순서.
  for (const a of [...appearances].sort((x, y) => x.hhmm - y.hhmm)) {
    const key = `${a.broker}:${a.side}`;
    if (a.hhmm < threshold) { seen.add(key); continue; }
    if (!seen.has(key)) {
      out.push({ t_ms: hhmmToMs(a.hhmm), broker: a.broker, side: a.side, net: 1 });
    }
    seen.add(key);
  }
  return out;
}

/** HHMM → 그 날 09:00 을 자정 UTC 로 두는 이 리포의 규약에 맞는 Unix ms. */
function hhmmToMs(hhmm: number): number {
  const base = Date.UTC(2026, 5, 26, 0, 0, 0); // 09:00 KST
  const minutes = (Math.floor(hhmm / 100) - 9) * 60 + (hhmm % 100);
  return base + minutes * 60_000;
}

const APPEARANCES: readonly Appearance[] = [
  { hhmm: 900, broker: '키움', side: 'buy' },
  { hhmm: 905, broker: '미래', side: 'sell' },
  { hhmm: 930, broker: '삼성', side: 'buy' },
  { hhmm: 1000, broker: '키움', side: 'sell' },   // 같은 거래원, 다른 방향
  { hhmm: 1100, broker: '키움', side: 'buy' },    // 재등장 — 이벤트가 아니다
  { hhmm: 1400, broker: 'NH', side: 'buy' },
  { hhmm: 1430, broker: '미래', side: 'buy' },
];

describe('기준 시각은 클라이언트 필터로 대체 가능하다', () => {
  it('최소 임계 조회의 t_ms 는 (거래원, 방향)의 첫 등장이다', () => {
    const all = backendEvents(APPEARANCES, TRADING_TIME_MIN_HHMM);
    expect(all.map((e) => `${e.broker}:${e.side}@${unixMsToKSTHhmm(e.t_ms)}`)).toEqual([
      '키움:buy@900',
      '미래:sell@905',
      '삼성:buy@930',
      '키움:sell@1000',
      'NH:buy@1400',
      '미래:buy@1430',
    ]);
    // 11:00 의 키움 buy 재등장은 빠진다 — 첫 등장이 아니기 때문이다.
    expect(all).toHaveLength(6);
  });

  for (const threshold of [900, 905, 930, 1000, 1100, 1400, 1430, 1500]) {
    it(`임계 ${threshold}: 서버 필터와 클라이언트 필터가 같은 집합을 낸다`, () => {
      const serverSide = backendEvents(APPEARANCES, threshold);
      const clientSide = backendEvents(APPEARANCES, TRADING_TIME_MIN_HHMM)
        .filter((e) => unixMsToKSTHhmm(e.t_ms) >= threshold);
      expect(clientSide).toEqual(serverSide);
    });
  }

  it('경계는 **이상**이다 — 임계와 같은 시각의 첫 등장은 포함된다', () => {
    const at930 = backendEvents(APPEARANCES, 930);
    expect(at930.some((e) => e.broker === '삼성')).toBe(true);
  });

  it('임계를 올리면 집합이 단조 감소한다 (필터 방향 오류의 red-check)', () => {
    const sizes = [900, 1000, 1400, 1500].map(
      (t) => backendEvents(APPEARANCES, TRADING_TIME_MIN_HHMM)
        .filter((e) => unixMsToKSTHhmm(e.t_ms) >= t).length,
    );
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes[0]).toBeGreaterThan(sizes[sizes.length - 1]);
  });
});
