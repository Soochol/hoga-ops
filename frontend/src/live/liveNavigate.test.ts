import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore } from '../state/livePage';
import { mirrorActiveGroupToLivePage } from './liveNavigate';

/**
 * 미러 가드(workspace 활성 그룹 → livePage 레거시 투영)의 경계.
 *
 * `projectActiveView` 는 원자적 **뷰 교체**라 historicalFromDate·activeViewport 를
 * 리셋하고 지표를 재투영한다. 그래서 "무엇이 뷰 교체인가" 를 가드가 정한다 —
 * 종목·kind·봉은 교체이고, **라벨 변화는 교체가 아니다**(심볼 마스터 실명 보강이
 * 라벨만 바꾼다).
 */
describe('mirrorActiveGroupToLivePage 가드', () => {
  beforeEach(() => {
    localStorage.clear();
    useLivePageStore.setState({
      activeInstrument: { kind: 'stock', code: '005930', label: '005930' },
      activeCode: '005930',
      candleTimeframe: '1m',
      lastMinuteTimeframe: '1m',
      historicalFromDate: '20260101',
      lastMinuteHistoricalFromDate: '20260101',
    });
  });

  it('라벨만 달라진 경우 재투영하지 않는다 — 실명 보강이 뷰를 갈아엎지 않게', () => {
    mirrorActiveGroupToLivePage({ code: '005930', name: '삼성전자' }, '1m');
    const s = useLivePageStore.getState();
    expect(s.historicalFromDate).toBe('20260101');
    expect(s.lastMinuteHistoricalFromDate).toBe('20260101');
  });

  it('종목이 바뀌면 재투영한다 — 뷰 교체는 리셋이 맞다', () => {
    mirrorActiveGroupToLivePage({ code: '000660', name: 'SK하이닉스' }, '1m');
    const s = useLivePageStore.getState();
    expect(s.activeCode).toBe('000660');
    expect(s.activeInstrument).toEqual({ kind: 'stock', code: '000660', label: 'SK하이닉스' });
    expect(s.historicalFromDate).toBeNull();
  });

  it('봉이 바뀌면 재투영한다', () => {
    mirrorActiveGroupToLivePage({ code: '005930', name: '005930' }, 'D');
    const s = useLivePageStore.getState();
    expect(s.candleTimeframe).toBe('D');
    expect(s.historicalFromDate).toBeNull();
  });

  it('kind 가 바뀌면(주식→지수) 재투영한다', () => {
    mirrorActiveGroupToLivePage({ code: 'KOSPI', name: 'KOSPI', kind: 'index' }, '1m');
    const s = useLivePageStore.getState();
    expect(s.activeInstrument).toEqual({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });
    expect(s.historicalFromDate).toBeNull();
  });

  it('아무것도 안 바뀌면 no-op', () => {
    mirrorActiveGroupToLivePage({ code: '005930', name: '005930' }, '1m');
    const s = useLivePageStore.getState();
    expect(s.historicalFromDate).toBe('20260101');
  });
});
