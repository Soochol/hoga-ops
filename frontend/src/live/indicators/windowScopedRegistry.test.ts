import { describe, expect, it } from 'vitest';
import { createWindowScopedRegistry, scopeEntries } from './windowScopedRegistry';

/**
 * 창 스코프 레지스트리 (2026-07-29).
 *
 * MA·일봉MA·pane 레전드 레지스트리는 슬롯 id('ma-1'·'candle' …)라는 **창마다 같은
 * 고정 문자열**을 키로 썼다. 차트 창이 둘 이상이면 서로 덮어쓰고 서로 지운다.
 * `flagLegendValueRegistry` 가 먼저 이 형태로 풀었고 이 셋만 누락돼 있었다.
 */
describe('createWindowScopedRegistry', () => {
  it('같은 키라도 창이 다르면 서로 덮어쓰지 않는다', () => {
    const reg = createWindowScopedRegistry<string, string>();
    reg.getState().register('w1', 'ma-1', 'A의 시리즈');
    reg.getState().register('w2', 'ma-1', 'B의 시리즈');

    // 종전엔 창 B 의 마운트가 A 의 엔트리를 덮어써 A 의 레전드가 B 종목 값을 보였다.
    expect(scopeEntries(reg.getState().byScope, 'w1').get('ma-1')).toBe('A의 시리즈');
    expect(scopeEntries(reg.getState().byScope, 'w2').get('ma-1')).toBe('B의 시리즈');
  });

  it('한 창의 해제가 다른 창의 살아 있는 등록을 지우지 않는다', () => {
    const reg = createWindowScopedRegistry<string, string>();
    reg.getState().register('w1', 'ma-1', 'A의 시리즈');
    reg.getState().register('w2', 'ma-1', 'B의 시리즈');

    reg.getState().unregister('w1', 'ma-1');

    // 종전엔 창 A 의 언마운트가 B 의 엔트리를 지워 B 레전드가 영구 공백이 됐다
    // (B 의 reconcile effect 는 config 가 바뀌기 전엔 다시 안 돈다).
    expect(scopeEntries(reg.getState().byScope, 'w2').get('ma-1')).toBe('B의 시리즈');
    expect(scopeEntries(reg.getState().byScope, 'w1').has('ma-1')).toBe(false);
  });

  it('남의 창 등록은 내 스코프의 참조를 바꾸지 않는다 (재렌더 팬아웃 차단)', () => {
    const reg = createWindowScopedRegistry<string, string>();
    reg.getState().register('w1', 'ma-1', 'A');
    const before = scopeEntries(reg.getState().byScope, 'w1');

    reg.getState().register('w2', 'ma-1', 'B');

    // 참조가 같아야 zustand 가 w1 소비자의 재렌더를 건너뛴다. 종전엔 평면 Map 이라
    // 어느 창의 reconcile 이든 열린 모든 창의 PaneLegendOverlay 를 깨웠다.
    expect(scopeEntries(reg.getState().byScope, 'w1')).toBe(before);
  });

  it('등록이 없는 스코프는 매번 같은 빈 Map 을 돌려준다', () => {
    const reg = createWindowScopedRegistry<string, string>();
    const a = scopeEntries(reg.getState().byScope, 'w1');
    reg.getState().register('w2', 'ma-1', 'B');
    const b = scopeEntries(reg.getState().byScope, 'w1');

    // 새 빈 Map 을 만들면 등록이 하나도 없는 창까지 매 변경에 재렌더된다.
    expect(b).toBe(a);
    expect(b.size).toBe(0);
  });

  it('clearScope 는 그 창만 턴다', () => {
    const reg = createWindowScopedRegistry<string, string>();
    reg.getState().register('w1', 'ma-1', 'A');
    reg.getState().register('w2', 'ma-1', 'B');

    reg.getState().clearScope('w1');

    expect(scopeEntries(reg.getState().byScope, 'w1').size).toBe(0);
    expect(scopeEntries(reg.getState().byScope, 'w2').get('ma-1')).toBe('B');
  });

  it('null 스코프(Provider 밖 = /study·단일 차트)도 유효한 키다', () => {
    const reg = createWindowScopedRegistry<string, string>();
    reg.getState().register(null, 'ma-1', '전역');
    reg.getState().register('w1', 'ma-1', '창');

    expect(scopeEntries(reg.getState().byScope, null).get('ma-1')).toBe('전역');
    expect(scopeEntries(reg.getState().byScope, 'w1').get('ma-1')).toBe('창');
  });
});
