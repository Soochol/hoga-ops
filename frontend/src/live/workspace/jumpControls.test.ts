import { describe, expect, it } from 'vitest';
import { jumpReceiverIds } from './jumpControls';
import type { JumpReceiver } from '../../chart/timeframeJump';

const origin = { windowId: 'monthly', group: 1, code: '005930', timeframe: 'M' } satisfies Parameters<typeof jumpReceiverIds>[2];
const target = (windowId: string, timeframe: JumpReceiver['timeframe'], stockCode: string | null = '005930'): JumpReceiver =>
  ({ windowId, timeframe, stockCode, code: stockCode, group: 1 });

describe('jumpReceiverIds', () => {
  it('uses the actual receiver predicate and preserves z order', () => {
    const targets = [target('monthly', 'M'), target('weekly', 'W'), target('daily', 'D'), target('minute', '1m'),
      target('wrong-stock', 'D', '000660'), { ...target('group2', 'W'), group: 2 },
      { ...target('frozen', '1m'), frozen: true }, { ...target('US', '1m'), usInstrument: true }];
    expect(jumpReceiverIds(targets, ['daily', 'minute', 'weekly'], origin, '005930', false))
      .toEqual(['daily', 'minute', 'weekly']);
  });
  it('keeps minute cross-symbol and null-code semantics', () => {
    const targets = [target('cross', '1m', '000660'), target('index', '1m', null), target('calendar', 'D', '000660')];
    expect(jumpReceiverIds(targets, [], origin, '005930', false)).toEqual(['index']);
    expect(jumpReceiverIds(targets, [], origin, '005930', true)).toEqual(['cross', 'index']);
  });
  it('allows calendar-only groups', () => {
    expect(jumpReceiverIds([target('daily', 'D')], [], origin, '005930', false)).toEqual(['daily']);
  });
});
