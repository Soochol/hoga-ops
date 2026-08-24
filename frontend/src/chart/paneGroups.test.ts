import { describe, expect, it } from 'vitest';
import {
  extractPaneToBoundary,
  flattenPaneGroups,
  mergePaneIntoGroup,
  movePaneGroupBeside,
  normalizePaneAxisMode,
  normalizePaneGroups,
  normalizePaneGroupStretch,
  paneGroupKey,
  paneGroupsFromOrder,
  priceScaleIdForGroupMember,
  resolveAxisMode,
  type PaneGroups,
} from './paneGroups';
import { CANONICAL_PANE_ORDER, normalizePaneOrder } from './paneOrder';
import type { PaneId } from './drawing/types';

const CANONICAL_SINGLETONS: PaneGroups = CANONICAL_PANE_ORDER.map((id) => [id]);

describe('normalizePaneGroups', () => {
  it('누락/비배열 입력 → canonical 싱글턴 전체', () => {
    expect(normalizePaneGroups(undefined)).toEqual(CANONICAL_SINGLETONS);
    expect(normalizePaneGroups(null)).toEqual(CANONICAL_SINGLETONS);
    expect(normalizePaneGroups('volume')).toEqual(CANONICAL_SINGLETONS);
    expect(normalizePaneGroups({})).toEqual(CANONICAL_SINGLETONS);
  });

  it('unknown id·중복·빈 그룹을 걷고 누락 pane 을 canonical 싱글턴으로 append', () => {
    const raw = [
      ['volume', 'nope', 'volume'],
      [],
      ['ratio', 42],
      // 나머지 pane 전부 누락 — canonical 순서의 싱글턴으로 뒤에 붙는다.
    ];
    // 기대값을 CANONICAL_PANE_ORDER 에서 파생한다 — 새 pane 이 추가돼도 이 테스트가
    // 목록 하드코딩 때문에 깨지지 않게(막는 방향은 순서·싱글턴 규칙이지 멤버 수가 아니다).
    const appended = CANONICAL_PANE_ORDER
      .filter((id) => !(['candle', 'volume', 'ratio'] as string[]).includes(id))
      .map((id) => [id]);
    expect(normalizePaneGroups(raw)).toEqual([
      ['candle'],
      ['volume'],
      ['ratio'],
      ...appended,
    ]);
  });

  it('candle 은 어느 그룹에 있었든 단독 그룹 index 0 으로 강제된다', () => {
    const raw = [['volume', 'candle', 'ratio'], ['investor-foreign', 'investor-institution']];
    const out = normalizePaneGroups(raw);
    expect(out[0]).toEqual(['candle']);
    expect(out[1]).toEqual(['volume', 'ratio']);
    expect(out[2]).toEqual(['investor-foreign', 'investor-institution']);
  });

  it('병합 그룹을 보존한다 — 저장 왕복이 그룹을 잃지 않는다', () => {
    const groups = normalizePaneGroups([
      ['candle'],
      ['investor-foreign', 'investor-institution'],
      ['volume'],
    ]);
    expect(normalizePaneGroups(groups)).toEqual(groups);
  });

  it('모든 PaneId 가 정확히 한 번 등장한다 (flatten = 순열)', () => {
    const out = normalizePaneGroups([['fill-strength'], ['volume', 'fill-strength']]);
    const flat = flattenPaneGroups(out);
    expect([...flat].sort()).toEqual([...CANONICAL_PANE_ORDER].sort());
    // flatten 은 normalizePaneOrder 의 유효 입력이고 그대로 통과한다.
    expect(normalizePaneOrder(flat)).toEqual(flat);
  });
});

describe('paneGroupsFromOrder / flattenPaneGroups', () => {
  it('order → 싱글턴 그룹 → flatten 왕복', () => {
    const order = normalizePaneOrder(['candle', 'ratio', 'volume']);
    expect(flattenPaneGroups(paneGroupsFromOrder(order))).toEqual(order);
  });
});

describe('mergePaneIntoGroup', () => {
  const base = (): PaneGroups => normalizePaneGroups(undefined);

  it('source 를 target 그룹 끝에 붙인다 — 첫 멤버(축 소유)는 불변', () => {
    const out = mergePaneIntoGroup(base(), 'investor-institution', 'investor-foreign');
    const group = out.find((g) => g.includes('investor-foreign'));
    expect(group).toEqual(['investor-foreign', 'investor-institution']);
    expect(out.some((g) => g.length === 1 && g[0] === 'investor-institution')).toBe(false);
  });

  it('비운 source 그룹은 사라진다', () => {
    const out = mergePaneIntoGroup(base(), 'ratio', 'volume');
    expect(out.every((g) => g.length > 0)).toBe(true);
    expect(flattenPaneGroups(out)).toContain('ratio');
    expect(out.length).toBe(base().length - 1);
  });

  it('candle·자기 자신·같은 그룹은 no-op(identity 보존)', () => {
    const groups = base();
    expect(mergePaneIntoGroup(groups, 'candle', 'volume')).toBe(groups);
    expect(mergePaneIntoGroup(groups, 'volume', 'candle')).toBe(groups);
    expect(mergePaneIntoGroup(groups, 'volume', 'volume')).toBe(groups);
    const merged = mergePaneIntoGroup(groups, 'ratio', 'volume');
    expect(mergePaneIntoGroup(merged, 'ratio', 'volume')).toBe(merged);
  });
});

