import { describe, it, expect } from 'vitest';
import { paneSpecsForTimeframe, type PaneToggles } from './paneSpecsForTimeframe';
import { type LiveTimeframe } from '../state/livePage';
import { PANE_SPECS } from '../chart/paneSpecs';
import { CANDLE_SPEC } from '../chart/projectors/candle';
import { VOLUME_SPEC } from '../chart/projectors/volume';

describe('paneSpecsForTimeframe', () => {
  it.each(['1m', '3m', '5m', '10m', '15m', '30m'] as const)(
    'minute timeframe %s → full 5-pane registry (PANE_SPECS identity)',
    (tf) => {
      expect(paneSpecsForTimeframe(tf)).toBe(PANE_SPECS);
    },
  );

  it.each(['D', 'W', 'M'] as const)(
    'calendar timeframe %s → only candle + volume',
    (tf) => {
      const result = paneSpecsForTimeframe(tf);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(CANDLE_SPEC);
      expect(result[1]).toBe(VOLUME_SPEC);
    },
  );

  it('minute timeframes share the SAME array reference (memoization)', () => {
    expect(paneSpecsForTimeframe('1m')).toBe(paneSpecsForTimeframe('5m'));
  });

  it('calendar timeframes share the SAME array reference (memoization)', () => {
    expect(paneSpecsForTimeframe('D')).toBe(paneSpecsForTimeframe('W'));
  });

  it('minute timeframes ignore investor toggles entirely', () => {
    expect(paneSpecsForTimeframe('1m', { foreignNet: true, institutionNet: true })).toBe(PANE_SPECS);
  });

  it('D + foreign toggle appends the foreign pane', () => {
    expect(paneSpecsForTimeframe('D', { foreignNet: true, institutionNet: false }).map((s) => s.name))
      .toEqual(['candle', 'volume', 'investor-foreign']);
  });

  it('D + institution toggle appends the institution pane in the correct slot', () => {
    // Spec-level self-heal: institution alone still lands right after volume,
    // because paneSpecsForTimeframe always emits canonical order (no hole left
    // by the absent foreign pane).
    expect(paneSpecsForTimeframe('D', { foreignNet: false, institutionNet: true }).map((s) => s.name))
      .toEqual(['candle', 'volume', 'investor-institution']);
  });

  it('D + both toggles appends foreign THEN institution (canonical order)', () => {
    expect(paneSpecsForTimeframe('D', { foreignNet: true, institutionNet: true }).map((s) => s.name))
      .toEqual(['candle', 'volume', 'investor-foreign', 'investor-institution']);
  });

  it('W and M never get investor panes even with toggles on (daily-only)', () => {
    for (const tf of ['W', 'M'] as const) {
      expect(paneSpecsForTimeframe(tf, { foreignNet: true, institutionNet: true }).map((s) => s.name))
        .toEqual(['candle', 'volume']);
    }
  });

  it('volumeEnabled:false drops the volume pane on minute timeframes', () => {
    expect(
      paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false, volumeEnabled: false }).map((s) => s.name),
    ).toEqual(['candle', 'quote-totals', 'ratio', 'fill-strength', 'program-trade']);
  });

  it('volumeEnabled:false drops the volume pane on calendar timeframes', () => {
    expect(
      paneSpecsForTimeframe('D', { foreignNet: false, institutionNet: false, volumeEnabled: false }).map((s) => s.name),
    ).toEqual(['candle']);
  });

  it('volumeEnabled:false + investor on → candle then investor, no volume', () => {
    expect(
      paneSpecsForTimeframe('D', { foreignNet: true, institutionNet: true, volumeEnabled: false }).map((s) => s.name),
    ).toEqual(['candle', 'investor-foreign', 'investor-institution']);
  });

  it('volumeEnabled omitted defaults to true (volume present)', () => {
    expect(paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false })).toBe(PANE_SPECS);
  });

  it('volume-off minute frames share a stable (frozen) array reference', () => {
    const a = paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false, volumeEnabled: false });
    const b = paneSpecsForTimeframe('5m', { foreignNet: false, institutionNet: false, volumeEnabled: false });
    expect(a).toBe(b);
  });
});

