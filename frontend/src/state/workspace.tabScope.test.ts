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
  localStorage.setItem(
    WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      windows: [
        {
          id: 'w1',
          kind: 'chart',
          group: 1,
          rect: { x: 0, y: 0, w: 500, h: 400 },
          chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
        },
      ],
      zOrder: ['w1'],
      groupSymbols: { 1: { code, name: code } },
    }),
  );
}

describe('워크스페이스 영속 스코프 (딥링크 탭 격리)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('쿼리 없는 /live 는 종전대로 localStorage 에 쓴다', async () => {
    seedSharedWorkspace('005930');
    const { useWorkspaceStore } = await loadWorkspaceAt('');

    useWorkspaceStore.getState().setGroupSymbol(1, { code: '000660', name: 'SK하이닉스' });

    expect(snapshot(localStorage)?.groupSymbols?.[1].code).toBe('000660');
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
