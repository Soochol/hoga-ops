import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { initStudyTabsSync, studyTabFromSave, toStudyTabsSnapshot, useStudyTabsStore } from './studyTabs';

/** studyTabs.ts 의 비-export 상수를 테스트가 다시 적는다 — 프로덕션 표면을 테스트만을
 *  위해 넓히지 않기 위해서다. 값이 갈리면 아래 저장 테스트가 빨개진다. */
const STUDY_TABS_STORAGE_KEY = 'study.tabs.v1';

const save = {
  schema_version: 2,
  id: 'view1',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  range: { from_date: '20260616', to_date: '20260616', from_ms: 1, to_ms: 2 },
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 100,
  updated_at_ms: 200,
} satisfies StudyViewReference;

describe('studyTabs store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it('creates a tab from a saved study view', () => {
    const tab = studyTabFromSave(save);
    expect(tab).toMatchObject({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자 · 장초반 · 1m',
      timeframe: '1m',
    });
  });

  it('replaces the active tab for normal navigation', () => {
    useStudyTabsStore.getState().openSaveInActiveTab(save);
    const first = useStudyTabsStore.getState().activeTabId;
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2', name: '마감' });
    const state = useStudyTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(first);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view2', name: '마감' });
  });

  // 탭이 창 봉을 든 채(StudyPage 가 되받아쓴다, #1326) 같은 저장뷰를 다시 열면
  // 저장 봉으로 리셋되고 **뷰포트는 버린다** — 다른 봉의 줌을 물려받으면 엉뚱한
  // 구간을 보게 된다. 이 경로는 봉 소유가 창으로 넘어오면서 오히려 흔해졌다.
  it('clears an existing saved-view tab viewport when reopening it with a different timeframe', () => {
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' });
    const tabId = useStudyTabsStore.getState().activeTabId!;
    // 창이 3m 이라 탭 라벨도 3m 으로 따라간 상태를 만든다(그 함수가 뷰포트를 비우므로
    // 뷰포트는 그 **다음에** 심는다 — 순서를 뒤집으면 검사 대상이 사라진다).
    useStudyTabsStore.getState().updateTabTimeframe(tabId, '3m');
    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: false,
    });

    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' });

    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '10m',
      viewport: null,
    });
  });

  it('탭은 저장 봉으로 시드된다 — 봉을 바꾸는 것은 창이지 이 스토어가 아니다', () => {
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' });

    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '10m',
      label: '삼성전자 · 장초반 · 10m',
    });
  });

  it('focuses an existing tab instead of replacing the active tab for the same saved view', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const [firstTab, secondTab] = useStudyTabsStore.getState().tabs;

    useStudyTabsStore.getState().openSaveInActiveTab(save);

    const state = useStudyTabsStore.getState();
    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view1', 'view2']);
    expect(state.activeTabId).toBe(firstTab.id);
    expect(state.tabs.find((tab) => tab.id === secondTab.id)).toMatchObject({ viewId: 'view2', name: '마감' });
  });

  it('treats same-code same-name saves as distinct tabs when their saved view ids differ', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const firstTabId = useStudyTabsStore.getState().activeTabId;
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2' });

    const state = useStudyTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(firstTabId);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view2', code: '005930', name: '장초반' });
  });

  it('opens Ctrl-click saves in a new tab', () => {
    useStudyTabsStore.getState().openSaveInActiveTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const state = useStudyTabsStore.getState();
    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view1', 'view2']);
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId).toBe('view2');
  });

  it('serializes without ephemeral generated ids', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).toEqual({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자 · 장초반 · 1m',
      name: '장초반',
      timeframe: '1m',
    });
  });

  it('persists pinned state in study tab snapshots', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const id = useStudyTabsStore.getState().activeTabId!;

    useStudyTabsStore.getState().toggleTabPinned(id);

    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).toMatchObject({
      viewId: save.id,
      pinned: true,
    });
  });

  it('keeps pinned study tabs before unpinned tabs when toggled', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const second = useStudyTabsStore.getState().tabs[1].id;

    useStudyTabsStore.getState().toggleTabPinned(second);

    expect(useStudyTabsStore.getState().tabs.map((t) => [t.viewId, Boolean(t.pinned)])).toEqual([
      ['view2', true],
      ['view1', false],
    ]);
  });

  it('does not close pinned study tabs', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const id = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().toggleTabPinned(id);

    useStudyTabsStore.getState().closeTab(id);

    expect(useStudyTabsStore.getState().tabs).toHaveLength(1);
    expect(useStudyTabsStore.getState().tabs[0].id).toBe(id);
  });

  it('does not drag study tabs across the pinned boundary', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const first = useStudyTabsStore.getState().tabs[0].id;
    useStudyTabsStore.getState().toggleTabPinned(first);

    useStudyTabsStore.getState().reorderTabs(0, 1);

    expect(useStudyTabsStore.getState().tabs.map((t) => t.viewId)).toEqual(['view1', 'view2']);
  });

  it('opens an unpinned study tab when the active pinned tab would be replaced', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const pinnedId = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().toggleTabPinned(pinnedId);

    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2', name: '마감' });

    expect(useStudyTabsStore.getState().tabs.map((t) => [t.viewId, Boolean(t.pinned)])).toEqual([
      ['view1', true],
      ['view2', false],
    ]);
    expect(useStudyTabsStore.getState().activeTabId).not.toBe(pinnedId);
  });

  it('keeps tab viewport in memory but excludes it from the persisted snapshot', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const tabId = useStudyTabsStore.getState().activeTabId!;

    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: false,
    });

    expect(useStudyTabsStore.getState().tabs[0].viewport).toEqual({
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: false,
    });
    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).not.toHaveProperty('viewport');
  });

  it('keeps a previously captured right padding when a later capture cannot compute it', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const tabId = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: true,
      rightPaddingBars: 12,
    });

    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: true,
    });

    expect(useStudyTabsStore.getState().tabs[0].viewport).toEqual({
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: true,
      rightPaddingBars: 12,
    });
  });

  it('closes every tab for a deleted study view and focuses a safe neighbor', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view1', name: '장초반 복사' });

    const nextActive = useStudyTabsStore.getState().closeTabsByViewId('view1');
    const state = useStudyTabsStore.getState();

    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view2']);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(nextActive?.viewId).toBe('view2');
  });
});

