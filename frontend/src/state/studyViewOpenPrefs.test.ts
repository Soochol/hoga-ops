import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStudyViewOpenPrefsStore } from './studyViewOpenPrefs';

describe('study view open preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '3m' });
  });

  // 기본값은 **창 주기 유지**다. 나머지 세 값('saved'·'current'·고정 분봉)은 전부
  // "저장뷰가 봉을 정한다" 는 같은 축 위에 있고, 그 축은 창이 여럿일 때 사용자가
  // 벌려 둔 배치를 무너뜨린다 — 일봉 창 + 분봉 창에서 다른 분봉 저장뷰를 열면
  // 포커스 창이 덮여 "분봉, 분봉" 이 된다. 대가는 저장 봉의 warm 캐시 보장이고,
  // 그건 'saved' 를 고르면 되찾는다(근거는 스토어 주석의 실측).
  it('defaults saved-view side-panel opens to keeping the window timeframe', async () => {
    // 초기값은 모듈 로드 시점에 결정되므로, 빈 스토리지에서 새로 로드해 검증한다.
    localStorage.clear();
    vi.resetModules();
    const fresh = await import('./studyViewOpenPrefs');
    expect(fresh.useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('keep');
  });

  it('persists the keep-window option', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('keep');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('keep');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('keep');
  });

  it('persists the selected default minute timeframe', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('5m');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('5m');
  });

  it('persists the current-timeframe option', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('current');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('current');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('current');
  });

  it('hydrates only valid saved-view open timeframes', () => {
    localStorage.setItem('studyView.openPrefs.v1', JSON.stringify({ defaultTimeframe: 'NOPE' }));
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '5m' });

    useStudyViewOpenPrefsStore.getState().hydrateFromStorage();

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
  });

  // #837 이 'saved' 를 'current' 로 승격하던 시절의 마이그레이션은 **읽을 때만** 변환했고
  // 저장은 하지 않았다. 그래서 그때 'saved' 를 골랐던 사용자의 저장값은 그대로 남아
  // 있고, 승격을 걷어내는 것만으로 원래 선택이 복원된다 — 강제 마이그레이션이 필요 없다.
  // 이 테스트가 그 복원을 못 박는다(승격 코드가 되살아나면 여기서 걸린다).
  it('honors a stored "saved" sentinel instead of promoting it', () => {
    localStorage.setItem('studyView.openPrefs.v1', JSON.stringify({ defaultTimeframe: 'saved' }));
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '5m' });

    useStudyViewOpenPrefsStore.getState().hydrateFromStorage();

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('saved');
  });

  // 반대 방향도 못 박는다: 'current' 를 명시적으로 고른 사용자는 그대로 유지된다.
  // 기본값을 바꾸면서 저장값까지 덮으면 그 사용자는 설정을 되돌릴 방법이 없어진다.
  it('honors a stored "current" choice (기본값 전환이 사용자 선택을 덮지 않는다)', () => {
    localStorage.setItem('studyView.openPrefs.v1', JSON.stringify({ defaultTimeframe: 'current' }));
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '5m' });

    useStudyViewOpenPrefsStore.getState().hydrateFromStorage();

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('current');
  });

  it('persists the saved-timeframe option', () => {
    useStudyViewOpenPrefsStore.getState().setDefaultTimeframe('saved');

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('saved');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('saved');
  });
});
