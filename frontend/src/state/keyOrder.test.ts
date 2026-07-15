import { describe, expect, it } from 'vitest';
import { normalizeKeyOrder, reorderVisible } from './keyOrder';

type K = 'a' | 'b' | 'c' | 'd';
const CANON: readonly K[] = ['a', 'b', 'c', 'd'];
const isKey = (v: string): v is K => (CANON as readonly string[]).includes(v);

describe('normalizeKeyOrder', () => {
  it('배열이 아니면 canonical 사본을 반환한다', () => {
    expect(normalizeKeyOrder(undefined, CANON, isKey)).toEqual(['a', 'b', 'c', 'd']);
    expect(normalizeKeyOrder(null, CANON, isKey)).toEqual(['a', 'b', 'c', 'd']);
    expect(normalizeKeyOrder({}, CANON, isKey)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('canonical 사본은 새 배열이다(참조 공유 안 함)', () => {
    const out = normalizeKeyOrder(42, CANON, isKey);
    expect(out).not.toBe(CANON);
    out.push('a');
    expect(CANON).toHaveLength(4);
  });

  it('저장된 순서를 그대로 존중한다', () => {
    expect(normalizeKeyOrder(['c', 'a', 'd', 'b'], CANON, isKey)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('unknown 키를 드롭한다(후방 호환: 삭제된 카드)', () => {
    expect(normalizeKeyOrder(['c', 'zzz', 'a'], CANON, isKey)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('중복은 첫 등장만 유지한다', () => {
    expect(normalizeKeyOrder(['b', 'b', 'a'], CANON, isKey)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('누락된 canonical 키를 canonical 순서로 뒤에 append한다(전방 호환: 새 카드)', () => {
    expect(normalizeKeyOrder(['d', 'b'], CANON, isKey)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('비문자열 엔트리를 무시한다', () => {
    expect(normalizeKeyOrder(['a', 3, null, 'c'], CANON, isKey)).toEqual(['a', 'c', 'b', 'd']);
  });
});

describe('reorderVisible', () => {
  it('숨김이 없으면 단순 arrayMove다', () => {
    expect(reorderVisible(['a', 'b', 'c', 'd'], new Set(), 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderVisible(['a', 'b', 'c', 'd'], new Set(), 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('숨김 키는 전체 순서 내 절대 위치를 유지한다', () => {
    // visible = [a, c, d] (b 숨김, index 1 고정). visible 0→2 이동.
    const out = reorderVisible(['a', 'b', 'c', 'd'], new Set<K>(['b']), 0, 2);
    expect(out).toEqual(['c', 'b', 'd', 'a']);
  });

  it('보이는 인덱스 기준으로 from/to를 해석한다', () => {
    // visible = [b, d] (a, c 숨김). b(0) ↔ d(1) 스왑.
    const out = reorderVisible(['a', 'b', 'c', 'd'], new Set<K>(['a', 'c']), 0, 1);
    expect(out).toEqual(['a', 'd', 'c', 'b']);
  });

  it('from===to 또는 범위 밖이면 원본 사본을 반환한다', () => {
    expect(reorderVisible(['a', 'b', 'c'], new Set(), 1, 1)).toEqual(['a', 'b', 'c']);
    expect(reorderVisible(['a', 'b', 'c'], new Set(), -1, 2)).toEqual(['a', 'b', 'c']);
    expect(reorderVisible(['a', 'b', 'c'], new Set(), 0, 9)).toEqual(['a', 'b', 'c']);
  });
});
