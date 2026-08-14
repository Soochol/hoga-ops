import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStudyViewOpenPrefsStore } from './studyViewOpenPrefs';

describe('study view open preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '3m' });
  });

  // 기본값은 **저장 봉 존중**이다. 봉 종속 지표 캐시가 봉마다 갈리는데, 저장 시점의
  // 사용자는 그 구간을 그 봉으로 보고 있었으므로 저장 봉은 이미 계산돼 있다 — warm 이
  // 확률이 아니라 구조다(스토어 주석의 실측). 다른 봉으로 열면 그 보장이 사라진다.
  it('defaults saved-view side-panel opens to the saved timeframe', async () => {
    // 초기값은 모듈 로드 시점에 결정되므로, 빈 스토리지에서 새로 로드해 검증한다.
    localStorage.clear();
    vi.resetModules();
    const fresh = await import('./studyViewOpenPrefs');
    expect(fresh.useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('saved');
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
