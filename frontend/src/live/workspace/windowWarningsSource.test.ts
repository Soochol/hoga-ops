import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  publishWindowWarnings,
  clearWindowWarnings,
  useWindowWarnings,
  backfillProgressDate,
} from './windowWarningsSource';

describe('windowWarningsSource', () => {
  beforeEach(() => {
    clearWindowWarnings('w1');
    clearWindowWarnings('w2');
  });

  it('returns empty defaults for an unpublished window (stable reference)', () => {
    const { result, rerender } = renderHook(() => useWindowWarnings('w1'));
    expect(result.current.backfillEarliestDate).toBeNull();
    const first = result.current;
    rerender();
    // 같은 참조여야 무한 렌더가 안 난다.
    expect(result.current).toBe(first);
  });

  it('delivers published warnings to the matching window only', () => {
    const w1 = renderHook(() => useWindowWarnings('w1'));
    const w2 = renderHook(() => useWindowWarnings('w2'));

    act(() => {
      publishWindowWarnings('w1', { backfillEarliestDate: '20260501' });
    });

    expect(w1.result.current.backfillEarliestDate).toBe('20260501');
    // w2 는 영향 없음(창별 격리).
    expect(w2.result.current.backfillEarliestDate).toBeNull();
  });

  it('clears warnings back to defaults on unmount/clear', () => {
    const { result } = renderHook(() => useWindowWarnings('w1'));
    act(() => {
      publishWindowWarnings('w1', { backfillEarliestDate: '20260501' });
    });
    expect(result.current.backfillEarliestDate).toBe('20260501');
    act(() => clearWindowWarnings('w1'));
    expect(result.current.backfillEarliestDate).toBeNull();
  });
});

/**
 * 진행 칩에 **무슨 날짜를 실을지** 정하는 순수 판정. 발행부(`ChartWindow`)가 이걸
 * 부르므로 여기가 회귀를 잡는 자리다 — 렌더층(`TitleBarSymbolRow`) 테스트는 "발행된
 * 값을 그린다" 만 재므로 **소스를 홀드된 번들로 되돌리는 회귀를 못 본다.**
 */
describe('backfillProgressDate', () => {
  const BASE = {
    extending: true,
    historicalFromDate: '20260101',
    settledFromDate: '20260609',
    earliestSegmentDate: '20260701',
  };

  it('확장 중이 아니면 칩을 띄우지 않는다', () => {
    expect(backfillProgressDate({ ...BASE, extending: false })).toBeNull();
  });

  it('창이 아직 없으면(초기 로드) 띄우지 않는다 — 백필이 아니라 첫 로드다', () => {
    expect(backfillProgressDate({ ...BASE, historicalFromDate: null })).toBeNull();
  });

  it('캔들이 아직 0개면 띄우지 않는다', () => {
    expect(backfillProgressDate({ ...BASE, earliestSegmentDate: null })).toBeNull();
  });

  // ── 이 판정의 목적 (2026-08-24) ──────────────────────────────────────
  // 종전엔 `segments[0].date` 만 썼는데, 그 번들은 워크백 내내 `extending` 홀드
  // (`lastSettledChartRef`)라 **날짜가 고정된다**. 실측(000270 10m, 1초 간격 샘플링):
  // t+4~16s 동안 "6/9까지" 가 13초간 그대로였고 그 사이 7일 타일이 여러 개 도착했다.
  // 13초 동안 같은 날짜가 멈춰 있으면 사용자에겐 **멈춘 것과 구별되지 않는다.**
  it('홀드된 세그먼트가 아니라 **settled from** 을 싣는다 — 진행이 보여야 한다', () => {
    // settled 가 세그먼트보다 과거 = 워크백이 그만큼 더 걸어갔다는 뜻.
    expect(backfillProgressDate(BASE)).toBe('20260609');
  });

  it('settled 가 없는 경로(지수·미배선)는 세그먼트로 폴백한다 — 칩을 죽이지 않는다', () => {
    expect(backfillProgressDate({ ...BASE, settledFromDate: null })).toBe('20260701');
  });

  it('settled 가 세그먼트보다 **미래면 세그먼트를 쓴다** — 칩 날짜가 뒤로 가지 않는다', () => {
    // 축소·오늘-델타로 창이 좁아진 값이 되실리는 렌더가 있으면 표시가 후퇴한다.
    // 진행 표시는 단조로워야 읽힌다.
    expect(backfillProgressDate({ ...BASE, settledFromDate: '20260801' })).toBe('20260701');
  });

  // ── 보충(gap fill) 대기도 칩을 세운다 (2026-08-25) ────────────────────
  // 구멍 구간을 팬으로 건널 때의 실측(010140 5m, 06-15~07-02 캡처 구멍 16일):
  // extend→stop 은 7초에 끝났지만 그 뒤 키움 보충 3콜이 도는 십수 초 동안 화면은
  // whitespace 였고, 칩은 extending 게이트라 꺼져 있었다 — **가장 긴 대기가 표시
  // 없는 구간**이라 사용자에겐 "갑자기 빈 화면 = 고장" 으로 읽혔다.
  it('확장이 끝나도 보충이 남아 있으면 칩을 유지한다', () => {
    expect(
      backfillProgressDate({ ...BASE, extending: false, gapFillPending: true }),
    ).toBe('20260609');
  });

  it('보충도 확장도 없으면 종전대로 null — 게이트가 넓어지기만 한 것이 아니다', () => {
    expect(
      backfillProgressDate({ ...BASE, extending: false, gapFillPending: false }),
    ).toBeNull();
  });

  it('보충 대기라도 창이 없으면(첫 로드) 띄우지 않는다 — 기존 게이트는 그대로다', () => {
    expect(
      backfillProgressDate({
        ...BASE, extending: false, gapFillPending: true, historicalFromDate: null,
      }),
    ).toBeNull();
  });
});
