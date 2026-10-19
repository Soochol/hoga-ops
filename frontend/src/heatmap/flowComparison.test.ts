import { describe, expect, it } from 'vitest';
import { flowLinePath, flowPoints, flowTimeLabel, flowValueAt, flowValueLabel, latestFlowTime } from './flowComparison';

const BASE = Date.parse('2026-10-19T09:00:00+09:00');
const BUCKET = 300_000;

describe('flow 비교의 시간·결측 계약', () => {
  it('그룹마다 다른 null 구간을 삭제하거나 압축하지 않는다', () => {
    const points = flowPoints([null, 2, null, 4], BASE, BUCKET, 'absolute');
    expect(points).toEqual([
      { time: BASE, value: null }, { time: BASE + BUCKET, value: 2 },
      { time: BASE + 2 * BUCKET, value: null }, { time: BASE + 3 * BUCKET, value: 4 },
    ]);
    expect(flowValueAt(points, BASE + 1.5 * BUCKET)).toBeNull();
    expect(flowLinePath(points, (t) => (t - BASE) / BUCKET, (v) => v)).toBe(' M1.00,2.00  M3.00,4.00');
  });
  it('같은 시각을 보간하고 관측 밖으로 연장하지 않는다', () => {
    const points = flowPoints([2, 4, null], BASE, BUCKET, 'absolute');
    expect(flowValueAt(points, BASE)).toBe(2);
    expect(flowValueAt(points, BASE + .5 * BUCKET)).toBe(3);
    expect(flowValueAt(points, BASE + BUCKET)).toBe(4);
    expect(flowValueAt(points, BASE - 1)).toBeNull();
    expect(flowValueAt(points, BASE + 2 * BUCKET + 1)).toBeNull();
  });
  it('첫 구간을 0으로 맞추며, 첫 구간이 없는 그룹은 다른 시각으로 대체하지 않는다', () => {
    expect(flowPoints([2, 4, null, -1], BASE, BUCKET, 'relative').map((p) => p.value)).toEqual([0, 2, null, -3]);
    expect(flowPoints([null, 4, 5], BASE, BUCKET, 'relative').map((p) => p.value)).toEqual([null, null, null]);
  });
  it('최근 30분은 여섯 버킷 전 값과 비교하고 결측을 건너뛰지 않는다', () => {
    const points = flowPoints([1, null, 2, 3, 4, 5, 7, 8, null], BASE, BUCKET, 'momentum');
    expect(points.map((p) => p.value)).toEqual([null, null, null, null, null, null, 6, null, null]);
    // 버킷 폭이 달라도 정확한 시간 차이를 사용한다.
    expect(flowPoints([1, 2, 4, 7], BASE, 600_000, 'momentum').map((p) => p.value)).toEqual([null, null, null, 6]);
  });
  it('최신 시각은 선택 그룹의 실측 기준이며 0과 음수도 유효하다', () => {
    const data = { date: '2026-10-19', bucket_ms: BUCKET, t_base_ms: BASE, groups: [
      { folder_id: 'a', pct: [1, 0, null] }, { folder_id: 'b', pct: [null, null, -2] },
    ] };
    expect(latestFlowTime(data, ['a'])).toBe(BASE + BUCKET);
    expect(latestFlowTime(data, ['a', 'b'])).toBe(BASE + 2 * BUCKET);
    expect(latestFlowTime(data, [])).toBeNull();
  });
  it('KST 시각, %와 %p 및 반올림된 음수 0을 구분한다', () => {
    expect(flowTimeLabel(BASE)).toBe('09:00');
    expect(flowValueLabel(null, '%')).toBe('—');
    expect(flowValueLabel(1.25, '%p')).toBe('+1.25%p');
    expect(flowValueLabel(-.001, '%')).toBe('+0.00%');
  });
});
