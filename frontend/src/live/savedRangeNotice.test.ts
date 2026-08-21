import { describe, expect, it } from 'vitest';
import { savedRangeNotice } from './savedRangeNotice';

const base = {
  fromDate: '20260701',
  toDate: '20260708',
  hasBand: true,
  candleCount: 300,
};

/**
 * 이 describe 가 **막는 방향은 하나다**: 분봉에서 이 함수가 다시 말을 하기 시작하는 것.
 *
 * 2026-08-21 이전에는 여기 250일 벽 안내 두 개가 있었다. 저장뷰 창이 그 구간에 얼려
 * 디스크를 읽게 되면서(`UseLiveBundleOptions.frozenRangeFrom`) 벽이 그 창에 적용되지
 * 않으므로, 문구가 살아 있으면 **볼 수 있는 구간을 못 본다고 말한다.**
 *
 * ⚠ **이 테스트가 못 보는 것**: 얼림이 실제로 배선됐는지는 여기서 원리적으로 못 잰다
 * (이 함수는 얼림을 인자로도 안 받는다). 그 축은 `useLiveBundle.test.tsx` 의
 * `planLiveRangeRequest` 케이스가 잡는다 — 벽 해제와 디스크 소스 전환을 값으로 센다.
 */
describe('savedRangeNotice — 분봉은 침묵한다', () => {
  it('구간이 벽 안이면 안내 없음', () => {
    expect(savedRangeNotice({ ...base, timeframe: '1m' })).toBeNull();
  });

  it('구간이 통째로 250일 벽 밖이어도 침묵 — 얼린 창은 디스크로 그 구간을 그린다', () => {
    expect(savedRangeNotice({
      ...base, timeframe: '1m', fromDate: '20240101', toDate: '20240108',
    })).toBeNull();
  });

  it('앞부분만 벽 밖이어도 침묵', () => {
    expect(savedRangeNotice({
      ...base, timeframe: '1m', fromDate: '20250101', toDate: '20260108',
    })).toBeNull();
  });

  it('캔들이 하나도 없어도 침묵 — 그 화면은 빈 상태가 소유한다', () => {
    // 전량 미캡처의 안내는 `candleEmptyState` 의 `savedRangeFrozen` 분기가 맡는다.
    // 여기서 한마디 더 얹으면 같은 사실을 두 곳에서 다르게 말하게 된다.
    expect(savedRangeNotice({
      ...base, timeframe: '1m', candleCount: 0, hasBand: false,
      earliestCandleDate: null,
    })).toBeNull();
  });

  it('첫 캔들이 저장 시작일이면 침묵 — 전 구간이 캡처돼 있다', () => {
    expect(savedRangeNotice({
      ...base, timeframe: '1m', earliestCandleDate: base.fromDate,
    })).toBeNull();
  });
});

/**
 * 분봉 **부분** 미캡처(2026-08-21). 얼린 창은 디스크를 읽으므로 캡처가 시작된 날부터만
 * 봉이 있고, 저장뷰는 그보다 과거를 가리킬 수 있다 — 실측으로 사용자의 벽 밖 분봉
 * 저장뷰 2개가 **둘 다** 이 경우다(저장 시작 2025-11-19·12-11 vs 캡처 시작 2026-01-02).
 *
 * **막는 방향**: 그 화면이 **침묵**하는 것. 빈 상태는 전량이 비어야 발화하므로 이 자리를
 * 원리적으로 못 본다 — 침묵하면 "앞이 잘렸는데 이유가 없는 차트" 가 된다.
 *
 * **개수로는 못 잰다**: 뒷부분만 캡처돼도 `candleCount` 는 크다. 그래서 판정 재료가
 * `earliestCandleDate` 와 `fromDate` 의 **비교**여야 한다.
 */
describe('savedRangeNotice — 분봉 부분 미캡처', () => {
  it('첫 캔들이 저장 시작일보다 늦으면 앞부분 미캡처를 말한다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20251119', toDate: '20260224',
      earliestCandleDate: '20260102',
    });

    expect(n?.text).toBe('저장 구간 앞부분 없음');
    // 결과(어디부터 보이는지)를 문구에 담는다 — 칩만으로는 "얼마나" 를 모른다.
    expect(n?.detail).toContain('2026.01.02');
  });

  it('개수가 많아도 앞이 잘렸으면 말한다 — candleCount 로는 못 잡는 자리', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20251119', toDate: '20260224',
      candleCount: 9999,
      earliestCandleDate: '20260102',
    });

    expect(n?.text).toBe('저장 구간 앞부분 없음');
  });

  it('첫 캔들이 저장 시작일보다 이르면 침묵 — 구간이 다 덮였다', () => {
    expect(savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20260110', toDate: '20260224',
      earliestCandleDate: '20260102',
    })).toBeNull();
  });

  it('earliestCandleDate 를 안 넘기면 침묵 — 모르는 것을 단언하지 않는다', () => {
    // 호출부가 이 값을 아직 못 구했을 때(로딩 중) 잘못된 경고가 깜빡이면 안 된다.
    expect(savedRangeNotice({ ...base, timeframe: '1m', fromDate: '20251119' })).toBeNull();
  });
});

