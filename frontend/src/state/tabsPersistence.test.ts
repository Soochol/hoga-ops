import { describe, it, expect } from 'vitest';
import { STORAGE_KEY } from './tabsPersistence';

describe('tabsPersistence — module scaffold', () => {
  it('exports STORAGE_KEY = "replay.tabs.v1"', () => {
    expect(STORAGE_KEY).toBe('replay.tabs.v1');
  });
});
