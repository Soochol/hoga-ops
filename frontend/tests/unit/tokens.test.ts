import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTokens } from '../../src/util/tokens';
import { SIZE_TOKENS, FIXED_PX_TOKENS } from '../../src/styles/design-tokens';

describe('resolveTokens', () => {
  let originalGetComputedStyle: typeof globalThis.getComputedStyle;

  beforeEach(() => {
    originalGetComputedStyle = globalThis.getComputedStyle;
  });
  afterEach(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
    vi.unstubAllGlobals();
  });

  it('returns CSS values when defined', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: (name: string) =>
        ({ '--up': '#22C55E', '--down': '#F43F5E' })[name] ?? '',
    }) as unknown as typeof globalThis.getComputedStyle;

    expect(resolveTokens({ up: ['--up', '#fff'], down: ['--down', '#000'] })).toEqual({
      up: '#22C55E',
      down: '#F43F5E',
    });
  });

  it('falls back when CSS var is empty', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: () => '',
    }) as unknown as typeof globalThis.getComputedStyle;

    expect(resolveTokens({ accent: ['--accent', '#14B8A6'] })).toEqual({
      accent: '#14B8A6',
    });
  });

  it('trims whitespace from CSS value', () => {
    globalThis.getComputedStyle = vi.fn().mockReturnValue({
      getPropertyValue: () => '  #13131C  ',
    }) as unknown as typeof globalThis.getComputedStyle;

    expect(resolveTokens({ bgCard: ['--bg-card', '#000'] })).toEqual({
      bgCard: '#13131C',
    });
  });

  it('returns fallbacks verbatim when document is absent (SSR)', () => {
    // vitest+jsdom provides document; simulate SSR by stubbing it away.
    const realDoc = globalThis.document;
    // @ts-expect-error — deleting a defined global in a test.
    delete globalThis.document;
    try {
      expect(
        resolveTokens({
          up: ['--up', '#22C55E'],
          down: ['--down', '#F43F5E'],
        }),
      ).toEqual({ up: '#22C55E', down: '#F43F5E' });
    } finally {
      globalThis.document = realDoc;
    }
  });
});

/**
 * Token registry tests run directly against design-tokens.ts — no CSS file
 * parsing, no fs reads, no ESM `__dirname` plumbing. Strongly typed: a
 * misspelled token name fails at compile time, not at test time.
 */
describe('design-tokens registry', () => {
  it('SIZE_TOKENS satisfy `rem × 16 == baseIntentPx` (drift check)', () => {
    for (const [name, t] of Object.entries(SIZE_TOKENS)) {
      const expected = t.rem * 16;
      expect(Math.abs(expected - t.baseIntentPx), `token ${name}: rem=${t.rem} × 16 != baseIntentPx=${t.baseIntentPx}`)
        .toBeLessThan(0.001);
    }
  });

  it('SIZE_TOKENS render exact 1.25× at default density (20px root)', () => {
    for (const [name, t] of Object.entries(SIZE_TOKENS)) {
      const rendered = t.rem * 20;
      const expected = t.baseIntentPx * 1.25;
      expect(Math.abs(rendered - expected), `token ${name}: rendered=${rendered} != 1.25× base intent=${expected}`)
        .toBeLessThan(0.001);
    }
  });

  it('--text-base has the documented value (anchor against accidental drift)', () => {
    expect(SIZE_TOKENS['text-base']).toEqual({
      rem: 0.8125,
      baseIntentPx: 13,
      usage: 'Body / UI default',
    });
  });

  it('--text-badge preserves SymbolSearch market-badge hierarchy below text-xs', () => {
    expect(SIZE_TOKENS['text-badge'].baseIntentPx).toBe(8.5);
    expect(SIZE_TOKENS['text-badge'].baseIntentPx).toBeLessThan(SIZE_TOKENS['text-xs'].baseIntentPx);
  });

  it('--h-tab-secondary is intentionally 2px shorter than --h-tab at base intent', () => {
    expect(SIZE_TOKENS['h-tab'].baseIntentPx - SIZE_TOKENS['h-tab-secondary'].baseIntentPx).toBe(2);
  });

  it('--sidebar-w and --dropdown-min-w share the same base intent (both 320px)', () => {
    expect(SIZE_TOKENS['sidebar-w'].baseIntentPx).toBe(SIZE_TOKENS['dropdown-min-w'].baseIntentPx);
  });

  it('FIXED_PX_TOKENS keep ADR-0011-sanctioned absolute pixels', () => {
    expect(FIXED_PX_TOKENS['radius-sm'].px).toBe(2);
    expect(FIXED_PX_TOKENS['radius-md'].px).toBe(4);
    expect(FIXED_PX_TOKENS['radius-lg'].px).toBe(6);
    expect(FIXED_PX_TOKENS['radius-full'].px).toBe(9999);
  });
});