describe('extractPaneToBoundary', () => {
  it('병합 그룹에서 빼내면 그 경계에 새 싱글턴 pane 이 생긴다 (병합의 역연산)', () => {
    const merged = mergePaneIntoGroup(normalizePaneGroups(undefined), 'ratio', 'volume');
    const volumeIdx = merged.findIndex((g) => g.includes('volume'));
    // volume 그룹 바로 아래 경계로 분리
    const out = extractPaneToBoundary(merged, 'ratio', volumeIdx + 1);
    expect(out[volumeIdx]).toEqual(['volume']);
    expect(out[volumeIdx + 1]).toEqual(['ratio']);
  });

  it('싱글턴을 다른 경계로 끼우면 순수 이동이다', () => {
    const groups = normalizePaneGroups(undefined);
    // volume(idx 1) 을 맨 뒤로
    const out = extractPaneToBoundary(groups, 'volume', groups.length);
    expect(out[out.length - 1]).toEqual(['volume']);
    expect(out.length).toBe(groups.length);
  });

  it('아래 방향 이동은 자기 그룹 제거로 당겨진 인덱스를 보정한다', () => {
    const groups = normalizePaneGroups(undefined); // [candle][volume][quote-totals][ratio]...
    // volume(idx 1)을 quote-totals(idx 2) 바로 아래 경계(원본 기준 3)로
    const out = extractPaneToBoundary(groups, 'volume', 3);
    expect(out[1]).toEqual(['quote-totals']);
    expect(out[2]).toEqual(['volume']);
  });

  it('candle 앞(경계 0)은 1 로 클램프되고 candle 자신은 no-op', () => {
    const groups = normalizePaneGroups(undefined);
    expect(extractPaneToBoundary(groups, 'candle', 2)).toBe(groups);
    const out = extractPaneToBoundary(groups, 'ratio', 0);
    expect(out[0]).toEqual(['candle']);
    expect(out[1]).toEqual(['ratio']);
  });

  it('제자리 재삽입은 identity 를 보존한다', () => {
    const groups = normalizePaneGroups(undefined);
    expect(extractPaneToBoundary(groups, 'volume', 1)).toBe(groups);
  });
});

describe('movePaneGroupBeside', () => {
  it('그룹 전체가 이웃 그룹 앞/뒤로 이동한다', () => {
    const merged = mergePaneIntoGroup(
      normalizePaneGroups(undefined), 'investor-institution', 'investor-foreign',
    );
    const out = movePaneGroupBeside(merged, 'investor-foreign', 'volume', 'before');
    const volumeIdx = out.findIndex((g) => g.includes('volume'));
    expect(out[volumeIdx - 1]).toEqual(['investor-foreign', 'investor-institution']);
    // 멤버 어느 쪽으로 불러도 같은 그룹 이동이다.
    const out2 = movePaneGroupBeside(merged, 'investor-institution', 'volume', 'before');
    expect(out2).toEqual(out);
  });

  it('candle 은 못 움직이고 candle 앞으로도 못 간다', () => {
    const groups = normalizePaneGroups(undefined);
    expect(movePaneGroupBeside(groups, 'candle', 'volume', 'after')).toBe(groups);
    const out = movePaneGroupBeside(groups, 'ratio', 'candle', 'before');
    expect(out[0]).toEqual(['candle']);
    expect(out[1]).toEqual(['ratio']);
  });

  it('같은 그룹의 멤버를 이웃으로 지목하면 no-op', () => {
    const merged = mergePaneIntoGroup(normalizePaneGroups(undefined), 'ratio', 'volume');
    expect(movePaneGroupBeside(merged, 'ratio', 'volume', 'before')).toBe(merged);
  });
});

