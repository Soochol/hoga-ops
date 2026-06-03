import { describe, it, expect } from 'vitest';
import { reorderCodes } from './reorderCodes';

describe('reorderCodes', () => {
  const codes = ['003490', '005930', '000660'];

  it('moves active before/after over via arrayMove', () => {
    // drag last (000660) onto first (003490) → 000660 takes index 0
    expect(reorderCodes(codes, '000660', '003490')).toEqual(['000660', '003490', '005930']);
  });

  it('returns null when active === over (dropped in place)', () => {
    expect(reorderCodes(codes, '005930', '005930')).toBeNull();
  });

  it('returns null when over is null/undefined (dropped outside)', () => {
    expect(reorderCodes(codes, '005930', null)).toBeNull();
    expect(reorderCodes(codes, '005930', undefined)).toBeNull();
  });

  it('returns null when a code is not in the list (stale)', () => {
    expect(reorderCodes(codes, '999999', '003490')).toBeNull();
  });
});
