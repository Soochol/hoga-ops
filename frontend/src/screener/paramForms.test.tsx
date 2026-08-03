import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DepthRenewalForm, hhmmToTimeValue, timeValueToHhmm } from './paramForms';

describe('기준시각 HHMM ↔ <input type="time"> 변환', () => {
  it('HHMM 정수를 0 패딩된 시각 문자열로', () => {
    expect(hhmmToTimeValue(1200)).toBe('12:00');
    expect(hhmmToTimeValue(905)).toBe('09:05');
    expect(hhmmToTimeValue(1520)).toBe('15:20');
  });
  it('시각 문자열을 HHMM 정수로 — 왕복이 항등', () => {
    for (const hhmm of [900, 905, 1200, 1459, 1520]) {
      expect(timeValueToHhmm(hhmmToTimeValue(hhmm))).toBe(hhmm);
    }
  });
  it('허용 범위 밖·형식 불량은 null — 서버 422 를 부르는 값을 만들지 않는다', () => {
    expect(timeValueToHhmm('08:59')).toBeNull();   // 개장 전
    expect(timeValueToHhmm('15:21')).toBeNull();   // 상한 초과
    expect(timeValueToHhmm('')).toBeNull();        // 입력 지우는 중
    expect(timeValueToHhmm('1200')).toBeNull();    // 콜론 없음
  });
});

describe('DepthRenewalForm', () => {
  const params = { start_hhmm: 1200, threshold_pct: 100 };

  it('유효한 시각만 onChange 로 흘린다 — 다른 파라미터는 보존', () => {
    const onChange = vi.fn();
    render(<DepthRenewalForm params={{ start_hhmm: 1200, threshold_pct: 120 }} onChange={onChange} />);
    const input = screen.getByLabelText('기준 시각');
    expect(input).toHaveValue('12:00');

    fireEvent.change(input, { target: { value: '13:30' } });
    expect(onChange).toHaveBeenCalledWith({ start_hhmm: 1330, threshold_pct: 120 });

    // 범위 밖은 무시 — 마지막 유효값이 유지된다(빈 값으로 스캔이 422 나지 않게).
    onChange.mockClear();
    fireEvent.change(input, { target: { value: '08:00' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('문턱을 바꿔도 기준시각은 보존된다', () => {
    const onChange = vi.fn();
    render(<DepthRenewalForm params={params} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('이전 최대 대비'), { target: { value: '120' } });
    expect(onChange).toHaveBeenCalledWith({ start_hhmm: 1200, threshold_pct: 120 });
  });

  it('문턱을 비우면 100 으로 — undefined 가 서버로 가지 않는다', () => {
    const onChange = vi.fn();
    render(<DepthRenewalForm params={params} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('이전 최대 대비'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ start_hhmm: 1200, threshold_pct: 100 });
  });
});