/**
 * 저장 배선 — `initStudyTabsSync()` 는 `src/main.tsx` 에서만 불리므로 **어떤 테스트도
 * 이 경로를 타지 않았다.** `attachPersistence` 의 유일한 실제 스토어 소비처인데
 * 스냅샷이 저장되는지, 다음 로드에 복원되는지가 통째로 미검증이었다.
 *
 * ⚠ `study.tabs.v1` 은 **공유 localStorage 에 탭 목록 전체 스냅샷**을 쓴다 —
 * `state/workspace.ts` 가 이름 붙여 고친 그 파괴 기전과 구조적으로 같다(두 탭 화면은
 * 각자 자기 메모리를 계속 그리므로 조용히 깨지고, 손실은 다음 새로고침에야 드러난다).
 * 도달성이 낮아(코드 전체에서 `window.open` 은 `/live` 한 곳뿐이라 /study 를 두 탭에
 * 띄우려면 사용자가 탭을 수동 복제해야 한다) 2026-08-17 에 **보류**로 결정했다.
 * 여기 테스트는 그 결정을 전제로 현재 동작을 못박는다 — 스코프를 바꾸면 여기가 빨개진다.
 */
describe('initStudyTabsSync — 저장 배선', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('탭 변경을 debounce 후 localStorage 에 쓴다', () => {
    vi.useFakeTimers();
    const dispose = initStudyTabsSync();
    try {
      useStudyTabsStore.getState().openSaveInNewTab(save);
      expect(localStorage.getItem(STUDY_TABS_STORAGE_KEY)).toBeNull(); // debounce 전

      vi.advanceTimersByTime(250);

      const raw = localStorage.getItem(STUDY_TABS_STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)).toMatchObject({
        version: 1,
        activeIndex: 0,
        tabs: [{ viewId: 'view1', code: '005930' }],
      });
    } finally {
      dispose();
    }
  });

  it('dispose 하면 더 이상 쓰지 않는다', () => {
    vi.useFakeTimers();
    const dispose = initStudyTabsSync();
    dispose();

    useStudyTabsStore.getState().openSaveInNewTab(save);
    vi.advanceTimersByTime(250);

    expect(localStorage.getItem(STUDY_TABS_STORAGE_KEY)).toBeNull();
  });

  it('저장한 스냅샷이 다음 로드에 복원된다 (탭 id 는 새로 발급)', async () => {
    vi.useFakeTimers();
    const dispose = initStudyTabsSync();
    let savedId: string;
    try {
      useStudyTabsStore.getState().openSaveInNewTab(save);
      savedId = useStudyTabsStore.getState().activeTabId!;
      vi.advanceTimersByTime(250);
    } finally {
      dispose();
    }
    vi.useRealTimers();

    // 스토어는 모듈 로드 시 하이드레이션하므로 신선하게 다시 불러온다.
    vi.resetModules();
    const { useStudyTabsStore: fresh } = await import('./studyTabs');

    const state = fresh.getState();
    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view1']);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    // id 는 nanoid 로 재발급된다 — 저장 스냅샷에 id 를 싣지 않기 때문.
    expect(state.tabs[0].id).not.toBe(savedId);
  });
});