describe('paneSpecsForTimeframe — 호가 토글', () => {
  const names = (tf: LiveTimeframe, t: PaneToggles) => paneSpecsForTimeframe(tf, t).map((s) => s.name);

  it('기본(토글 ON) 분봉 → 프로그램 순매수 포함 6 pane 유지', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false });
    expect(n).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength', 'program-trade']);
  });
  it('quoteTotalsEnabled=false → 총잔량 pane 제거', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false, quoteTotalsEnabled: false });
    expect(n).not.toContain('quote-totals');
    expect(n).toContain('ratio');
    expect(n).toContain('fill-strength');
  });
  it('ratio·fill 동시 off → 둘 다 제거', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false, ratioEnabled: false, fillStrengthEnabled: false });
    expect(n).toEqual(['candle', 'volume', 'quote-totals', 'program-trade']);
  });
  it('calendar(D) → 호가 토글 무관(애초에 없음)', () => {
    const n = names('D', { foreignNet: false, institutionNet: false, quoteTotalsEnabled: true });
    expect(n).toEqual(['candle', 'volume']);
  });
  it('study mode can mount hoga panes for calendar timeframe snapshots', () => {
    const n = names('D', { foreignNet: false, institutionNet: false, forceHogaPanes: true });
    expect(n).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength', 'program-trade']);
  });
  it('hogaPanes=false removes hoga panes even on minute timeframes', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false, hogaPanes: false });
    expect(n).toEqual(['candle', 'volume']);
  });
  it('hogaPanes=false overrides forceHogaPanes for index instruments', () => {
    const n = names('D', { foreignNet: false, institutionNet: false, hogaPanes: false, forceHogaPanes: true });
    expect(n).toEqual(['candle', 'volume']);
  });
  it('동일 토글 2회 호출 → 동일 배열 참조(참조 안정)', () => {
    const t = { foreignNet: false, institutionNet: false, ratioEnabled: false };
    expect(paneSpecsForTimeframe('1m', t)).toBe(paneSpecsForTimeframe('1m', t));
  });
  it('서로 다른 단일 드롭은 캐시 충돌 없이 다른 배열 (auto-derived 키)', () => {
    // 수작업 비트 키였다면 새 토글 추가 시 충돌 가능 — kept-name 파생 키는
    // 드롭 대상이 다르면 키도 달라 충돌 불가. (volume 드롭) ≠ (ratio 드롭).
    const volOff = paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false, volumeEnabled: false });
    const ratioOff = paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false, ratioEnabled: false });
    expect(volOff.map((s) => s.name)).not.toEqual(ratioOff.map((s) => s.name));
    expect(volOff).not.toBe(ratioOff);
  });

  it('programTradeEnabled=false → 프로그램 순매수 pane 제거', () => {
    const n = names('1m', { foreignNet: false, institutionNet: false, programTradeEnabled: false });
    expect(n).not.toContain('program-trade');
    expect(n).toContain('fill-strength');
  });
});

describe('paneSpecsForTimeframe — paneOrder (ADR-0114)', () => {
  const CANON = [
    'candle', 'volume', 'quote-totals', 'ratio',
    'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
  ] as const;
  const names = (tf: LiveTimeframe, t: PaneToggles, order?: readonly string[]) =>
    paneSpecsForTimeframe(tf, t, order as never).map((s) => s.name);

  it('canonical order keeps PANE_SPECS identity (all-base minute)', () => {
    expect(paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false }, CANON)).toBe(PANE_SPECS);
  });

  it('reorders kept panes by the provided order', () => {
    const order = [
      'candle', 'ratio', 'volume', 'quote-totals',
      'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
    ] as const;
    expect(names('1m', { foreignNet: false, institutionNet: false }, order))
      .toEqual(['candle', 'ratio', 'volume', 'quote-totals', 'fill-strength', 'program-trade']);
  });

  it('a custom order yields a stable (frozen) reference across calls', () => {
    const order = ['candle', 'ratio', 'volume', 'quote-totals', 'fill-strength', 'program-trade'] as const;
    const a = paneSpecsForTimeframe('1m', { foreignNet: false, institutionNet: false }, order as never);
    const b = paneSpecsForTimeframe('5m', { foreignNet: false, institutionNet: false }, order as never);
    expect(a).toBe(b);
  });

  it('order composes with the D-only investor gate (membership still gated)', () => {
    // 분봉: investor 는 순서에 있어도 게이트로 제외된다.
    expect(names('1m', { foreignNet: true, institutionNet: true }, CANON))
      .not.toContain('investor-foreign');
    // D + 커스텀 순서: investor-institution 을 volume 앞으로.
    const order = [
      'candle', 'investor-institution', 'investor-foreign', 'volume',
      'quote-totals', 'ratio', 'fill-strength', 'program-trade',
    ] as const;
    expect(names('D', { foreignNet: true, institutionNet: true }, order))
      .toEqual(['candle', 'investor-institution', 'investor-foreign', 'volume']);
  });
});
