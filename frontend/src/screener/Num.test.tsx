import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Num } from './Num';
import { NumericInputValidationContext, useNumericInputValidation } from './numericInputValidation';

function Form({ required = true, step }: { required?: boolean; step?: number }) {
  const [value, setValue] = useState<number | undefined>(200);
  const [other, setOther] = useState(5);
  const validation = useNumericInputValidation();
  return <NumericInputValidationContext.Provider value={validation.report}>
    <Num label="조건값" value={value} onChange={setValue} required={required} step={step} />
    <Num label="다른 값" value={other} onChange={n => setOther(n!)} />
    <output data-testid="committed">{String(value)}</output>
    <button disabled={validation.invalid}>조회</button>
  </NumericInputValidationContext.Provider>;
}

it('백스페이스로 완전히 지우고 형제 필드를 편집해도 빈칸과 차단 상태를 유지한다', async () => {
  const user = userEvent.setup();
  render(<Form />);
  const input = screen.getByLabelText('조건값');
  await user.click(input);
  await user.keyboard('{End}{Backspace}{Backspace}{Backspace}');
  expect(input).toHaveValue('');
  expect(screen.getByRole('button', { name: '조회' })).toBeDisabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('다른 값'), { target: { value: '6' } });
  expect(input).toHaveValue('');
  await user.tab();
  expect(input).toHaveAccessibleDescription('값을 입력하세요.');
  await user.click(input);
  await user.keyboard('300{Enter}');
  expect(input).toHaveValue('300');
  expect(screen.getByTestId('committed')).toHaveTextContent('300');
  expect(screen.getByRole('button', { name: '조회' })).toBeEnabled();
});

it('음수 부호와 소수점의 중간 입력을 보존한다', async () => {
  const user = userEvent.setup();
  render(<Form />);
  const input = screen.getByLabelText('조건값');
  await user.clear(input);
  await user.type(input, '-');
  expect(input).toHaveValue('-');
  expect(screen.getByRole('button', { name: '조회' })).toBeDisabled();
  await user.type(input, '0.');
  expect(input).toHaveValue('-0.');
  await user.type(input, '25');
  expect(input).toHaveValue('-0.25');
  expect(screen.getByTestId('committed')).toHaveTextContent('-0.25');
  expect(screen.getByRole('button', { name: '조회' })).toBeEnabled();
});

it('선택값은 빈칸을 undefined로 전달하고 정수 조건은 소수를 막는다', () => {
  const view = render(<Form required={false} />);
  fireEvent.change(screen.getByLabelText('조건값'), { target: { value: '' } });
  fireEvent.blur(screen.getByLabelText('조건값'));
  expect(screen.getByTestId('committed')).toHaveTextContent('undefined');
  expect(screen.getByRole('button', { name: '조회' })).toBeEnabled();
  view.unmount();
  render(<Form step={1} />);
  fireEvent.change(screen.getByLabelText('조건값'), { target: { value: '1.5' } });
  fireEvent.keyDown(screen.getByLabelText('조건값'), { key: 'Enter' });
  expect(screen.getByRole('alert')).toHaveTextContent('정수로 입력하세요.');
  expect(screen.getByTestId('committed')).toHaveTextContent('200');
  expect(screen.getByRole('button', { name: '조회' })).toBeDisabled();
});
