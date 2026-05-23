import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadForceRetryDefault, saveForceRetryDefault } from './forceRetryDefault';

describe('forceRetryDefault', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('loadForceRetryDefault returns false when key is absent', () => {
    expect(loadForceRetryDefault()).toBe(false);
  });

  it('saveForceRetryDefault(true) round-trips through loadForceRetryDefault', () => {
    saveForceRetryDefault(true);
    expect(loadForceRetryDefault()).toBe(true);
  });

  it('saveForceRetryDefault(false) round-trips and overrides a previous true', () => {
    saveForceRetryDefault(true);
    saveForceRetryDefault(false);
    expect(loadForceRetryDefault()).toBe(false);
  });

  it('loadForceRetryDefault returns false when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadForceRetryDefault()).toBe(false);
  });
});
