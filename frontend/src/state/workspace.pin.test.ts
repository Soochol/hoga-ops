import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_STORAGE_KEY } from './workspace';

/**
 * 창 종목 고정(핀) — "클릭으로는 안 바뀌고, 그 창에 직접 드롭할 때만 바뀐다".
 *
 * 이 파일이 못박는 것 넷:
 *  1. 핀 창은 **그룹 종목 교체를 지나간다**(핀이 boolean 이 아니라 종목 사본인 이유).
 *  2. 클릭 목적지(`activationTarget`)가 핀 창을 건너뛴다 — 세 결과를 구분한다.
 *  3. 드롭(`setWindowSymbol`)만 핀 창에 쓸 수 있다.
 *  4. 핀은 **영속되지만 프리셋·딥링크 탭에는 실리지 않고**, 프리셋 적용은 id 가
 *     살아남는 창의 핀을 **나가는 상태에서 이월**한다(payload 는 여전히 안 읽는다).
 *
 * 스토어는 모듈 초기화 시점에 하이드레이션하므로(readStorage), 저장값·URL 을 바꾸려면
 * 먼저 세우고 모듈을 다시 import 한다(tabScope 테스트와 같은 규율).
 */

type SeedWindow = {
  id: string;
  group: number;
  pinned?: { code: string; name: string };
};

function seed(windows: SeedWindow[], groupSymbols: Record<number, { code: string; name: string }>) {
  sessionStorage.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      schema_version: 2,
      windows: windows.map((w) => ({
        id: w.id,
        kind: 'chart',
        group: w.group,
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
        chart: { timeframe: '1m' },
        ...(w.pinned ? { pinned: w.pinned } : {}),
      })),
      zOrder: windows.map((w) => w.id),
      groupSymbols,
    }),
  );
}

async function loadStore(search = '') {
  window.history.replaceState({}, '', `/live${search}`);
  vi.resetModules();
  return await import('./workspace');
}

const SAMSUNG = { code: '005930', name: '삼성전자' };
const HYNIX = { code: '000660', name: 'SK하이닉스' };
const KAKAO = { code: '035720', name: '카카오' };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('핀 창은 그룹 종목 교체를 지나간다', () => {
  it('같은 그룹의 다른 창에 종목이 들어와도 핀 창의 표시 종목은 그대로다', async () => {
    // 회귀의 핵심 시나리오: 핀을 boolean 자물쇠로 만들면 여기서 샌다 — 종목 SSOT 가
    // 그룹이라, 그룹 동료 창 하나가 바뀌면 잠긴 창의 화면도 같이 바뀐다.
    seed([{ id: 'pinned', group: 1, pinned: SAMSUNG }, { id: 'free', group: 1 }], { 1: SAMSUNG });
    const { useWorkspaceStore, windowSymbolOf } = await loadStore();

    useWorkspaceStore.getState().setGroupSymbol(1, HYNIX);

    const s = useWorkspaceStore.getState();
    const pinned = s.windows.find((w) => w.id === 'pinned');
    const free = s.windows.find((w) => w.id === 'free');
    expect(windowSymbolOf(s, pinned)?.code).toBe('005930');
    expect(windowSymbolOf(s, free)?.code).toBe('000660');
  });

  it('핀 창은 그룹 교체의 fresh-view 런타임 리셋에서도 빠진다', async () => {
    // 화면이 안 바뀌는 창의 딥 백필을 되감을 이유가 없다.
    seed([{ id: 'pinned', group: 1, pinned: SAMSUNG }, { id: 'free', group: 1 }], { 1: SAMSUNG });
    const { useWorkspaceStore } = await loadStore();
    useWorkspaceStore.getState().extendChartHistoricalRange('pinned', '2026-01-02');
    useWorkspaceStore.getState().extendChartHistoricalRange('free', '2026-01-02');

    useWorkspaceStore.getState().setGroupSymbol(1, HYNIX);

    const rt = useWorkspaceStore.getState().chartRuntime;
    expect(rt.pinned?.historicalFromDate).toBe('2026-01-02');
    expect(rt.free).toBeUndefined();
  });
});

