import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BreakoutForm, DepthPeakForm, DepthPeakPeriodForm, DepthRenewalForm } from './paramForms';
import { hhmmToTimeValue, timeValueToHhmm } from './paramFormsHelpers';

describe('기준시각 HHMM ↔ <input type="time"> 변환', () => {
  it('HHMM 정수를 0 패딩된 시각 문자열로', () => {
    expect(hhmmToTimeValue(1200)).toBe('12:00');
    expect(hhmmToTimeValue(905)).toBe('09:05');
    expect(hhmmToTimeValue(1520)).toBe('15:20');
  });
  it('시각 문자열을 HHMM 정수로 — 왕복이 항등', () => {
    for (const hhmm of [900, 905, 1200, 1459, 1520, 1700, 1959]) {
      expect(timeValueToHhmm(hhmmToTimeValue(hhmm))).toBe(hhmm);
    }
  });
  it('허용 범위 밖·형식 불량은 null — 서버 422 를 부르는 값을 만들지 않는다', () => {
    expect(timeValueToHhmm('08:59')).toBeNull();   // 개장 전
    expect(timeValueToHhmm('20:00')).toBeNull();   // 상한 초과
    expect(timeValueToHhmm('')).toBeNull();        // 입력 지우는 중
    expect(timeValueToHhmm('1200')).toBeNull();    // 콜론 없음
  });
});

describe('Num 입력 검증 (실제 조건 폼 경유)', () => {
  it('범위 밖 값은 그대로 보이고 blur에서 오류를 안내한다', () => {
    const onChange = vi.fn();
    render(<BreakoutForm params={{ lookback: 200, period: 500 }} onChange={onChange} />);
    const input = screen.getByLabelText('최근 기간(봉)');
    fireEvent.change(input, { target: { value: '-5' } });
    expect(input).toHaveValue('-5');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent('1 이상으로 입력하세요.');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('5000');
    expect(screen.getByRole('alert')).toHaveTextContent('1000 이하로 입력하세요.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('문자와 빈칸은 기본값으로 복원하지 않는다', () => {
    const onChange = vi.fn();
    render(<BreakoutForm params={{ lookback: 200, period: 500 }} onChange={onChange} />);
    const input = screen.getByLabelText('최근 기간(봉)');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('abc');
    expect(screen.getByRole('alert')).toHaveTextContent('숫자를 입력하세요.');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('값을 입력하세요.');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('총잔량 문턱(threshold_pct)은 서버 하한 ge=1 을 미러한다', () => {
  it.each([
    ['peak', <DepthPeakForm params={{ lookback: 20, threshold_pct: 100 }} onChange={() => {}} />, '과거 peak 대비'],
    ['period peak', <DepthPeakPeriodForm params={{ lookback: 5, period: 20, threshold_pct: 100 }} onChange={() => {}} />, '과거 peak 대비(%)'],
    ['renewal', <DepthRenewalForm params={{ start_hhmm: 1200, threshold_pct: 100 }} onChange={() => {}} />, '이전 최대 대비'],
  ])('%s: 0을 자동 보정하지 않고 하한 오류를 표시한다', (_, form, label) => {
    render(form);
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('0');
    expect(screen.getByRole('alert')).toHaveTextContent('1 이상으로 입력하세요.');
  });

  it('상한은 두지 않는다', () => {
    const onChange = vi.fn();
    render(<DepthPeakPeriodForm params={{ lookback: 5, period: 20, threshold_pct: 100 }} onChange={onChange} />);
    const input = screen.getByLabelText('과거 peak 대비(%)');
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ lookback: 5, period: 20, threshold_pct: 5000 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('문턱을 비우면 빈칸을 유지하고 숫자 파라미터를 바꾸지 않는다', () => {
    const onChange = vi.fn();
    render(<DepthRenewalForm params={params} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('이전 최대 대비'), { target: { value: '' } });
    expect(screen.getByLabelText('이전 최대 대비')).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });
});
