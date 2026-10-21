import { describe, expect, it } from 'vitest';
import type { RankingKind, RankingRow } from '../api/liveRankings';
import { rankingMetricFor } from './rankingMetric';

const row: RankingRow = { rank: 1, code: '005930', name: '삼성전자', price: 71200, change_pct: 5.79, trade_value_won: null };

describe('ranking metrics', () => {
  it.each([
    ['change', { change_won: 1200 }, '+1,200원'],
    ['change', { change_won: -1200 }, '-1,200원'],
    ['change', { change_won: -0 }, '0원'],
    ['surge', { volume_surge_pct: -25.5 }, '-25.5%'],
    ['surge', { volume_surge_pct: Infinity }, '—'],
    ['volume', { volume: 9999 }, '9,999주'],
    ['volume', { volume: 10000 }, '1만주'],
    ['volume', { volume: 12345678 }, '1,235만주'],
    ['volume', { volume: -1 }, '—'],
    ['volume', { volume: 1.5 }, '—'],
    ['change', {}, '—'], ['surge', {}, '—'], ['volume', {}, '—'],
  ] satisfies [RankingKind, Partial<RankingRow>, string][])(
    '%s formats its own metric and preserves absent data', (kind, metric, text) => {
      expect(rankingMetricFor({ ...row, ...metric }, kind)?.text).toBe(text);
    },
  );
});
