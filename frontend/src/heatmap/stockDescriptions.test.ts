import { describe, expect, it } from 'vitest';
import descriptions from './stockDescriptions.json';
import universe from './stockDescriptionUniverse.json';
import { getStockDescription } from './stockDescriptions';

describe('reviewed heatmap company descriptions', () => {
  it('covers every unique Code in the reviewed 330-stock universe', () => {
    expect(universe.codes).toHaveLength(330);
    expect(Object.keys(descriptions).sort()).toEqual(universe.codes);
    for (const [code, description] of Object.entries(descriptions)) {
      expect(code).toMatch(/^[0-9A-Z]{6}$/);
      expect(description.name.trim()).not.toBe('');
      expect(description.lines.length).toBeGreaterThanOrEqual(2);
      expect(description.lines.length).toBeLessThanOrEqual(3);
      for (const line of description.lines) {
        expect(line.trim()).toBe(line);
        expect(line.length).toBeGreaterThan(8);
        expect(line).not.toMatch(/설명 준비|관련주입니다|추가 예정/);
      }
      expect(description.sources.length).toBeGreaterThan(0);
      for (const source of description.sources) expect(new URL(source).protocol).toBe('https:');
    }
  });

  it('resolves a single shared record per Code, including alphanumeric Codes', () => {
    expect(getStockDescription('0158S0')?.name).toBe('엘리스');
    expect(getStockDescription('066570')).toBe(getStockDescription('066570'));
    expect(getStockDescription(undefined)).toBeUndefined();
    expect(getStockDescription('999999')).toBeUndefined();
    expect(getStockDescription('toString')).toBeUndefined();
  });
});
