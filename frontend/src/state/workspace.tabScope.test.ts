import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_STORAGE_KEY } from './workspace';

/** 워크스페이스 스토어는 모듈 초기화 시점에 하이드레이션하므로(readStorage), 스코프
 *  판정을 바꾸려면 URL 을 먼저 세우고 모듈을 다시 import 해야 한다. */
async function loadWorkspaceAt(search: string) {
  window.history.replaceState({}, '', `/live${search}`);
  vi.resetModules();
  return await import('./workspace');
}

function snapshot(store: Storage) {
  const raw = store.getItem(WORKSPACE_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { groupSymbols?: Record<string, { code: string }> }) : null;
}

/** 사용자가 늘 쓰던 공유 워크스페이스 — 창 1개 + 그룹1 종목. */
function seedSharedWorkspace(code: string) {
  seedWorkspace(localStorage, code);
}

function seedWorkspace(store: Storage, code: string, windowId = 'w1') {
  store.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      windows: [
        {
          id: windowId,
          kind: 'chart',
          group: 1,
          rect: { x: 0, y: 0, w: 500, h: 400 },
          chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
        },
      ],
      zOrder: [windowId],
      groupSymbols: { 1: { code, name: code } },
    }),
  );
}

describe('워크스페이스 영속 스코프 (전 탭 격리)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('메인 탭은 자기 sessionStorage 와 공유 시드에 함께 쓴다', async () => {
    seedSharedWorkspace('005930');
    const { useWorkspaceStore } = await loadWorkspaceAt('');

    useWorkspaceStore.getState().setGroupSymbol(1, { code: '000660', name: 'SK하이닉스' });

    // authoritative = 자기 탭. 공유 키는 "새 탭의 시드" 로 함께 갱신된다.
    expect(snapshot(sessionStorage)?.groupSymbols?.[1].code).toBe('000660');
    expect(snapshot(localStorage)?.groupSymbols?.[1].code).toBe('000660');
  });

  it('회귀 핵심: 다른 탭이 공유 시드를 바꿔도 이미 열린 탭은 밟히지 않는다', async () => {
    // 이 탭은 이미 자기 배치를 갖고 있다(= 한 번이라도 조작했다).
    seedWorkspace(sessionStorage, '000660', 'mine');
    // 그 사이 다른 메인 탭이 공유 시드를 자기 것으로 덮어썼다.
    seedWorkspace(localStorage, '005930', 'theirs');

    const { useWorkspaceStore } = await loadWorkspaceAt('');

    // 하이드레이션은 자기 탭만 본다 — 남의 창·종목이 새어 들어오지 않는다.
    expect(useWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(['mine']);
    expect(useWorkspaceStore.getState().groupSymbols[1]?.code).toBe('000660');
  });

  it('메인 탭도 자기 저장소가 비어 있으면 공유 시드를 물려받는다', async () => {
    seedSharedWorkspace('005930');
    const { useWorkspaceStore } = await loadWorkspaceAt('');

    expect(useWorkspaceStore.getState().groupSymbols[1]?.code).toBe('005930');
    // 열기만 해서는 아무것도 쓰지 않는다(시드는 읽기 전용).
    expect(snapshot(sessionStorage)).toBeNull();
  });

  it('?code= 로 열린 탭은 sessionStorage 에만 쓰고 공유 워크스페이스를 건드리지 않는다', async () => {
    seedSharedWorkspace('005930');
    const { useWorkspaceStore } = await loadWorkspaceAt('?code=000660');

    useWorkspaceStore.getState().setGroupSymbol(1, { code: '000660', name: 'SK하이닉스' });

    expect(snapshot(sessionStorage)?.groupSymbols?.[1].code).toBe('000660');
    // 회귀 핵심: 공유 키는 원래 종목 그대로.
    expect(snapshot(localStorage)?.groupSymbols?.[1].code).toBe('005930');
  });

  it('?index= 로 열린 탭도 같은 격리를 받는다', async () => {
    seedSharedWorkspace('005930');
    const { useWorkspaceStore } = await loadWorkspaceAt('?index=KOSPI');

    useWorkspaceStore.getState().setGroupSymbol(1, { code: 'KOSPI', name: 'KOSPI' });

    expect(snapshot(localStorage)?.groupSymbols?.[1].code).toBe('005930');
  });

  it('딥링크 탭은 자기 저장소가 비어 있으면 공유 레이아웃에서 1회 시드한다', async () => {
    seedSharedWorkspace('005930');
    const { useWorkspaceStore } = await loadWorkspaceAt('?code=000660');

    // 사용자가 늘 쓰던 창 배치를 그대로 물려받는다 — 공장 기본이 아니다.
    expect(useWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(['w1']);
  });

  it('시드는 읽기 전용이다 — 딥링크 탭을 열기만 해서는 공유 키가 바뀌지 않는다', async () => {
    seedSharedWorkspace('005930');
    const before = localStorage.getItem(WORKSPACE_STORAGE_KEY);

    await loadWorkspaceAt('?code=000660');

    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(before);
  });
});