describe('activationTarget — 클릭 목적지', () => {
  it('포커스 창이 핀이면 그 아래 핀 아닌 창으로 넘어간다', async () => {
    // zOrder 마지막이 포커스. 'pinned' 가 최상단이지만 목적지는 'free' 여야 한다.
    seed([{ id: 'free', group: 2 }, { id: 'pinned', group: 1, pinned: SAMSUNG }], { 1: SAMSUNG });
    const { useWorkspaceStore, activationTarget } = await loadStore();

    const target = activationTarget(useWorkspaceStore.getState());

    expect(target).toEqual({ kind: 'window', window: expect.objectContaining({ id: 'free' }) });
  });

  it('핀이 없으면 종전대로 포커스 창(zOrder 마지막)이다', async () => {
    seed([{ id: 'a', group: 1 }, { id: 'b', group: 2 }], { 1: SAMSUNG });
    const { useWorkspaceStore, activationTarget } = await loadStore();

    const target = activationTarget(useWorkspaceStore.getState());

    expect(target).toEqual({ kind: 'window', window: expect.objectContaining({ id: 'b' }) });
  });

  it('창이 전부 핀이면 blocked — empty 와 구분된다', async () => {
    seed([{ id: 'p1', group: 1, pinned: SAMSUNG }, { id: 'p2', group: 2, pinned: HYNIX }], {});
    const { useWorkspaceStore, activationTarget } = await loadStore();

    expect(activationTarget(useWorkspaceStore.getState())).toEqual({ kind: 'blocked' });
  });

  it('창이 하나도 없으면 empty(그룹 1 시드) — blocked 로 뭉개지 않는다', async () => {
    // 빈 워크스페이스의 클릭까지 실패로 알리면 안 된다(종전엔 그룹 1 에 시드했다).
    seed([], {});
    const { useWorkspaceStore, activationTarget } = await loadStore();
    // seed([]) 는 창 0개라 하이드레이션이 공장 기본으로 폴백한다 → 직접 비워서 잰다.
    const state = { ...useWorkspaceStore.getState(), windows: [], zOrder: [] };

    expect(activationTarget(state)).toEqual({ kind: 'empty', group: 1 });
  });
});

describe('toggleWindowPin', () => {
  it('켜면 지금 그리던 종목을 창이 든다', async () => {
    seed([{ id: 'w1', group: 1 }], { 1: SAMSUNG });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().toggleWindowPin('w1');

    expect(useWorkspaceStore.getState().windows[0].pinned).toEqual(SAMSUNG);
  });

  it('끄면 슬롯이 지워지고 다시 그룹 종목을 따른다', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore, windowSymbolOf } = await loadStore();

    useWorkspaceStore.getState().toggleWindowPin('w1');

    const s = useWorkspaceStore.getState();
    expect(s.windows[0].pinned).toBeUndefined();
    expect(windowSymbolOf(s, s.windows[0])?.code).toBe('000660');
  });

  it('고정할 종목이 없는 창은 켜지지 않는다', async () => {
    // 표현 불가 상태(그룹도 안 따르고 자기 종목도 없음)를 만들지 않는다.
    seed([{ id: 'w1', group: 3 }], {});
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().toggleWindowPin('w1');

    expect(useWorkspaceStore.getState().windows[0].pinned).toBeUndefined();
  });

  it('해제로 종목이 바뀌면 fresh-view 로 런타임을 리셋한다', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore } = await loadStore();
    useWorkspaceStore.getState().extendChartHistoricalRange('w1', '2026-01-02');

    useWorkspaceStore.getState().toggleWindowPin('w1');

    expect(useWorkspaceStore.getState().chartRuntime.w1).toBeUndefined();
  });
});

describe('setWindowSymbol — 드롭 경로의 문', () => {
  it('핀 창에 드롭하면 그 창만 바뀌고 그룹은 그대로다', async () => {
    seed([{ id: 'pinned', group: 1, pinned: SAMSUNG }, { id: 'free', group: 1 }], { 1: HYNIX });
    const { useWorkspaceStore, windowSymbolOf } = await loadStore();

    useWorkspaceStore.getState().setWindowSymbol('pinned', KAKAO);

    const s = useWorkspaceStore.getState();
    expect(windowSymbolOf(s, s.windows.find((w) => w.id === 'pinned'))?.code).toBe('035720');
    expect(s.groupSymbols[1]?.code).toBe('000660');
  });

  it('핀 없는 창에 드롭하면 종전대로 그룹 교체(동료 창이 따라온다)', async () => {
    seed([{ id: 'a', group: 1 }, { id: 'b', group: 1 }], { 1: SAMSUNG });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().setWindowSymbol('a', KAKAO);

    expect(useWorkspaceStore.getState().groupSymbols[1]?.code).toBe('035720');
  });
});

