import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import {
  studyActiveViewFromSave,
  toStudyActiveViewSnapshot,
  useStudyActiveViewStore,
} from './studyActiveView';

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

/** 하이드레이션은 모듈 로드 시점에 **한 번만** 돈다(`create()` 초기값). localStorage 를
 *  심고 `setState` 하는 평범한 패턴으로는 그 경로에 절대 닿지 못하므로, 실제 부팅을
 *  재현하려면 모듈을 다시 평가해야 한다. */
async function hydrateFresh() {
  vi.resetModules();
  const mod = await import('./studyActiveView');
  return mod.useStudyActiveViewStore.getState().active;
}

describe('studyActiveView store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStudyActiveViewStore.setState({ active: null });
  });

  // 탭 시절에는 `formatStudyTabLabel` 이 `삼성전자 · 장초반 · 1m` 조합 문자열을 만들었다.
  // 그 포맷은 탭 칩 전용이었고 헤더는 label·name·code 를 따로 렌더하므로 raw 를 담는다.
  it('저장뷰에서 활성 뷰를 만든다 — 라벨은 가공하지 않은 원본이다', () => {
    expect(studyActiveViewFromSave(save)).toEqual({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자',
      name: '장초반',
    });
  });

  it('저장뷰를 열면 현재 뷰를 제자리 교체한다', () => {
    useStudyActiveViewStore.getState().openSave(save);
    useStudyActiveViewStore.getState().openSave({ ...save, id: 'view2', name: '마감' });
    expect(useStudyActiveViewStore.getState().active).toMatchObject({
      viewId: 'view2',
      name: '마감',
    });
  });

  it('같은 뷰를 두 번 열어도 상태가 같다 (멱등)', () => {
    useStudyActiveViewStore.getState().openSave(save);
    const first = useStudyActiveViewStore.getState().active;
    useStudyActiveViewStore.getState().openSave(save);
    expect(useStudyActiveViewStore.getState().active).toEqual(first);
  });

  it('활성 뷰가 삭제되면 비우고 true 를 답한다', () => {
    useStudyActiveViewStore.getState().openSave(save);
    expect(useStudyActiveViewStore.getState().clearIfView('view1')).toBe(true);
    expect(useStudyActiveViewStore.getState().active).toBeNull();
  });

  // 비활성 뷰 삭제가 화면을 흔들면 안 된다 — 드로어에서 남의 뷰를 지웠을 뿐이다.
  it('다른 뷰가 삭제되면 false 를 답하고 활성 뷰를 건드리지 않는다', () => {
    useStudyActiveViewStore.getState().openSave(save);
    expect(useStudyActiveViewStore.getState().clearIfView('other')).toBe(false);
    expect(useStudyActiveViewStore.getState().active).toMatchObject({ viewId: 'view1' });
  });

  it('스냅샷은 version 과 view 만 담는다', () => {
    useStudyActiveViewStore.getState().openSave(save);
    expect(toStudyActiveViewSnapshot(useStudyActiveViewStore.getState())).toEqual({
      version: 1,
      view: { viewId: 'view1', code: '005930', label: '삼성전자', name: '장초반' },
    });
  });

  describe('하이드레이션', () => {
    it('자기 키가 있으면 그대로 복원한다 — 마지막 뷰 복원의 실체', async () => {
      window.localStorage.setItem('study.activeView.v1', JSON.stringify({
        version: 1,
        view: { viewId: 'view9', code: '000660', label: 'SK하이닉스', name: '눌림목' },
      }));
      expect(await hydrateFresh()).toMatchObject({ viewId: 'view9', code: '000660' });
    });

    // ADR-0113 은 `/live` 에서 옛 탭 키를 버렸다. 저기엔 `live.page.v1` 이라는 독립
    // 영속처가 있었고 여기엔 없다 — 버리면 기존 사용자의 첫 진입이 빈 화면이 된다.
    it('자기 키가 없으면 study.tabs.v1 의 활성 탭 하나를 승계한다', async () => {
      window.localStorage.setItem('study.tabs.v1', JSON.stringify({
        version: 1,
        activeIndex: 1,
        tabs: [
          { viewId: 'view-a', code: '005930', label: 'A', name: 'a', timeframe: '1m' },
          { viewId: 'view-b', code: '000660', label: 'B', name: 'b', timeframe: '5m' },
        ],
      }));
      expect(await hydrateFresh()).toEqual({
        viewId: 'view-b',
        code: '000660',
        label: 'B',
        name: 'b',
      });
    });

    it('activeIndex 가 범위를 벗어나면 clamp 한다', async () => {
      window.localStorage.setItem('study.tabs.v1', JSON.stringify({
        version: 1,
        activeIndex: 9,
        tabs: [
          { viewId: 'view-a', code: '005930', label: 'A', name: 'a', timeframe: '1m' },
          { viewId: 'view-b', code: '000660', label: 'B', name: 'b', timeframe: '5m' },
        ],
      }));
      expect(await hydrateFresh()).toMatchObject({ viewId: 'view-b' });
    });

    // 승계는 **1회성**이다. 새 키가 생긴 뒤에도 옛 키를 읽으면 사용자가 그 사이 바꾼
    // 뷰가 매 부팅마다 옛 탭으로 되돌아간다.
    it('자기 키가 있으면 study.tabs.v1 을 쳐다보지 않는다', async () => {
      window.localStorage.setItem('study.activeView.v1', JSON.stringify({
        version: 1,
        view: { viewId: 'view-new', code: '005930', label: 'N', name: 'n' },
      }));
      window.localStorage.setItem('study.tabs.v1', JSON.stringify({
        version: 1,
        activeIndex: 0,
        tabs: [{ viewId: 'view-old', code: '000660', label: 'O', name: 'o', timeframe: '1m' }],
      }));
      expect(await hydrateFresh()).toMatchObject({ viewId: 'view-new' });
    });

    // 활성 뷰를 비운 채 저장한 상태(뷰 삭제 직후)가 옛 탭으로 되살아나면 안 된다.
    it('자기 키가 명시적 null 이면 승계하지 않는다', async () => {
      window.localStorage.setItem('study.activeView.v1', JSON.stringify({ version: 1, view: null }));
      window.localStorage.setItem('study.tabs.v1', JSON.stringify({
        version: 1,
        activeIndex: 0,
        tabs: [{ viewId: 'view-old', code: '000660', label: 'O', name: 'o', timeframe: '1m' }],
      }));
      expect(await hydrateFresh()).toBeNull();
    });

    it('둘 다 없으면 null 이다', async () => {
      expect(await hydrateFresh()).toBeNull();
    });

    it('깨진 JSON·모양이 다른 값은 null 로 떨어진다', async () => {
      window.localStorage.setItem('study.activeView.v1', '{not json');
      expect(await hydrateFresh()).toBeNull();

      window.localStorage.setItem('study.activeView.v1', JSON.stringify({ version: 1, view: { viewId: 1 } }));
      expect(await hydrateFresh()).toBeNull();
    });

    it('탭 스냅샷이 비었거나 필수 필드가 없으면 승계하지 않는다', async () => {
      window.localStorage.setItem('study.tabs.v1', JSON.stringify({ version: 1, activeIndex: 0, tabs: [] }));
      expect(await hydrateFresh()).toBeNull();

      window.localStorage.setItem('study.tabs.v1', JSON.stringify({
        version: 1,
        activeIndex: 0,
        tabs: [{ label: 'A', name: 'a', timeframe: '1m' }],
      }));
      expect(await hydrateFresh()).toBeNull();
    });
  });
});
