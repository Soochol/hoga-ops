/**
 * 영속 커널의 직접 테스트.
 *
 * 이 두 함수는 18개 모듈이 쓰는데 **직접 테스트가 하나도 없었다** — 전부 소비처
 * 스토어 테스트를 통한 간접 커버였다. 그래서 커널만의 성질(스코프 분기, 손상값
 * 폴백, storage 부재 시 무음)이 어느 소비처 테스트에도 단독으로 잡히지 않았다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { persistJson, readJsonObject } from './persist';

const KEY = 'persist.test.v1';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('persistJson', () => {
  it('기본 스코프는 shared — localStorage 에 쓴다', () => {
    persistJson(KEY, { a: 1 });
    expect(localStorage.getItem(KEY)).toBe('{"a":1}');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("scope 'tab' 은 sessionStorage 에 쓴다", () => {
    persistJson(KEY, { a: 1 }, 'tab');
    expect(sessionStorage.getItem(KEY)).toBe('{"a":1}');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('두 스코프는 같은 키를 써도 서로를 덮지 않는다', () => {
    // 워크스페이스의 write-through(tab 권위 + shared 시드)가 이 성질에 기대고 있다.
    persistJson(KEY, { from: 'shared' });
    persistJson(KEY, { from: 'tab' }, 'tab');
    expect(readJsonObject(KEY)).toEqual({ from: 'shared' });
    expect(readJsonObject(KEY, 'tab')).toEqual({ from: 'tab' });
  });

  it('직렬화 불가능한 값에도 던지지 않는다', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => persistJson(KEY, cyclic)).not.toThrow();
  });

  it('storage 가 없어도 던지지 않는다 (SSR / privacy 모드)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    // @ts-expect-error — SSR 을 재현하려면 전역을 실제로 없애야 한다.
    delete globalThis.localStorage;
    try {
      expect(() => persistJson(KEY, { a: 1 })).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('readJsonObject', () => {
  it('없는 키는 빈 객체 — 부재와 빈 값이 구별되지 않는다', () => {
    // ⚠ 이 동작이 계약이다. "이 키가 쓰인 적 있는가" 로 시드·마이그레이션을 게이트하는
    // 곳(chartPrefsPersistence · indicatorSettingsV2 · indicatorsWindowMigration ·
    // chart/drawing/persistence)이 **그래서** 원시 getItem 을 쓴다. 여기를 바꾸려면
    // 그 네 곳을 함께 봐야 한다.
    expect(readJsonObject(KEY)).toEqual({});
  });

  it('손상된 JSON 은 빈 객체', () => {
    localStorage.setItem(KEY, '{');
    expect(readJsonObject(KEY)).toEqual({});
  });

  it('배열은 통과하고 스칼라·null 은 빈 객체 — 반환 타입이 거짓말하는 지점', () => {
    // 가드가 `typeof !== 'object' || === null` 뿐이라 배열이 그대로 빠져나간다.
    // 선언된 반환형은 `Record<string, unknown>` 이므로 **타입이 실동작과 다르다**.
    // 여기서 좁히지 않는 것은 소비처 18곳의 동작이 함께 바뀌기 때문 — 실동작을
    // 못박아 두고, 좁힐 때 이 단언이 먼저 빨개지게 한다.
    localStorage.setItem(KEY, '[1,2]');
    expect(readJsonObject(KEY)).toEqual([1, 2]);
    localStorage.setItem(KEY, '42');
    expect(readJsonObject(KEY)).toEqual({});
    localStorage.setItem(KEY, 'null');
    expect(readJsonObject(KEY)).toEqual({});
    localStorage.setItem(KEY, '"str"');
    expect(readJsonObject(KEY)).toEqual({});
  });

  it('빈 문자열은 빈 객체', () => {
    localStorage.setItem(KEY, '');
    expect(readJsonObject(KEY)).toEqual({});
  });

  it('왕복한다', () => {
    persistJson(KEY, { nested: { n: 1 }, list: [1, 2] });
    expect(readJsonObject(KEY)).toEqual({ nested: { n: 1 }, list: [1, 2] });
  });

  it('storage 가 없으면 빈 객체 (SSR)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    // @ts-expect-error — SSR 재현.
    delete globalThis.localStorage;
    try {
      expect(readJsonObject(KEY)).toEqual({});
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
