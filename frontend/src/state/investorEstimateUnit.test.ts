import { describe, it, expect, beforeEach } from 'vitest';
import {
  INVESTOR_ESTIMATE_UNITS,
  INVESTOR_ESTIMATE_UNIT_LABELS,
  subscribeToInvestorEstimateUnitStorage,
  useInvestorEstimateUnitStore,
  type InvestorEstimateUnit,
} from './investorEstimateUnit';

const KEY = 'live.investorEstimateUnit.v1';

describe('useInvestorEstimateUnitStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useInvestorEstimateUnitStore.setState({ unit: 'qty' });
  });

  it('defaults to qty (수량)', () => {
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty');
  });

  it('setUnit updates and persists to localStorage', () => {
    useInvestorEstimateUnitStore.getState().setUnit('amount');
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount');
    expect(localStorage.getItem(KEY)).toContain('amount');
  });

  it('toggleUnit 은 두 값을 왕복하며 매번 영속한다', () => {
    useInvestorEstimateUnitStore.getState().toggleUnit();
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount');
    expect(localStorage.getItem(KEY)).toContain('amount');

    useInvestorEstimateUnitStore.getState().toggleUnit();
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty');
    expect(localStorage.getItem(KEY)).toContain('qty');
  });

  it('rejects unknown values at runtime', () => {
    useInvestorEstimateUnitStore.getState().setUnit('bogus' as InvestorEstimateUnit);
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty');
  });

  it('hydrates from localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify({ unit: 'amount' }));
    useInvestorEstimateUnitStore.getState().hydrateFromStorage();
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount');
  });

  it('ignores corrupt stored JSON during hydration', () => {
    localStorage.setItem(KEY, '{');
    useInvestorEstimateUnitStore.getState().hydrateFromStorage();
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty');
  });

  it('ignores persisted unknown unit values during hydration', () => {
    localStorage.setItem(KEY, JSON.stringify({ unit: 'BAD' }));
    useInvestorEstimateUnitStore.getState().hydrateFromStorage();
    expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty');
  });

  it('두 단위와 라벨이 짝을 이룬다 (주/억)', () => {
    expect(INVESTOR_ESTIMATE_UNITS.map((u) => INVESTOR_ESTIMATE_UNIT_LABELS[u])).toEqual(['주', '억']);
  });

  /** 단위는 탭 전역이다 — 창별로 갈리면 나란히 놓고 비교하는 일이 불가능하다는
   *  모듈 도크스트링의 논거가 탭에도 그대로 성립한다(`/live` 딥링크가 새 탭을 연다).
   *  거래소(`liveVenue.ts`, 2026-08-07)와 같은 모양. */
  describe('subscribeToInvestorEstimateUnitStorage', () => {
    it('다른 탭의 선택을 반영하고, 해제하면 더 이상 반영하지 않는다', () => {
      const unsubscribe = subscribeToInvestorEstimateUnitStorage();

      // 저장 → 이벤트 순서. 구독은 event.newValue 가 아니라 저장소를 다시 읽으므로
      // 이벤트만 쏘면 아무 일도 일어나지 않는다.
      localStorage.setItem(KEY, JSON.stringify({ unit: 'amount' }));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
      expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount');

      unsubscribe();
      localStorage.setItem(KEY, JSON.stringify({ unit: 'qty' }));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
      expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount'); // 그대로
    });

    it('다른 키의 storage 이벤트는 무시한다', () => {
      const unsubscribe = subscribeToInvestorEstimateUnitStorage();

      localStorage.setItem(KEY, JSON.stringify({ unit: 'amount' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui.themePreference.v1' }));

      expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty'); // beforeEach 값
      unsubscribe();
    });

    it('다른 탭이 쓴 미지 값은 통과시키지 않는다', () => {
      // 저장소를 다시 읽는 설계의 이득: 초기화와 같은 검증(isUnit)을 그대로 탄다.
      // newValue 를 믿었다면 손으로 편집된 값이 store 에 들어온다.
      const unsubscribe = subscribeToInvestorEstimateUnitStorage();

      localStorage.setItem(KEY, JSON.stringify({ unit: 'BAD' }));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));

      expect(useInvestorEstimateUnitStore.getState().unit).toBe('qty');
      unsubscribe();
    });

    it('재수화는 저장소를 되쓰지 않는다 — 왕복이 멈춘다', () => {
      const unsubscribe = subscribeToInvestorEstimateUnitStorage();

      // 이 탭이 같은 키를 되썼다면 문자열이 정규화 결과로 바뀌었을 것이다.
      // 되쓰기가 있으면 상대 탭이 또 이벤트를 받아 핑퐁이 된다.
      const payload = '{"unit":"amount"}';
      localStorage.setItem(KEY, payload);
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));

      expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount');
      expect(localStorage.getItem(KEY)).toBe(payload);
      unsubscribe();
    });
  });
});
