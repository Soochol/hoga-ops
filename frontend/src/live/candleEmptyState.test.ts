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

  // --- 200 + data_warnings 경로 -------------------------------------------
  // 백엔드가 벤더 실패를 500 이 아니라 경고로 강등하므로(#1226) `error` 는 null 인데
  // 캔들만 0 인 상태가 **정상 경로로** 생긴다. 경고를 안 보면 그 화면이 "이 구간에
  // 캔들이 없다" 로 떠서, 벤더가 거절한 것을 없는 데이터라고 단언하게 된다.

  it('인증 실패 경고 → 재시도를 제안하지 않는다', () => {
    // 설정을 고치기 전에는 영원히 같은 실패라 재시도 버튼은 헛돈다. 앱 설정 모달로도
    // 못 고치므로(처방이 벤더 쪽이다) 행동 자체를 비운다.
    const s = deriveCandleEmptyState({
      ...base,
      warnings: [{ reason: 'auth_error', msg: '인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]' }],
    });
    expect(s?.text).toBe('벤더 인증에 실패해 캔들을 받지 못했다');
    expect(s?.action).toBeNull();
    // 8050(단말기 등록)과 8005(토큰)는 고칠 곳이 다르다 — 원문이 없으면 구별 불가다.
    expect(s?.detail).toContain('8050');
  });

  it('일반 벤더 실패 경고 → "없는 데이터" 가 아니라 "못 받은 데이터" 로 말한다', () => {
    for (const reason of ['rate_limit_upstream', 'transport_error', 'api_error', 'batch_limit_exceeded']) {
      const s = deriveCandleEmptyState({ ...base, warnings: [{ reason, msg: 'vendor said no' }] });
      expect(s?.text).toBe('벤더가 이 구간을 주지 않았다');
      expect(s?.action).toBe('retry');
      expect(s?.detail).toBe('vendor said no');
    }
  });

  it('인증 실패가 다른 벤더 실패보다 우선한다 — 처방이 정반대다', () => {
    // 한 응답에 섞여 오면 재시도를 권하는 쪽이 이기면 안 된다.
    const s = deriveCandleEmptyState({
      ...base,
      warnings: [{ reason: 'rate_limit_upstream', msg: 'a' }, { reason: 'auth_error', msg: 'b' }],
    });
    expect(s?.action).toBeNull();
  });

  it('우리 쪽 유예는 벤더 탓으로 말하지 않는다', () => {
    // capacity_overloaded 는 우리 스케줄러 대기열, fetch_budget_exhausted 는 우리가
    // 건 요청당 상한이다 — 둘 다 벤더에게 **묻지도 않았다**. "벤더가 주지 않았다" 는
    // 묻지도 않은 쪽에 책임을 지우는 거짓이고, "이 구간에 캔들이 없다"(예전 문구)는
    // 미룬 것을 없는 것이라 단언하는 거짓이다.
    for (const reason of ['capacity_overloaded', 'fetch_budget_exhausted']) {
      const s = deriveCandleEmptyState({ ...base, warnings: [{ reason, msg: 'deferred' }] });
      expect(s?.text).toBe('요청이 밀려 이 구간을 아직 받지 못했다');
      // 장외엔 폴링이 멈춰 저절로 낫지 않는다 — 그 구간에서 유일하게 듣는 손잡이다.
      expect(s?.action).toBe('retry');
    }
  });

  it('벤더 실패가 우리 쪽 유예보다 우선한다 — 상류 거절이 더 알려 준다', () => {
    const s = deriveCandleEmptyState({
      ...base,
      warnings: [{ reason: 'capacity_overloaded', msg: 'a' }, { reason: 'api_error', msg: 'b' }],
    });
    expect(s?.text).toBe('벤더가 이 구간을 주지 않았다');
    expect(s?.detail).toBe('b');
  });

  it('벤더 실패가 아닌 사유는 이 분기를 켜지 않는다', () => {
    // 허용목록이라 `invariant_violation`(행 단위 검증)·`rest_bypassed`(우회 켜짐)는
    // 통과한다. 여기가 새면 아래 우회 안내가 도달 불가가 된다.
    expect(deriveCandleEmptyState({ ...base, warnings: [{ reason: 'invariant_violation', msg: 'x' }] }))
      .toEqual({ text: '이 구간에 캔들이 없다', action: null });
    const bypass = deriveCandleEmptyState({
      ...base, restBypassEnabled: true, warnings: [{ reason: 'rest_bypassed', msg: 'x' }],
    });
    expect(bypass?.text).toContain('벤더 우회');
  });

  it('에러가 경고보다 우선한다 — 조회 자체가 실패했으면 그게 이유다', () => {
    const s = deriveCandleEmptyState({
      ...base,
      error: apiError('not_wired'),
      warnings: [{ reason: 'auth_error', msg: 'x' }],
    });
    expect(s?.text).toContain('벤더 연결');
  });
});
