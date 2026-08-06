import { describe, expect, it } from 'vitest';
import { deriveCandleEmptyState, type CandleEmptyInput } from './candleEmptyState';

const base: CandleEmptyInput = {
  error: null,
  hasCandles: false,
  isLoading: false,
  restBypassEnabled: false,
  hasInstrument: true,
};
const apiError = (code: string) => Object.assign(new Error('x'), { code });

describe('deriveCandleEmptyState', () => {
  it('캔들이 있으면 아무 말도 하지 않는다', () => {
    expect(deriveCandleEmptyState({ ...base, hasCandles: true })).toBeNull();
  });

  it('로딩 중엔 판단하지 않는다 — 매 조회마다 깜빡이면 안 된다', () => {
    expect(deriveCandleEmptyState({ ...base, isLoading: true })).toBeNull();
  });

  it('종목이 안 골라졌으면 이 안내의 대상이 아니다', () => {
    // 그 상태는 ChartWindow 의 "종목 없음" 빈 상태가 이미 소유한다 — 두 개가 겹치면
    // 사용자는 어느 쪽을 고쳐야 할지 모른다.
    expect(deriveCandleEmptyState({ ...base, hasInstrument: false })).toBeNull();
  });

  it('자격증명 미배선(not_wired) → 설정으로 보낸다', () => {
    const s = deriveCandleEmptyState({ ...base, error: apiError('not_wired') });
    expect(s?.text).toContain('벤더 연결');
    expect(s?.action).toBe('settings');
  });

  it('벤더 장애(kiwoom_*) → 재시도', () => {
    for (const code of ['kiwoom_api_error', 'kiwoom_http_error']) {
      const s = deriveCandleEmptyState({ ...base, error: apiError(code) });
      expect(s?.text).toContain('벤더 응답');
      expect(s?.action).toBe('retry');
    }
  });

  it('모르는 실패도 침묵하지 않는다 — 코드를 못 읽어도 실패는 말할 수 있다', () => {
    const s = deriveCandleEmptyState({ ...base, error: new Error('boom') });
    expect(s?.text).toBe('캔들을 불러오지 못했다');
    expect(s?.action).toBe('retry');
  });

  it('우회 ON + 디스크 없음 → 설정(우회 끄기)으로 보낸다', () => {
    const s = deriveCandleEmptyState({ ...base, restBypassEnabled: true });
    expect(s?.text).toContain('벤더 우회');
    expect(s?.action).toBe('settings');
  });

  it('에러가 우회보다 우선한다 — 조회가 실패했으면 그게 이유다', () => {
    // 우회 ON 인데 에러도 있으면 "저장된 캔들 없음" 은 틀린 설명이다.
    const s = deriveCandleEmptyState({
      ...base, restBypassEnabled: true, error: apiError('not_wired'),
    });
    expect(s?.text).toContain('벤더 연결');
  });

  it('정상 응답인데 비었으면 행동을 제안하지 않는다', () => {
    // 고칠 것이 없다 — 없는 버튼이 있는 버튼보다 정직하다.
    const s = deriveCandleEmptyState(base);
    expect(s).toEqual({ text: '이 구간에 캔들이 없다', action: null });
  });
});