describe('그룹 차트 링크 발행자 — groupTargetChartWindow', () => {
  it('핀 차트는 발행자가 되지 않는다 — 같은 그룹의 핀 아닌 차트가 받는다', async () => {
    // 발행 payload 는 종목 종속(code·bundle)이라, 핀 창이 발행하면 소비자의
    // `link.code === code` 가드에 전량 걸려 그룹 데이터 창이 **영구히** 링크를 잃는다.
    seed([{ id: 'follower', group: 1 }, { id: 'pinnedTop', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore, groupTargetChartWindow } = await loadStore();
    const s = useWorkspaceStore.getState();

    // zOrder 마지막(z-최상위)이 pinnedTop 이지만 발행자는 follower 여야 한다.
    expect(groupTargetChartWindow(s.windows, s.zOrder, 1)?.id).toBe('follower');
  });

  it('그룹의 차트가 핀 하나뿐이면 발행자가 없다(null) — 파생할 파이프라인이 없다', async () => {
    seed([{ id: 'onlyPinned', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore, groupTargetChartWindow } = await loadStore();
    const s = useWorkspaceStore.getState();

    expect(groupTargetChartWindow(s.windows, s.zOrder, 1)).toBeNull();
  });

  it('핀이 없으면 종전대로 z-최상위 차트(회귀 대조군)', async () => {
    seed([{ id: 'a', group: 1 }, { id: 'b', group: 1 }], { 1: HYNIX });
    const { useWorkspaceStore, groupTargetChartWindow } = await loadStore();
    const s = useWorkspaceStore.getState();

    expect(groupTargetChartWindow(s.windows, s.zOrder, 1)?.id).toBe('b');
  });
});

describe('setWindowGroup', () => {
  it('핀 창의 그룹 이동은 런타임을 리셋하지 않는다 — 표시 종목이 안 바뀐다', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX, 2: KAKAO });
    const { useWorkspaceStore } = await loadStore();
    useWorkspaceStore.getState().extendChartHistoricalRange('w1', '2026-01-02');

    useWorkspaceStore.getState().setWindowGroup('w1', 2);

    expect(useWorkspaceStore.getState().chartRuntime.w1?.historicalFromDate).toBe('2026-01-02');
  });

  it('핀 없는 창은 종전대로 리셋한다(회귀 대조군)', async () => {
    seed([{ id: 'w1', group: 1 }], { 1: HYNIX, 2: KAKAO });
    const { useWorkspaceStore } = await loadStore();
    useWorkspaceStore.getState().extendChartHistoricalRange('w1', '2026-01-02');

    useWorkspaceStore.getState().setWindowGroup('w1', 2);

    expect(useWorkspaceStore.getState().chartRuntime.w1).toBeUndefined();
  });
});

describe('unpinAllWindows', () => {
  it('전 창의 핀을 풀고 막힘 슬롯을 비운다', async () => {
    seed([{ id: 'p1', group: 1, pinned: SAMSUNG }, { id: 'p2', group: 1, pinned: HYNIX }], { 1: KAKAO });
    const { useWorkspaceStore } = await loadStore();
    useWorkspaceStore.getState().reportBlockedActivation('카카오');

    useWorkspaceStore.getState().unpinAllWindows();

    const s = useWorkspaceStore.getState();
    expect(s.windows.every((w) => w.pinned === undefined)).toBe(true);
    expect(s.blockedActivation).toBeNull();
  });
});

describe('영속·프리셋·딥링크', () => {
  it('핀은 sessionStorage 로 왕복한다', async () => {
    seed([{ id: 'w1', group: 1 }], { 1: SAMSUNG });
    const first = await loadStore();
    first.useWorkspaceStore.getState().toggleWindowPin('w1');

    const again = await loadStore();

    expect(again.useWorkspaceStore.getState().windows[0].pinned).toEqual(SAMSUNG);
  });

  it('프리셋 스냅샷은 핀을 담지 않는다 — 배치만 담는다는 계약', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: SAMSUNG });
    const { snapshotWorkspace } = await loadStore();

    expect(snapshotWorkspace().windows[0]).not.toHaveProperty('pinned');
  });

  it('프리셋을 적용해도 핀이 들어오지 않는다 — 옛 payload 에 남아 있어도', async () => {
    // 저장 쪽을 막아도 서버에 이미 실린 프리셋이 있을 수 있으므로 읽기가 최종 방어선.
    seed([{ id: 'w1', group: 1 }], { 1: SAMSUNG });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().applyWorkspaceSnapshot({
      windows: [
        {
          id: 'preset-1',
          kind: 'chart',
          group: 1,
          rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
          chart: { timeframe: '1m' },
          pinned: KAKAO,
        },
      ],
      zOrder: ['preset-1'],
    });

    expect(useWorkspaceStore.getState().windows[0].pinned).toBeUndefined();
  });

  it('딥링크 탭은 시드의 핀을 물려받지 않는다 — 안 그러면 그 URL 이 죽는다', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: SAMSUNG });

    const { useWorkspaceStore } = await loadStore('?code=035720');

    expect(useWorkspaceStore.getState().windows[0].pinned).toBeUndefined();
  });

  it('일반 탭은 그대로 물려받는다(위 딥링크 단언의 대조군)', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: SAMSUNG });

    const { useWorkspaceStore } = await loadStore('');

    expect(useWorkspaceStore.getState().windows[0].pinned).toEqual(SAMSUNG);
  });
});