describe('paneAxisMode — 그룹별 y축 모드 오버라이드', () => {
  it('resolveAxisMode: 오버라이드 없음 = 화이트리스트 기본값(공유/격리)', () => {
    expect(resolveAxisMode(['investor-foreign', 'investor-institution'], {})).toBe('shared');
    expect(resolveAxisMode(['volume', 'ratio'], {})).toBe('isolated');
    expect(resolveAxisMode(['volume'], {})).toBe('isolated'); // 싱글턴은 항상 격리(무의미)
  });

  it('resolveAxisMode: 오버라이드가 기본값을 이긴다 — 3모드, 키는 순서 무관', () => {
    expect(resolveAxisMode(
      ['volume', 'ratio'], { [paneGroupKey(['ratio', 'volume'])]: 'shared' },
    )).toBe('shared');
    expect(resolveAxisMode(
      ['volume', 'ratio'], { [paneGroupKey(['ratio', 'volume'])]: 'left' },
    )).toBe('left');
    expect(resolveAxisMode(
      ['investor-foreign', 'investor-institution'],
      { [paneGroupKey(['investor-institution', 'investor-foreign'])]: 'isolated' },
    )).toBe('isolated');
  });

  it('normalizePaneAxisMode: 미지 값·현재 그룹과 매칭 안 되는 키를 걷는다', () => {
    const groups = mergePaneIntoGroup(normalizePaneGroups(undefined), 'ratio', 'volume');
    const liveKey = paneGroupKey(['volume', 'ratio']);
    const out = normalizePaneAxisMode(
      {
        [liveKey]: 'left',
        'quote-totals,fill-strength': 'shared', // 존재하지 않는 그룹 → 드롭
        volume: 'shared',                        // 싱글턴 키 → 드롭
        [paneGroupKey(['a', 'b'])]: true,        // 미지 값 → 드롭
      },
      groups,
    );
    expect(out).toEqual({ [liveKey]: 'left' });
    expect(normalizePaneAxisMode(null, groups)).toEqual({});
  });

  it('normalizePaneGroupStretch: 비유한·범위 밖·스테일 키를 걷는다', () => {
    const groups = mergePaneIntoGroup(normalizePaneGroups(undefined), 'ratio', 'volume');
    const liveKey = paneGroupKey(['volume', 'ratio']);
    const out = normalizePaneGroupStretch(
      {
        [liveKey]: 1.2,
        'quote-totals,fill-strength': 0.5, // 존재하지 않는 그룹 → 드롭
        [paneGroupKey(['a', 'b'])]: Number.NaN, // 비유한 → 드롭
      },
      groups,
    );
    expect(out).toEqual({ [liveKey]: 1.2 });
    expect(normalizePaneGroupStretch({ [liveKey]: 99 }, groups)).toEqual({});
  });

  it('priceScaleIdForGroupMember: mode 인자가 화이트리스트 판정을 대체한다', () => {
    // 비화이트리스트 그룹을 공유로 강제 → 리매핑 없음(전원 원 스케일).
    expect(priceScaleIdForGroupMember(['volume', 'ratio'], 'ratio', 'right', 'shared')).toBeNull();
    // 화이트리스트 쌍을 분리로 강제 → 비대표 멤버 격리.
    expect(priceScaleIdForGroupMember(
      ['investor-foreign', 'investor-institution'], 'investor-institution', 'right', 'isolated',
    )).toBe('merged:investor-institution:right');
  });

  it("priceScaleIdForGroupMember: 'left' 모드 — 둘째 멤버의 right 계열만 왼쪽 축으로", () => {
    const group = ['volume', 'fill-strength', 'ratio'];
    // 둘째 멤버의 'right' → 'left' (왼쪽 축 눈금).
    expect(priceScaleIdForGroupMember(group, 'fill-strength', 'right', 'left')).toBe('left');
    // 둘째 멤버의 누적선 오버레이('')는 왼쪽 축을 차지하면 안 된다 — 격리 유지.
    expect(priceScaleIdForGroupMember(group, 'fill-strength', '', 'left'))
      .toBe('merged:fill-strength:');
    // 셋째 멤버는 계속 격리, 대표는 원 스케일.
    expect(priceScaleIdForGroupMember(group, 'ratio', 'right', 'left')).toBe('merged:ratio:right');
    expect(priceScaleIdForGroupMember(group, 'volume', 'right', 'left')).toBeNull();
  });
});

describe('priceScaleIdForGroupMember', () => {
  it('싱글턴 그룹·그룹 첫 멤버(대표)는 리매핑 없음', () => {
    expect(priceScaleIdForGroupMember(['volume'], 'volume', 'right')).toBeNull();
    expect(priceScaleIdForGroupMember(['volume', 'ratio'], 'volume', 'right')).toBeNull();
  });

  it('비대표 멤버는 멤버별 네임스페이스 스케일로 격리 — right 와 오버레이("") 둘 다', () => {
    const group: PaneId[] = ['volume', 'fill-strength'];
    expect(priceScaleIdForGroupMember(group, 'fill-strength', 'right'))
      .toBe('merged:fill-strength:right');
    // 누적선 오버레이 스케일('')도 리매핑 — 같은 id = 같은 스케일이라 두 멤버의
    // 누적선이 오토스케일을 나눠 갖는 것을 막는다.
    expect(priceScaleIdForGroupMember(group, 'fill-strength', ''))
      .toBe('merged:fill-strength:');
  });

  it('화이트리스트(외국인+기관)는 전원 원 스케일 유지 = 축 공유', () => {
    const pair: PaneId[] = ['investor-foreign', 'investor-institution'];
    expect(priceScaleIdForGroupMember(pair, 'investor-foreign', 'right')).toBeNull();
    expect(priceScaleIdForGroupMember(pair, 'investor-institution', 'right')).toBeNull();
  });

  it('화이트리스트 조합에 다른 멤버가 끼면 공유가 풀린다', () => {
    const trio: PaneId[] = ['investor-foreign', 'investor-institution', 'volume'];
    expect(priceScaleIdForGroupMember(trio, 'investor-institution', 'right'))
      .toBe('merged:investor-institution:right');
    expect(priceScaleIdForGroupMember(trio, 'volume', 'right'))
      .toBe('merged:volume:right');
  });
});
