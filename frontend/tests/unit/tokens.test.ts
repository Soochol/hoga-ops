import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTokens } from '../../src/util/tokens';

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
