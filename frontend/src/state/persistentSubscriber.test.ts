import { describe, it, expect } from 'vitest';
import { attachPersistence } from './persistentSubscriber';

describe('persistentSubscriber — module scaffold', () => {
  it('exports attachPersistence as a function', () => {
    expect(typeof attachPersistence).toBe('function');
  });
});
