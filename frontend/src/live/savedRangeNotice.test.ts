import { describe, expect, it } from 'vitest';
import { savedRangeNotice } from './savedRangeNotice';

const base = {
  fromDate: '20260701',
  toDate: '20260708',
  minuteFloorDate: '20251215',
  hasBand: true,
  candleCount: 300,
};

describe('savedRangeNotice — 분봉 250일 벽', () => {
  it('구간 전체가 벽 안이면 안내 없음', () => {
    expect(savedRangeNotice({ ...base, timeframe: '1m' })).toBeNull();
  });

  it('구간 끝까지 벽 밖이면 "범위 밖" — 대안(일봉)을 문구에 담는다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m', fromDate: '20240101', toDate: '20240108',
    });
    expect(n?.text).toBe('저장 구간이 분봉 범위 밖');
    expect(n?.detail).toContain('일봉');
  });

  it('시작만 벽 밖이면 "일부만 표시" — 되는 데까지는 보여준다', () => {
    const n = savedRangeNotice({
      ...base, timeframe: '1m', fromDate: '20250101', toDate: '20260108',
    });
    expect(n?.text).toBe('저장 구간 일부만 표시');
  });

  it('경계 그 날짜는 벽 안이다 (< 이지 <= 가 아니다)', () => {
    expect(savedRangeNotice({
      ...base, timeframe: '1m', fromDate: '20251215', toDate: '20251216',
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

  it('캘린더 봉은 분봉 벽을 보지 않는다 — 일봉은 250일 밖도 조회된다', () => {
    expect(savedRangeNotice({
      ...base, timeframe: 'D', fromDate: '20200101', toDate: '20200108', hasBand: true,
    })).toBeNull();
  });
});
