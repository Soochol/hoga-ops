import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_STORAGE_KEY } from '../state/workspace';

/**
 * 클릭 진입점(`activateLiveInstrument`)과 창 고정의 접점.
 *
 * 관심종목·히트맵·스크리너·랭킹·검색·지수바가 **전부** 이 함수 하나로 수렴하므로
 * (useJumpToLive 소비처 11곳), 여기서 목적지 규칙을 못박으면 표면별로 다시 잴 필요가
 * 없다. 대신 그 수렴이 깨지면(누가 setGroupSymbol 을 직접 부르면) 이 테스트는
 * 그것을 못 본다 — 그 축은 `WorkspaceCanvas` 리졸버 테스트가 따로 잰다.
 */

function seedWorkspace(
  windows: { id: string; group: number; pinned?: { code: string; name: string } }[],
  groupSymbols: Record<number, { code: string; name: string }>,
) {
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

async function load() {
  window.history.replaceState({}, '', '/live');
  vi.resetModules();
  const workspace = await import('../state/workspace');
  const navigate = await import('./liveNavigate');
  return { ...workspace, ...navigate };
}

const SAMSUNG = { code: '005930', name: '삼성전자' };
const HYNIX = { code: '000660', name: 'SK하이닉스' };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('클릭 종목 교체 vs 창 고정', () => {
  it('포커스 창이 고정이면 그 창은 안 바뀌고 아래 창이 받는다', async () => {
    // 사용자 요청의 핵심 문장: "창 헤더가 포커스가 되더라도 종목 변경이 안 되게".
    // 'pinned' 가 zOrder 마지막(=포커스)이지만 종목은 'free' 로 가야 한다.
    seedWorkspace([{ id: 'free', group: 2 }, { id: 'pinned', group: 1, pinned: SAMSUNG }], {
      1: SAMSUNG,
      2: HYNIX,
    });
    const { useWorkspaceStore, activateLiveCode, windowSymbolOf } = await load();

    activateLiveCode('035720', '카카오');

    const s = useWorkspaceStore.getState();
    expect(windowSymbolOf(s, s.windows.find((w) => w.id === 'pinned'))?.code).toBe('005930');
    expect(windowSymbolOf(s, s.windows.find((w) => w.id === 'free'))?.code).toBe('035720');
  });

  it('받은 창을 포커스로 올린다 — 미러가 화면에 없는 종목을 잡지 않게', async () => {
    // 안 올리면 activeCode(관심종목 하트·검색 하이라이트·탭 제목)가 여전히 고정 창의
    // 종목이라, 방금 클릭한 종목이 어디에도 활성으로 보이지 않는다.
    seedWorkspace([{ id: 'free', group: 2 }, { id: 'pinned', group: 1, pinned: SAMSUNG }], {
      1: SAMSUNG,
      2: HYNIX,
    });
    const { useWorkspaceStore, activateLiveCode, focusedWindowSymbol } = await load();

    activateLiveCode('035720', '카카오');

    const s = useWorkspaceStore.getState();
    expect(s.zOrder[s.zOrder.length - 1]).toBe('free');
    expect(focusedWindowSymbol(s)?.code).toBe('035720');
  });

  it('고정이 없으면 종전대로 포커스 창의 그룹이 바뀐다(회귀 대조군)', async () => {
    seedWorkspace([{ id: 'a', group: 1 }, { id: 'b', group: 2 }], { 1: SAMSUNG, 2: HYNIX });
    const { useWorkspaceStore, activateLiveCode } = await load();

    activateLiveCode('035720', '카카오');

    const s = useWorkspaceStore.getState();
    expect(s.groupSymbols[2]?.code).toBe('035720');
    expect(s.groupSymbols[1]?.code).toBe('005930');
  });

  it('전 창이 고정이면 아무것도 안 바꾸고 **알린다** — 조용한 무반응 금지', async () => {
    seedWorkspace([{ id: 'p1', group: 1, pinned: SAMSUNG }, { id: 'p2', group: 2, pinned: HYNIX }], {
      1: SAMSUNG,
      2: HYNIX,
    });
    const { useWorkspaceStore, activateLiveCode } = await load();

    activateLiveCode('035720', '카카오');

    const s = useWorkspaceStore.getState();
    expect(s.windows.find((w) => w.id === 'p1')?.pinned).toEqual(SAMSUNG);
    expect(s.windows.find((w) => w.id === 'p2')?.pinned).toEqual(HYNIX);
    expect(s.blockedActivation).toEqual({ name: '카카오' });
  });
});
