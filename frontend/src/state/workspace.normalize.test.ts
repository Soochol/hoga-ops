import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_STORAGE_KEY } from './workspace';

/**
 * 레거시 px → 비율 지연 마이그레이션 (ADR-0122).
 *
 * 핵심은 "언제" 변환하느냐다. 하이드레이션 시점에는 그 px 가 *어떤 캔버스에서*
 * 만들어졌는지 모르므로 고정 기준으로 나누면 안 된다(넓은 모니터 레이아웃이 비율
 * 1 을 넘겨 화면 밖으로 날아간다). 캔버스가 자기 크기를 처음 실측할 때까지 미룬다.
 */
const LEGACY_PX = {
  windows: [
    { id: 'chart1', kind: 'chart', group: 1, rect: { x: 16, y: 16, w: 720, h: 760 }, chart: { timeframe: '1m' } },
    { id: 'book1', kind: 'book', group: 1, rect: { x: 748, y: 16, w: 680, h: 560 } },
  ],
  zOrder: ['chart1', 'book1'],
  groupSymbols: {},
};

describe('워크스페이스 rect 정규화 (ADR-0122)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('schema_version 없는 저장값은 px 를 보존한 채 변환 대기로 들어온다', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(LEGACY_PX));
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();

    expect(s.pendingNormalize).toBe(true);
    // 아직 px 그대로 — 캔버스를 모르는 채로 비율인 척하면 창이 좌상단에 뭉친다.
    expect(s.windows[1].rect).toEqual({ x: 748, y: 16, w: 680, h: 560 });
  });

  it('캔버스 실측 시점에 그 캔버스 기준으로 비율화한다(배치 무변화)', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(LEGACY_PX));
    const mod = await import('./workspace');
    const canvas = { w: 1546, h: 776 };

    mod.useWorkspaceStore.getState().normalizeLegacyRects(canvas);
    const s = mod.useWorkspaceStore.getState();

    expect(s.pendingNormalize).toBe(false);
    const book = s.windows.find((w) => w.id === 'book1')!.rect;
    expect(book.x).toBeCloseTo(748 / 1546, 10);
    expect(book.w).toBeCloseTo(680 / 1546, 10);
    // 변환 직후 같은 캔버스로 펴면 원래 px 가 그대로 나온다 = 사용자 눈에 변화 없음.
    expect(book.x * canvas.w).toBeCloseTo(748, 6);
    expect(book.h * canvas.h).toBeCloseTo(560, 6);
  });

  it('정규화 결과를 v2 로 영속화한다(다음 로드는 변환 없이 바로 비율)', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(LEGACY_PX));
    const mod = await import('./workspace');
    mod.useWorkspaceStore.getState().normalizeLegacyRects({ w: 1546, h: 776 });

    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
    expect(saved.schema_version).toBe(mod.WORKSPACE_SCHEMA_VERSION);
    expect(saved.windows[1].rect.w).toBeCloseTo(680 / 1546, 10);

    vi.resetModules();
    const reloaded = await import('./workspace');
    expect(reloaded.useWorkspaceStore.getState().pendingNormalize).toBe(false);
  });

  it('두 번 불러도 한 번만 변환한다(비율을 또 나누면 창이 사라진다)', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(LEGACY_PX));
    const mod = await import('./workspace');
    const canvas = { w: 1546, h: 776 };

    mod.useWorkspaceStore.getState().normalizeLegacyRects(canvas);
    const once = mod.useWorkspaceStore.getState().windows.map((w) => ({ ...w.rect }));
    mod.useWorkspaceStore.getState().normalizeLegacyRects(canvas);
    const twice = mod.useWorkspaceStore.getState().windows.map((w) => ({ ...w.rect }));

    expect(twice).toEqual(once);
  });

  it('v2 저장값은 변환 없이 비율 그대로 읽는다', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        schema_version: 2,
        windows: [{ id: 'b', kind: 'book', group: 1, rect: { x: 0.48, y: 0.02, w: 0.44, h: 0.72 } }],
        zOrder: ['b'],
        groupSymbols: {},
      }),
    );
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();

    expect(s.pendingNormalize).toBe(false);
    expect(s.windows[0].rect).toEqual({ x: 0.48, y: 0.02, w: 0.44, h: 0.72 });
  });

  it('v2 인데 비율 범위를 벗어난 rect 는 드롭한다(px 오염 방어)', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        schema_version: 2,
        windows: [{ id: 'bad', kind: 'book', group: 1, rect: { x: 748, y: 16, w: 680, h: 560 } }],
        zOrder: ['bad'],
        groupSymbols: {},
      }),
    );
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();

    // 손상 창은 드롭되고 공장 기본으로 폴백한다(창을 0개로 잃지 않는다).
    expect(s.windows.some((w) => w.id === 'bad')).toBe(false);
    expect(s.windows.length).toBeGreaterThan(0);
  });
});