/**
 * 키움 보충(`useMinuteGapFill`)이 붙으면서 생긴 판정들.
 *
 * **막는 방향**: 되는 일을 "안 된다" 고 말하는 것. 2026-08-21 까지 이 함수는 앞부분
 * 미캡처에 무조건 "캡처 이전 구간은 채울 수 없습니다" 를 붙였는데, 보충 경로가 생긴
 * 지금 그 문장은 세 갈래 중 하나(보유 기간 밖)에서만 참이다.
 *
 * **못 보는 것**: 실제로 벤더가 응답했는지. 이 함수는 개수만 받으므로 훅이 센 값이
 * 틀리면 그대로 틀린다 — 그 축은 `useMinuteGapFill` 쪽 테스트가 맡는다.
 */
describe('savedRangeNotice — 키움 보충', () => {
  const noGapFill = { filledCount: 0, rescaledCount: 0, unfillableCount: 0, pending: false };

  it('보충 중이면 그것만 말한다 — 채워지는 구간을 "없다" 고 단언하지 않는다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20251119', toDate: '20260224',
      earliestCandleDate: '20260102',
      gapFill: { ...noGapFill, pending: true, unfillableCount: 3 },
    });

    expect(n?.text).toBe('빈 거래일 보충 중');
  });

  it('앞부분이 보유 기간 밖이면 그 이유를 말한다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20240827', toDate: '20260224',
      earliestCandleDate: '20260102',
      gapFill: { ...noGapFill, unfillableCount: 40 },
    });

    expect(n?.text).toBe('저장 구간 앞부분 없음');
    expect(n?.detail).toContain('보유 기간');
    // 되는 일을 안 된다고 말하던 옛 문장이 남아 있으면 안 된다.
    expect(n?.detail).not.toContain('디스크 캡처를 읽으므로');
  });

  it('보유 기간 안인데도 앞이 비면 이유를 단정하지 않는다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20260101', toDate: '20260224',
      earliestCandleDate: '20260102',
      gapFill: noGapFill,
    });

    expect(n?.detail).toContain('캡처도 벤더 보충도');
  });

  it('앞은 멀쩡하고 중간에 척도 불일치만 남으면 그것을 말한다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20260110', toDate: '20260224',
      earliestCandleDate: '20260102',
      gapFill: { ...noGapFill, filledCount: 5, rescaledCount: 2 },
    });

    expect(n?.text).toContain('수정주가');
    expect(n?.text).toContain('2일');
  });

  it('앞은 멀쩡하고 보유 밖 결손만 남으면 개수를 말한다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20260110', toDate: '20260224',
      earliestCandleDate: '20260102',
      gapFill: { ...noGapFill, unfillableCount: 7 },
    });

    expect(n?.text).toContain('보유 기간 밖');
    expect(n?.text).toContain('7일');
  });

  it('전부 채워졌으면 침묵한다 — 안 되는 것만 말하는 정책', () => {
    expect(savedRangeNotice({
      ...base, timeframe: '1m',
      fromDate: '20260110', toDate: '20260224',
      earliestCandleDate: '20260102',
      gapFill: { ...noGapFill, filledCount: 12 },
    })).toBeNull();
  });
});

describe('savedRangeNotice — 캘린더 봉 밴드 부재', () => {
  it('밴드가 잡히면 안내 없음', () => {
    expect(savedRangeNotice({ ...base, timeframe: 'D', hasBand: true })).toBeNull();
  });

  it('밴드가 없으면 "데이터 없음" — 그러지 않으면 밴드가 무성 소멸한다', () => {
    const n = savedRangeNotice({ ...base, timeframe: 'D', hasBand: false });
    expect(n?.text).toBe('저장 구간 데이터 없음');
  });

  it('캔들이 아예 없으면 침묵 — 그 화면은 빈 상태가 소유한다', () => {
    expect(savedRangeNotice({
      ...base, timeframe: 'D', hasBand: false, candleCount: 0,
    })).toBeNull();
  });

  it('캘린더 봉은 얼림과 무관하다 — 일봉은 250일 밖도 원래 조회된다', () => {
    expect(savedRangeNotice({
      ...base, timeframe: 'D', fromDate: '20200101', toDate: '20200108', hasBand: true,
    })).toBeNull();
  });
});