describe('프리셋 적용은 핀을 이월한다 — payload 가 아니라 나가는 상태에서', () => {
  const presetWindow = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'chart',
    group: 1,
    rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
    chart: { timeframe: '1m' },
    ...extra,
  });

  it('id 가 살아남는 창은 핀을 유지한다 — 프리셋이 보던 종목을 바꾸지 않는다', async () => {
    // 그룹 종목(HYNIX)과 핀 종목(SAMSUNG)을 다르게 — 이월이 없으면 이 창은 그룹으로
    // 복귀해 화면이 HYNIX 로 바뀐다(계약이 지키려던 바로 그 손해).
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().applyWorkspaceSnapshot({
      windows: [presetWindow('w1')],
      zOrder: ['w1'],
    });

    expect(useWorkspaceStore.getState().windows[0].pinned).toEqual(SAMSUNG);
  });

  it('id 가 사라지면 핀도 창과 함께 사라진다 — 닫힌 창의 핀과 같은 결말', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().applyWorkspaceSnapshot({
      windows: [presetWindow('preset-1')],
      zOrder: ['preset-1'],
    });

    expect(useWorkspaceStore.getState().windows[0].pinned).toBeUndefined();
  });

  it('payload 의 핀보다 현재 핀이 이긴다 — 이월과 payload 차단은 독립이다', async () => {
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore.getState().applyWorkspaceSnapshot({
      windows: [presetWindow('w1', { pinned: KAKAO })],
      zOrder: ['w1'],
    });

    expect(useWorkspaceStore.getState().windows[0].pinned).toEqual(SAMSUNG);
  });
});

describe('부수 슬롯', () => {
  it('backfillSymbolNames 가 핀 종목의 실명도 치유한다', async () => {
    // 이름 없이 드롭된 종목(`name === code`)이 핀 슬롯에 들어가면, 그룹만 고치던
    // 종전 루프는 핀 창만 `005930(005930)` 로 남겨 둔다.
    seed([{ id: 'w1', group: 1, pinned: { code: '005930', name: '005930' } }], {
      1: { code: '000660', name: '000660' },
    });
    const { useWorkspaceStore } = await loadStore();

    useWorkspaceStore
      .getState()
      .backfillSymbolNames((code) => (code === '005930' ? '삼성전자' : 'SK하이닉스'));

    const s = useWorkspaceStore.getState();
    expect(s.windows[0].pinned?.name).toBe('삼성전자');
    expect(s.groupSymbols[1]?.name).toBe('SK하이닉스');
  });

  it('focusedWindowSymbol 은 포커스 창이 핀이면 그 종목을 준다(그룹 종목이 아니라)', async () => {
    // activeCode 미러의 출처 — 여기서 그룹을 보면 관심종목 하트·탭 제목이
    // 화면에 없는 종목을 가리킨다.
    seed([{ id: 'w1', group: 1, pinned: SAMSUNG }], { 1: HYNIX });
    const { useWorkspaceStore, focusedWindowSymbol } = await loadStore();

    expect(focusedWindowSymbol(useWorkspaceStore.getState())?.code).toBe('005930');
  });
});
